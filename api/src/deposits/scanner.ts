// Deposit scanner orchestrator — CUSTODY_SPEC.md § 5 step 2.
//
// Same shape as mining/engine.ts's epoch settlement (wired into server.ts's
// existing timer): one setInterval, one global pg_advisory_xact_lock so two
// API instances never scan the same block range twice. This codebase runs a
// single Fastify service on Railway — no queue, no Redis — so this follows
// the one pattern already proven safe for recurring work under that shape.
//
// ⚠️ The whole tick (RPC calls included) runs inside one transaction, so a
// failure partway through rolls back the cursor advance along with any
// credits from that batch — the next tick re-scans the same range rather than
// silently skipping it. The tradeoff: a pool connection sits held for the
// duration of the RPC round trips, not just DB work. Acceptable at this
// tick's cadence and pool size; revisit if scan volume ever grows enough for
// that to matter.
import { sql, now, type TxApi } from "../db.ts";
import { config } from "../config.ts";
import { rpcCall } from "../rpc.ts";
import { custodyEnabled } from "../custody.ts";
import { scanEvmChain } from "./adapters/evm.ts";
import { recordObservedDeposit } from "./credit.ts";

// Chains this scanner knows how to walk. Grows as chain families are added
// (TRC20 shares this adapter's log-scanning shape; UTXO/Solana/Aptos need
// their own adapter and their own entry in tickDepositScan below).
const EVM_CHAINS = ["bep20"];

async function latestBlock(chain: string): Promise<number> {
  const hex = (await rpcCall(chain, "eth_blockNumber", [])) as string;
  return parseInt(hex, 16);
}

async function scanOneEvmChain(chain: string, t: TxApi): Promise<void> {
  const confirmations = config.depositConfirmations[chain] ?? 15;
  const cursor = await t.get<{ last_scanned_block: string }>(
    "SELECT last_scanned_block FROM deposit_scan_cursors WHERE chain = ?", chain,
  );
  const latest = await latestBlock(chain);
  const safeTip = latest - confirmations;
  // No cursor yet: start one block back from the safe tip rather than genesis
  // — this is a listener for NEW deposits, not a historical backfill tool.
  const fromBlock = cursor ? Number(cursor.last_scanned_block) + 1 : Math.max(0, safeTip - 1);
  if (fromBlock > safeTip) return; // nothing has reached the confirmation depth yet

  const { deposits, scannedTo } = await scanEvmChain(chain, fromBlock, safeTip);
  for (const d of deposits) {
    await recordObservedDeposit(d, confirmations, t);
  }

  await t.run(
    `INSERT INTO deposit_scan_cursors (chain, last_scanned_block, updated_at)
     VALUES (?,?,?)
     ON CONFLICT (chain) DO UPDATE SET last_scanned_block = EXCLUDED.last_scanned_block, updated_at = EXCLUDED.updated_at`,
    chain, scannedTo, now(),
  );
}

export async function tickDepositScan(): Promise<{ chain: string; scanned: boolean }[]> {
  return sql.tx(async (t) => {
    // One global lock, not per-chain — scanning is I/O-bound and cheap enough
    // to serialize across chains; split into per-chain locks only if scan
    // time ever approaches the tick interval.
    await t.run("SELECT pg_advisory_xact_lock(hashtext('deposit-scan'))");

    const results: { chain: string; scanned: boolean }[] = [];
    for (const chain of EVM_CHAINS) {
      if (!custodyEnabled(chain)) {
        results.push({ chain, scanned: false });
        continue; // no xpub configured for this chain => no deposit addresses to watch
      }
      await scanOneEvmChain(chain, t);
      results.push({ chain, scanned: true });
    }
    return results;
  });
}
