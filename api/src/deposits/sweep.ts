// EVM sweeper — CUSTODY_SPEC.md § 5 step 3. Moves a deposit address's USDT
// balance into treasury, in two phases so a crash or retry resumes from the
// right step instead of re-sending gas that already landed:
//   pending -> gas_sent -> gas_confirmed -> swept
//
// ⚠️ OFF BY DEFAULT since 2026-08-08 (config.custodySweepEnabled) — the
// founder chose "never sweep" so a deposit stays at the user's own address
// long enough for a refund (and payoutRelay.ts's withdrawal pass-through) to
// genuinely be signed BY that address instead of by treasury. The code stays
// here, working, for a possible future admin-triggered manual consolidation;
// it just no longer runs on the automatic tick. See payoutRelay.ts's header
// for what replaced the "consolidate then pay from treasury" flow this used
// to feed.
//
// ⚠️ NEVER CALLS postUsdt(). Crediting already happened when chain_deposits
// flipped to 'credited' (deposits/credit.ts) — this file's only job is
// treasury consolidation. Keep this file free of any usdt_ledger import; that
// absence is the actual guarantee, not just a comment.
//
// ⚠️ THIS IS WHERE A DECRYPTED CHILD PRIVATE KEY EXISTS, briefly. It comes
// from custodySeeds.deriveChildPrivateKey(), lives in a local for exactly one
// signature, and is never stored, logged, or returned.
import {
  createWalletClient, createPublicClient, http, fallback, parseUnits, erc20Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sql, now, newId } from "../db.ts";
import { config } from "../config.ts";
import { ONCHAIN_CHAINS } from "../payout.ts";
import { treasurySignerKey } from "../signer.ts";
import { deriveChildPrivateKey, sweepSigningEnabled } from "../custodySeeds.ts";
import { rpcCall } from "../rpc.ts";
import { charge } from "../costGuard.ts";

type SweepJob = { id: string; status: string; gas_tx_hash: string | null };

// Addresses worth checking this tick: anything with an unswept credited
// deposit (a NEW candidate, checked against the dust floor once a job opens)
// or an already-open job stuck mid-phase (must be driven to completion
// regardless of the floor — a job once started is finished, not abandoned).
async function findSweepWork(chain: string): Promise<{ address: string; addrIndex: number }[]> {
  const rows = await sql.all<{ address: string; addr_index: string }>(
    `SELECT DISTINCT dw.address, dw.addr_index
     FROM deposit_wallets dw
     WHERE dw.chain = ?
       AND (
         EXISTS (
           SELECT 1 FROM chain_deposits cd
           WHERE cd.chain = dw.chain AND LOWER(cd.address) = LOWER(dw.address)
             AND cd.status = 'credited' AND cd.swept_at IS NULL
         )
         OR EXISTS (
           SELECT 1 FROM sweep_jobs sj
           WHERE sj.chain = dw.chain AND sj.deposit_wallet_ref = dw.address
             AND sj.status IN ('gas_sent','gas_confirmed')
         )
       )`,
    chain,
  );
  return rows.map((r) => ({ address: r.address, addrIndex: Number(r.addr_index) }));
}

async function openOrGetJob(
  chain: string, address: string, publicClient: ReturnType<typeof createPublicClient>,
  token: NonNullable<(typeof ONCHAIN_CHAINS)[keyof typeof ONCHAIN_CHAINS]>,
): Promise<SweepJob | null> {
  const existing = await sql.get<SweepJob>(
    `SELECT id, status, gas_tx_hash FROM sweep_jobs
     WHERE chain = ? AND deposit_wallet_ref = ? AND status NOT IN ('swept','failed')`,
    chain, address,
  );
  if (existing) return existing;

  const rawBalance = (await publicClient.readContract({
    address: token.usdt, abi: erc20Abi, functionName: "balanceOf", args: [address as `0x${string}`],
  })) as bigint;
  const dustFloorRaw = parseUnits((config.sweepDustFloorMicro / 1_000_000).toString(), token.decimals);
  if (rawBalance < dustFloorRaw) return null; // not worth the gas yet

  await sql.run(
    `INSERT INTO sweep_jobs (id, chain, deposit_wallet_ref, token, amount_at_sweep_start, status, created_at)
     VALUES (?,?,?,?,?, 'pending', ?)
     ON CONFLICT (chain, deposit_wallet_ref) WHERE status NOT IN ('swept','failed') DO NOTHING`,
    newId(), chain, address, "usdt", rawBalance.toString(), now(),
  );
  // Re-read rather than trust our own insert: if another instance won a race
  // to open this job at the same instant, this picks up ITS row, not ours.
  return (await sql.get<SweepJob>(
    `SELECT id, status, gas_tx_hash FROM sweep_jobs
     WHERE chain = ? AND deposit_wallet_ref = ? AND status NOT IN ('swept','failed')`,
    chain, address,
  )) ?? null;
}

async function markDepositsSwept(chain: string, address: string): Promise<void> {
  await sql.run(
    `UPDATE chain_deposits SET swept_at = ?
     WHERE chain = ? AND LOWER(address) = LOWER(?) AND status = 'credited' AND swept_at IS NULL`,
    now(), chain, address,
  );
}

export async function sweepDepositAddress(chain: string, address: string, addrIndex: number): Promise<void> {
  if (!config.custodySweepEnabled) return; // "never sweep" default — see header
  if (!sweepSigningEnabled("evm")) return; // no sweep seed configured — deposits sit safely unswept
  const token = ONCHAIN_CHAINS[chain as keyof typeof ONCHAIN_CHAINS];
  if (!token) return;
  const treasuryPk = treasurySignerKey();
  if (!treasuryPk) return; // no treasury signer — same as sweeping being off

  // Charged against the process ceiling before anything is spent (costGuard.ts).
  // This is the worst-shaped loop in the codebase for cost: it runs PER DEPOSIT
  // ADDRESS, and viem's sendTransaction with a local account is roughly five
  // JSON-RPC calls before the broadcast (chain id, nonce, fee estimate, gas
  // estimate, raw send), times up to two sends, times the transport's own
  // retries. 30 is a deliberate over-estimate — the point of a ceiling is that
  // it is not surprised. These go out through viem's transport rather than
  // rpc.ts, so this is the only place they can be counted.
  //
  // "low": sweeping is treasury consolidation, it is OFF by default, and a
  // skipped sweep costs nothing but a delay — the money is already credited
  // and already at the user's own address (deposits/sweep.ts's header).
  if (!charge("rpc", 30, "low")) return;

  const transport = fallback(config.payoutRpc[chain].map((url) => http(url)));
  const publicClient = createPublicClient({ chain: token.viemChain, transport });
  const treasuryAccount = privateKeyToAccount(treasuryPk);

  let job = await openOrGetJob(chain, address, publicClient, token);
  if (!job) return;

  try {
    // The decrypted child key. Local for the rest of this function only —
    // never assigned to anything that outlives this call.
    const childPkHex = deriveChildPrivateKey("evm", addrIndex);
    const childAccount = privateKeyToAccount(`0x${childPkHex}`);

    if (job.status === "pending") {
      const treasuryClient = createWalletClient({ account: treasuryAccount, chain: token.viemChain, transport });
      const gasTx = await treasuryClient.sendTransaction({
        to: childAccount.address,
        value: BigInt(config.evmSweepGasAmountWei),
      });
      await sql.run("UPDATE sweep_jobs SET status = 'gas_sent', gas_tx_hash = ? WHERE id = ?", gasTx, job.id);
      job = { ...job, status: "gas_sent", gas_tx_hash: gasTx };
    }

    if (job.status === "gas_sent") {
      const receipt = (await rpcCall(chain, "eth_getTransactionReceipt", [job.gas_tx_hash])) as
        { status: string } | null;
      if (!receipt) return; // gas tx not mined yet — next tick checks again
      if (receipt.status !== "0x1") throw new Error(`Gas funding tx ${job.gas_tx_hash} reverted.`);
      await sql.run("UPDATE sweep_jobs SET status = 'gas_confirmed' WHERE id = ?", job.id);
      job = { ...job, status: "gas_confirmed" };
    }

    if (job.status === "gas_confirmed") {
      const rawBalance = (await publicClient.readContract({
        address: token.usdt, abi: erc20Abi, functionName: "balanceOf", args: [childAccount.address],
      })) as bigint;

      if (rawBalance === 0n) {
        // Already swept by an earlier attempt that broadcast successfully but
        // crashed before recording it — treat as done, not as an error.
        await sql.run("UPDATE sweep_jobs SET status = 'swept', completed_at = ? WHERE id = ?", now(), job.id);
      } else {
        const childClient = createWalletClient({ account: childAccount, chain: token.viemChain, transport });
        const sweepTx = await childClient.writeContract({
          address: token.usdt, abi: erc20Abi, functionName: "transfer",
          args: [treasuryAccount.address, rawBalance],
        });
        await sql.run(
          "UPDATE sweep_jobs SET status = 'swept', sweep_tx_hash = ?, completed_at = ? WHERE id = ?",
          sweepTx, now(), job.id,
        );
      }
      await markDepositsSwept(chain, address);
    }
  } catch (err) {
    await sql.run(
      "UPDATE sweep_jobs SET attempts = attempts + 1, last_error = ? WHERE id = ?",
      (err as Error)?.message ?? String(err), job.id,
    );
  }
}

export async function tickSweep(): Promise<void> {
  if (!config.custodySweepEnabled) return; // "never sweep" default — see header
  if (!sweepSigningEnabled("evm")) return;
  for (const chain of ["bep20"]) {
    const work = await findSweepWork(chain);
    for (const w of work) {
      await sweepDepositAddress(chain, w.address, w.addrIndex);
    }
  }
}
