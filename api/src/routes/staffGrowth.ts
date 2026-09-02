// Growth admin — referrals (brief part 41) and the leaderboard (part 42).
//
// WHY THESE TWO SIT TOGETHER
// --------------------------
// They are the same job. The leaderboard exists to make people invite friends,
// and the referral rates decide whether inviting is worth doing. A staff member
// tuning one is almost always about to look at the other, and splitting them
// across two sections would mean setting a rate on one screen and finding out
// what it did on another.
//
// ⚠️ THE ADVERTISED RATE IS THE MINIMUM ACROSS ACTIVE NETWORKS, AND THAT IS THE
// NUMBER THIS SCREEN LEADS WITH. The invite screens promise a rate we meet on
// every offer (see GET /referrals/me), so raising CPX to 25% and forgetting
// surveyx changes NOTHING a user can see. Before this screen there was no way
// to find that out except by reading five rows and doing the comparison in your
// head — which is how the bulk-update endpoint came to exist in the first
// place. Here the advertised figure is stated first, and the per-network table
// underneath marks the row that is pinning it.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { sql, logAudit } from "../db.ts";
import { requirePermission, type Role, type Permission } from "../roles.ts";
import {
  loadLeaderboard, listExclusions, addExclusion, removeExclusion,
} from "../leaderboard.ts";
import { enabled as flagEnabled } from "../flags.ts";

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

type NetworkRow = {
  id: string; name: string; status: string; split: number;
  l1: number; l2: number; first_task: number; days: number;
};

export async function staffGrowthRoutes(app: FastifyInstance) {
  // ---- Referrals ----------------------------------------------------------
  //
  // Everything here is DERIVED from the ledger and the referrals table
  // (analytics.ts's rule). There is no stored "referral spend" counter, because
  // a counter that disagrees with the ledger is worse than no counter, and the
  // ledger is the thing a user will quote back at us.
  app.get("/staff/referrals", staffGuard("referrals.manage", async () => {
    const networks = await sql.all<NetworkRow>(
      `SELECT id, name, status,
              commission_split_pct        AS split,
              referral_bonus_pct          AS l1,
              referral_bonus_pct_l2       AS l2,
              referral_first_task_bonus   AS first_task,
              referral_bonus_days         AS days
       FROM networks ORDER BY status, name`,
    );

    // What the invite screens actually promise. The MIN across ACTIVE rows —
    // a floor we meet on every offer, and a disabled network can never drag it
    // down (matching /referrals/me exactly; if these two ever disagree, this
    // screen is lying about what users were told).
    const active = networks.filter((n) => n.status === "active");
    const minOf = (pick: (n: NetworkRow) => number) =>
      active.length === 0 ? 0 : Math.min(...active.map(pick));
    const advertised = {
      l1: minOf((n) => n.l1),
      l2: minOf((n) => n.l2),
      firstTaskBonus: minOf((n) => n.first_task),
      // 0 means lifetime, and a MIN over a set containing 0 would report
      // "lifetime" as the floor when one network stops paying after 30 days.
      // The honest floor is the shortest NON-lifetime window, or lifetime only
      // when every active network is lifetime.
      windowDays: (() => {
        const limited = active.map((n) => n.days).filter((d) => d > 0);
        return limited.length === active.length && limited.length > 0
          ? Math.min(...limited)
          : 0;
      })(),
    };

    // Which active rows are holding the advertised figure down. This is the
    // whole point of the screen: "raise it" means raising THESE rows, and one
    // forgotten row keeps the promise where it was.
    const pinning = active
      .filter((n) => n.l1 === advertised.l1 || n.l2 === advertised.l2 || n.first_task === advertised.firstTaskBonus)
      .map((n) => n.id);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
    const one = async (text: string, ...params: unknown[]) =>
      (await sql.get<{ v: number }>(text, ...params))?.v ?? 0;

    const [paidAll, paid30d, referredUsers, activatedUsers, payingReferrers] = await Promise.all([
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM ledger_entries WHERE source_type = 'referral_bonus' AND amount > 0"),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM ledger_entries WHERE source_type = 'referral_bonus' AND amount > 0 AND created_at >= ?", thirtyDaysAgo),
      one("SELECT COUNT(*)::int AS v FROM users WHERE referred_by IS NOT NULL"),
      // An invite is only worth paying for if it does something. This is the
      // number that says whether referral spend is buying users or signups.
      one(`SELECT COUNT(DISTINCT u.id)::int AS v FROM users u
           JOIN task_completions c ON c.user_id = u.id AND c.status = 'credited'
           WHERE u.referred_by IS NOT NULL`),
      one("SELECT COUNT(DISTINCT user_id)::int AS v FROM ledger_entries WHERE source_type = 'referral_bonus' AND amount > 0"),
    ]);

    // Every account that has invited at least ONE person (founder, 2026-09-02:
    // "if someone invited even one user, show them here" — not just the ones we
    // have already paid). Real emails: this is a staff screen for spotting a
    // ring, and a masked handle cannot be looked up.
    const top = await sql.all<Record<string, unknown>>(
      `SELECT u.id, u.email, u.status, u.username, u.telegram_username,
              (SELECT COALESCE(SUM(le.amount),0)::int FROM ledger_entries le
                 WHERE le.user_id = u.id AND le.source_type = 'referral_bonus' AND le.amount > 0) AS points,
              (SELECT COUNT(*)::int FROM users i WHERE i.referred_by = u.id) AS invites,
              (SELECT COUNT(DISTINCT c.user_id)::int FROM users i
                 JOIN task_completions c ON c.user_id = i.id AND c.status = 'credited'
                 WHERE i.referred_by = u.id) AS active_invites,
              (SELECT COUNT(*)::int FROM fraud_flags f
                 WHERE f.user_id = u.id AND f.resolved_by IS NULL) AS open_flags
       FROM users u
       WHERE EXISTS (SELECT 1 FROM users i WHERE i.referred_by = u.id)
       ORDER BY invites DESC, points DESC
       LIMIT 100`,
    );

    return {
      // Whether the referral machinery is on at all. A rates screen that says
      // "15%" while the flag is off is the same lie as a stale rate.
      enabled: await flagEnabled("referrals"),
      advertised,
      pinning,
      networks: networks.map((n) => ({
        id: n.id, name: n.name, status: n.status,
        commissionSplitPct: n.split,
        // The margin is what referral pay comes OUT of. Served alongside the
        // rates so the panel can show the headroom without re-deriving it and
        // getting the arithmetic subtly different from the API that enforces it.
        marginPct: 100 - n.split,
        referralBonusPct: n.l1, referralBonusPctL2: n.l2,
        referralFirstTaskBonus: n.first_task, referralBonusDays: n.days,
        headroomPct: (100 - n.split) - (n.l1 + n.l2),
      })),
      totals: {
        paidAll, paid30d, referredUsers, activatedUsers, payingReferrers,
        // Rounded here rather than in the panel: one definition of "activation
        // rate", so two screens cannot quote two numbers.
        activationPct: referredUsers === 0 ? 0 : Math.round((activatedUsers / referredUsers) * 100),
      },
      topReferrers: top.map((r) => {
        const invites = Number(r.invites ?? 0);
        const active = Number(r.active_invites ?? 0);
        return {
          id: r.id, email: r.email, status: r.status,
          username: r.username ?? null, telegramUsername: r.telegram_username ?? null,
          points: r.points, invites, activeInvites: active,
          // The other half of the story: invites that signed up and did nothing.
          // A high count here next to a high invite count is the shape of a
          // fake-signup farm.
          inactiveInvites: Math.max(0, invites - active),
          inactivePct: invites === 0 ? 0 : Math.round(((invites - active) / invites) * 100),
          openFlags: r.open_flags,
        };
      }),
    };
  }));

  // Who a specific inviter actually brought in — the drill-down behind a Top
  // partners row (founder, 2026-09-02: "let me click and see how many are
  // active vs not"). Derived; no stored list.
  app.get("/staff/referrals/:id/invitees", staffGuard("referrals.manage", async (_ctx, req) => {
    const id = (req.params as { id: string }).id;
    const rows = await sql.all<Record<string, unknown>>(
      `SELECT i.id, i.email, i.username, i.telegram_username, i.status, i.created_at,
              (SELECT COUNT(*)::int FROM task_completions c
                 WHERE c.user_id = i.id AND c.status = 'credited') AS credited_tasks,
              COALESCE((SELECT SUM(amount) FROM rozi_ledger
                 WHERE user_id = i.id AND source_type = 'mining' AND direction = 'credit'), 0) AS mined_micro
       FROM users i WHERE i.referred_by = ?
       ORDER BY i.created_at DESC LIMIT 500`,
      id,
    );
    return {
      invitees: rows.map((r) => ({
        id: r.id, email: r.email, username: r.username ?? null,
        telegramUsername: r.telegram_username ?? null,
        status: r.status, joinedAt: r.created_at,
        creditedTasks: Number(r.credited_tasks ?? 0),
        active: Number(r.credited_tasks ?? 0) > 0,
        minedRozi: Number(r.mined_micro ?? 0) / 1_000_000,
      })),
    };
  }));

  // ---- Leaderboard --------------------------------------------------------
  //
  // Staff see the boards EXACTLY as they are computed for users, from the same
  // function — plus the real email, because the only decision available on this
  // screen is "should this specific person be here", and "fa•••" cannot be
  // looked up, held or asked about.
  app.get("/staff/leaderboard", staffGuard("leaderboard.manage", async () => {
    const { earners, referrers } = await loadLeaderboard();
    const exclusions = await listExclusions();
    return {
      // The flag that switches the whole page off for users. Shown here so the
      // screen cannot be read as "this is live" when it is not — the boards
      // below are still computed either way, which is the confusing part.
      enabled: await flagEnabled("leaderboard"),
      topEarners: earners.map((r, i) => ({
        rank: i + 1, id: r.id, email: r.email,
        username: r.username ?? null, telegramUsername: r.telegram_username ?? null,
        points: r.earned,
      })),
      topReferrers: referrers.map((r, i) => ({
        rank: i + 1, id: r.id, email: r.email,
        username: r.username ?? null, telegramUsername: r.telegram_username ?? null,
        points: r.ref_points, invites: r.invites,
      })),
      exclusions: exclusions.map((x) => ({
        userId: x.user_id, email: x.email, reason: x.reason, at: x.created_at,
      })),
    };
  }));

  const exclusionSchema = z.object({
    userId: z.string().min(1),
    // Mandatory, same as a withdrawal hold. Somebody will ask in three months
    // why a real-looking account is missing from the board, and "no reason
    // recorded" is not an answer anyone can act on.
    reason: z.string().min(1).max(200),
  });

  app.post("/staff/leaderboard/exclusions", staffGuard("leaderboard.manage", async ({ userId, role }, req, reply) => {
    const parsed = exclusionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Pick a user and give a reason." });

    const target = await sql.get<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE id = ?", parsed.data.userId);
    if (!target) return reply.code(404).send({ error: "No such user." });

    await addExclusion(target.id, parsed.data.reason, userId);
    await logAudit({
      actorUserId: userId, actorRole: role, action: "leaderboard_exclude",
      targetUserId: target.id, detail: parsed.data.reason, actorIp: req.ip,
    });
    return { ok: true };
  }));

  app.delete("/staff/leaderboard/exclusions/:userId", staffGuard("leaderboard.manage", async ({ userId, role }, req, reply) => {
    const target = (req.params as { userId: string }).userId;
    if (!(await removeExclusion(target))) {
      return reply.code(404).send({ error: "That user is not hidden." });
    }
    await logAudit({
      actorUserId: userId, actorRole: role, action: "leaderboard_unexclude",
      targetUserId: target, actorIp: req.ip,
    });
    return { ok: true };
  }));
}
