// Withdrawal velocity controls — the compensating control for having NO
// per-request human approval below the auto-withdraw ceiling (autoWithdraw.ts).
//
// CUSTODY_SPEC.md § 3.3 names the exact attack this closes: "a limit is where
// an attacker will aim, repeatedly, just under it." autoWithdrawMaxPoints
// bounds one request; nothing bounded the SUM of many requests until this.
import { sql, type TxApi } from "./db.ts";
import { config } from "./config.ts";
import { flagOnce } from "./fraud.ts";

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

// Soft signal: many withdrawal REQUESTS in 24h, regardless of amount or
// whether they auto-settled. Never blocks — staff review only, same posture
// as every other fraud.ts check (payout_address_reuse, ip_reuse, ...).
export async function checkWithdrawalVelocity(userId: string): Promise<void> {
  try {
    const row = await sql.get<{ n: string }>(
      `SELECT COUNT(*) AS n FROM withdrawal_requests WHERE user_id = ? AND created_at >= ?`,
      userId, hoursAgoIso(24),
    );
    const n = Number(row?.n ?? 0);
    if (n >= config.withdrawalVelocityFlagCount) {
      await flagOnce(
        "withdrawal_velocity", `user:${userId}`, userId, "medium",
        `${n} withdrawal requests in the last 24 hours.`,
      );
    }
  } catch {
    // A fraud signal must never break a legitimate withdrawal.
  }
}

// Sum of ALL withdrawal requests (any status — pending counts too, since the
// question is "how much has this session tried to move today", not "how much
// actually settled") in the trailing 24h. Used by the step-up gate below so
// splitting one large withdrawal into several requests each individually
// under stepUpMinPoints does not avoid proving control of the account.
export async function requestedLast24hPoints(userId: string): Promise<number> {
  const row = await sql.get<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawal_requests WHERE user_id = ? AND created_at >= ?`,
    userId, hoursAgoIso(24),
  );
  return Number(row?.total ?? 0);
}

// Hard gate, checked INSIDE tryAutoSettle (autoWithdraw.ts) alongside its
// existing per-request ceiling. Sums this user's already-auto-paid amount in
// the trailing 24h; if this request would push that sum over the cap, it
// refuses auto-settlement and falls back to the manual queue — same
// non-throwing "just another refusal reason" shape every other gate in
// tryAutoSettle already has.
//
// ⚠️ MUST be called from inside tryAutoSettle's pg_advisory_xact_lock(userId)
// scope, not before it. Read outside the lock, two concurrent withdrawal
// requests for the same user can each see the sum BEFORE the other's commit
// and both pass — the exact "many requests, read the aggregate, race the
// write" shape guardrail #8 exists to close. Accepts an optional tx handle
// (defaults to top-level sql) for exactly that reason, same pattern postUsdt/
// postLedger already use.
export async function autoWithdrawnLast24hPoints(
  userId: string, t: Pick<TxApi, "get"> = sql,
): Promise<number> {
  const row = await t.get<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawal_requests
     WHERE user_id = ? AND reviewed_by = 'system:auto' AND status = 'paid' AND paid_at >= ?`,
    userId, hoursAgoIso(24),
  );
  return Number(row?.total ?? 0);
}
