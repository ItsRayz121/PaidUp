import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { sql, balanceOf } from "../db.ts";
import { config } from "../config.ts";
import { getUserId } from "../auth.ts";

// Wraps a handler so a thrown {statusCode,message} becomes a clean JSON error.
function guard(
  handler: (userId: string, req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown,
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
  app.get("/tasks", guard(async (userId) => {
    const user = (await sql.get<UserRow>("SELECT * FROM users WHERE id = ?", userId))!;
    const rows = await sql.all<Record<string, unknown>>(
      "SELECT * FROM tasks WHERE status = 'active' AND country = ? ORDER BY points DESC",
      user.country,
    );
    return {
      tasks: rows.map((t) => ({
        id: t.id, type: t.type, title: t.title, points: t.points,
        network: t.network, advertiser: t.advertiser, minutes: t.minutes,
        requirement: t.requirement ?? undefined,
      })),
    };
  }));

  // Balance = SUM(ledger). Never a stored field.
  app.get("/wallet/balance", guard(async (userId) => ({
    points: await balanceOf(userId),
    minWithdrawPoints: config.minWithdrawPoints,
  })));

  // Full ledger history for the user. A withdrawal's status comes from the
  // withdrawal_requests row (pending/paid/rejected) — NEVER hard-coded, or a
  // just-requested payout would falsely read as "paid".
  app.get("/wallet/ledger", guard(async (userId) => {
    const rows = await sql.all<Record<string, unknown>>(
      `SELECT le.*, w.status AS w_status
       FROM ledger_entries le
       LEFT JOIN withdrawal_requests w
         ON w.id = le.source_ref_id AND le.source_type = 'withdrawal'
       WHERE le.user_id = ? ORDER BY le.created_at DESC`,
      userId,
    );
    return {
      entries: rows.map((e) => ({
        id: e.id,
        label: (e.note as string) || labelFor(e.source_type as string),
        points: e.amount,
        status: statusFor(e.source_type as string, e.w_status as string | null),
        kind: kindFor(e.source_type as string),
        at: e.created_at,
      })),
    };
  }));

  // Referral earnings kept SEPARATE from task earnings (user story).
  app.get("/referrals/me", guard(async (userId) => {
    const user = (await sql.get<UserRow>("SELECT referral_code FROM users WHERE id = ?", userId))!;
    // ::int — Postgres returns COUNT()/SUM() of integers as bigint, i.e. a string.
    const joined = await sql.get<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM referrals WHERE referrer_user_id = ?", userId,
    );
    const earned = await sql.get<{ s: number }>(
      "SELECT COALESCE(SUM(amount),0)::int AS s FROM ledger_entries WHERE user_id = ? AND source_type = 'referral_bonus'",
      userId,
    );
    return { code: user.referral_code, joined: joined?.n ?? 0, earnedPoints: earned?.s ?? 0 };
  }));
}

// Display status for a ledger row. Withdrawals track their request; everything
// else is a settled credit ("earned").
function statusFor(source: string, withdrawalStatus: string | null): string {
  if (source !== "withdrawal") return "earned";
  if (withdrawalStatus === "paid") return "paid";
  if (withdrawalStatus === "rejected") return "rejected";
  return "pending"; // pending / agent_approved / manager_approved
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
