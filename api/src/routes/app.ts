import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { sql, now, newId, balanceOf, getSetting } from "../db.ts";
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
    // Hide offers from a network the Admin has disabled. A task whose network
    // has no row yet (predates the networks table) still shows — absence = active.
    const rows = await sql.all<Record<string, unknown>>(
      `SELECT t.* FROM tasks t
       LEFT JOIN networks n ON n.id = t.network
       WHERE t.status = 'active' AND t.country = ?
         AND (n.status IS NULL OR n.status = 'active')
       ORDER BY t.points DESC`,
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

  // Balance = SUM(ledger). Never a stored field. Also returns the current
  // withdrawal fee (points) so the withdraw screen can show fee + net.
  app.get("/wallet/balance", guard(async (userId) => ({
    points: await balanceOf(userId),
    minWithdrawPoints: config.minWithdrawPoints,
    withdrawalFeePoints: Number(await getSetting("withdrawal_fee_points", "0")) || 0,
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

  // ---- Leaderboard --------------------------------------------------------
  // Social proof + friendly competition to drive referrals (founder request).
  // Two boards: top EARNERS (most points earned from tasks + referrals) and top
  // REFERRERS (most points earned from their invites). Names are masked for
  // privacy; the caller's own row is flagged so the UI can highlight it.
  app.get("/leaderboard", guard(async (userId) => {
    const LIMIT = 20;
    const earners = await sql.all<{ id: string; email: string; earned: number }>(
      `SELECT u.id, u.email,
              COALESCE(SUM(CASE WHEN le.source_type IN ('task_completion','referral_bonus')
                                 AND le.amount > 0 THEN le.amount ELSE 0 END),0)::int AS earned
       FROM users u JOIN ledger_entries le ON le.user_id = u.id
       WHERE u.email_verified = 1
       GROUP BY u.id, u.email
       HAVING SUM(CASE WHEN le.source_type IN ('task_completion','referral_bonus')
                        AND le.amount > 0 THEN le.amount ELSE 0 END) > 0
       ORDER BY earned DESC, u.created_at ASC
       LIMIT ${LIMIT}`,
    );
    const referrers = await sql.all<{ id: string; email: string; ref_points: number; invites: number }>(
      `SELECT u.id, u.email,
              COALESCE(SUM(le.amount),0)::int AS ref_points,
              (SELECT COUNT(*)::int FROM referrals r WHERE r.referrer_user_id = u.id) AS invites
       FROM users u JOIN ledger_entries le ON le.user_id = u.id AND le.source_type = 'referral_bonus'
       GROUP BY u.id, u.email
       HAVING SUM(le.amount) > 0
       ORDER BY ref_points DESC, u.created_at ASC
       LIMIT ${LIMIT}`,
    );
    return {
      topEarners: earners.map((r, i) => ({
        rank: i + 1, name: maskName(r.email), points: r.earned, isMe: r.id === userId,
      })),
      topReferrers: referrers.map((r, i) => ({
        rank: i + 1, name: maskName(r.email), points: r.ref_points, invites: r.invites, isMe: r.id === userId,
      })),
    };
  }));

  // ---- Support: earner-facing help tickets --------------------------------
  // Simple English, one screen. A ticket is a subject + a thread of messages;
  // staff answer from the Agent queue.
  const newTicketSchema = z.object({
    subject: z.string().min(1).max(120),
    message: z.string().min(1).max(2000),
  });
  app.post("/support/tickets", guard(async (userId, req, reply) => {
    const parsed = newTicketSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Add a short subject and your message." });
    const id = newId();
    await sql.tx(async (t) => {
      await t.run(
        "INSERT INTO support_tickets (id, user_id, subject, status, created_at, updated_at) VALUES (?,?,?, 'open', ?, ?)",
        id, userId, parsed.data.subject, now(), now(),
      );
      await t.run(
        "INSERT INTO ticket_messages (id, ticket_id, author_role, author_id, body, created_at) VALUES (?,?, 'user', ?,?,?)",
        newId(), id, userId, parsed.data.message, now(),
      );
    });
    return { ticket: { id, subject: parsed.data.subject, status: "open" } };
  }));

  // My tickets, newest first, each with its full message thread.
  app.get("/support/tickets", guard(async (userId) => {
    const tickets = await sql.all<Record<string, unknown>>(
      "SELECT id, subject, status, created_at, updated_at FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC",
      userId,
    );
    const out = [];
    for (const t of tickets) {
      const messages = await sql.all(
        "SELECT author_role, body, created_at FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC",
        t.id,
      );
      out.push({ id: t.id, subject: t.subject, status: t.status, at: t.created_at, updatedAt: t.updated_at, messages });
    }
    return { tickets: out };
  }));

  // Add a message to my own ticket (reopens it so staff see it again).
  const replySchema = z.object({ message: z.string().min(1).max(2000) });
  app.post("/support/tickets/:id/messages", guard(async (userId, req, reply) => {
    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Type your message first." });
    const id = (req.params as { id: string }).id;
    // Ownership check — a user may only post to their own ticket.
    const ticket = await sql.get<{ id: string }>("SELECT id FROM support_tickets WHERE id = ? AND user_id = ?", id, userId);
    if (!ticket) return reply.code(404).send({ error: "Ticket not found." });
    await sql.tx(async (t) => {
      await t.run(
        "INSERT INTO ticket_messages (id, ticket_id, author_role, author_id, body, created_at) VALUES (?,?, 'user', ?,?,?)",
        newId(), id, userId, parsed.data.message, now(),
      );
      await t.run("UPDATE support_tickets SET status = 'open', updated_at = ? WHERE id = ?", now(), id);
    });
    return { ok: true };
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

// Mask an email into a public leaderboard handle: first 2 chars of the local
// part + dots (e.g. "fa•••"). Never exposes the full address or the domain.
function maskName(email: string): string {
  const local = (email.split("@")[0] || "user").trim();
  if (local.length <= 2) return `${local[0] ?? "u"}•••`;
  return `${local.slice(0, 2)}•••`;
}
