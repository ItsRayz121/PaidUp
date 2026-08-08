// The per-user-wallet payout relay (founder, 2026-08-08) — routes a
// withdrawal or refund's DESTINATION transaction through the user's own
// derived deposit address (custody.ts) instead of sending it directly from
// treasury. Two purposes, two different reasons for existing:
//
//   "refund"     — the user's own address genuinely already holds this USDT
//                   (their own prior top-up deposit). Signing from that
//                   address is real: it is the actual money, at the actual
//                   place the user put it.
//   "withdrawal" — task/referral earnings have NEVER existed as USDT at any
//                   user's address; they only ever existed as a treasury
//                   balance funded by ad-network revenue. So this is a
//                   deliberate PASS-THROUGH: treasury funds gas AND the exact
//                   net amount into the user's own address first, which then
//                   forwards it to the destination. This is the founder's
//                   informed choice, not an oversight — told plainly that it
//                   costs 2-3 on-chain transactions instead of 1 and does NOT
//                   reduce custody risk (the platform already holds one
//                   master key, custodySeeds.ts, capable of signing for every
//                   user address — the same key that made the old sweep-to-
//                   treasury possible makes this pass-through possible too).
//                   Chose it anyway; recorded here, not hidden.
//
// ⚠️ FAIL CLOSED. Every call site checks relayAvailable(chain) FIRST and
// falls straight back to the pre-existing direct-treasury payout.ts path
// when it's false. Unsetting CUSTODY_SEED_EVM_ENCRYPTED/_SECRET reverts the
// whole feature to today's behaviour with no code change.
//
// State machine, modeled directly on deposits/sweep.ts (same resumability,
// same rpcCall/viem usage, same "never throw — record attempts/last_error,
// retry next tick" posture). Every phase transition is a conditional
// `UPDATE ... WHERE status = <expected>` so two ticks racing the same job
// can never both broadcast the same step — new code, so unlike sweep.ts's
// unguarded transitions this costs nothing extra to add.
//
//   refund:     pending -> gas_sent -> gas_confirmed -> prefund_confirmed
//               (balance verified, not funded) -> forward_sent -> forward_confirmed
//   withdrawal: pending -> gas_sent -> gas_confirmed -> prefund_sent ->
//               prefund_confirmed -> forward_sent -> forward_confirmed
//
// 'failed' is terminal and NOT auto-retried (same convention as sweep_jobs)
// — a genuine on-chain revert needs a human, not a loop that might resend
// into the same failure. The underlying withdrawal_requests /
// usdt_refund_requests row is left at 'sending' (visibly stuck, not silently
// marked paid) so staff see it.
import {
  createWalletClient, createPublicClient, http, fallback, parseUnits, erc20Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sql, now, newId, getOrCreateDepositWallet, type TxApi } from "./db.ts";
import { config } from "./config.ts";
import { ONCHAIN_CHAINS } from "./payout.ts";
import { treasurySignerKey } from "./signer.ts";
import { custodyEnabled } from "./custody.ts";
import { deriveChildPrivateKey, sweepSigningEnabled } from "./custodySeeds.ts";
import { rpcCall } from "./rpc.ts";
import { sendPushToUser } from "./push.ts";

export type RelayPurpose = "withdrawal" | "refund";

// Whether the relay path can be attempted for this chain right now. Checked
// by every call site BEFORE creating a job — false means "do what payout.ts
// already did", never "fail the request".
export function relayAvailable(chain: string): boolean {
  return chain === "bep20" && custodyEnabled(chain) && sweepSigningEnabled("evm") && treasurySignerKey() !== null;
}

function microToDecimalString(micro: number): string {
  return (micro / 1_000_000).toFixed(6);
}

type CreateJobParams = {
  chain: "bep20";
  userId: string;
  toAddress: string;
  amountMicro: number; // net, post-fee, micro-USDT
  needsPrefund: boolean; // true = withdrawal pass-through, false = refund
};

// Idempotent — ON CONFLICT (purpose, request_id) DO NOTHING means calling
// this twice for the same request (an auto-settle racing a staff retry) never
// opens a second live job for the same money.
export async function createRelayJob(
  purpose: RelayPurpose, requestId: string, params: CreateJobParams, t: Pick<TxApi, "run"> = sql,
): Promise<void> {
  if (params.amountMicro <= 0) throw new Error("Relay job amount must be positive.");
  const wallet = await getOrCreateDepositWallet(params.userId, params.chain);
  await t.run(
    `INSERT INTO payout_relay_jobs
       (id, purpose, request_id, chain, user_id, from_address, addr_index, to_address, amount_micro, needs_prefund, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?)
     ON CONFLICT (purpose, request_id) DO NOTHING`,
    newId(), purpose, requestId, params.chain, params.userId, wallet.address, wallet.addrIndex,
    params.toAddress, params.amountMicro, params.needsPrefund ? 1 : 0, now(),
  );
}

type RelayJob = {
  id: string; purpose: RelayPurpose; request_id: string; chain: string; user_id: string;
  from_address: string; addr_index: string | number; to_address: string; amount_micro: string | number;
  needs_prefund: number; status: string;
  gas_tx_hash: string | null; prefund_tx_hash: string | null; forward_tx_hash: string | null;
};

async function findRelayWork(): Promise<RelayJob[]> {
  return sql.all<RelayJob>(
    `SELECT * FROM payout_relay_jobs WHERE status NOT IN ('forward_confirmed','failed') ORDER BY created_at`,
  );
}

async function transition(id: string, from: string, to: string, extra: Record<string, string> = {}): Promise<boolean> {
  const cols = ["status = ?"];
  const vals: string[] = [to];
  for (const [k, v] of Object.entries(extra)) { cols.push(`${k} = ?`); vals.push(v); }
  const claim = await sql.run(
    `UPDATE payout_relay_jobs SET ${cols.join(", ")} WHERE id = ? AND status = ?`,
    ...vals, id, from,
  );
  return claim.rowCount > 0;
}

async function markFailed(id: string, error: string): Promise<void> {
  await sql.run(
    "UPDATE payout_relay_jobs SET status = 'failed', last_error = ?, attempts = attempts + 1 WHERE id = ? AND status <> 'failed'",
    error, id,
  );
}

// The ONE place a completed relay job closes the loop: flips the underlying
// request to 'paid' and fires the "money sent" push, moved here from the old
// synchronous call sites because settlement is asynchronous now. Leaves
// reviewed_by/reviewed_at alone — those were stamped when the request moved
// TO 'sending' (auto-settle or a staff click), not now.
async function completeRequest(job: RelayJob): Promise<void> {
  const usdt = microToDecimalString(Number(job.amount_micro));
  if (job.purpose === "withdrawal") {
    const updated = await sql.get<{ user_id: string }>(
      `UPDATE withdrawal_requests SET status = 'paid', paid_at = ?, tx_hash = ?, usdt_amount = ?
       WHERE id = ? AND status = 'sending' RETURNING user_id`,
      now(), job.forward_tx_hash, usdt, job.request_id,
    );
    if (updated) {
      void sendPushToUser(updated.user_id, {
        title: "Your money is sent",
        body: `We sent ${usdt} USDT to your wallet. Check it now.`,
        url: "/wallet",
      });
    }
  } else {
    const updated = await sql.get<{ user_id: string }>(
      `UPDATE usdt_refund_requests SET status = 'paid', tx_hash = ?
       WHERE id = ? AND status = 'sending' RETURNING user_id`,
      job.forward_tx_hash, job.request_id,
    );
    if (updated) {
      void sendPushToUser(updated.user_id, {
        title: "Your money is sent",
        body: `We sent ${usdt} USDT back to your wallet. Check it now.`,
        url: "/wallet",
      });
    }
  }
}

export async function advanceRelayJob(job: RelayJob): Promise<void> {
  // ⚠️ SECURITY-REVIEW FIX (2026-08-08): every call site that CREATES a job
  // checks `config.payoutMode === "onchain"` — relayAvailable() alone does
  // not know about the mode, only whether the signing keys exist. That
  // matters here too, not just at creation: without this check, flipping
  // PAYOUT_MODE back to "manual" — the operator's emergency stop — would NOT
  // stop a job already sitting in a non-terminal state from continuing to
  // sign and broadcast on the next tick. This makes the switch actually mean
  // "nothing signs," not just "nothing NEW gets queued."
  if (config.payoutMode !== "onchain") return;
  const token = ONCHAIN_CHAINS[job.chain as keyof typeof ONCHAIN_CHAINS];
  if (!token) return;
  const treasuryPk = treasurySignerKey();
  if (!treasuryPk) return;

  const transport = fallback(config.payoutRpc[job.chain].map((url) => http(url)));
  const publicClient = createPublicClient({ chain: token.viemChain, transport });
  const treasuryAccount = privateKeyToAccount(treasuryPk);

  try {
    // The decrypted child key. Local for the rest of this call only — never
    // assigned to anything that outlives it. Same posture as sweep.ts.
    const childPkHex = deriveChildPrivateKey("evm", Number(job.addr_index));
    const childAccount = privateKeyToAccount(`0x${childPkHex}`);
    if (childAccount.address.toLowerCase() !== job.from_address.toLowerCase()) {
      // Should be unreachable (both derive from the same account key, same
      // path, as custodySeeds.ts guarantees) — refuse rather than sign from
      // an address that doesn't match what the job says it's paying from.
      await markFailed(job.id, "Derived signing key does not match the job's recorded address.");
      return;
    }

    if (job.status === "pending") {
      const treasuryClient = createWalletClient({ account: treasuryAccount, chain: token.viemChain, transport });
      const gasTx = await treasuryClient.sendTransaction({
        to: childAccount.address,
        value: BigInt(config.evmSweepGasAmountWei),
      });
      if (await transition(job.id, "pending", "gas_sent", { gas_tx_hash: gasTx })) {
        job = { ...job, status: "gas_sent", gas_tx_hash: gasTx };
      } else return; // lost the race to another tick — let it drive the job
    }

    if (job.status === "gas_sent") {
      const receipt = (await rpcCall(job.chain, "eth_getTransactionReceipt", [job.gas_tx_hash])) as
        { status: string } | null;
      if (!receipt) return; // not mined yet — next tick checks again
      if (receipt.status !== "0x1") { await markFailed(job.id, `Gas funding tx ${job.gas_tx_hash} reverted.`); return; }
      if (await transition(job.id, "gas_sent", "gas_confirmed")) {
        job = { ...job, status: "gas_confirmed" };
      } else return;
    }

    if (job.status === "gas_confirmed") {
      if (job.needs_prefund) {
        const amount = parseUnits(microToDecimalString(Number(job.amount_micro)), token.decimals);
        const treasuryClient = createWalletClient({ account: treasuryAccount, chain: token.viemChain, transport });
        const prefundTx = await treasuryClient.writeContract({
          address: token.usdt, abi: erc20Abi, functionName: "transfer",
          args: [childAccount.address, amount],
        });
        if (await transition(job.id, "gas_confirmed", "prefund_sent", { prefund_tx_hash: prefundTx })) {
          job = { ...job, status: "prefund_sent", prefund_tx_hash: prefundTx };
        } else return;
      } else {
        // Refund: the money should already be here (the user's own prior
        // deposit) — verify on-chain before ever signing, never trust the row.
        const rawBalance = (await publicClient.readContract({
          address: token.usdt, abi: erc20Abi, functionName: "balanceOf", args: [childAccount.address],
        })) as bigint;
        const needed = parseUnits(microToDecimalString(Number(job.amount_micro)), token.decimals);
        if (rawBalance < needed) {
          await markFailed(
            job.id,
            `Address ${childAccount.address} holds less than the refund amount — cannot sign a refund it can't back.`,
          );
          return;
        }
        if (await transition(job.id, "gas_confirmed", "prefund_confirmed")) {
          job = { ...job, status: "prefund_confirmed" };
        } else return;
      }
    }

    if (job.status === "prefund_sent") {
      const receipt = (await rpcCall(job.chain, "eth_getTransactionReceipt", [job.prefund_tx_hash])) as
        { status: string } | null;
      if (!receipt) return;
      if (receipt.status !== "0x1") { await markFailed(job.id, `Prefund tx ${job.prefund_tx_hash} reverted.`); return; }
      if (await transition(job.id, "prefund_sent", "prefund_confirmed")) {
        job = { ...job, status: "prefund_confirmed" };
      } else return;
    }

    if (job.status === "prefund_confirmed") {
      const amount = parseUnits(microToDecimalString(Number(job.amount_micro)), token.decimals);
      const childClient = createWalletClient({ account: childAccount, chain: token.viemChain, transport });
      const forwardTx = await childClient.writeContract({
        address: token.usdt, abi: erc20Abi, functionName: "transfer",
        args: [job.to_address as `0x${string}`, amount],
      });
      if (await transition(job.id, "prefund_confirmed", "forward_sent", { forward_tx_hash: forwardTx })) {
        job = { ...job, status: "forward_sent", forward_tx_hash: forwardTx };
      } else return;
    }

    if (job.status === "forward_sent") {
      const receipt = (await rpcCall(job.chain, "eth_getTransactionReceipt", [job.forward_tx_hash])) as
        { status: string } | null;
      if (!receipt) return;
      if (receipt.status !== "0x1") { await markFailed(job.id, `Forward tx ${job.forward_tx_hash} reverted.`); return; }
      const moved = await transition(job.id, "forward_sent", "forward_confirmed", { completed_at: now() });
      if (moved) await completeRequest(job);
    }
  } catch (err) {
    await sql.run(
      "UPDATE payout_relay_jobs SET attempts = attempts + 1, last_error = ? WHERE id = ?",
      (err as Error)?.message ?? String(err), job.id,
    );
  }
}

export async function tickPayoutRelay(): Promise<void> {
  const jobs = await findRelayWork();
  for (const job of jobs) {
    await advanceRelayJob(job);
  }
}
