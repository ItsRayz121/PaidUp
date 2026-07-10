import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { db, now, newId, balanceOf, postLedger } from "../db.ts";
import { config } from "../config.ts";
import { getUserId } from "../auth.ts";

function guard(handler: (userId: string, req: FastifyRequest, reply: FastifyReply) => unknown) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await handler(getUserId(req), req, reply);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Something went wrong" });
    }
  };
}

const createSchema = z.object({
  amountPoints: z.number().int().positive(),
  payoutRail: z.enum(["jazzcash", "easypaisa"]),
});

export async function withdrawalRoutes(app: FastifyInstance) {
  // Request a payout. We DEBIT the ledger now to hold the funds, so the same
  // points can't be withdrawn twice while the request is pending. A rejection
  // writes a compensating credit (see staff route).
  app.post("/withdrawals", guard((userId, req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter a valid amount and wallet." });
    const { amountPoints, payoutRail } = parsed.data;

    if (amountPoints < config.minWithdrawPoints) {
      return reply.code(400).send({
        error: `You need at least ${config.minWithdrawPoints} points to get money.`,
      });
    }
    if (amountPoints > balanceOf(userId)) {
      return reply.code(400).send({ error: "You do not have that many points yet." });
    }

    const id = newId();
    db.prepare(
      `INSERT INTO withdrawal_requests (id, user_id, amount, payout_rail, status, created_at)
       VALUES (?,?,?,?, 'pending', ?)`,
    ).run(id, userId, amountPoints, payoutRail, now());

    // Hold the funds.
    postLedger({
      userId, points: amountPoints, direction: "debit",
      sourceType: "withdrawal", sourceRefId: id, note: `Withdrawal to ${payoutRail}`,
    });

    return { request: { id, amount: amountPoints, payoutRail, status: "pending" } };
  }));

  // The user's own payout history.
  app.get("/withdrawals", guard((userId) => {
    const rows = db
      .prepare("SELECT * FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as Array<Record<string, unknown>>;
    return {
      requests: rows.map((r) => ({
        id: r.id, amount: r.amount, payoutRail: r.payout_rail,
        status: r.status, at: r.created_at, reviewNote: r.review_note ?? undefined,
        paidAt: r.paid_at ?? undefined,
      })),
    };
  }));
}
