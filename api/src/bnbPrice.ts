// BNB -> USD, for display only (founder, 2026-09-05): the Treasury Wallet
// panel shows a live BNB (gas) balance with no sense of what it is actually
// worth, and a staff member reading "0.0001 BNB" cannot tell "plenty of gas"
// from "nearly empty" without doing the conversion themselves.
//
// Source: Binance's public ticker (no API key, no billing, generous public
// rate limit) — this is a display estimate, never a rate anything is priced
// or settled against. Unlike ROZI (guardrail #7: no fixed rate, ever), BNB is
// a real, liquid, publicly-priced asset; showing its market value is not the
// same claim as pricing ROZI would be.
//
// ⚠️ CACHED 5 MINUTES AND CHARGED THROUGH costGuard, ON PURPOSE. This file
// exists in the shadow of two real billing incidents from something polling a
// provider forever (CLAUDE.md, 2026-08-13 and 2026-08-27) — Binance's ticker
// isn't billed, but the same "never let a call site have no ceiling" rule
// applies here too, and the panel it feeds is only ever opened on demand, not
// polled.
import { config } from "./config.ts";
import { charge } from "./costGuard.ts";

const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;
const URL = "https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT";

let cache: { at: number; usdMicroPerBnb: number } | null = null;

/** 1 BNB's price in micro-USD (6dp), or null if never successfully fetched. */
export async function bnbUsdMicroPrice(): Promise<number | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.usdMicroPerBnb;
  // A refusal must fall back to the last good price, never to null — null
  // renders as "could not check" on a panel that a moment ago had a real
  // number, which reads as the price vanishing rather than a rate limit.
  if (!charge("price", 1, "low")) return cache?.usdMicroPerBnb ?? null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`price HTTP ${res.status}`);
    const body = (await res.json()) as { price?: string };
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error("bad price payload");
    const usdMicroPerBnb = Math.round(price * 1_000_000);
    cache = { at: Date.now(), usdMicroPerBnb };
    return usdMicroPerBnb;
  } catch {
    // Same posture as every other on-demand chain/price read in this
    // codebase (bscscan.ts, hasEnoughGasForDisplay): never throw on a display
    // read, and a stale cached price beats no price at all.
    return cache?.usdMicroPerBnb ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/** wei (18dp) x a price in micro-USD-per-BNB -> micro-USD (6dp). Null propagates. */
export function bnbWeiToUsdMicro(wei: string | null | undefined, usdMicroPerBnb: number | null): number | null {
  if (!wei || usdMicroPerBnb == null) return null;
  try {
    const big = BigInt(wei);
    return Number((big * BigInt(usdMicroPerBnb)) / 1_000_000_000_000_000_000n);
  } catch {
    return null;
  }
}

/** Test seam only. */
export function __resetForTests(): void {
  cache = null;
}
