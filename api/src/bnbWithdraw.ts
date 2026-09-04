// A user withdrawing their OWN BNB out of their derived custody address
// (wallet overhaul). Reuses the exact signing primitive payoutRelay.ts's
// refund path already uses (deriveChildPrivateKey) — but this is a plain
// native-value transfer, not an ERC-20 transfer, so it is a separate,
// simpler job than payout_relay_jobs (whose amount_micro column is
// USDT-scaled at 6dp; BNB needs 18dp wei).
//
// ⚠️ ZERO TREASURY INVOLVEMENT AND ZERO LEDGER ENTRY. The balance being moved
// is the address's own live on-chain balance — not anything this system ever
// held, owes, or debited. A failed job needs no compensating credit, because
// nothing was ever taken out of an internal balance in the first place.
//
// Two-phase, same resumability posture as payoutRelay.ts: every transition is
// a conditional `UPDATE ... WHERE status = <expected>` inside a per-job
// advisory lock, so two ticks racing the same job can never both broadcast.
// 'failed' is terminal, same relayMaxAttempts give-up rule as the rest of
// this codebase's relay jobs — without it, a job that can never succeed
// (balance spent elsewhere between request and send) would retry forever.
import { createWalletClient, http, fallback } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { sql, getOrCreateDepositWallet, type TxApi } from "./db.ts";
import { config } from "./config.ts";
import { deriveChildPrivateKey } from "./custodySeeds.ts";
import { rpcCall } from "./rpc.ts";
import { CostCeilingError } from "./costGuard.ts";
import { sendPushToUser } from "./push.ts";
import { requiredGasWei } from "./payoutRelay.ts";

type BnbJob = {
  id: string; user_id: string; chain: string; address: string; amount_wei: string;
  status: string; tx_hash: string | null; attempts: number; last_error: string | null;
};

type PendingPush = { userId: string; title: string; body: string; url: string };

const TERMINAL = ["paid", "failed"];

async function findWorkIds(): Promise<string[]> {
  const rows = await sql.all<{ id: string }>(
    `SELECT id FROM bnb_withdrawal_requests WHERE status IN ('pending','sending') ORDER BY created_at`,
  );
  return rows.map((r) => r.id);
}

async function markFailed(t: Pick<TxApi, "run">, id: string, error: string): Promise<void> {
  await t.run(
    "UPDATE bnb_withdrawal_requests SET status = 'failed', last_error = ?, attempts = attempts + 1 WHERE id = ? AND status <> 'failed'",
    error, id,
  );
}

// Advances ONE job as far as it can go in one call. Locked PER JOB, same
// `pg_try_advisory_xact_lock(hashtext(...))` posture as advanceRelayJob —
// see that function's header for why the lock must be held across the
// network call, not just the DB write.
export async function advanceBnbWithdrawal(jobId: string): Promise<void> {
  const box: { push: PendingPush | null } = { push: null };

  await sql.tx(async (t) => {
    const got = await t.get<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext(?)) AS locked", `bnb-withdraw:${jobId}`,
    );
    if (!got?.locked) return;

    const job = await t.get<BnbJob>("SELECT * FROM bnb_withdrawal_requests WHERE id = ?", jobId);
    if (!job || TERMINAL.includes(job.status)) return;

    if (job.attempts >= config.relayMaxAttempts) {
      await markFailed(t, job.id, job.last_error ?? "Gave up after repeated failures.");
      box.push = {
        userId: job.user_id, title: "About your BNB withdrawal",
        body: "We could not send this one. Please try again.", url: "/wallet/bnb",
      };
      return;
    }

    if (job.chain !== "bep20") {
      await markFailed(t, job.id, `Unsupported chain "${job.chain}".`);
      return;
    }

    // ⚠️ THE LOAD-BEARING CHECK (same as advanceRelayJob's — see
    // payoutRelay.ts). relayAvailable() alone does not know about
    // payoutMode, so the route creating this job could accept a request
    // while every signing key is configured but the founder has
    // deliberately left PAYOUT_MODE on "manual". Without this, flipping the
    // switch back to manual would not stop a job already queued from
    // signing and broadcasting on the very next tick.
    if (config.payoutMode !== "onchain") return;

    const transport = fallback(config.payoutRpc.bep20.map((url) => http(url)));

    try {
      const wallet = await getOrCreateDepositWallet(job.user_id, "bep20");
      const childPkHex = deriveChildPrivateKey("evm", wallet.addrIndex);
      const account = privateKeyToAccount(`0x${childPkHex}`);
      if (account.address.toLowerCase() !== wallet.address.toLowerCase()) {
        // Should be unreachable — both derive from the same account key, same
        // path (custodySeeds.ts). Refuse rather than sign from a mismatch.
        await markFailed(t, job.id, "Derived signing key does not match this account's deposit address.");
        return;
      }

      if (job.status === "pending") {
        const amountWei = BigInt(job.amount_wei);
        const raw = (await rpcCall("bep20", "eth_getBalance", [account.address, "latest"], { priority: "high" })) as string;
        const balanceWei = BigInt(raw);
        // Defensive re-check, right before signing — the balance could have
        // moved since the route's own check at request time.
        if (balanceWei < amountWei + requiredGasWei()) {
          box.push = await failNothingHeld(t, job, "Not enough BNB left to cover this withdrawal and its own network fee.");
          return;
        }

        const client = createWalletClient({ account, chain: bsc, transport });
        const txHash = await client.sendTransaction({
          to: job.address as `0x${string}`,
          value: amountWei,
        });
        const claim = await t.run(
          "UPDATE bnb_withdrawal_requests SET status = 'sending', tx_hash = ? WHERE id = ? AND status = 'pending'",
          txHash, job.id,
        );
        if (claim.rowCount === 0) return; // lost the race to another tick — should be unreachable under the advisory lock
      } else {
        // 'sending' — poll for the receipt of the tx already broadcast.
        if (!job.tx_hash) {
          await markFailed(t, job.id, "No transaction hash recorded — cannot check status.");
          return;
        }
        const receipt = (await rpcCall("bep20", "eth_getTransactionReceipt", [job.tx_hash], { priority: "high" })) as
          { status: string } | null;
        if (!receipt) return; // still pending on-chain, check again next tick
        if (receipt.status !== "0x1") {
          box.push = await failNothingHeld(t, job, `Transaction ${job.tx_hash} reverted.`);
          return;
        }
        const done = await t.get<{ user_id: string }>(
          `UPDATE bnb_withdrawal_requests SET status = 'paid', completed_at = ?
           WHERE id = ? AND status = 'sending' RETURNING user_id`,
          new Date().toISOString(), job.id,
        );
        if (done) {
          box.push = {
            userId: done.user_id, title: "Your BNB is sent",
            body: "We sent your BNB. Check your wallet.", url: "/wallet/bnb",
          };
        }
      }
    } catch (err) {
      // See advanceRelayJob for why a cost-ceiling refusal must not spend an
      // attempt: nothing was tried, and the retry budget is what retires a job.
      if (err instanceof CostCeilingError) return;
      await t.run(
        "UPDATE bnb_withdrawal_requests SET attempts = attempts + 1, last_error = ? WHERE id = ?",
        (err as Error)?.message ?? String(err), job.id,
      );
    }
  });

  if (box.push) void sendPushToUser(box.push.userId, box.push);
}

// Marks the job failed. Always safe to call — see this file's header: there
// is never anything held internally to restore.
async function failNothingHeld(t: Pick<TxApi, "run">, job: BnbJob, error: string): Promise<PendingPush | null> {
  await markFailed(t, job.id, error);
  return {
    userId: job.user_id, title: "About your BNB withdrawal",
    body: "We could not send this one. Your BNB is still in your wallet.", url: "/wallet/bnb",
  };
}

export async function tickBnbWithdrawals(): Promise<void> {
  const ids = await findWorkIds();
  for (const id of ids) {
    await advanceBnbWithdrawal(id);
  }
}
