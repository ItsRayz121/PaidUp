import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { db, now, balanceOf, postLedger } from "../db.ts";
import { config } from "../config.ts";
import { requireStaff, canApproveAmount, type Role } from "../roles.ts";

function staffGuard(
  allowed: Role[],
  handler: (ctx: { userId: string; role: Role }, req: FastifyRequest, reply: FastifyReply) => unknown,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await handler(requireStaff(req, allowed), req, reply);
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
  app.get("/staff/withdrawals", staffGuard(["agent", "manager", "admin"], ({ role }, req) => {
    const status = (req.query as { status?: string }).status ?? "pending";
    let rows = db
      .prepare(
        `SELECT w.*, u.email AS user_email FROM withdrawal_requests w
         JOIN users u ON u.id = w.user_id WHERE w.status = ? ORDER BY w.created_at ASC`,
      )
      .all(status) as Array<Record<string, unknown>>;

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
  app.post("/staff/withdrawals/:id/decision", staffGuard(["agent", "manager", "admin"], ({ userId, role }, req, reply) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Pick approve, reject, or pay." });
    const { action, note } = parsed.data;

    const id = (req.params as { id: string }).id;
    const w = db.prepare("SELECT * FROM withdrawal_requests WHERE id = ?").get(id) as
      | { id: string; user_id: string; amount: number; status: string } | undefined;
    if (!w) return reply.code(404).send({ error: "Request not found." });
    if (w.status === "paid" || w.status === "rejected") {
      return reply.code(409).send({ error: `This request is already ${w.status}.` });
    }

    const stamp = (status: string, extra: Record<string, string> = {}) => {
      const cols = ["status = ?", "reviewed_by = ?", "reviewed_at = ?", "review_note = ?"];
      const vals: (string | null)[] = [status, userId, now(), note ?? null];
      for (const [k, v] of Object.entries(extra)) { cols.push(`${k} = ?`); vals.push(v); }
      db.prepare(`UPDATE withdrawal_requests SET ${cols.join(", ")} WHERE id = ?`).run(...vals, id);
    };

    if (action === "approve") {
      if (!canApproveAmount(role, w.amount)) {
        return reply.code(403).send({ error: "This is above your limit. A Manager must approve it." });
      }
      stamp(role === "agent" ? "agent_approved" : "manager_approved");
      return { ok: true, status: role === "agent" ? "agent_approved" : "manager_approved" };
    }

    if (action === "reject") {
      // Return the held points to the user (compensating credit — the ledger
      // stays append-only; we never delete the original debit).
      postLedger({
        userId: w.user_id, points: w.amount, direction: "credit",
        sourceType: "admin_adjustment", sourceRefId: id,
        note: "Withdrawal not approved — points returned",
      });
      stamp("rejected");
      return { ok: true, status: "rejected", refunded: w.amount };
    }

    // action === "pay"
    if (!READY.includes(w.status)) {
      return reply.code(409).send({ error: "Approve this request before marking it paid." });
    }
    if (!canApproveAmount(role, w.amount)) {
      return reply.code(403).send({ error: "This is above your limit. A Manager must pay it." });
    }
    // In v1 payout is manual; a real payout API call would happen here.
    stamp("paid", { paid_at: now() });
    return { ok: true, status: "paid" };
  }));

  // One-screen dispute view: user's balance, ledger, and fraud flags.
  app.get("/staff/users/:id", staffGuard(["agent", "manager", "admin"], (_ctx, req, reply) => {
    const id = (req.params as { id: string }).id;
    const user = db.prepare("SELECT id, email, country, referral_code, status, created_at FROM users WHERE id = ?").get(id) as
      | Record<string, unknown> | undefined;
    if (!user) return reply.code(404).send({ error: "User not found." });

    const ledger = db.prepare("SELECT amount, source_type, note, created_at FROM ledger_entries WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(id);
    const flags = db.prepare("SELECT flag_type, severity, detail, created_at, resolution_note FROM fraud_flags WHERE user_id = ? ORDER BY created_at DESC").all(id);

    return { user: { ...user, balancePoints: balanceOf(id) }, ledger, fraudFlags: flags };
  }));

  // Open fraud flags — managers/admins only.
  app.get("/staff/fraud", staffGuard(["manager", "admin"], () => {
    const flags = db.prepare(
      `SELECT f.*, u.email AS user_email FROM fraud_flags f
       LEFT JOIN users u ON u.id = f.user_id WHERE f.resolved_by IS NULL ORDER BY f.created_at DESC`,
    ).all();
    return { flags };
  }));
}
