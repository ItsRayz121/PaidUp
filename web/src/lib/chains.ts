// USDT payout chains shown in the withdraw screen. USDT only at launch (founder
// decision); local payment rails are "Coming soon". The server does the full
// address check (EIP-55 for EVM) — this is just instant UI feedback.
export type ChainId = "bep20" | "base" | "aptos";

export const CHAINS: { id: ChainId; label: string; note: string }[] = [
  { id: "bep20", label: "BEP20 · BNB Chain", note: "Low fees. Most common." },
  { id: "base", label: "Base", note: "Low fees." },
  { id: "aptos", label: "Aptos", note: "USDT on Aptos." },
];

export function addressLooksValid(chain: ChainId, address: string): boolean {
  const a = address.trim();
  if (chain === "aptos") return /^0x[0-9a-fA-F]{1,64}$/.test(a);
  return /^0x[0-9a-fA-F]{40}$/.test(a); // EVM: 0x + 40 hex
}
