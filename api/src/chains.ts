// Supported USDT payout chains and destination-address validation.
// PKR and other local rails are "Coming soon" and are NOT accepted here.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

// Launch set (founder decision 2026-07-11): USDT on BEP20, Base (both EVM,
// shared 0x address format) and Aptos (non-EVM). Polygon was dropped. TRC20
// (Tron) is a quick future add — it just needs a base58 "T…" validator here and
// a CHAINS entry; the rest of the payout/withdraw flow is chain-agnostic.
export type ChainId = "bep20" | "base" | "aptos";

export const CHAINS: { id: ChainId; label: string; kind: "evm" | "aptos"; note: string }[] = [
  { id: "bep20", label: "BEP20 (BNB Chain)", kind: "evm", note: "USDT on BNB Smart Chain" },
  { id: "base", label: "Base", kind: "evm", note: "USDT on Base" },
  { id: "aptos", label: "Aptos", kind: "aptos", note: "USDT on Aptos" },
];

export function chainById(id: string): (typeof CHAINS)[number] | undefined {
  return CHAINS.find((c) => c.id === id);
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
