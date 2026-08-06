// Fully-automatic on-chain settlement of a USDT deposit REFUND (founder,
// 2026-08-06: "the money he deposited, he can withdraw it any time with no
// issues" — the only gate should be staff approval, and only above a
// ceiling). This is autoWithdraw.ts's exact pattern, applied to
// usdt_refund_requests instead of withdrawal_requests — a refund never
// touches the points ledger, so it needed its own smaller mirror rather than
// a shared function with a branch in the middle of it.
//
// Runs as a separate step right after the request-creation transaction in
// routes/mining.ts's POST /usdt/refunds commits, same reason tryAutoSettle
// does: consistency with the one place this codebase already holds a
// transaction open across a network call (routes/staff.ts's manual "pay").
import { sql, now, isWithdrawalHeld, type TxApi } from "./db.ts";
import { config } from "./config.ts";
import { getPayoutProvider } from "./payout.ts";
import type { ChainId } from "./chains.ts";
import { sendPushToUser } from "./push.ts";
import { autoRefundedLast24hMicro } from "./velocity.ts";

export type AutoRefundResult =
  | { settled: true; txHash: string; usdt: string }
  | { settled: false; reason: string };

// micro-USDT -> the decimal string parseUnits/pointsToUsdt-shaped consumers
// expect. Exact for any integer micro value: dividing a BIGINT by 1e6 and
// re-fixing to 6dp never loses a digit the way an intermediate float sum
// could, because there is exactly one division and no accumulation.
function microToUsdtString(micro: number): string {
  return (micro / 1_000_000).toFixed(6);
}

// Attempt to auto-settle a just-created, still-'pending' refund request.
// ⚠️ NEVER THROWS, same guarantee as tryAutoSettle and for the same reason:
// the request already exists and its money is already held (debited) by the
// time this runs. A failure here must fall back to "stays pending for staff"
// — the exact behaviour that existed before this file did — never fail the
// request that already succeeded from the user's point of view.
export async function tryAutoSettleRefund(requestId: string): Promise<AutoRefundResult> {
  try {
    const req = await sql.get<{
      id: string; user_id: string; chain: string; address: string;
      amount: number; status: string;
    }>("SELECT * FROM usdt_refund_requests WHERE id = ?", requestId);
    if (!req || req.status !== "pending") return { settled: false, reason: "not pending" };

    if (config.payoutMode !== "onchain") return { settled: false, reason: "onchain payout mode is off" };
    if (req.amount > config.autoRefundMaxMicro) return { settled: false, reason: "above auto ceiling" };

    // Reuses the WITHDRAWAL hold, deliberately not a separate refund hold: a
    // staff member holding an account because of suspected abuse means
    // "stop this account's automatic outgoing money," full stop — a second,
    // independent hold flag would be a second place fraud response has to
    // remember to check.
    const hold = await isWithdrawalHeld(req.user_id);
    if (hold.held) return { settled: false, reason: `account held: ${hold.reason}` };

    const provider = getPayoutProvider();
    if (!provider.canSettle(req.chain as ChainId)) {
      return { settled: false, reason: "provider cannot settle this chain right now" };
    }

    const usdt = microToUsdtString(req.amount);

    const result = await sql.tx(async (t: TxApi) => {
      // GUARDRAIL #8, applied to an AGGREGATE read, not just a balance — the
      // exact race the withdrawal side closed for the same reason (see
      // tryAutoSettle's identical comment): two refund requests for the same
      // user, auto-settling close together, must not both read
      // autoRefundedLast24hMicro before either has committed 'paid'.
      await t.run("SELECT pg_advisory_xact_lock(hashtext(?))", req.user_id);

      const locked = await t.get<{ status: string }>(
        "SELECT status FROM usdt_refund_requests WHERE id = ? FOR UPDATE", requestId,
      );
      if (!locked || locked.status !== "pending") {
        throw new Error("already handled");
      }

      const already = await autoRefundedLast24hMicro(req.user_id, t);
      if (already + req.amount > config.autoRefundMaxMicroPer24h) {
        throw new Error("above rolling 24h auto-refund cap");
      }

      const sent = await provider.send({
        requestId: req.id,
        chain: req.chain as ChainId,
        address: req.address,
        points: 0, // unused by both providers' send() — a refund never touches points
        usdt,
      });
      // NO LEDGER ROW HERE, same rule the manual staff "paid" handler follows
      // (staffMining.ts): the debit already happened when the user asked, so
      // writing another one now would take the money twice.
      await t.run(
        `UPDATE usdt_refund_requests
         SET status = 'paid', tx_hash = ?, reviewed_by = 'system:auto', reviewed_at = ?
         WHERE id = ?`,
        sent.txHash, now(), requestId,
      );
      return sent;
    });

    void sendPushToUser(req.user_id, {
      title: "Your money is sent",
      body: `We sent ${usdt} USDT back to your wallet. Check it now.`,
      url: "/wallet",
    });
    return { settled: true, txHash: result.txHash, usdt };
  } catch (e) {
    return { settled: false, reason: (e as Error).message || "auto-settle failed" };
  }
}
