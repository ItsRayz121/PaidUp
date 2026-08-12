// EVM deposit adapter — CUSTODY_SPEC.md § 5 step 2.
//
// Finds USDT Transfer() events landing on any address we've ever handed a
// user, using topics[2] (the indexed `to`) as an OR-filter — one eth_getLogs
// call covers every deposit address at once instead of one call each.
//
// ⚠️ rpc.ts's own header already says public endpoints are not sufficient for
// a listener that must never miss a deposit. This adapter now SURVIVES that
// limit (see adaptive range below) rather than hard-failing the whole scan
// tick on it — but surviving is not the same as scanning fast. Put a paid
// endpoint first in RPC_BEP20 when scan volume needs the throughput back.
import { rpcCall, RpcError } from "../../rpc.ts";
import { sql } from "../../db.ts";
import { ONCHAIN_CHAINS } from "../../payout.ts";
import type { ObservedDeposit } from "../types.ts";

// keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer topic0,
// identical on every EVM chain.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Provider limits vary; these are conservative enough for free-tier public
// nodes AND paid ones, and only affect how many round trips a scan takes.
const MAX_BLOCK_RANGE = 5_000;
const MAX_ADDRESSES_PER_CALL = 200;

// A public BSC node rejects eth_getLogs outright once the block window (or
// the result count) crosses ITS OWN limit — which is not published and is not
// the same across providers. `limit exceeded` is the exact message this
// codebase has seen in production (CLAUDE.md, 2026-08-08). Rather than
// treating that as a hard failure, halve the window and try again: a smaller
// range almost always fits, and it still makes forward progress instead of
// failing the whole tick (and the cursor advance with it) every 20s forever.
const RANGE_LIMIT_PATTERN = /limit|range|too many|exceed|too large/i;
// ⚠️ 200 was too high a floor — measured directly against the real endpoints
// (2026-08-12), not assumed: bnbchain.org's and defibit.io's public dataseed
// nodes refuse eth_getLogs at EVERY width down to 50, and a free-tier
// fallback that does answer (blastapi.io) caps out at exactly 10 inclusive
// blocks. 10 is chosen to land on that ceiling exactly (this file's window is
// `fromBlock..fromBlock+range-1`, so range=10 spans 10 inclusive blocks).
// Going lower than what a real provider needs only costs extra round trips
// during a catch-up backlog — steady-state ticks (a handful of new blocks
// every ~20s) are unaffected either way, since the requested window is
// capped to what's actually needed, not to this floor.
const MIN_BLOCK_RANGE = 10;

// Remembers the last window size that actually worked, per chain, so the
// next tick starts there instead of re-discovering it from MAX_BLOCK_RANGE
// on every single call.
const lastGoodRange = new Map<string, number>();

type EvmLog = {
  transactionHash: string;
  logIndex: string;
  data: string;
  topics: string[];
  blockNumber: string;
  blockHash: string;
};

function addressToTopic(addr: string): string {
  return "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function topicToAddress(topic: string): string {
  return "0x" + topic.slice(-40);
}

// Raw on-chain amount (at the token's own decimals) -> our internal
// micro-USDT (6 dp). BSC USDT is 18 decimals — the same trap payout.ts's
// ONCHAIN_CHAINS map exists to prevent, here in the other direction.
function toMicroUsdt(raw: bigint, decimals: number): bigint {
  if (decimals === 6) return raw;
  if (decimals > 6) return raw / 10n ** BigInt(decimals - 6);
  return raw * 10n ** BigInt(6 - decimals);
}

function isRangeLimitError(e: unknown): boolean {
  return e instanceof RpcError && RANGE_LIMIT_PATTERN.test(e.message);
}

async function fetchLogsForWindow(
  chain: string, fromBlock: number, toBlock: number, tokenAddress: string, addrList: string[],
): Promise<EvmLog[]> {
  const logs: EvmLog[] = [];
  for (let i = 0; i < addrList.length; i += MAX_ADDRESSES_PER_CALL) {
    const batch = addrList.slice(i, i + MAX_ADDRESSES_PER_CALL);
    const batchLogs = (await rpcCall(chain, "eth_getLogs", [{
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
      address: tokenAddress,
      topics: [TRANSFER_TOPIC, null, batch.map(addressToTopic)],
    }])) as EvmLog[];
    logs.push(...batchLogs);
  }
  return logs;
}

// Scan `chain` from `fromBlock` up to at most `toBlockCap`, capped to an
// adaptive window that shrinks on a provider's range/result-size limit and
// remembers what worked. Returns the deposits found and how far it actually
// got — the caller (scanner.ts) persists that as the new cursor.
export async function scanEvmChain(
  chain: string,
  fromBlock: number,
  toBlockCap: number,
): Promise<{ deposits: ObservedDeposit[]; scannedTo: number }> {
  const token = ONCHAIN_CHAINS[chain as keyof typeof ONCHAIN_CHAINS];
  if (!token) return { deposits: [], scannedTo: fromBlock - 1 };
  if (fromBlock > toBlockCap) return { deposits: [], scannedTo: fromBlock - 1 };

  const wallets = await sql.all<{ user_id: string; address: string }>(
    "SELECT user_id, address FROM deposit_wallets WHERE chain = ?", chain,
  );
  if (wallets.length === 0) return { deposits: [], scannedTo: toBlockCap };
  const byAddress = new Map(wallets.map((w) => [w.address.toLowerCase(), w.user_id]));
  const addrList = [...byAddress.keys()];

  let range = Math.min(lastGoodRange.get(chain) ?? MAX_BLOCK_RANGE, MAX_BLOCK_RANGE);
  let logs: EvmLog[];
  let toBlock: number;
  for (;;) {
    toBlock = Math.min(fromBlock + range - 1, toBlockCap);
    try {
      logs = await fetchLogsForWindow(chain, fromBlock, toBlock, token.usdt, addrList);
      break;
    } catch (e) {
      if (!isRangeLimitError(e) || range <= MIN_BLOCK_RANGE) throw e;
      range = Math.max(MIN_BLOCK_RANGE, Math.floor(range / 2));
    }
  }
  lastGoodRange.set(chain, range);

  const deposits: ObservedDeposit[] = [];
  for (const log of logs) {
    const toAddr = topicToAddress(log.topics[2]);
    const userId = byAddress.get(toAddr.toLowerCase());
    // The topic filter should guarantee this, but a filter is not proof —
    // never credit an address we did not ourselves hand to a user.
    if (!userId) continue;

    deposits.push({
      userId,
      chain,
      address: toAddr,
      txHash: log.transactionHash,
      logIndex: parseInt(log.logIndex, 16),
      amountMicro: toMicroUsdt(BigInt(log.data), token.decimals),
      token: "usdt",
      blockNumber: parseInt(log.blockNumber, 16),
      blockHash: log.blockHash,
    });
  }

  return { deposits, scannedTo: toBlock };
}
