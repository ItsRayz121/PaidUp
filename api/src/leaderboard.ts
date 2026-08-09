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

export type EarnerRow = { id: string; email: string; earned: number };
export type ReferrerRow = { id: string; email: string; ref_points: number; invites: number };

// These two aggregates scan the whole ledger, and the leaderboard is a page
// every user opens. Recomputing it per request is per-user cost for a board
// that is identical for everyone — so the RAW rows are cached for a minute
// (the personal isMe flag is applied per request, never cached). A stale
// leaderboard is harmless; a ledger scan per view is not.
const LEADERBOARD_TTL_MS = 60_000;
let cache: { at: number; earners: EarnerRow[]; referrers: ReferrerRow[] } | null = null;

/**
 * Drop the cached boards.
 *
 * Called after an exclusion is added or removed. Without it, an admin hides a
 * seeded test account, reloads, and still sees it at rank 1 for up to a minute
 * — which reads as "the button did nothing" and gets clicked again.
 */
export function invalidateLeaderboard(): void {
  cache = null;
}

// Rows hidden from both boards. A LEFT JOIN … IS NULL rather than a NOT IN
// subquery so the filter is part of the same scan, and so an empty exclusion
// table (the normal case) costs nothing.
const NOT_EXCLUDED =
  "LEFT JOIN leaderboard_exclusions x ON x.user_id = u.id";

export async function loadLeaderboard(): Promise<{ earners: EarnerRow[]; referrers: ReferrerRow[] }> {
  if (cache && Date.now() - cache.at < LEADERBOARD_TTL_MS) return cache;

  const LIMIT = 20;
  const earners = await sql.all<EarnerRow>(
    `SELECT u.id, u.email,
            COALESCE(SUM(CASE WHEN le.source_type IN ('task_completion','referral_bonus')
                               AND le.amount > 0 THEN le.amount ELSE 0 END),0)::int AS earned
     FROM users u
     JOIN ledger_entries le ON le.user_id = u.id
     ${NOT_EXCLUDED}
     WHERE u.email_verified = 1 AND x.user_id IS NULL
     GROUP BY u.id, u.email
     HAVING SUM(CASE WHEN le.source_type IN ('task_completion','referral_bonus')
                      AND le.amount > 0 THEN le.amount ELSE 0 END) > 0
     ORDER BY earned DESC, u.created_at ASC
     LIMIT ${LIMIT}`,
  );
  const referrers = await sql.all<ReferrerRow>(
    `SELECT u.id, u.email,
            COALESCE(SUM(le.amount),0)::int AS ref_points,
            (SELECT COUNT(*)::int FROM referrals r WHERE r.referrer_user_id = u.id) AS invites
     FROM users u
     JOIN ledger_entries le ON le.user_id = u.id AND le.source_type = 'referral_bonus'
     ${NOT_EXCLUDED}
     WHERE x.user_id IS NULL
     GROUP BY u.id, u.email
     HAVING SUM(le.amount) > 0
     ORDER BY ref_points DESC, u.created_at ASC
     LIMIT ${LIMIT}`,
  );
  cache = { at: Date.now(), earners, referrers };
  return cache;
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
