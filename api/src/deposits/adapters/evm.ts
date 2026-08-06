// EVM deposit adapter — CUSTODY_SPEC.md § 5 step 2.
//
// Finds USDT Transfer() events landing on any address we've ever handed a
// user, using topics[2] (the indexed `to`) as an OR-filter — one eth_getLogs
// call covers every deposit address at once instead of one call each.
//
// ⚠️ rpc.ts's own header already says public endpoints are not sufficient for
// a listener that must never miss a deposit. This adapter inherits that limit
// as-is; put a paid endpoint first in RPC_BEP20 before this runs for real.
import { rpcCall } from "../../rpc.ts";
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

// Scan `chain` from `fromBlock` up to at most `toBlockCap`, capped to
// MAX_BLOCK_RANGE per call. Returns the deposits found and how far it
// actually got — the caller (scanner.ts) persists that as the new cursor.
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

  const toBlock = Math.min(fromBlock + MAX_BLOCK_RANGE - 1, toBlockCap);
  const addrList = [...byAddress.keys()];
  const deposits: ObservedDeposit[] = [];

  for (let i = 0; i < addrList.length; i += MAX_ADDRESSES_PER_CALL) {
    const batch = addrList.slice(i, i + MAX_ADDRESSES_PER_CALL);
    const logs = (await rpcCall(chain, "eth_getLogs", [{
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
      address: token.usdt,
      topics: [TRANSFER_TOPIC, null, batch.map(addressToTopic)],
    }])) as EvmLog[];

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
  }

  return { deposits, scannedTo: toBlock };
}
