// Supported USDT payout chains and destination-address validation.
// PKR and other local rails are "Coming soon" and are NOT accepted here.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

// TWO LISTS, AND THE DIFFERENCE MATTERS.
//
// KNOWN_CHAINS is every chain this code can understand — validate an address
// for, label, settle a payout on. CHAINS is the shorter list we currently OFFER.
//
// They are separate because a chain can stop being offered while rows that used
// it still exist. Deleting Base and Aptos outright would leave every historical
// withdrawal on those chains with no label and no validator, so a staff member
// opening an old request would see a blank network and payout.ts would refuse to
// recognise its own past work. Narrowing the OFFERED list changes what new
// requests can be made on, and touches nothing that already happened.
export type ChainId = "bep20" | "base" | "aptos";

type ChainMeta = { id: ChainId; label: string; kind: "evm" | "aptos"; note: string };

// Everything we can still read, validate and label. Do not remove entries here
// while any row in withdrawal_requests or payout_addresses references them.
export const KNOWN_CHAINS: ChainMeta[] = [
  { id: "bep20", label: "BEP20 (BNB Chain)", kind: "evm", note: "USDT on BNB Smart Chain" },
  { id: "base", label: "Base", kind: "evm", note: "USDT on Base" },
  { id: "aptos", label: "Aptos", kind: "aptos", note: "USDT on Aptos" },
];

// What a user may pick TODAY. BEP20 only (founder, 2026-07-29): deposits are
// BEP20-only for a safety reason (see usdtTreasuryChain in mining/core.ts), and
// matching the payout side means one chain to hold USDT on, one gas token to
// keep funded, one explorer to check, and one answer when a user asks support
// "which network?". Base and Aptos come back by moving a line back into this
// list — the validators and labels never left.
export const CHAINS: ChainMeta[] = KNOWN_CHAINS.filter((c) => c.id === "bep20");

// Lookup spans KNOWN_CHAINS, never CHAINS. A historical row on a chain we no
// longer offer must still resolve to its label.
export function chainById(id: string): ChainMeta | undefined {
  return KNOWN_CHAINS.find((c) => c.id === id);
}

// Whether a chain may be used for a NEW withdrawal request. This is the check
// that enforces the narrowing; chainById deliberately does not.
export function chainIsOffered(id: string): boolean {
  return CHAINS.some((c) => c.id === id);
}

// EIP-55 mixed-case checksum. Only meaningful when the address has mixed case;
// an all-lower or all-upper address carries no checksum to verify.
function isEip55Valid(address: string): boolean {
  const body = address.slice(2);
  const hash = bytesToHex(keccak_256(utf8ToBytes(body.toLowerCase())));
  for (let i = 0; i < 40; i++) {
    const c = body[i];
    if (c >= "a" && c <= "f") { if (parseInt(hash[i], 16) >= 8) return false; }
    else if (c >= "A" && c <= "F") { if (parseInt(hash[i], 16) < 8) return false; }
  }
  return true;
}

// Validate a destination address for a chain. Returns a user-facing error on
// failure so the frontend can show it directly (simple English).
export function validateAddress(chain: ChainId, addressRaw: string): { ok: true } | { ok: false; error: string } {
  const address = addressRaw.trim();
  const meta = chainById(chain);
  if (!meta) return { ok: false, error: "Pick a network." };

  if (meta.kind === "evm") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return { ok: false, error: "That does not look like a wallet address. It should start with 0x and have 42 characters." };
    }
    const body = address.slice(2);
    const mixedCase = body !== body.toLowerCase() && body !== body.toUpperCase();
    // Only a mixed-case address exposes a checksum; if it's present it must pass.
    if (mixedCase && !isEip55Valid(address)) {
      return { ok: false, error: "This address has a typo (the checksum does not match). Please paste it again." };
    }
    return { ok: true };
  }

  // Aptos: 0x + up to 64 hex chars (leading zeros may be trimmed).
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
    return { ok: false, error: "That does not look like an Aptos address. It should start with 0x." };
  }
  return { ok: true };
}
