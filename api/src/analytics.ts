// Business analytics (brief part 48) — the numbers that say whether this is
// working as a business, rather than whether the server is up.
//
// Everything here is DERIVED from tables that already exist. There is no
// analytics pipeline, no event stream and no second source of truth: a KPI that
// disagrees with the ledger is worse than no KPI, and the fastest way to get one
// is to start counting things twice.
//
// The single exception is `user_activity_days`, which exists because DAU cannot
// be derived from anything already stored — see its comment in db.ts.

import { sql, now } from "./db.ts";

// ---- Activity ---------------------------------------------------------------

const utcDay = (d: Date | string = new Date()) =>
  new Date(d).toISOString().slice(0, 10);

// Written at most once per user per day PER PROCESS. Without this memo, the
// upsert below would run on every authenticated request — which for an app that
// polls mining every few seconds is thousands of no-op writes per user per day.
// A Set of "userId:day" is the whole mechanism; it is bounded by (active users x
// 1 day) and cleared when the day rolls over.
let seenDay = utcDay();
const seen = new Set<string>();

/**
 * Record that this user was active today.
 *
 * FIRE AND FORGET, ALWAYS. This is called from the guard that every earner
 * request passes through, and an analytics row must never be able to fail a
 * request that was otherwise going to succeed. Errors are swallowed on purpose.
 */
export function touchActivity(userId: string): void {
  const day = utcDay();
  if (day !== seenDay) { seen.clear(); seenDay = day; }
  const key = `${userId}:${day}`;
  if (seen.has(key)) return;
  seen.add(key);
  void sql.run(
    "INSERT INTO user_activity_days (user_id, day) VALUES (?,?) ON CONFLICT DO NOTHING",
    userId, day,
  ).catch(() => {
    // Let it be retried on the next request rather than lost for the day.
    seen.delete(key);
  });
}

// ---- The report -------------------------------------------------------------

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
const dayStr = (n: number) => utcDay(new Date(Date.now() - n * 86400_000));

async function scalar(text: string, ...params: unknown[]): Promise<number> {
  const r = await sql.get<{ v: number | string }>(text, ...params);
  return Number(r?.v ?? 0);
}

export type Analytics = Awaited<ReturnType<typeof loadAnalytics>>;

export async function loadAnalytics(days = 30) {
  const since = daysAgo(days);
  const today = utcDay();
  const startOfToday = `${today}T00:00:00.000Z`;

  const [
    // Users
    totalUsers, verifiedUsers, newToday, new7d, new30d,
    dau, wau, mau,
    // Tasks
    taskStarts30d, completions30d, credited30d,
    proofsSubmitted30d, proofsApproved30d, proofsPending,
    completionsToday, taskOpens30d, proofsRejected30d,
    // Mining
    activeMiners, sessions30d, roziMinedToday,
    // Money
    depositMicro30d, depositMicroAll,
    withdrawnPoints30d, withdrawnPointsAll, withdrawPendingPoints,
    refundMicro30d,
    rewardCostPoints30d, referralCostPoints30d,
    // Referrals
    referredSignups, referredActivated,
    // Risk
    openFraud, openTickets,
  ] = await Promise.all([
    scalar("SELECT COUNT(*)::int AS v FROM users"),
    scalar("SELECT COUNT(*)::int AS v FROM users WHERE email_verified = 1"),
    scalar("SELECT COUNT(*)::int AS v FROM users WHERE created_at >= ?", startOfToday),
    scalar("SELECT COUNT(*)::int AS v FROM users WHERE created_at >= ?", daysAgo(7)),
    scalar("SELECT COUNT(*)::int AS v FROM users WHERE created_at >= ?", daysAgo(30)),

    scalar("SELECT COUNT(*)::int AS v FROM user_activity_days WHERE day = ?", today),
    scalar("SELECT COUNT(DISTINCT user_id)::int AS v FROM user_activity_days WHERE day >= ?", dayStr(6)),
    scalar("SELECT COUNT(DISTINCT user_id)::int AS v FROM user_activity_days WHERE day >= ?", dayStr(29)),

    // "Started" = a completion row exists at all, whatever it became. The
    // funnel's top: how many attempts, of which how many were verified and
    // then actually paid.
    scalar("SELECT COUNT(*)::int AS v FROM task_completions WHERE created_at >= ?", since),
    scalar("SELECT COUNT(*)::int AS v FROM task_completions WHERE status IN ('verified','credited') AND created_at >= ?", since),
    scalar("SELECT COUNT(*)::int AS v FROM task_completions WHERE status = 'credited' AND created_at >= ?", since),
    scalar("SELECT COUNT(*)::int AS v FROM task_proofs WHERE created_at >= ?", since),
    scalar("SELECT COUNT(*)::int AS v FROM task_proofs WHERE status = 'approved' AND created_at >= ?", since),
    scalar("SELECT COUNT(*)::int AS v FROM task_proofs WHERE status = 'pending'"),
    scalar("SELECT COUNT(*)::int AS v FROM task_completions WHERE status = 'credited' AND created_at >= ?", startOfToday),
    // The very top of the funnel: users who opened a task's detail page.
    scalar("SELECT COUNT(DISTINCT user_id)::int AS v FROM task_opens WHERE last_at >= ?", since),
    scalar("SELECT COUNT(*)::int AS v FROM task_proofs WHERE status = 'rejected' AND created_at >= ?", since),

    // A miner is "active" if they have a session that has not ended yet.
    scalar("SELECT COUNT(DISTINCT user_id)::int AS v FROM mining_sessions WHERE status = 'active'"),
    scalar("SELECT COUNT(*)::int AS v FROM mining_sessions WHERE started_at >= ?", since),
    scalar(
      `SELECT COALESCE(SUM(amount),0) AS v FROM rozi_ledger
        WHERE source_type = 'mining' AND direction = 'credit' AND created_at >= ?`,
      startOfToday,
    ),

    scalar("SELECT COALESCE(SUM(amount),0) AS v FROM usdt_ledger WHERE direction = 'credit' AND source_type = 'topup' AND created_at >= ?", since),
    scalar("SELECT COALESCE(SUM(amount),0) AS v FROM usdt_ledger WHERE direction = 'credit' AND source_type = 'topup'"),
    scalar("SELECT COALESCE(SUM(amount),0)::int AS v FROM withdrawal_requests WHERE status = 'paid' AND paid_at >= ?", since),
    scalar("SELECT COALESCE(SUM(amount),0)::int AS v FROM withdrawal_requests WHERE status = 'paid'"),
    scalar("SELECT COALESCE(SUM(amount),0)::int AS v FROM withdrawal_requests WHERE status IN ('pending','agent_approved','manager_approved','sending')"),
    scalar("SELECT COALESCE(SUM(amount),0) AS v FROM usdt_refund_requests WHERE status = 'paid' AND created_at >= ?", since),

    // What the offers cost us in points, split so referral spend is visible on
    // its own — it comes out of margin and is the easiest cost to under-notice.
    scalar("SELECT COALESCE(SUM(amount),0)::int AS v FROM ledger_entries WHERE source_type = 'task_completion' AND direction = 'credit' AND created_at >= ?", since),
    scalar("SELECT COALESCE(SUM(amount),0)::int AS v FROM ledger_entries WHERE source_type = 'referral_bonus' AND direction = 'credit' AND created_at >= ?", since),

    scalar("SELECT COUNT(*)::int AS v FROM users WHERE referred_by IS NOT NULL"),
    // "Activated" is the honest denominator for referral quality: an invite who
    // signed up and then actually finished something. Counting signups alone is
    // what makes a farm look like growth.
    scalar(
      `SELECT COUNT(DISTINCT u.id)::int AS v FROM users u
        WHERE u.referred_by IS NOT NULL
          AND EXISTS (SELECT 1 FROM task_completions c
                       WHERE c.user_id = u.id AND c.status = 'credited')`,
    ),

    scalar("SELECT COUNT(*)::int AS v FROM fraud_flags WHERE resolved_by IS NULL"),
    scalar("SELECT COUNT(*)::int AS v FROM support_tickets WHERE status != 'closed'"),
  ]);

  // ---- Retention -----------------------------------------------------------
  // D1 / D7 / D30: of the users who signed up on a given day, how many were
  // active N days later. Measured against a cohort that is OLD ENOUGH to have
  // had the chance — a D7 number that includes people who signed up yesterday
  // is not low, it is meaningless.
  const retention = await sql.all<{ window: string; cohort: number; returned: number }>(
    `WITH cohorts AS (
       SELECT id, to_char(created_at::timestamp, 'YYYY-MM-DD') AS signup_day
         FROM users
        WHERE created_at >= ? AND created_at < ?
     )
     SELECT '1' AS window,
            COUNT(*)::int AS cohort,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM user_activity_days a
               WHERE a.user_id = c.id
                 AND a.day = to_char((c.signup_day::date + 1), 'YYYY-MM-DD')
            ))::int AS returned
       FROM cohorts c`,
    daysAgo(31), daysAgo(1),
  );

  const retentionFor = async (n: number, oldestDays: number) => {
    const r = await sql.get<{ cohort: number; returned: number }>(
      `WITH cohorts AS (
         SELECT id, created_at::timestamp::date AS signup_day
           FROM users
          WHERE created_at >= ? AND created_at < ?
       )
       SELECT COUNT(*)::int AS cohort,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM user_activity_days a
                 WHERE a.user_id = c.id
                   AND a.day = to_char(c.signup_day + ?::int, 'YYYY-MM-DD')
              ))::int AS returned
         FROM cohorts c`,
      daysAgo(oldestDays), daysAgo(n),
      n,
    );
    return { cohort: r?.cohort ?? 0, returned: r?.returned ?? 0 };
  };
  const [d1, d7, d30] = await Promise.all([
    retentionFor(1, 31), retentionFor(7, 37), retentionFor(30, 60),
  ]);

  // ---- Daily series --------------------------------------------------------
  // One row per day, several measures, for the charts. Built by LEFT JOINing
  // onto a generated date range so a quiet day appears as a zero rather than
  // vanishing — a line chart that silently drops empty days draws a trend that
  // did not happen.
  const series = await sql.all<{
    day: string; signups: number; active: number;
    completions: number; points: number;
  }>(
    `WITH days AS (
       SELECT to_char(d, 'YYYY-MM-DD') AS day
         FROM generate_series(?::date, ?::date, '1 day') AS d
     )
     SELECT days.day,
       COALESCE((SELECT COUNT(*)::int FROM users u
                  WHERE to_char(u.created_at::timestamp,'YYYY-MM-DD') = days.day), 0) AS signups,
       COALESCE((SELECT COUNT(*)::int FROM user_activity_days a
                  WHERE a.day = days.day), 0) AS active,
       COALESCE((SELECT COUNT(*)::int FROM task_completions c
                  WHERE c.status = 'credited'
                    AND to_char(c.created_at::timestamp,'YYYY-MM-DD') = days.day), 0) AS completions,
       COALESCE((SELECT SUM(COALESCE(c.points,0))::int FROM task_completions c
                  WHERE c.status = 'credited'
                    AND to_char(c.created_at::timestamp,'YYYY-MM-DD') = days.day), 0) AS points
       FROM days ORDER BY days.day ASC`,
    dayStr(days - 1), today,
  );

  const miningSeries = await sql.all<{ day: string; rozi: string; miners: number }>(
    `WITH days AS (
       SELECT to_char(d, 'YYYY-MM-DD') AS day
         FROM generate_series(?::date, ?::date, '1 day') AS d
     )
     SELECT days.day,
       COALESCE((SELECT SUM(amount) FROM rozi_ledger r
                  WHERE r.source_type = 'mining' AND r.direction = 'credit'
                    AND to_char(r.created_at::timestamp,'YYYY-MM-DD') = days.day), 0)::text AS rozi,
       COALESCE((SELECT COUNT(DISTINCT r.user_id)::int FROM rozi_ledger r
                  WHERE r.source_type = 'mining' AND r.direction = 'credit'
                    AND to_char(r.created_at::timestamp,'YYYY-MM-DD') = days.day), 0) AS miners
       FROM days ORDER BY days.day ASC`,
    dayStr(days - 1), today,
  );

  // ---- Per-campaign revenue (brief part 15) --------------------------------
  // Revenue per network, derived from what the network reported against what we
  // paid out. `revenue` is our margin: the network's payout minus the user's
  // reward, at the network's configured split.
  //
  // ⚠️ THIS IS AN ESTIMATE AND THE PANEL SAYS SO. We store what we PAID the
  // user, not what the network paid US — there is no invoice in this database.
  // At a 60/40 split, a 600-point reward implies a $1.00 gross and $0.40 to us,
  // but only while the dashboard's split matches what the network is really
  // paying. A real revenue figure needs the network's own reporting.
  const byNetwork = await sql.all<{
    network: string; label: string; split: number; status: string;
    completions: number; user_points: number;
  }>(
    `SELECT c.network,
            COALESCE(n.name, c.network) AS label,
            COALESCE(n.commission_split_pct, 60)::int AS split,
            COALESCE(n.status, 'active') AS status,
            COUNT(*)::int AS completions,
            COALESCE(SUM(COALESCE(c.points,0)),0)::int AS user_points
       FROM task_completions c
       LEFT JOIN networks n ON n.id = c.network
      WHERE c.status = 'credited' AND c.created_at >= ?
      GROUP BY c.network, n.name, n.commission_split_pct, n.status
      ORDER BY user_points DESC`,
    since,
  );

  const rewardCost = rewardCostPoints30d + referralCostPoints30d;
  // Gross implied by the split: if users get `split`% of the payout, the whole
  // payout is userPoints / (split/100), and our share is the remainder.
  const grossPoints = byNetwork.reduce(
    (sum, n) => sum + (n.split > 0 ? n.user_points / (n.split / 100) : 0), 0,
  );
  const revenuePoints = Math.max(0, Math.round(grossPoints - rewardCostPoints30d));

  return {
    generatedAt: now(),
    windowDays: days,
    users: {
      total: totalUsers, verified: verifiedUsers,
      newToday, new7d, new30d,
      dau, wau, mau,
      // Stickiness. The single most diagnostic ratio here: DAU/MAU says how
      // many days a month an average active user opens the app.
      stickiness: mau > 0 ? Math.round((dau / mau) * 1000) / 10 : 0,
    },
    retention: {
      d1: { ...d1, pct: pct(d1.returned, d1.cohort) },
      d7: { ...d7, pct: pct(d7.returned, d7.cohort) },
      d30: { ...d30, pct: pct(d30.returned, d30.cohort) },
      // Kept so the shape is stable even if the window query above is trimmed.
      sampleWindow: retention.length,
    },
    tasks: {
      opened: taskOpens30d,
      starts: taskStarts30d, verified: completions30d, credited: credited30d,
      completionRate: pct(credited30d, taskStarts30d),
      openedToCreditedRate: pct(credited30d, taskOpens30d),
      proofsSubmitted: proofsSubmitted30d, proofsApproved: proofsApproved30d,
      proofsRejected: proofsRejected30d, proofsPending,
      approvalRate: pct(proofsApproved30d, proofsSubmitted30d),
      completionsToday,
    },
    mining: {
      activeMiners, sessions: sessions30d,
      roziMinedTodayMicro: String(roziMinedToday),
    },
    money: {
      depositMicro30d: String(depositMicro30d),
      depositMicroAll: String(depositMicroAll),
      refundMicro30d: String(refundMicro30d),
      withdrawnPoints30d, withdrawnPointsAll, withdrawPendingPoints,
      rewardCostPoints: rewardCost,
      referralCostPoints: referralCostPoints30d,
      revenuePoints,
      // Per ACTIVE user, not per registered one: dividing by everyone who ever
      // signed up flatters the number every month, forever.
      revenuePerActiveUser: mau > 0 ? Math.round((revenuePoints / mau) * 100) / 100 : 0,
    },
    referrals: {
      signups: referredSignups,
      activated: referredActivated,
      conversion: pct(referredActivated, referredSignups),
    },
    risk: { openFraud, openTickets },
    series,
    miningSeries,
    byNetwork: byNetwork.map((n) => ({
      network: n.network, label: n.label, split: n.split, status: n.status,
      completions: n.completions,
      userPoints: n.user_points,
      // Our margin on this network, on the same estimate as above.
      marginPoints: n.split > 0
        ? Math.max(0, Math.round(n.user_points / (n.split / 100) - n.user_points))
        : 0,
    })),
  };
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}
