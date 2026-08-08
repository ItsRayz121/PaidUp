// Fully-automatic on-chain withdrawal (founder decision, 2026-08-05): a
// request settles the instant it's made, with no staff step, UNLESS the
// account is held or the amount is above the automatic ceiling — either of
// those drops it into the exact same manual Agent->Manager queue every
// withdrawal used to go through (routes/staff.ts's decision endpoint, which
// is completely unchanged by this file).
//
// This runs as a SEPARATE step right after the request-creation transaction
// in routes/withdrawals.ts commits, not folded into it — the same reason
// routes/staff.ts's manual "pay" action holds a transaction open across the
// network call to provider.send(): consistency with the one place this
// codebase already does that, not a new pattern invented here.
import { sql, now, isWithdrawalHeld, type TxApi } from "./db.ts";
import { config } from "./config.ts";
import { getPayoutProvider, pointsToUsdt } from "./payout.ts";
import type { ChainId } from "./chains.ts";
import { sendPushToUser } from "./push.ts";
import { autoWithdrawnLast24hPoints } from "./velocity.ts";
import { getAutoWithdrawMaxPoints } from "./autoSettleSettings.ts";

export type AutoSettleResult =
  | { settled: true; txHash: string; usdt: string }
  | { settled: false; reason: string };

// Attempt to auto-settle a just-created, still-'pending' withdrawal request.
// ⚠️ NEVER THROWS. The request has already been created and its points
// already held by the time this runs — a failure here must fall back to
// "stays pending for staff", exactly the behaviour that existed before
// automatic withdrawal did, never fail the request that already succeeded
// from the user's point of view.
export async function tryAutoSettle(requestId: string): Promise<AutoSettleResult> {
  try {
    const req = await sql.get<{
      id: string; user_id: string; amount: number; payout_rail: string;
      payout_address: string; fee_points: number; status: string;
    }>("SELECT * FROM withdrawal_requests WHERE id = ?", requestId);
    if (!req || req.status !== "pending") return { settled: false, reason: "not pending" };

    if (config.payoutMode !== "onchain") return { settled: false, reason: "onchain payout mode is off" };
    if (req.amount > (await getAutoWithdrawMaxPoints())) return { settled: false, reason: "above auto ceiling" };

    const hold = await isWithdrawalHeld(req.user_id);
    if (hold.held) return { settled: false, reason: `account held: ${hold.reason}` };

    const provider = getPayoutProvider();
    if (!provider.canSettle(req.payout_rail as ChainId)) {
      return { settled: false, reason: "provider cannot settle this chain right now" };
    }

    const net = Math.max(0, req.amount - (req.fee_points ?? 0));
    const usdt = pointsToUsdt(net);

    const result = await sql.tx(async (t: TxApi) => {
      // GUARDRAIL #8, applied to an AGGREGATE read, not just a balance: two
      // withdrawal requests for the same user, auto-settling close together,
      // must not both read autoWithdrawnLast24hPoints before either has
      // committed 'paid' — that race is exactly how the rolling-24h cap
      // below gets bypassed by firing several requests at once. Locking the
      // USER (not just this one row) before the read is what closes it.
      await t.run("SELECT pg_advisory_xact_lock(hashtext(?))", req.user_id);

      // Re-lock and re-check status INSIDE the transaction: it must still be
      // 'pending' at the moment of settlement, in case a staff member (or a
      // duplicate trigger) touched this same request in the gap since the
      // read above.
      const locked = await t.get<{ status: string }>(
        "SELECT status FROM withdrawal_requests WHERE id = ? FOR UPDATE", requestId,
      );
      if (!locked || locked.status !== "pending") {
        throw new Error("already handled");
      }

      // CUSTODY_SPEC.md § 3.3: the per-request ceiling above bounds ONE
      // request; this bounds the SUM of a rolling 24h window, closing "many
      // requests just under the ceiling" — the obvious attack once there is
      // no per-request human approval at all. Read HERE, under the user lock
      // just taken, not before this transaction opened.
      const already = await autoWithdrawnLast24hPoints(req.user_id, t);
      if (already + req.amount > config.autoWithdrawMaxPointsPer24h) {
        throw new Error("above rolling 24h auto-withdraw cap");
      }

      const sent = await provider.send({
        requestId: req.id,
        chain: req.payout_rail as ChainId,
        address: req.payout_address,
        points: net,
        usdt,
      });
      await t.run(
        `UPDATE withdrawal_requests
         SET status = 'paid', reviewed_by = 'system:auto', review_note = ?,
             reviewed_at = ?, paid_at = ?, tx_hash = ?, usdt_amount = ?
         WHERE id = ?`,
        "Sent automatically — below the auto-withdraw ceiling, no staff review required.",
        now(), now(), sent.txHash, usdt, requestId,
      );
      return sent;
    });

    void sendPushToUser(req.user_id, {
      title: "Your money is sent",
      body: `We sent ${usdt} USDT to your wallet. Check it now.`,
      url: "/wallet",
    });
    return { settled: true, txHash: result.txHash, usdt };
  } catch (e) {
    return { settled: false, reason: (e as Error).message || "auto-settle failed" };
  }
}
