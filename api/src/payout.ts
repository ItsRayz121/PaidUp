// Payout provider — turns an approved withdrawal into a USDT transfer.
//
// Two modes (config.payoutMode):
//   • "manual"  (default): a staff member sends USDT from the treasury wallet
//     by hand, then records the on-chain tx hash when marking the request
//     paid. The API stores that hash so the user (and audit) can see proof of
//     payment. This path is fully live.
//   • "onchain": the API itself signs and broadcasts the USDT ERC-20 transfer
//     when a withdrawal is approved. LIVE as of 2026-08-05 (founder decision:
//     fully automatic withdrawal, with staff able to hold/pause an account
//     instead of approving each request by hand — see routes/staffMining.ts
//     for the hold controls). Still gated on real preconditions: PAYOUT_MODE
//     must be "onchain", a treasury signing key must be configured
//     (signer.ts — encrypted at rest, never a plaintext env var), and the
//     target chain needs an RPC endpoint. MUST be proven on testnet before
//     ever pointing this at mainnet with real funds — moving money with code
//     that has never been exercised is exactly what guardrail #1/#4 exist to
//     prevent.
//
// Points -> USDT is computed here from config.pointsPerUsdt so the amount paid
// always traces to a single conversion rule.
import { createWalletClient, http, fallback, parseUnits, erc20Abi, type Chain as ViemChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { config } from "./config.ts";
import { chainById, type ChainId } from "./chains.ts";
import { treasurySignerKey } from "./signer.ts";

export type PayoutResult = { txHash: string };

export type PayoutRequest = {
  requestId: string;
  chain: ChainId;
  address: string;
  points: number;
  usdt: string; // decimal string, e.g. "12.500000"
  // For manual mode: the hash the staff member pasted after sending by hand.
  providedTxHash?: string;
};

export interface PayoutProvider {
  readonly mode: "manual" | "onchain";
  // Whether this provider can settle the given chain right now. Manual can
  // always settle (a human sends it); onchain needs RPC + signer for the chain.
  canSettle(chain: ChainId): boolean;
  send(req: PayoutRequest): Promise<PayoutResult>;
}

// Convert a points amount to a USDT decimal string (6 dp — USDT's smallest unit
// on most chains). Rounded down so we never over-pay from rounding.
export function pointsToUsdt(points: number): string {
  const raw = points / config.pointsPerUsdt;
  return (Math.floor(raw * 1e6) / 1e6).toFixed(6);
}

// Basic shape check for an on-chain tx hash a staff member pastes (EVM: 0x + 64
// hex; Aptos also uses 0x + 64 hex). Kept lenient — it's a record, not a gate.
export function looksLikeTxHash(h: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(h.trim());
}

// ---- Manual provider (live) ------------------------------------------------
const manualProvider: PayoutProvider = {
  mode: "manual",
  canSettle() {
    return true;
  },
  async send(req) {
    const hash = req.providedTxHash?.trim();
    if (!hash) {
      throw {
        statusCode: 400,
        message:
          "Send the USDT from the treasury wallet first, then paste the transaction hash to mark it paid.",
      };
    }
    if (!looksLikeTxHash(hash)) {
      throw { statusCode: 400, message: "That does not look like a transaction hash (0x + 64 characters)." };
    }
    return { txHash: hash };
  },
};

// ---- On-chain provider ------------------------------------------------------
// Per-chain USDT contract + decimals + the viem chain definition it broadcasts
// against. BSC USDT (BEP20) has 18 decimals — NOT the 6 most USDT deployments
// use, which is exactly the kind of thing that silently pays 10^12x the wrong
// amount if copied from another chain without checking. Only bep20 is filled
// in: it is the only chain this product offers for new withdrawals (chains.ts,
// "ONE CHAIN IN, ONE CHAIN OUT"). Adding another chain here is one map entry —
// it does NOT need touching anything else in this file.
// Exported so deposits/adapters/evm.ts's listener scans the SAME contract
// address this signer pays out from — one source of truth for "which token
// contract is USDT on this chain", not two definitions that could drift.
export const ONCHAIN_CHAINS: Partial<Record<ChainId, { viemChain: ViemChain; usdt: `0x${string}`; decimals: number }>> = {
  bep20: { viemChain: bsc, usdt: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
};

const onchainProvider: PayoutProvider = {
  mode: "onchain",
  canSettle(chain) {
    const meta = chainById(chain);
    if (!meta || meta.kind !== "evm") return false; // Aptos: manual only
    if (!ONCHAIN_CHAINS[chain]) return false;
    // ⚠️ `.length > 0`, NOT Boolean(...). payoutRpc holds ARRAYS since the
    // failover change, and Boolean([]) is TRUE — so the truthiness check this
    // replaced would have reported "yes, I can auto-send" for a chain with no
    // endpoint configured at all, on the one code path whose entire job is to
    // refuse when it is not ready.
    if ((config.payoutRpc[chain]?.length ?? 0) === 0) return false;
    try {
      return treasurySignerKey() !== null;
    } catch {
      // A configured-but-undecryptable key (wrong TREASURY_KEY_SECRET, a
      // corrupted value) must read as "cannot settle", not throw out of a
      // boolean check that callers use to decide whether to even try.
      return false;
    }
  },
  async send(req) {
    if (!this.canSettle(req.chain)) {
      throw {
        statusCode: 501,
        message:
          "On-chain auto-send is not enabled for this network yet. Pay it manually and record the hash.",
      };
    }
    const def = ONCHAIN_CHAINS[req.chain]!;
    const pk = treasurySignerKey()!;
    const account = privateKeyToAccount(pk);
    const transport = fallback(config.payoutRpc[req.chain].map((url) => http(url)));
    const client = createWalletClient({ account, chain: def.viemChain, transport });

    // req.usdt is already the rounded-down decimal string from pointsToUsdt —
    // parseUnits converts it to the chain's smallest unit using THIS chain's
    // decimals, not an assumed 6, which is the bug this map exists to prevent.
    const amount = parseUnits(req.usdt, def.decimals);

    const hash = await client.writeContract({
      address: def.usdt,
      abi: erc20Abi,
      functionName: "transfer",
      args: [req.address as `0x${string}`, amount],
    });

    return { txHash: hash };
  },
};

export function getPayoutProvider(): PayoutProvider {
  return config.payoutMode === "onchain" ? onchainProvider : manualProvider;
}
