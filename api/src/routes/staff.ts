import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { sql, now, newId, balanceOf, postLedger, getSetting, setSetting } from "../db.ts";
import { config } from "../config.ts";
import { requireStaff, canApproveAmount, type Role } from "../roles.ts";
import { getPayoutProvider, pointsToUsdt } from "../payout.ts";
import type { ChainId } from "../chains.ts";

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

  // ---- Admin: global settings (withdrawal fee) ---------------------------
  app.get("/staff/settings", staffGuard(["admin"], async () => ({
    withdrawalFeePoints: Number(await getSetting("withdrawal_fee_points", "0")) || 0,
  })));

  const settingsSchema = z.object({
    // Flat fee (points) taken out of every withdrawal. 0 = no fee.
    withdrawalFeePoints: z.number().int().min(0).max(1_000_000),
  });
  app.patch("/staff/settings", staffGuard(["admin"], async (_ctx, req, reply) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter a fee of 0 or more points." });
    await setSetting("withdrawal_fee_points", String(parsed.data.withdrawalFeePoints));
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

    // 7-day activity series (completions + points credited per day).
    const series = await sql.all<{ day: string; completions: number; points: number }>(
      `SELECT to_char(created_at::timestamp, 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS completions,
              COALESCE(SUM(points),0)::int AS points
       FROM (
         SELECT tc.created_at, t.points
         FROM task_completions tc JOIN tasks t ON t.id = tc.task_id
         WHERE tc.status = 'credited' AND tc.created_at >= ?
       ) x
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
}
