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
//
// ⚠️ 2026-08-08: same "settlement isn't always synchronous" change as
// autoWithdraw.ts. A refund is the ONE case where payoutRelay.ts's per-user
// signing is real (not a pass-through) — the user's own address genuinely
// holds this USDT, their own prior deposit. When payoutRelay.relayAvailable()
// is true, this creates a relay job and leaves the request at 'sending';
// otherwise it falls straight back to the original synchronous
// provider.send() (direct treasury pay) — unchanged.
import { sql, now, isWithdrawalHeld, type TxApi } from "./db.ts";
import { config } from "./config.ts";
import { getPayoutProvider } from "./payout.ts";
import { relayAvailable, createRelayJob } from "./payoutRelay.ts";
import type { ChainId } from "./chains.ts";
import { sendPushToUser } from "./push.ts";
import { autoRefundedLast24hMicro } from "./velocity.ts";
import { getAutoRefundMaxMicro } from "./autoSettleSettings.ts";

export type AutoRefundResult =
  | { settled: true; txHash: string; usdt: string }
  | { settled: "processing" }
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
      amount: number; fee_micro: number; status: string;
    }>("SELECT * FROM usdt_refund_requests WHERE id = ?", requestId);
    if (!req || req.status !== "pending") return { settled: false, reason: "not pending" };

    // The gas fee (founder, 2026-08-08) is snapshotted on the row at request
    // time and reduces only what gets SENT — `req.amount` is still what was
    // already debited from the user, in full, when they asked.
    const net = req.amount - (req.fee_micro ?? 0);

    if (config.payoutMode !== "onchain") return { settled: false, reason: "onchain payout mode is off" };
    // The ceiling and the 24h cap are both measured on the REQUESTED amount,
    // not the discounted net — a fee must never be a way to sneak a request
    // that would otherwise be over the line back under it.
    if (req.amount > (await getAutoRefundMaxMicro())) return { settled: false, reason: "above auto ceiling" };

    // Reuses the WITHDRAWAL hold, deliberately not a separate refund hold: a
    // staff member holding an account because of suspected abuse means
    // "stop this account's automatic outgoing money," full stop — a second,
    // independent hold flag would be a second place fraud response has to
    // remember to check.
    const hold = await isWithdrawalHeld(req.user_id);
    if (hold.held) return { settled: false, reason: `account held: ${hold.reason}` };

    const relay = relayAvailable(req.chain);
    const provider = getPayoutProvider();
    if (!relay && !provider.canSettle(req.chain as ChainId)) {
      return { settled: false, reason: "provider cannot settle this chain right now" };
    }

    const usdt = microToUsdtString(net);

    const outcome = await sql.tx(async (t: TxApi) => {
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

      if (relay) {
        // This is the ONE place payoutRelay's per-user signing is real, not
        // a pass-through: the user's own address genuinely holds this USDT
        // (their prior deposit). No prefund step — see payoutRelay.ts.
        await createRelayJob("refund", req.id, {
          chain: "bep20", userId: req.user_id, toAddress: req.address,
          amountMicro: Math.round(Number(usdt) * 1_000_000), needsPrefund: false,
        }, t);
        await t.run(
          `UPDATE usdt_refund_requests SET status = 'sending', reviewed_by = 'system:auto', reviewed_at = ? WHERE id = ?`,
          now(), requestId,
        );
        return { processing: true as const };
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
      return { processing: false as const, txHash: sent.txHash };
    });

    if (outcome.processing) return { settled: "processing" };

    void sendPushToUser(req.user_id, {
      title: "Your money is sent",
      body: `We sent ${usdt} USDT back to your wallet. Check it now.`,
      url: "/wallet",
    });
    return { settled: true, txHash: outcome.txHash, usdt };
  } catch (e) {
    return { settled: false, reason: (e as Error).message || "auto-settle failed" };
  }
}
