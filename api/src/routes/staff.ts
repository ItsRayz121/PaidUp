import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { sql, now, newId, balanceOf, postLedger, logAudit, getSetting, setSetting } from "../db.ts";
import { config } from "../config.ts";
import { requireStaff, canApproveAmount, type Role } from "../roles.ts";
import { getPayoutProvider, pointsToUsdt } from "../payout.ts";
import { validateAddress, type ChainId } from "../chains.ts";

function staffGuard(
  allowed: Role[],
  handler: (ctx: { userId: string; role: Role }, req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await handler(await requireStaff(req, allowed), req, reply);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Something went wrong" });
    }
  };
}

const READY = ["agent_approved", "manager_approved"];
const decisionSchema = z.object({
  action: z.enum(["approve", "reject", "pay"]),
  note: z.string().max(500).optional(),
  // Manual payout: the on-chain hash of the USDT the staff member sent by hand.
  // Required to mark paid in manual mode; ignored when auto-send is on.
  txHash: z.string().max(120).optional(),
});

export async function staffRoutes(app: FastifyInstance) {
  // Withdrawal queue. Agents only see requests within their approval limit.
  app.get("/staff/withdrawals", staffGuard(["agent", "manager", "admin"], async ({ role }, req) => {
    const status = (req.query as { status?: string }).status ?? "pending";
    let rows = await sql.all<Record<string, unknown>>(
      `SELECT w.*, u.email AS user_email FROM withdrawal_requests w
       JOIN users u ON u.id = w.user_id WHERE w.status = ? ORDER BY w.created_at ASC`,
      status,
    );

    if (role === "agent") {
      rows = rows.filter((r) => (r.amount as number) <= config.agentApprovalMaxPoints);
    }
    return {
      // The hot wallet each chain's payouts are sent FROM (admin sets it in
      // Settings). Shown beside the queue so whoever is paying sends from the
      // right wallet. Public information once a payout has ever been made.
      treasury: {
        bep20: await getSetting("treasury_address_bep20", ""),
        base: await getSetting("treasury_address_base", ""),
        aptos: await getSetting("treasury_address_aptos", ""),
      },
      requests: rows.map((r) => ({
        id: r.id, userId: r.user_id, userEmail: r.user_email, amount: r.amount,
        chain: r.payout_rail, address: r.payout_address ?? null,
        status: r.status, at: r.created_at,
        withinAgentLimit: (r.amount as number) <= config.agentApprovalMaxPoints,
      })),
    };
  }));

  // Approve / reject / mark paid. Enforces the Agent->Manager threshold chain.
  app.post("/staff/withdrawals/:id/decision", staffGuard(["agent", "manager", "admin"], async ({ userId, role }, req, reply) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Pick approve, reject, or pay." });
    const { action, note, txHash } = parsed.data;

    const id = (req.params as { id: string }).id;

    const stampSql = (status: string, extra: Record<string, string> = {}) => {
      const cols = ["status = ?", "reviewed_by = ?", "reviewed_at = ?", "review_note = ?"];
      const vals: (string | null)[] = [status, userId, now(), note ?? null];
      for (const [k, v] of Object.entries(extra)) { cols.push(`${k} = ?`); vals.push(v); }
      return { text: `UPDATE withdrawal_requests SET ${cols.join(", ")} WHERE id = ?`, vals: [...vals, id] };
    };

    // The whole decision runs in one transaction that locks the request row
    // (FOR UPDATE). Two staff acting on the same request at once serialize: the
    // second waits, then re-reads the status the first set and bails — so a
    // reject can never refund twice. staffGuard maps a thrown {statusCode} to
    // JSON, so throwing here rolls the transaction back cleanly.
    return await sql.tx(async (t) => {
      const w = await t.get<{ id: string; user_id: string; amount: number; status: string; payout_rail: string; payout_address: string; fee_points: number }>(
        "SELECT * FROM withdrawal_requests WHERE id = ? FOR UPDATE", id,
      );
      if (!w) throw { statusCode: 404, message: "Request not found." };
      if (w.status === "paid" || w.status === "rejected") {
        throw { statusCode: 409, message: `This request is already ${w.status}.` };
      }

      if (action === "approve") {
        if (!canApproveAmount(role, w.amount)) {
          throw { statusCode: 403, message: "This is above your limit. A Manager must approve it." };
        }
        const status = role === "agent" ? "agent_approved" : "manager_approved";
        const s = stampSql(status);
        await t.run(s.text, ...s.vals);
        return { ok: true, status };
      }

      if (action === "reject") {
        // Return the held points to the user (compensating credit — the ledger
        // stays append-only; we never delete the original debit).
        await postLedger({
          userId: w.user_id, points: w.amount, direction: "credit",
          sourceType: "admin_adjustment", sourceRefId: id,
          note: "Withdrawal not approved — points returned",
        }, t);
        const s = stampSql("rejected");
        await t.run(s.text, ...s.vals);
        return { ok: true, status: "rejected", refunded: w.amount };
      }

      // action === "pay"
      if (!READY.includes(w.status)) {
        throw { statusCode: 409, message: "Approve this request before marking it paid." };
      }
      if (!canApproveAmount(role, w.amount)) {
        throw { statusCode: 403, message: "This is above your limit. A Manager must pay it." };
      }
      // Settle the payout: manual mode records the hash the staff member sent by
      // hand; onchain mode (when enabled + tested) signs and broadcasts here.
      // The USDT amount is on the NET (amount minus the fee snapshotted at
      // request time), derived from one conversion rule, and stored alongside the
      // on-chain hash as proof of payment.
      const net = Math.max(0, w.amount - (w.fee_points ?? 0));
      const usdt = pointsToUsdt(net);
      const provider = getPayoutProvider();
      const result = await provider.send({
        requestId: w.id,
        chain: w.payout_rail as ChainId,
        address: w.payout_address,
        points: net,
        usdt,
        providedTxHash: txHash,
      });
      const s = stampSql("paid", { paid_at: now(), tx_hash: result.txHash, usdt_amount: usdt });
      await t.run(s.text, ...s.vals);
      return { ok: true, status: "paid", txHash: result.txHash, usdt };
    });
  }));

  // One-screen dispute view: user's balance, ledger, and fraud flags.
  app.get("/staff/users/:id", staffGuard(["agent", "manager", "admin"], async (_ctx, req, reply) => {
    const id = (req.params as { id: string }).id;
    const user = await sql.get<Record<string, unknown>>(
      "SELECT id, email, country, referral_code, status, created_at FROM users WHERE id = ?", id,
    );
    if (!user) return reply.code(404).send({ error: "User not found." });

    const ledger = await sql.all("SELECT amount, source_type, note, created_at FROM ledger_entries WHERE user_id = ? ORDER BY created_at DESC LIMIT 100", id);
    const flags = await sql.all("SELECT flag_type, severity, detail, created_at, resolution_note FROM fraud_flags WHERE user_id = ? ORDER BY created_at DESC", id);

    return { user: { ...user, balancePoints: await balanceOf(id) }, ledger, fraudFlags: flags };
  }));

  // Open fraud flags — managers/admins only.
  app.get("/staff/fraud", staffGuard(["manager", "admin"], async () => {
    const flags = await sql.all(
      `SELECT f.*, u.email AS user_email FROM fraud_flags f
       LEFT JOIN users u ON u.id = f.user_id WHERE f.resolved_by IS NULL ORDER BY f.created_at DESC`,
    );
    return { flags };
  }));

  // Resolve a flag (managers/admins). Append-only spirit: we don't delete, we
  // stamp who cleared it and why, leaving the trail (docs/ARCHITECTURE.md).
  app.post("/staff/fraud/:id/resolve", staffGuard(["manager", "admin"], async ({ userId }, req, reply) => {
    const note = (req.body as { note?: string })?.note;
    const id = (req.params as { id: string }).id;
    const res = await sql.run(
      "UPDATE fraud_flags SET resolved_by = ?, resolution_note = ? WHERE id = ? AND resolved_by IS NULL",
      userId, note ?? null, id,
    );
    if (!res.rowCount) return reply.code(404).send({ error: "Flag not found or already resolved." });
    return { ok: true };
  }));

  // ---- Admin: ad-network config ------------------------------------------
  // Commission split + referral bonus live here, never in code (guardrail /
  // docs/ARCHITECTURE.md § Commission split). Admin can disable a network,
  // which stops its postbacks crediting and hides its offers, with no redeploy.
  const networkPatchSchema = z.object({
    status: z.enum(["active", "disabled"]).optional(),
    commissionSplitPct: z.number().int().min(0).max(100).optional(),
    referralBonusPct: z.number().int().min(0).max(100).optional(),
    // Level-2 (indirect) referral share. 0 turns the second level off.
    referralBonusPctL2: z.number().int().min(0).max(100).optional(),
    // Flat one-time bonus (points) when an invited user finishes their 1st task.
    referralFirstTaskBonus: z.number().int().min(0).max(1_000_000).optional(),
    // Referral window in days (0 = lifetime). Up to ~10 years.
    referralBonusDays: z.number().int().min(0).max(3650).optional(),
  });

  app.get("/staff/networks", staffGuard(["admin"], async () => {
    const rows = await sql.all<Record<string, unknown>>(
      `SELECT n.*,
         (SELECT COUNT(*)::int FROM tasks t WHERE t.network = n.id) AS task_count,
         (SELECT COUNT(*)::int FROM task_completions c WHERE c.network = n.id AND c.status = 'credited') AS credited_count
       FROM networks n ORDER BY n.type, n.name`,
    );
    return {
      networks: rows.map((n) => ({
        id: n.id, name: n.name, type: n.type, status: n.status,
        commissionSplitPct: n.commission_split_pct, referralBonusPct: n.referral_bonus_pct,
        referralBonusPctL2: n.referral_bonus_pct_l2, referralFirstTaskBonus: n.referral_first_task_bonus,
        referralBonusDays: n.referral_bonus_days,
        taskCount: n.task_count, creditedCount: n.credited_count, updatedAt: n.updated_at,
      })),
    };
  }));

  app.patch("/staff/networks/:id", staffGuard(["admin"], async (_ctx, req, reply) => {
    const parsed = networkPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter a valid status or a split between 0 and 100." });
    const id = (req.params as { id: string }).id;

    const cols: string[] = [];
    const vals: unknown[] = [];
    if (parsed.data.status !== undefined) { cols.push("status = ?"); vals.push(parsed.data.status); }
    if (parsed.data.commissionSplitPct !== undefined) { cols.push("commission_split_pct = ?"); vals.push(parsed.data.commissionSplitPct); }
    if (parsed.data.referralBonusPct !== undefined) { cols.push("referral_bonus_pct = ?"); vals.push(parsed.data.referralBonusPct); }
    if (parsed.data.referralBonusPctL2 !== undefined) { cols.push("referral_bonus_pct_l2 = ?"); vals.push(parsed.data.referralBonusPctL2); }
    if (parsed.data.referralFirstTaskBonus !== undefined) { cols.push("referral_first_task_bonus = ?"); vals.push(parsed.data.referralFirstTaskBonus); }
    if (parsed.data.referralBonusDays !== undefined) { cols.push("referral_bonus_days = ?"); vals.push(parsed.data.referralBonusDays); }
    if (!cols.length) return reply.code(400).send({ error: "Nothing to change." });
    cols.push("updated_at = ?"); vals.push(now());

    const res = await sql.run(`UPDATE networks SET ${cols.join(", ")} WHERE id = ?`, ...vals, id);
    if (!res.rowCount) return reply.code(404).send({ error: "Network not found." });
    return { ok: true };
  }));

  // ---- Admin: global settings (withdrawal fee + treasury wallet) ----------
  // The treasury wallet is the HOT WALLET: the founder funds it with USDT, and
  // every manual payout is sent FROM it. One address per chain, stored in
  // app_settings. Display/reference only — the API never holds a private key
  // for these addresses (on-chain auto-send has its own env-gated signer, see
  // payout.ts), so a leaked admin session cannot move treasury funds from here.
  app.get("/staff/settings", staffGuard(["admin"], async () => ({
    withdrawalFeePoints: Number(await getSetting("withdrawal_fee_points", "0")) || 0,
    treasury: {
      bep20: await getSetting("treasury_address_bep20", ""),
      base: await getSetting("treasury_address_base", ""),
      aptos: await getSetting("treasury_address_aptos", ""),
    },
  })));

  const settingsSchema = z.object({
    // Flat fee (points) taken out of every withdrawal. 0 = no fee.
    withdrawalFeePoints: z.number().int().min(0).max(1_000_000).optional(),
    // Treasury (hot wallet) address per chain. Empty string clears it.
    treasury: z.object({
      bep20: z.string().trim().max(120).optional(),
      base: z.string().trim().max(120).optional(),
      aptos: z.string().trim().max(120).optional(),
    }).optional(),
  });
  app.patch("/staff/settings", staffGuard(["admin"], async ({ userId, role }, req, reply) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Check the values and try again." });

    if (parsed.data.withdrawalFeePoints !== undefined) {
      await setSetting("withdrawal_fee_points", String(parsed.data.withdrawalFeePoints));
    }
    if (parsed.data.treasury) {
      for (const [chain, address] of Object.entries(parsed.data.treasury)) {
        if (address === undefined) continue;
        // Same validator users' payout addresses go through — a typo'd treasury
        // address on the staff screen would misdirect every manual payout.
        if (address !== "") {
          const check = validateAddress(chain as ChainId, address);
          if (!check.ok) return reply.code(400).send({ error: `${chain}: ${check.error}` });
        }
        await setSetting(`treasury_address_${chain}`, address);
        // A treasury address swap is exactly what an attacker with a stolen
        // admin session would do (payouts start flowing to THEIR wallet), so
        // every change lands in the append-only audit log.
        await logAudit({
          actorUserId: userId, actorRole: role, action: "treasury_address_change",
          detail: `${chain} -> ${address || "(cleared)"}`,
        });
      }
    }
    return { ok: true };
  }));

  // ---- Agent: support tickets --------------------------------------------
  app.get("/staff/tickets", staffGuard(["agent", "manager", "admin"], async (_ctx, req) => {
    const status = (req.query as { status?: string }).status ?? "open";
    const rows = await sql.all<Record<string, unknown>>(
      `SELECT ti.*, u.email AS user_email,
         (SELECT COUNT(*)::int FROM ticket_messages m WHERE m.ticket_id = ti.id) AS message_count
       FROM support_tickets ti JOIN users u ON u.id = ti.user_id
       WHERE ti.status = ? ORDER BY ti.updated_at ASC`,
      status,
    );
    return {
      tickets: rows.map((t) => ({
        id: t.id, userId: t.user_id, userEmail: t.user_email, subject: t.subject,
        status: t.status, messageCount: t.message_count, at: t.created_at, updatedAt: t.updated_at,
      })),
    };
  }));

  app.get("/staff/tickets/:id", staffGuard(["agent", "manager", "admin"], async (_ctx, req, reply) => {
    const id = (req.params as { id: string }).id;
    const ticket = await sql.get<Record<string, unknown>>(
      `SELECT ti.*, u.email AS user_email FROM support_tickets ti
       JOIN users u ON u.id = ti.user_id WHERE ti.id = ?`, id,
    );
    if (!ticket) return reply.code(404).send({ error: "Ticket not found." });
    const messages = await sql.all(
      "SELECT id, author_role, body, created_at FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC", id,
    );
    return {
      ticket: {
        id: ticket.id, userId: ticket.user_id, userEmail: ticket.user_email,
        subject: ticket.subject, status: ticket.status, at: ticket.created_at,
      },
      messages,
    };
  }));

  const replySchema = z.object({
    message: z.string().min(1).max(2000),
    close: z.boolean().optional(),
  });
  app.post("/staff/tickets/:id/reply", staffGuard(["agent", "manager", "admin"], async ({ userId }, req, reply) => {
    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Type a reply first." });
    const id = (req.params as { id: string }).id;

    const ticket = await sql.get<{ id: string }>("SELECT id FROM support_tickets WHERE id = ?", id);
    if (!ticket) return reply.code(404).send({ error: "Ticket not found." });

    await sql.tx(async (t) => {
      await t.run(
        "INSERT INTO ticket_messages (id, ticket_id, author_role, author_id, body, created_at) VALUES (?,?, 'staff', ?,?,?)",
        newId(), id, userId, parsed.data.message, now(),
      );
      await t.run(
        "UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?",
        parsed.data.close ? "closed" : "answered", now(), id,
      );
    });
    return { ok: true };
  }));

  // ---- Manager: KPI dashboard --------------------------------------------
  // All figures derived from the ledger and request tables — no stored
  // aggregates to drift out of sync (guardrail #2 in spirit).
  app.get("/staff/kpis", staffGuard(["manager", "admin"], async () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);

    const one = async (text: string, ...params: unknown[]) =>
      (await sql.get<{ v: number }>(text, ...params))?.v ?? 0;

    const [
      totalUsers, newUsers7d, pendingCount, pendingPoints,
      paidCount7d, paidPoints7d, paidPointsAll,
      taskPointsAll, referralPointsAll, completionsToday,
      openFraud, openTickets,
    ] = await Promise.all([
      one("SELECT COUNT(*)::int AS v FROM users WHERE email_verified = 1"),
      one("SELECT COUNT(*)::int AS v FROM users WHERE email_verified = 1 AND created_at >= ?", sevenDaysAgo),
      one("SELECT COUNT(*)::int AS v FROM withdrawal_requests WHERE status IN ('pending','agent_approved','manager_approved')"),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM withdrawal_requests WHERE status IN ('pending','agent_approved','manager_approved')"),
      one("SELECT COUNT(*)::int AS v FROM withdrawal_requests WHERE status = 'paid' AND paid_at >= ?", sevenDaysAgo),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM withdrawal_requests WHERE status = 'paid' AND paid_at >= ?", sevenDaysAgo),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM withdrawal_requests WHERE status = 'paid'"),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM ledger_entries WHERE source_type = 'task_completion'"),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM ledger_entries WHERE source_type = 'referral_bonus'"),
      one("SELECT COUNT(*)::int AS v FROM task_completions WHERE status = 'credited' AND created_at >= ?", startOfToday.toISOString()),
      one("SELECT COUNT(*)::int AS v FROM fraud_flags WHERE resolved_by IS NULL"),
      one("SELECT COUNT(*)::int AS v FROM support_tickets WHERE status != 'closed'"),
    ]);

    // 7-day activity series (completions + points credited per day). Reads points
    // off the completion itself, so dynamic-amount networks (CPX surveys, which
    // have no task row) are included too.
    const series = await sql.all<{ day: string; completions: number; points: number }>(
      `SELECT to_char(created_at::timestamp, 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS completions,
              COALESCE(SUM(COALESCE(points,0)),0)::int AS points
       FROM task_completions
       WHERE status = 'credited' AND created_at >= ?
       GROUP BY day ORDER BY day ASC`,
      sevenDaysAgo,
    );

    return {
      users: { total: totalUsers, new7d: newUsers7d },
      withdrawals: { pendingCount, pendingPoints, paidCount7d, paidPoints7d, paidPointsAll },
      earning: { taskPointsAll, referralPointsAll, completionsToday },
      risk: { openFraud, openTickets },
      series,
    };
  }));

  // ==========================================================================
  // SUPER-ADMIN capabilities. `admin` was always the top role, but it had no
  // tools: no way to find a user, credit one, suspend one, or appoint staff.
  // ==========================================================================

  // ---- Admin: find users --------------------------------------------------
  // Search by email or id. Balance is summed from the ledger, never stored.
  app.get("/staff/users", staffGuard(["manager", "admin"], async (_ctx, req) => {
    const q = ((req.query as { q?: string }).q ?? "").trim().toLowerCase();
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 50) || 50, 200);

    const rows = await sql.all<{ id: string; email: string; country: string; status: string; created_at: string; balance: number }>(
      `SELECT u.id, u.email, u.country, u.status, u.created_at,
              COALESCE((SELECT SUM(amount) FROM ledger_entries l WHERE l.user_id = u.id), 0)::int AS balance
       FROM users u
       WHERE (? = '' OR LOWER(u.email) LIKE ? OR LOWER(u.id) = ?)
       ORDER BY u.created_at DESC
       LIMIT ?`,
      q, `%${q}%`, q, limit,
    );
    return { users: rows };
  }));

  // ---- Admin: suspend / restore an account --------------------------------
  // Enforced for real: every earner route re-checks users.status on each call
  // (see requireActiveUser), so an already-issued JWT stops working immediately.
  const statusSchema = z.object({
    status: z.enum(["active", "suspended"]),
    reason: z.string().trim().min(3, "Say why.").max(500),
  });
  app.post("/staff/users/:id/status", staffGuard(["admin"], async ({ userId: actorId, role }, req, reply) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Pick a status and give a reason." });
    const targetId = (req.params as { id: string }).id;

    const target = await sql.get<{ id: string; status: string }>("SELECT id, status FROM users WHERE id = ?", targetId);
    if (!target) return reply.code(404).send({ error: "User not found." });

    // Locking yourself out of your own product is a bad afternoon.
    if (targetId === actorId && parsed.data.status === "suspended") {
      return reply.code(400).send({ error: "You cannot suspend your own account." });
    }

    await sql.tx(async (t) => {
      await t.run("UPDATE users SET status = ? WHERE id = ?", parsed.data.status, targetId);
      await logAudit({
        actorUserId: actorId, actorRole: role,
        action: parsed.data.status === "suspended" ? "user_suspended" : "user_restored",
        targetUserId: targetId, detail: parsed.data.reason,
      }, t);
    });
    return { ok: true, status: parsed.data.status };
  }));

  // ---- Admin: adjust a user's points by hand ------------------------------
  // This MINTS MONEY. Points are redeemable for real USDT, so a credit here is a
  // withdrawal from the treasury with extra steps. Constraints, all deliberate:
  //   - admin only (not manager, not agent)
  //   - a written reason is mandatory — it lands in the user's own ledger note
  //   - capped per adjustment (config.adminAdjustMaxPoints) so one stolen session
  //     or one extra zero cannot drain the treasury in a single call
  //   - written through postLedger, so it is an append-only entry like every
  //     other movement (guardrail #2) — never a mutable balance edit
  //   - a debit cannot push a user below zero
  //   - recorded in admin_audit_log against the staff member who did it
  const adjustSchema = z.object({
    points: z.number().int().refine((n) => n !== 0, "Enter a non-zero amount."),
    reason: z.string().trim().min(3, "Say why.").max(500),
  });
  app.post("/staff/users/:id/adjust", staffGuard(["admin"], async ({ userId: actorId, role }, req, reply) => {
    const parsed = adjustSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Enter an amount (not zero) and a reason." });
    }
    const { points, reason } = parsed.data;
    const targetId = (req.params as { id: string }).id;

    if (Math.abs(points) > config.adminAdjustMaxPoints) {
      return reply.code(400).send({
        error: `One adjustment cannot be more than ${config.adminAdjustMaxPoints} points.`,
      });
    }

    const target = await sql.get<{ id: string }>("SELECT id FROM users WHERE id = ?", targetId);
    if (!target) return reply.code(404).send({ error: "User not found." });

    const result = await sql.tx(async (t) => {
      // Lock the row so a concurrent withdrawal can't race a debit past zero.
      await t.run("SELECT pg_advisory_xact_lock(hashtext(?))", targetId);
      const before = await balanceOf(targetId, t);
      if (points < 0 && before + points < 0) {
        throw { statusCode: 400, message: `That would take the balance below zero (they have ${before}).` };
      }
      const entryId = await postLedger({
        userId: targetId,
        points: Math.abs(points),
        direction: points > 0 ? "credit" : "debit",
        sourceType: "admin_adjustment",
        note: reason,
      }, t);
      await logAudit({
        actorUserId: actorId, actorRole: role, action: "points_adjusted",
        targetUserId: targetId,
        detail: `${points > 0 ? "+" : ""}${points} points — ${reason}`,
      }, t);
      return { entryId, before, after: before + points };
    });
    return { ok: true, ...result };
  }));

  // ---- Admin: appoint / remove staff --------------------------------------
  app.get("/staff/staff", staffGuard(["admin"], async () => {
    const rows = await sql.all<{ user_id: string; email: string; role: Role; created_at: string }>(
      `SELECT a.user_id, u.email, a.role, a.created_at
       FROM admin_users a JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at ASC`,
    );
    return { staff: rows.map((r) => ({ userId: r.user_id, email: r.email, role: r.role, at: r.created_at })) };
  }));

  const roleSchema = z.object({ role: z.enum(["agent", "manager", "admin", "none"]) });
  app.put("/staff/staff/:id", staffGuard(["admin"], async ({ userId: actorId, role: actorRole }, req, reply) => {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Pick a role." });
    const targetId = (req.params as { id: string }).id;
    const next = parsed.data.role;

    const target = await sql.get<{ id: string }>("SELECT id FROM users WHERE id = ?", targetId);
    if (!target) return reply.code(404).send({ error: "User not found." });

    // Lockout protection: never let the last admin demote or remove themselves.
    // Without this, one click can leave the product with no one who can appoint
    // anyone — recoverable only by editing the database by hand.
    if (next !== "admin") {
      const admins = await sql.get<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM admin_users WHERE role = 'admin'",
      );
      const targetIsAdmin = await sql.get<{ role: Role }>(
        "SELECT role FROM admin_users WHERE user_id = ?", targetId,
      );
      if (targetIsAdmin?.role === "admin" && (admins?.n ?? 0) <= 1) {
        return reply.code(400).send({ error: "This is the last admin. Appoint another admin first." });
      }
    }

    await sql.tx(async (t) => {
      if (next === "none") {
        await t.run("DELETE FROM admin_users WHERE user_id = ?", targetId);
      } else {
        await t.run(
          "INSERT INTO admin_users (user_id, role, created_at) VALUES (?,?,?) " +
          "ON CONFLICT(user_id) DO UPDATE SET role = EXCLUDED.role",
          targetId, next, now(),
        );
      }
      await logAudit({
        actorUserId: actorId, actorRole,
        action: next === "none" ? "staff_removed" : "staff_role_set",
        targetUserId: targetId, detail: next,
      }, t);
    });
    return { ok: true, role: next };
  }));

  // ---- Admin: the money view ----------------------------------------------
  // Every figure is derived from the ledger, so it cannot drift from reality.
  // `outstanding` is the liability that matters: points users hold that they can
  // still cash out. Compare it against the treasury before you spend.
  app.get("/staff/money", staffGuard(["admin"], async () => {
    const one = async (text: string, ...p: unknown[]) =>
      (await sql.get<{ v: number }>(text, ...p))?.v ?? 0;

    const [credited, debited, paidPoints, pendingPoints, feePoints, adjustments] = await Promise.all([
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM ledger_entries WHERE amount > 0"),
      one("SELECT COALESCE(SUM(-amount),0)::int AS v FROM ledger_entries WHERE amount < 0"),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM withdrawal_requests WHERE status = 'paid'"),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM withdrawal_requests WHERE status IN ('pending','agent_approved','manager_approved')"),
      one("SELECT COALESCE(SUM(COALESCE(fee_points,0)),0)::int AS v FROM withdrawal_requests WHERE status = 'paid'"),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM ledger_entries WHERE source_type = 'admin_adjustment'"),
    ]);

    const recentAudit = await sql.all(
      `SELECT a.action, a.detail, a.created_at, a.actor_role,
              actor.email AS actor_email, target.email AS target_email
       FROM admin_audit_log a
       JOIN users actor ON actor.id = a.actor_user_id
       LEFT JOIN users target ON target.id = a.target_user_id
       ORDER BY a.created_at DESC LIMIT 50`,
    );

    return {
      points: {
        credited, debited, adjustments,
        outstanding: credited - debited, // live user liability
        paidPoints, pendingPoints, feePoints,
      },
      usdt: {
        outstanding: pointsToUsdt(credited - debited),
        paid: pointsToUsdt(paidPoints),
        pending: pointsToUsdt(pendingPoints),
      },
      recentAudit,
    };
  }));

  // ---- Admin: CSV export --------------------------------------------------
  // Quotes are doubled per RFC 4180 so a comma or quote in an email or a
  // free-text reason cannot shift columns.
  //
  // A leading = + - @ (or tab/CR) makes Excel treat the cell as a FORMULA, and
  // RFC quoting does not stop that — Excel strips the quotes first. Some of
  // these fields are user-supplied (emails), so prefix those cells with a single
  // quote, which Excel renders as plain text.
  const csv = (rows: Record<string, unknown>[]): string => {
    if (!rows.length) return "";
    const cols = Object.keys(rows[0]);
    const cell = (v: unknown) => {
      const s = String(v ?? "");
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
  };

  app.get("/staff/export/:what", staffGuard(["admin"], async (_ctx, req, reply) => {
    const what = (req.params as { what: string }).what;
    let rows: Record<string, unknown>[];

    if (what === "ledger") {
      rows = await sql.all(
        `SELECT l.created_at, u.email, l.amount, l.direction, l.source_type, l.note
         FROM ledger_entries l JOIN users u ON u.id = l.user_id
         ORDER BY l.created_at DESC LIMIT 10000`,
      );
    } else if (what === "withdrawals") {
      rows = await sql.all(
        `SELECT w.created_at, u.email, w.amount, w.fee_points, w.payout_rail, w.payout_address,
                w.status, w.tx_hash, w.paid_at
         FROM withdrawal_requests w JOIN users u ON u.id = w.user_id
         ORDER BY w.created_at DESC LIMIT 10000`,
      );
    } else if (what === "audit") {
      rows = await sql.all(
        `SELECT a.created_at, actor.email AS actor, a.actor_role, a.action,
                target.email AS target, a.detail
         FROM admin_audit_log a
         JOIN users actor ON actor.id = a.actor_user_id
         LEFT JOIN users target ON target.id = a.target_user_id
         ORDER BY a.created_at DESC LIMIT 10000`,
      );
    } else {
      return reply.code(404).send({ error: "Unknown export." });
    }

    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${what}.csv"`)
      .send(csv(rows));
  }));
}
