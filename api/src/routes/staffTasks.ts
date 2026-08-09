// Admin: create and manage OUR OWN tasks, and review the proofs users submit
// for them. Ad-network tasks come from an adapter; these we write by hand.
//
// The two verification modes (guardrail #1 — a task can never credit itself):
//   'proof'    — user submits evidence; a STAFF MEMBER approves; the credit is
//                that audit-logged human decision.
//   'postback' — a partner's server calls /webhooks/custom/postback with this
//                task's own secret. Same contract as a real ad network.
//
// Crediting always goes through creditCompletion() (../credit.ts), the SAME path
// the network postbacks use, so a custom task pays referral bonuses and respects
// velocity caps identically. This file never writes to the ledger directly.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { sql, now, newId, logAudit } from "../db.ts";
import { config } from "../config.ts";
import { requirePermission, type Role, type Permission } from "../roles.ts";
import { creditCompletion, type NetworkRow } from "../credit.ts";
import { campaignMoney, EXHAUSTED } from "../taskBudget.ts";

function staffGuard(
  perm: Permission,
  handler: (ctx: { userId: string; role: Role }, req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await handler(await requirePermission(req, perm), req, reply);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Something went wrong" });
    }
  };
}

const CUSTOM_NETWORK = "custom";

// The logos a task card can show. A CLOSED LIST, not a free-text field and not a
// URL: the icon name is looked up against a map of inline SVGs in the web app
// (components/icons.tsx `taskIcon`), so an Admin can never point a task card at
// an off-site image. Task cards sit next to balances, and a remote image there
// is a third-party request on a money screen — a tracking pixel at best.
//
// Adding one = a line here and a matching entry in `taskIcon`. An unknown value
// is refused at this boundary, so the two lists cannot drift apart silently.
export const TASK_ICONS = ["whatsapp", "telegram", "twitter", "youtube", "facebook", "instagram", "star"] as const;

const upsertSchema = z.object({
  title: z.string().min(3).max(120),
  points: z.number().int().positive().max(1_000_000),
  verifyMode: z.enum(["proof", "postback"]),
  instructions: z.string().max(2000).optional(),
  proofLabel: z.string().max(120).optional(),
  // Ask the user to type evidence? Only meaningful for verifyMode 'proof'.
  // False still routes the claim through the staff queue — see the column note
  // in db.ts. Defaults to true so an older client that never sends it keeps the
  // behaviour it was written against.
  proofRequired: z.boolean().optional(),
  // ⚠️ http/https ONLY, AND THE SCHEME CHECK IS THE POINT — `.url()` alone is not
  // enough. Zod's `.url()` is `new URL()`, which happily accepts
  // `javascript:alert(1)` and `data:text/html,…`. This value is rendered as the
  // href of the task card's button in the earner app (components/TaskFlow.tsx)
  // and of the Open link in the staff panel, so anything but http(s) here is
  // stored XSS on a screen that sits next to a balance — reachable by whoever
  // holds an admin session, which is exactly the session worth stealing.
  //
  // Checked at this boundary, not at render: there are two render sites already
  // and the next one will not remember.
  // The try/catch is load-bearing: zod v3 still runs a refinement after the
  // inner `.url()` has already failed, so a bare `new URL("")` in here THROWS
  // out of safeParse instead of producing a validation error — and "" is the
  // legal value that clears the link.
  actionUrl: z.string().url().max(500)
    .refine((u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } },
      { message: "The link must start with http:// or https://" })
    .optional().or(z.literal("")),
  minutes: z.number().int().min(0).max(600).default(1),
  country: z.string().max(60).default("Pakistan"),
  // ⚠️ 'exhausted' IS ACCEPTED SO AN ADMIN CAN SEE IT, BUT ONLY THE CREDIT PATH
  // SETS IT. An Admin picking it by hand would be claiming a campaign ran out
  // when it did not; the two states an Admin owns are active and disabled.
  // Reactivating an exhausted campaign whose budget was not raised simply
  // exhausts it again on the next completion, which is the correct outcome.
  status: z.enum(["active", "disabled"]).default("active"),
  icon: z.enum(TASK_ICONS).optional().or(z.literal("")),
  // ---- Campaign budget + revenue (brief parts 15 + 16) --------------------
  // null clears a cap back to unlimited; undefined leaves it alone. Both are
  // needed: "no budget" is a real, common state and has to be settable.
  budgetConversions: z.number().int().positive().max(10_000_000).nullable().optional(),
  budgetPoints: z.number().int().positive().max(1_000_000_000).nullable().optional(),
  // What the partner pays US per conversion, in micro-USD. Entered as dollars
  // in the panel and converted there; stored as an integer so no campaign's
  // margin is computed from a float.
  revenuePerConversionMicro: z.number().int().min(0).max(1_000_000_000).optional(),
});

export async function staffTaskRoutes(app: FastifyInstance) {
  // ---- List every custom task (admin) -------------------------------------
  app.get("/staff/tasks", staffGuard("tasks.view", async () => {
    const tasks = await sql.all<Record<string, unknown>>(
      `SELECT t.id, t.title, t.points, t.type, t.verify_mode, t.instructions, t.proof_label,
              t.proof_required, t.action_url, t.icon, t.minutes, t.country, t.status, t.created_at,
              t.budget_conversions, t.budget_points, t.revenue_per_conversion_micro,
              t.budget_exhausted_at,
              (t.postback_secret IS NOT NULL) AS has_secret,
              (SELECT COUNT(*) FROM task_completions c WHERE c.task_id = t.id AND c.status = 'credited') AS credited_count,
              (SELECT COUNT(*) FROM task_proofs p WHERE p.task_id = t.id AND p.status = 'pending') AS pending_proofs
       FROM tasks t WHERE t.source = 'custom' ORDER BY t.created_at DESC`,
    );

    // Part 15 — what each campaign earned against what it paid. DERIVED from the
    // completions and the ledger (taskBudget.ts), never a stored counter, so it
    // cannot drift away from the rows it is summarising.
    const money = await campaignMoney(config.pointsPerUsdt);
    return {
      tasks: tasks.map((t) => {
        const m = money.get(t.id as string);
        const cap = t.budget_conversions as number | null;
        const used = m?.conversions ?? 0;
        return {
          ...t,
          // Everything below is money, and it is served pre-computed for the
          // same reason `netUsdt` is on the withdrawal queue: a figure the panel
          // works out for itself is a second definition waiting to disagree.
          spentConversions: used,
          spentPoints: m?.points ?? 0,
          referralPointsPaid: m?.referralPoints ?? 0,
          revenueMicro: m?.revenueMicro ?? 0,
          marginMicro: m?.marginMicro ?? 0,
          // null when there is no cap — NOT 0 and NOT 100. A campaign with no
          // budget is not "0% used", and a progress bar reading 0% forever is
          // how an unbudgeted campaign gets mistaken for a budgeted one.
          budgetUsedPct: cap && cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : null,
        };
      }),
    };
  }));

  // ---- Create a custom task -----------------------------------------------
  app.post("/staff/tasks", staffGuard("tasks.manage", async ({ userId, role }, req) => {
    const b = upsertSchema.parse(req.body ?? {});
    const id = newId();
    // A postback task needs a secret so a partner can sign; a proof task never
    // has one (there is no server to hand it to), which also means it can't be
    // credited through the postback route even by mistake.
    const secret = b.verifyMode === "postback" ? randomBytes(24).toString("hex") : null;

    await sql.run(
      `INSERT INTO tasks
        (id, type, title, points, network, advertiser, minutes, requirement, country, status,
         source, verify_mode, instructions, proof_label, proof_required, action_url, icon,
         postback_secret, budget_conversions, budget_points, revenue_per_conversion_micro, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'custom', ?,?,?,?,?,?,?,?,?,?,?)`,
      id, "custom", b.title, b.points, CUSTOM_NETWORK, "RoziPay", b.minutes,
      b.instructions ?? null, b.country, b.status,
      b.verifyMode, b.instructions ?? null, b.proofLabel ?? null,
      b.proofRequired === false ? 0 : 1,
      b.actionUrl && b.actionUrl.length > 0 ? b.actionUrl : null,
      b.icon && b.icon.length > 0 ? b.icon : null, secret,
      b.budgetConversions ?? null, b.budgetPoints ?? null,
      b.revenuePerConversionMicro ?? 0, now(),
    );

    await logAudit({
      actorUserId: userId, actorRole: role, action: "custom_task_create",
      detail: `${b.title} (${b.verifyMode}, ${b.points} pts)`,
    });
    return { ok: true, id };
  }));

  // ---- Edit a custom task -------------------------------------------------
  app.patch("/staff/tasks/:id", staffGuard("tasks.manage", async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    const b = upsertSchema.partial().parse(req.body ?? {});

    const existing = await sql.get<{ verify_mode: string; postback_secret: string | null }>(
      "SELECT verify_mode, postback_secret FROM tasks WHERE id = ? AND source = 'custom'", id,
    );
    if (!existing) return { ok: false, error: "not found" };

    const nextMode = b.verifyMode ?? existing.verify_mode;
    // Switching TO postback mints a secret if there wasn't one; switching to
    // proof drops it (the postback URL stops working, which is correct).
    let secret = existing.postback_secret;
    if (nextMode === "postback" && !secret) secret = randomBytes(24).toString("hex");
    if (nextMode === "proof") secret = null;

    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
    if (b.title !== undefined) set("title", b.title);
    if (b.points !== undefined) set("points", b.points);
    if (b.minutes !== undefined) set("minutes", b.minutes);
    if (b.country !== undefined) set("country", b.country);
    if (b.status !== undefined) set("status", b.status);
    if (b.instructions !== undefined) { set("instructions", b.instructions); set("requirement", b.instructions); }
    if (b.proofLabel !== undefined) set("proof_label", b.proofLabel);
    if (b.proofRequired !== undefined) set("proof_required", b.proofRequired ? 1 : 0);
    if (b.actionUrl !== undefined) set("action_url", b.actionUrl && b.actionUrl.length > 0 ? b.actionUrl : null);
    if (b.icon !== undefined) set("icon", b.icon && b.icon.length > 0 ? b.icon : null);
    // Budgets: `null` clears the cap, a number sets it, absent leaves it.
    if (b.budgetConversions !== undefined) set("budget_conversions", b.budgetConversions);
    if (b.budgetPoints !== undefined) set("budget_points", b.budgetPoints);
    if (b.revenuePerConversionMicro !== undefined) {
      set("revenue_per_conversion_micro", b.revenuePerConversionMicro);
    }
    // ⚠️ RAISING A BUDGET ON AN EXHAUSTED CAMPAIGN REOPENS IT. Otherwise the one
    // action that fixes the problem — giving the campaign more room — leaves it
    // paused, and the Admin has to know to also flip the status back. The stamp
    // stays, so the record that it ran out once is not erased. If the new budget
    // is still under what has been spent, the next completion pauses it again.
    if (b.status === undefined && (b.budgetConversions !== undefined || b.budgetPoints !== undefined)) {
      const cur = await sql.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", id);
      if (cur?.status === EXHAUSTED) set("status", "active");
    }
    set("verify_mode", nextMode);
    set("postback_secret", secret);

    vals.push(id);
    await sql.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...vals);

    await logAudit({
      actorUserId: userId, actorRole: role, action: "custom_task_update",
      detail: `task ${id}: ${sets.map((s) => s.split(" = ")[0]).join(", ")}`,
    });
    return { ok: true };
  }));

  // ---- Reveal the postback URL + secret for a task ------------------------
  // Separate endpoint (not in the list) so the secret is fetched deliberately,
  // and every reveal is audit-logged.
  app.get("/staff/tasks/:id/postback", staffGuard("tasks.manage", async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    const t = await sql.get<{ postback_secret: string | null; verify_mode: string }>(
      "SELECT postback_secret, verify_mode FROM tasks WHERE id = ? AND source = 'custom'", id,
    );
    if (!t) return { ok: false, error: "not found" };
    if (t.verify_mode !== "postback" || !t.postback_secret) {
      return { ok: false, error: "this task is verified by staff approval, not a postback" };
    }
    await logAudit({
      actorUserId: userId, actorRole: role, action: "custom_task_secret_view", detail: `task ${id}`,
    });
    return {
      ok: true,
      taskId: id,
      secret: t.postback_secret,
      path: "/webhooks/custom/postback",
      // The signed string a partner must reproduce. Spelled out so it can be
      // copy-pasted into their integration without reading our source.
      signature: "hex(HMAC_SHA256(secret, `${task_id}.${user_id}.${txn_id}`))",
      params: ["task_id", "user_id", "txn_id", "sig"],
    };
  }));

  // ---- Proof review queue (any staff) -------------------------------------
  app.get("/staff/task-proofs", staffGuard("tasks.review", async (_ctx, req) => {
    const status = z.enum(["pending", "approved", "rejected"]).catch("pending")
      .parse((req.query as { status?: string })?.status);
    const proofs = await sql.all<Record<string, unknown>>(
      `SELECT p.id, p.task_id, p.user_id, p.proof_text, p.status, p.review_note, p.created_at,
              u.email AS user_email, t.title AS task_title, t.points AS task_points,
              t.proof_label
       FROM task_proofs p
       JOIN users u ON u.id = p.user_id
       JOIN tasks t ON t.id = p.task_id
       WHERE p.status = ? ORDER BY p.created_at ASC LIMIT 200`,
      status,
    );
    return { proofs };
  }));

  // ---- Approve / reject a proof -------------------------------------------
  app.post("/staff/task-proofs/:id/decision", staffGuard("tasks.review", async ({ userId, role }, req) => {
    const proofId = (req.params as { id: string }).id;
    const b = z.object({
      action: z.enum(["approve", "reject"]),
      note: z.string().max(500).optional(),
    }).parse(req.body ?? {});

    const proof = await sql.get<{
      id: string; task_id: string; user_id: string; status: string;
    }>("SELECT id, task_id, user_id, status FROM task_proofs WHERE id = ?", proofId);
    if (!proof) return { ok: false, error: "not found" };
    if (proof.status !== "pending") return { ok: false, error: "already reviewed" };

    if (b.action === "reject") {
      await sql.run(
        "UPDATE task_proofs SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
        b.note ?? null, userId, now(), proofId,
      );
      await logAudit({
        actorUserId: userId, actorRole: role, action: "task_proof_reject",
        targetUserId: proof.user_id, detail: `proof ${proofId}${b.note ? `: ${b.note}` : ""}`,
      });
      return { ok: true, status: "rejected" };
    }

    // APPROVE. Read the task's reward + this source's referral config, then run
    // the SHARED credit path. externalId ties the credit to the proof, so a
    // re-submission after this can't double-pay (idempotency on network+external_id).
    const task = await sql.get<{ points: number; status: string }>(
      "SELECT points, status FROM tasks WHERE id = ? AND source = 'custom'", proof.task_id,
    );
    if (!task) return { ok: false, error: "task missing" };
    if (task.status !== "active") return { ok: false, error: "task is disabled" };

    const net = await sql.get<NetworkRow>(
      `SELECT status, referral_bonus_pct, referral_bonus_pct_l2, referral_first_task_bonus, referral_bonus_days
       FROM networks WHERE id = ?`, CUSTOM_NETWORK,
    );

    const outcome = await creditCompletion({
      userId: proof.user_id, network: CUSTOM_NETWORK, externalId: `proof:${proofId}`,
      taskId: proof.task_id, points: task.points, offerType: "custom",
      payload: { proofId, approvedBy: userId },
      net,
      // A proof must NOT burn the external_id on a velocity block — see the field
      // doc on CreditRequest. The proof simply stays pending and can be approved
      // again once the user is back under their cap.
      recordRejection: false,
    }, app.log);

    if (outcome.status === "velocity_blocked") {
      // Leave the proof pending; tell the reviewer why nothing was credited.
      return { ok: false, error: `Blocked by a fraud cap (${outcome.detail}). The user is over their daily limit — try again later.` };
    }
    // The campaign ran out mid-queue. The proof stays PENDING (recordRejection
    // is false above, so nothing burned its external_id) — but unlike a velocity
    // block, waiting will not fix this one, so the message says so. Raising the
    // budget in the task editor makes the same proof approvable again.
    if (outcome.status === "budget_exhausted") {
      return {
        ok: false,
        error: `This campaign's budget is used up (${outcome.used} of ${outcome.cap} `
          + `${outcome.reason === "points" ? "points" : "conversions"}), so it has paused itself. `
          + "Raise its budget in Our own tasks to approve this.",
      };
    }
    if (outcome.status === "unknown_user") return { ok: false, error: "user not found" };
    if (outcome.status === "duplicate") {
      // Already credited (e.g. a double-click). Mark the proof approved to match.
      await sql.run(
        "UPDATE task_proofs SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
        b.note ?? "already credited", userId, now(), proofId,
      );
      return { ok: true, status: "approved", duplicate: true };
    }

    // Credited. Record the human decision on the proof.
    await sql.run(
      "UPDATE task_proofs SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
      b.note ?? null, userId, now(), proofId,
    );
    await logAudit({
      actorUserId: userId, actorRole: role, action: "task_proof_approve",
      targetUserId: proof.user_id, detail: `proof ${proofId} → ${outcome.points} pts`,
    });
    return { ok: true, status: "approved", credited: outcome.points };
  }));
}
