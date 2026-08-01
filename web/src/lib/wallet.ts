// Talking to the wallet app the user already has, with no library.
//
// Every crypto wallet worth naming — MetaMask, Trust, Binance, OKX,
// TokenPocket, SafePal — exposes the same tiny interface on `window.ethereum`
// (EIP-1193): you ask it for the account, and you ask it to sign a string. That
// is all this feature needs, so there is no wallet SDK here and no third-party
// script on a money screen. Everything below is two `request` calls and the
// error handling around them.
//
// WHAT IT REPLACES: a text box the user pasted 42 characters into. See
// api/src/wallet.ts for why that box was the dangerous part.
import { useSyncExternalStore } from "react";

// The subset of EIP-1193 we use. Deliberately not `any` — this is the boundary
// where an extension we do not control reaches into our page.
type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  isMetaMask?: boolean;
  providers?: Eip1193Provider[];
};

declare global {
  interface Window { ethereum?: Eip1193Provider }
}

// EIP-1193 error codes we act on. 4001 is the user tapping Reject, which is a
// normal thing to do and must never be shown as an error.
const USER_REJECTED = 4001;

export class WalletError extends Error {
  /** True when the user simply declined — the UI shows nothing, not a failure. */
  cancelled: boolean;
  constructor(message: string, cancelled = false) {
    super(message);
    this.cancelled = cancelled;
  }
}

function pickProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const eth = window.ethereum;
  if (!eth) return null;
  // With two extensions installed they fight over `window.ethereum` and the
  // loser is listed in `.providers`. Prefer MetaMask when the array exists,
  // because it is the one whose absence users notice; otherwise take whatever
  // won. On the mobile in-app browsers our users actually have there is only
  // ever one, so this branch is a desktop convenience.
  if (Array.isArray(eth.providers) && eth.providers.length > 0) {
    return eth.providers.find((p) => p.isMetaMask) ?? eth.providers[0];
  }
  return eth;
}

/** Is there a wallet in THIS browser? False in plain mobile Chrome. */
export function hasWallet(): boolean {
  return pickProvider() !== null;
}

// Render-safe version, the same shape lib/telegram.ts uses for `insideTelegram`
// and for the same reason: `window.ethereum` does not exist on the server, so
// reading it during render makes the first paint disagree with the HTML.
//
// The server snapshot is `true` — the connect button is what renders for the
// split second before the browser answers. A button that resolves into
// instructions reads better than instructions that blink out of existence.
const subscribeNever = () => () => {};
const serverHasWallet = () => true;
export function useHasWallet(): boolean {
  return useSyncExternalStore(subscribeNever, hasWallet, serverHasWallet);
}

function toWalletError(e: unknown): WalletError {
  const err = e as { code?: number; message?: string };
  if (err?.code === USER_REJECTED) return new WalletError("cancelled", true);
  return new WalletError(err?.message || "Your wallet did not answer. Please try again.");
}

/**
 * Ask the wallet which account we are talking to. This is the call that opens
 * the wallet's approval sheet, so it must happen from a real tap — browsers and
 * wallets both suppress it otherwise.
 */
export async function connectWallet(): Promise<string> {
  const provider = pickProvider();
  if (!provider) throw new WalletError("no-wallet");
  let accounts: unknown;
  try {
    accounts = await provider.request({ method: "eth_requestAccounts" });
  } catch (e) {
    throw toWalletError(e);
  }
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(first)) {
    throw new WalletError("Your wallet did not share an address. Please try again.");
  }
  return first;
}

/**
 * Sign the server's challenge. `personal_sign` is the one signing method that
 * cannot produce a transaction — the wallet prefixes the message before hashing
 * it, so the result can never be replayed as a transfer no matter what the text
 * says. Never swap this for `eth_sign`, which signs raw bytes and is exactly
 * how wallets get drained.
 */
export async function signMessage(address: string, message: string): Promise<string> {
  const provider = pickProvider();
  if (!provider) throw new WalletError("no-wallet");
  try {
    // Param order for personal_sign is (message, address) — the reverse of
    // eth_sign, and getting it backwards fails in wallet-specific ways.
    const sig = await provider.request({ method: "personal_sign", params: [message, address] });
    if (typeof sig !== "string") throw new WalletError("Your wallet did not sign. Please try again.");
    return sig;
  } catch (e) {
    if (e instanceof WalletError) throw e;
    throw toWalletError(e);
  }
}

/**
 * Links that re-open the CURRENT page inside a wallet app's own browser, for
 * the very common case of a user on plain mobile Chrome with a wallet app
 * installed but nothing injected into the page.
 *
 * This is the difference between the feature working for our market and only
 * working for people with a desktop extension. Both wallets take the site
 * without its scheme.
 */
export function walletDeepLinks(): { metamask: string; trust: string } | null {
  if (typeof window === "undefined") return null;
  const url = window.location.href;
  const bare = url.replace(/^https?:\/\//, "");
  return {
    metamask: `https://metamask.app.link/dapp/${bare}`,
    // coin_id 60 is the Ethereum-family chain set, which is what a BEP20
    // address belongs to.
    trust: `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(url)}`,
  };
}

/** Shorten an address for display: 0x1234…abcd. Never for comparison. */
export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
