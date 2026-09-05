// The leaderboard, in one place, because two callers now read it.
//
// WHY THIS FILE EXISTS
// --------------------
// The boards used to be private helpers inside routes/app.ts. The staff panel
// (brief part 42) needs to see EXACTLY what users see — that is the whole point
// of an admin leaderboard screen: "who is on it, and should they be?". Two
// copies of the query would answer that question wrong the first time either
// one changed, and the wrong answer looks like a working screen.
//
// So the query lives here, both routes call it, and the exclusion filter below
// applies to both by construction rather than by remembering.
//
// ⚠️ THE MASK IS APPLIED AT THE ROUTE, NOT HERE. Staff see real emails (they
// are deciding whether to exclude a specific person, so a masked handle is
// useless to them); earners never do. Returning raw rows and letting each
// caller decide is what keeps the masking decision visible at the boundary
// where it matters, instead of buried in a shared function.
import { sql, now } from "./db.ts";

export type EarnerRow = { id: string; email: string; username: string | null; telegram_username: string | null; earned: number };
export type ReferrerRow = { id: string; email: string; username: string | null; telegram_username: string | null; ref_points: number; invites: number };

// These two aggregates scan the whole ledger, and the leaderboard is a page
// every user opens. Recomputing it per request is per-user cost for a board
// that is identical for everyone — so the RAW rows are cached for a minute
// (the personal isMe flag is applied per request, never cached). A stale
// leaderboard is harmless; a ledger scan per view is not.
const LEADERBOARD_TTL_MS = 60_000;
type Board = { earners: EarnerRow[]; referrers: ReferrerRow[] };
// Keyed by window ("all", or a period range) so "This Week"/"This Month"
// (2026-09-05) cache independently of the all-time board rather than fighting
// over one slot. Bounded by construction — there are only ever a few live
// window keys at once (all/week/month), never one per request.
const cache = new Map<string, { at: number } & Board>();

/**
 * Drop every cached board (all windows).
 *
 * Called after an exclusion is added or removed. Without it, an admin hides a
 * seeded test account, reloads, and still sees it at rank 1 for up to a minute
 * — which reads as "the button did nothing" and gets clicked again.
 */
export function invalidateLeaderboard(): void {
  cache.clear();
}

// Rows hidden from both boards. A LEFT JOIN … IS NULL rather than a NOT IN
// subquery so the filter is part of the same scan, and so an empty exclusion
// table (the normal case) costs nothing.
const NOT_EXCLUDED =
  "LEFT JOIN leaderboard_exclusions x ON x.user_id = u.id";

// A closed or in-progress period to score the boards over — the SAME bounds
// the leaderboard-reward settlement job uses for a just-closed period
// (leaderboardRewards.ts), so "This Week" on screen and "what the weekly
// prize was scored against" can never quietly disagree. `untilISO` is
// exclusive; omit it to mean "up to now" (an in-progress period on display).
export type LeaderboardRange = { sinceISO: string; untilISO?: string };

function rangeKey(range?: LeaderboardRange): string {
  if (!range) return "all";
  return `${range.sinceISO}..${range.untilISO ?? ""}`;
}

export async function loadLeaderboard(
  range?: LeaderboardRange, limit = 20,
): Promise<Board> {
  const key = `${rangeKey(range)}:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < LEADERBOARD_TTL_MS) return hit;

  const bounds = range ? "AND le.created_at >= ?" + (range.untilISO ? " AND le.created_at < ?" : "") : "";
  const boundParams = range ? (range.untilISO ? [range.sinceISO, range.untilISO] : [range.sinceISO]) : [];

  const earners = await sql.all<EarnerRow>(
    `SELECT u.id, u.email, u.username, u.telegram_username,
            COALESCE(SUM(CASE WHEN le.source_type IN ('task_completion','referral_bonus')
                               AND le.amount > 0 ${bounds} THEN le.amount ELSE 0 END),0)::int AS earned
     FROM users u
     JOIN ledger_entries le ON le.user_id = u.id
     ${NOT_EXCLUDED}
     WHERE u.email_verified = 1 AND x.user_id IS NULL
     GROUP BY u.id, u.email, u.username, u.telegram_username
     HAVING SUM(CASE WHEN le.source_type IN ('task_completion','referral_bonus')
                      AND le.amount > 0 ${bounds} THEN le.amount ELSE 0 END) > 0
     ORDER BY earned DESC, u.created_at ASC
     LIMIT ${limit}`,
    ...boundParams, ...boundParams,
  );
  const referrers = await sql.all<ReferrerRow>(
    `SELECT u.id, u.email, u.username, u.telegram_username,
            COALESCE(SUM(le.amount),0)::int AS ref_points,
            (SELECT COUNT(*)::int FROM referrals r WHERE r.referrer_user_id = u.id) AS invites
     FROM users u
     JOIN ledger_entries le ON le.user_id = u.id AND le.source_type = 'referral_bonus' ${bounds}
     ${NOT_EXCLUDED}
     WHERE x.user_id IS NULL
     GROUP BY u.id, u.email, u.username, u.telegram_username
     HAVING SUM(le.amount) > 0
     ORDER BY ref_points DESC, u.created_at ASC
     LIMIT ${limit}`,
    ...boundParams,
  );
  const board = { at: Date.now(), earners, referrers };
  cache.set(key, board);
  return board;
}

/**
 * Mask an email into a public leaderboard handle: first 2 chars of the local
 * part + dots (e.g. "fa•••"). Never exposes the full address or the domain.
 */
export function maskName(email: string): string {
  const local = (email.split("@")[0] || "user").trim();
  if (local.length <= 2) return `${local[0] ?? "u"}•••`;
  return `${local.slice(0, 2)}•••`;
}

export type ExclusionRow = {
  user_id: string; email: string; reason: string;
  excluded_by: string | null; created_at: string;
};

export async function listExclusions(): Promise<ExclusionRow[]> {
  return sql.all<ExclusionRow>(
    `SELECT x.user_id, u.email, x.reason, x.excluded_by, x.created_at
     FROM leaderboard_exclusions x JOIN users u ON u.id = x.user_id
     ORDER BY x.created_at DESC`,
  );
}

export async function addExclusion(userId: string, reason: string, by: string): Promise<void> {
  // Re-hiding someone already hidden updates the reason rather than failing.
  // The staff member's intent is "this person should not be on the board", and
  // a 409 on that is a wrong answer to a right instruction.
  await sql.run(
    `INSERT INTO leaderboard_exclusions (user_id, reason, excluded_by, created_at)
     VALUES (?,?,?,?)
     ON CONFLICT (user_id) DO UPDATE SET reason = EXCLUDED.reason, excluded_by = EXCLUDED.excluded_by`,
    userId, reason, by, now(),
  );
  invalidateLeaderboard();
}

export async function removeExclusion(userId: string): Promise<boolean> {
  const r = await sql.run("DELETE FROM leaderboard_exclusions WHERE user_id = ?", userId);
  invalidateLeaderboard();
  return r.rowCount > 0;
}
