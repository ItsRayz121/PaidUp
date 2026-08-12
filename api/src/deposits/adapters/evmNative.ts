// Native-value (BNB) deposit adapter.
//
// A plain BNB send emits NO log event — eth_getLogs (evm.ts's whole mechanism)
// is structurally blind to it. The only way to see one over plain JSON-RPC is
// to walk full block bodies (eth_getBlockByNumber(..., true)) and look at each
// top-level transaction's own `to`/`value`. That is what this file does, and
// ONLY that: a BNB transfer moved out of a contract call (an "internal
// transaction") is invisible here, same "no full trace-based indexer"
// boundary this codebase already draws for the wider chain (CLAUDE.md, wallet
// screen entry, 2026-08-08 third pass). Fine for ordinary wallet-to-wallet
// sends, which is the real case a user in these markets actually does.
//
// ⚠️ ONE RPC CALL PER BLOCK, not per 5,000-block window like evm.ts's log
// scan — so the catch-up range here is deliberately much smaller. Steady
// state (no backlog) only ever asks for the handful of blocks since the last
// tick; this cap only matters after downtime.
import { rpcCall } from "../../rpc.ts";
import { sql } from "../../db.ts";
import type { ObservedNativeDeposit } from "../types.ts";

const MAX_NATIVE_BLOCK_RANGE = 100;

type EvmTx = { hash: string; from: string; to: string | null; value: string; blockHash: string };
type EvmBlockWithTxs = { number: string; hash: string; transactions: EvmTx[] } | null;

export async function scanEvmNativeChain(
  chain: string,
  fromBlock: number,
  toBlockCap: number,
): Promise<{ deposits: ObservedNativeDeposit[]; scannedTo: number }> {
  if (fromBlock > toBlockCap) return { deposits: [], scannedTo: fromBlock - 1 };

  const wallets = await sql.all<{ user_id: string; address: string }>(
    "SELECT user_id, address FROM deposit_wallets WHERE chain = ?", chain,
  );
  if (wallets.length === 0) return { deposits: [], scannedTo: toBlockCap };
  const byAddress = new Map(wallets.map((w) => [w.address.toLowerCase(), w.user_id]));

  const toBlock = Math.min(fromBlock + MAX_NATIVE_BLOCK_RANGE - 1, toBlockCap);
  const deposits: ObservedNativeDeposit[] = [];

  for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
    const block = (await rpcCall(chain, "eth_getBlockByNumber", [
      "0x" + blockNum.toString(16), true,
    ])) as EvmBlockWithTxs;
    if (!block) continue; // not produced yet, or a transient gap — next tick re-covers it

    for (const tx of block.transactions) {
      if (!tx.to) continue; // contract creation — never a deposit-address recipient
      const userId = byAddress.get(tx.to.toLowerCase());
      if (!userId) continue;
      const amountWei = BigInt(tx.value);
      if (amountWei <= 0n) continue; // a plain call with no value attached, not a deposit

      deposits.push({
        userId, chain, address: tx.to, txHash: tx.hash, fromAddress: tx.from,
        amountWei, blockNumber: blockNum, blockHash: block.hash,
      });
    }
  }

  return { deposits, scannedTo: toBlock };
}
