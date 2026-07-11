// Payout provider — turns an approved withdrawal into a USDT transfer.
//
// Two modes (config.payoutMode):
//   • "manual"  (default, v1 non-goal "no automated payouts"): a staff member
//     sends USDT from the treasury wallet by hand, then records the on-chain
//     tx hash when marking the request paid. The API stores that hash so the
//     user (and audit) can see proof of payment. This path is fully live.
//   • "onchain": the API itself signs and broadcasts the USDT ERC-20 transfer
//     when an admin clicks pay. This path is SCAFFOLDED and OFF by default. It
//     stays disabled until (a) PAYOUT_MODE=onchain, (b) a funded PAYOUT_SIGNER_KEY
//     is set, (c) the target chain has an RPC endpoint, and — critically — it
//     has been proven on a testnet first. Moving mainnet funds with code that
//     has never been exercised is exactly what guardrail #1/#4 and the
//     "verify end-to-end" rule exist to prevent.
//
// Points -> USDT is computed here from config.pointsPerUsdt so the amount paid
// always traces to a single conversion rule.
import { config } from "./config.ts";
import { chainById, type ChainId } from "./chains.ts";

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

// ---- On-chain provider (scaffold, disabled until configured + tested) ------
// The integration points are laid out so this is a real slot, not vapor, but it
// deliberately refuses to run until the operator has funded a wallet, wired an
// RPC per chain, and validated the flow on testnet. When you implement the
// broadcast, do it here: build the ERC-20 transfer calldata
// (transfer(address,uint256) selector 0xa9059cbb + padded args, using each
// chain's USDT decimals — BSC USDT is 18, Polygon/Base USDT is 6), sign an
// EIP-1559 tx with config.payoutSignerKey, and eth_sendRawTransaction to the
// chain's RPC. Aptos uses a different (non-EVM) tx format and stays manual.
const onchainProvider: PayoutProvider = {
  mode: "onchain",
  canSettle(chain) {
    const meta = chainById(chain);
    if (!meta || meta.kind !== "evm") return false; // Aptos: manual only
    return Boolean(config.payoutSignerKey) && Boolean(config.payoutRpc[chain]);
  },
  async send(req) {
    if (!this.canSettle(req.chain)) {
      throw {
        statusCode: 501,
        message:
          "On-chain auto-send is not enabled for this network yet. Pay it manually and record the hash.",
      };
    }
    // Not implemented on purpose — see the header comment. Until the broadcast
    // is written and proven on testnet, this must not silently mark funds paid.
    throw {
      statusCode: 501,
      message:
        "On-chain auto-send is scaffolded but not live. Verify it on testnet before enabling, then implement the broadcast in api/src/payout.ts.",
    };
  },
};

export function getPayoutProvider(): PayoutProvider {
  return config.payoutMode === "onchain" ? onchainProvider : manualProvider;
}
