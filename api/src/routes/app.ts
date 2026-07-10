import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { db, balanceOf } from "../db.ts";
import { config } from "../config.ts";
import { getUserId } from "../auth.ts";

// Wraps a handler so a thrown {statusCode,message} becomes a clean JSON error.
function guard(
  handler: (userId: string, req: FastifyRequest, reply: FastifyReply) => unknown,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = getUserId(req);
      return await handler(userId, req, reply);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Something went wrong" });
    }
  };
}

type UserRow = { id: string; country: string; referral_code: string };

export async function appRoutes(app: FastifyInstance) {
  // Offer feed for the user's country
  app.get("/tasks", guard((userId) => {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow;
    const rows = db
      .prepare("SELECT * FROM tasks WHERE status = 'active' AND country = ? ORDER BY points DESC")
      .all(user.country) as Array<Record<string, unknown>>;
    return {
      tasks: rows.map((t) => ({
        id: t.id, type: t.type, title: t.title, points: t.points,
        network: t.network, advertiser: t.advertiser, minutes: t.minutes,
        requirement: t.requirement ?? undefined,
      })),
    };
  }));

  // Balance = SUM(ledger). Never a stored field.
  app.get("/wallet/balance", guard((userId) => ({
    points: balanceOf(userId),
    minWithdrawPoints: config.minWithdrawPoints,
  })));

  // Full ledger history for the user
  app.get("/wallet/ledger", guard((userId) => {
    const rows = db
      .prepare("SELECT * FROM ledger_entries WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as Array<Record<string, unknown>>;
    return {
      entries: rows.map((e) => ({
        id: e.id,
        label: (e.note as string) || labelFor(e.source_type as string),
        points: e.amount,
        // Settled ledger rows are done; pending/rejected live in
        // task_completions / withdrawal_requests (next slice).
        status: e.source_type === "withdrawal" ? "paid" : "earned",
        kind: kindFor(e.source_type as string),
        at: e.created_at,
      })),
    };
  }));

  // Referral earnings kept SEPARATE from task earnings (user story).
  app.get("/referrals/me", guard((userId) => {
    const user = db.prepare("SELECT referral_code FROM users WHERE id = ?").get(userId) as UserRow;
    const joined = (db
      .prepare("SELECT COUNT(*) AS n FROM referrals WHERE referrer_user_id = ?")
      .get(userId) as { n: number }).n;
    const earned = (db
      .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM ledger_entries WHERE user_id = ? AND source_type = 'referral_bonus'")
      .get(userId) as { s: number }).s;
    return { code: user.referral_code, joined, earnedPoints: earned };
  }));
}

function labelFor(source: string): string {
  switch (source) {
    case "task_completion": return "Task reward";
    case "referral_bonus": return "Referral bonus";
    case "withdrawal": return "Money sent";
    case "admin_adjustment": return "Adjustment";
    default: return "Points";
  }
}
function kindFor(source: string): string {
  if (source === "referral_bonus") return "referral";
  if (source === "withdrawal") return "withdrawal";
  return "task";
}
