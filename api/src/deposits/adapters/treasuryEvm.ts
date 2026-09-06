// Treasury-address scanner — watches for ANY USDT Transfer (and, optionally,
// native BNB transfer) where the TREASURY WALLET is either side, not just
// incoming to a per-user deposit address (that is deposits/adapters/evm.ts's
// job). Same adaptive range-shrinking discipline as that file — a public BSC
// node refuses a wide eth_getLogs window long before it refuses a narrow one
// (CLAUDE.md, 2026-08-12) — reusing its exported helpers rather than a second,
// independently-typed copy that could silently drift.
import { rpcCall } from "../../rpc.ts";
import { config } from "../../config.ts";
import { ONCHAIN_CHAINS } from "../../payout.ts";
import {
  TRANSFER_TOPIC, MAX_BLOCK_RANGE, MIN_BLOCK_RANGE, MAX_ADDRESSES_PER_CALL,
  addressToTopic, topicToAddress, toMicroUsdt, isRangeLimitError, type EvmLog,
} from "./evm.ts";

export type ObservedTreasuryTx = {
  chain: string;
  txHash: string;
  logIndex: number | null; // null for a native transfer
  blockNumber: number;
  blockHash: string;
  fromAddress: string;
  toAddress: string;
  tokenSymbol: "USDT" | "BNB";
  tokenAddress: string | null;
  tokenDecimals: number;
  amountRaw: string;
  amountMicro: number | null; // null for BNB — no fixed USD rate is stored on this ledger
};

// Own instance, deliberately not shared with evm.ts's — a different query
// shape/address set can legitimately need a different working window.
const lastGoodRange = new Map<string, number>();

async function fetchLogsForWindow(
  chain: string, fromBlock: number, toBlock: number, tokenAddress: string,
  addrList: string[], position: "from" | "to",
): Promise<EvmLog[]> {
  const logs: EvmLog[] = [];
  for (let i = 0; i < addrList.length; i += MAX_ADDRESSES_PER_CALL) {
    const batch = addrList.slice(i, i + MAX_ADDRESSES_PER_CALL);
    const topics = position === "to"
      ? [TRANSFER_TOPIC, null, batch.map(addressToTopic)]
      : [TRANSFER_TOPIC, batch.map(addressToTopic), null];
    const batchLogs = (await rpcCall(chain, "eth_getLogs", [{
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
      address: tokenAddress,
      topics,
    }], { priority: "high" })) as EvmLog[];
    logs.push(...batchLogs);
  }
  return logs;
}

// Scans for USDT Transfer events where any address in `treasuryAddrs` is
// EITHER the sender or the recipient — two eth_getLogs calls per window
// (topic position 1 = from, position 2 = to; a single call cannot OR across
// two topic positions), both under the same adaptive range so a provider's
// range limit shrinks the window for both at once.
export async function scanTreasuryUsdt(
  chain: string, treasuryAddrs: string[], fromBlock: number, toBlockCap: number,
): Promise<{ txs: ObservedTreasuryTx[]; scannedTo: number }> {
  const token = ONCHAIN_CHAINS[chain as keyof typeof ONCHAIN_CHAINS];
  if (!token || treasuryAddrs.length === 0 || fromBlock > toBlockCap) {
    return { txs: [], scannedTo: fromBlock - 1 };
  }

  let range = Math.min(lastGoodRange.get(chain) ?? MAX_BLOCK_RANGE, MAX_BLOCK_RANGE);
  let toBlock: number;
  let incoming: EvmLog[] = [];
  let outgoing: EvmLog[] = [];
  for (;;) {
    toBlock = Math.min(fromBlock + range - 1, toBlockCap);
    try {
      [incoming, outgoing] = await Promise.all([
        fetchLogsForWindow(chain, fromBlock, toBlock, token.usdt, treasuryAddrs, "to"),
        fetchLogsForWindow(chain, fromBlock, toBlock, token.usdt, treasuryAddrs, "from"),
      ]);
      break;
    } catch (e) {
      if (!isRangeLimitError(e) || range <= MIN_BLOCK_RANGE) throw e;
      range = Math.max(MIN_BLOCK_RANGE, Math.floor(range / 2));
    }
  }
  lastGoodRange.set(chain, range);

  const seen = new Set<string>();
  const txs: ObservedTreasuryTx[] = [];
  for (const log of [...incoming, ...outgoing]) {
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) continue; // a log matching both filters (self-transfer) — counted once
    seen.add(key);
    const from = topicToAddress(log.topics[1]);
    const to = topicToAddress(log.topics[2]);
    if (from.toLowerCase() === to.toLowerCase()) continue; // treasury -> treasury: not a real business event
    txs.push({
      chain, txHash: log.transactionHash, logIndex: parseInt(log.logIndex, 16),
      blockNumber: parseInt(log.blockNumber, 16), blockHash: log.blockHash,
      fromAddress: from, toAddress: to,
      tokenSymbol: "USDT", tokenAddress: token.usdt, tokenDecimals: token.decimals,
      amountRaw: BigInt(log.data).toString(),
      amountMicro: Number(toMicroUsdt(BigInt(log.data), token.decimals)),
    });
  }
  return { txs, scannedTo: toBlock };
}

// ---- Native (BNB) — gated behind config.treasuryNativeScanEnabled ---------
// One eth_getBlockByNumber(..., true) per block, same cost shape as
// deposits/adapters/evmNative.ts and the same reason that file's own scan is
// off by default (CLAUDE.md, 2026-08-13). Scoped to a small, fixed address
// set (the treasury address, maybe two), so the cost does not grow with the
// user base the way the per-user native scanner's did — but it is still one
// RPC call per block, forever, once turned on.
type EvmTx = { hash: string; from: string; to: string | null; value: string };
type EvmBlockWithTxs = { number: string; hash: string; transactions: EvmTx[] } | null;

export async function scanTreasuryNative(
  chain: string, treasuryAddrs: string[], fromBlock: number, toBlockCap: number,
): Promise<{ txs: ObservedTreasuryTx[]; scannedTo: number }> {
  if (treasuryAddrs.length === 0 || fromBlock > toBlockCap) return { txs: [], scannedTo: fromBlock - 1 };
  const wanted = new Set(treasuryAddrs.map((a) => a.toLowerCase()));
  const toBlock = Math.min(fromBlock + config.nativeDepositScanBlockRange - 1, toBlockCap);
  const txs: ObservedTreasuryTx[] = [];

  for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
    const block = (await rpcCall(chain, "eth_getBlockByNumber", [
      "0x" + blockNum.toString(16), true,
    ], { priority: "high" })) as EvmBlockWithTxs;
    if (!block) continue;
    for (const tx of block.transactions) {
      if (!tx.to) continue;
      const from = tx.from.toLowerCase();
      const to = tx.to.toLowerCase();
      if (from === to) continue;
      if (!wanted.has(from) && !wanted.has(to)) continue;
      const amountWei = BigInt(tx.value);
      if (amountWei <= 0n) continue;
      txs.push({
        chain, txHash: tx.hash, logIndex: null,
        blockNumber: blockNum, blockHash: block.hash,
        fromAddress: tx.from, toAddress: tx.to,
        tokenSymbol: "BNB", tokenAddress: null, tokenDecimals: 18,
        amountRaw: amountWei.toString(), amountMicro: null,
      });
    }
  }
  return { txs, scannedTo: toBlock };
}
