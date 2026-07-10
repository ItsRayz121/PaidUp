import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { sql, now, balanceOf, postLedger } from "../db.ts";
import { config } from "../config.ts";
import { requireStaff, canApproveAmount, type Role } from "../roles.ts";

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
        payoutRail: r.payout_rail, status: r.status, at: r.created_at,
        withinAgentLimit: (r.amount as number) <= config.agentApprovalMaxPoints,
      })),
    };
  }));

  // Approve / reject / mark paid. Enforces the Agent->Manager threshold chain.
  app.post("/staff/withdrawals/:id/decision", staffGuard(["agent", "manager", "admin"], async ({ userId, role }, req, reply) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Pick approve, reject, or pay." });
    const { action, note } = parsed.data;

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
      const w = await t.get<{ id: string; user_id: string; amount: number; status: string }>(
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
      // In v1 payout is manual; the on-chain USDT send will happen here.
      const s = stampSql("paid", { paid_at: now() });
      await t.run(s.text, ...s.vals);
      return { ok: true, status: "paid" };
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
}
