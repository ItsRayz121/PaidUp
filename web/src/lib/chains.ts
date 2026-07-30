// USDT payout chains shown in the withdraw screen. USDT only at launch (founder
// decision); local payment rails are "Coming soon". The server does the full
// address check (EIP-55 for EVM) — this is just instant UI feedback.
//
// Mirrors api/src/chains.ts, including its two-list split: KNOWN_CHAINS is
// everything we can label (a past withdrawal on Base must not render a blank
// network), CHAINS is what a user may pick today.
export type ChainId = "bep20" | "base" | "aptos";

type ChainMeta = { id: ChainId; label: string; note: string };

export const KNOWN_CHAINS: ChainMeta[] = [
  // The label says BEP20 first and puts BNB Chain second, because BNB is also a
  // TOKEN the user holds — and on the deposit side that ambiguity is how people
  // send the wrong coin. Same wording discipline here (see topup.addressWarn).
  { id: "bep20", label: "BEP20 · BNB Chain", note: "Low fees. Most common." },
  { id: "base", label: "Base", note: "Low fees." },
  { id: "aptos", label: "Aptos", note: "USDT on Aptos." },
];

// BEP20 only (founder, 2026-07-29) — one chain in, one chain out. Restoring a
// chain is moving its line back into this filter, on both sides.
export const CHAINS: ChainMeta[] = KNOWN_CHAINS.filter((c) => c.id === "bep20");

export function chainLabel(id: string): string {
  return KNOWN_CHAINS.find((c) => c.id === id)?.label ?? id;
}

export function addressLooksValid(chain: ChainId, address: string): boolean {
  const a = address.trim();
  if (chain === "aptos") return /^0x[0-9a-fA-F]{1,64}$/.test(a);
  return /^0x[0-9a-fA-F]{40}$/.test(a); // EVM: 0x + 40 hex
}
