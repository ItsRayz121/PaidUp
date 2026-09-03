// On-demand BNB address history via BscScan (founder, 2026-08-29).
//
// The native BNB deposit scanner is OFF on purpose — it walked every block
// 24/7 and cost real money (see CLAUDE.md, the 2026-08-13 billing entry). So
// incoming BNB never lands in `native_deposits` and the /wallet/bnb history
// was empty even when the wallet held BNB.
//
// This reads the chain ONLY when a user opens /wallet/bnb, for that one user's
// own derived deposit address, 25 rows, with a 60s per-address cache. It never
// throws — a BscScan hiccup returns an empty list (or the last cached one),
// never an error on a money screen.
//
// ⚠️ ENDPOINT: the old standalone host `api.bscscan.com/api` (Etherscan API V1)
// was retired in 2025 — it now answers every request with a "migrate to V2"
// error, which this code read as `status !== "1"` and silently turned into an
// empty history. We call Etherscan's V2 multichain endpoint instead
// (`api.etherscan.io/v2/api` + `chainid=56` for BNB Smart Chain); a free
// BscScan/Etherscan key works on it unchanged. Same `{status, result}` shape.
import { config } from "./config.ts";

export type BnbAddressTx = {
  hash: string;
  from: string;
  to: string;
  valueWei: string;
  at: string; // ISO
  direction: "in" | "out";
};

type RawTx = { hash: string; from: string; to: string; value: string; timeStamp: string };
type CacheEntry = { at: number; rows: BnbAddressTx[] };

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;
// Etherscan V2 multichain — chainid 56 is BNB Smart Chain. See the endpoint
// note in this file's header for why the old api.bscscan.com host is gone.
const API = "https://api.etherscan.io/v2/api";
const CHAIN_ID = 56;
const TIMEOUT_MS = 8_000;

export async function fetchBnbAddressHistory(address: string): Promise<BnbAddressTx[]> {
  const key = config.bscscanApiKey;
  if (!key || !/^0x[0-9a-fA-F]{40}$/.test(address)) return [];
  const addr = address.toLowerCase();

  const hit = cache.get(addr);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;

  try {
    const [ext, int] = await Promise.all([
      queryList("txlist", addr, key),
      queryList("txlistinternal", addr, key),
    ]);
    const rows = [...ext, ...int]
      .filter((r) => r.value && r.value !== "0")
      .map((r) => normalize(r, addr))
      // one hash can appear in both lists (a contract call that also moved
      // value) — keep the first, they carry the same amount/direction
      .filter((r, i, all) => all.findIndex((x) => x.hash === r.hash) === i)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, 25);
    cache.set(addr, { at: Date.now(), rows });
    return rows;
  } catch {
    return hit?.rows ?? [];
  }
}

async function queryList(action: string, address: string, key: string): Promise<RawTx[]> {
  const url =
    `${API}?chainid=${CHAIN_ID}&module=account&action=${action}&address=${address}` +
    `&startblock=0&endblock=99999999&sort=desc&page=1&offset=25&apikey=${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    const body = (await res.json()) as { status?: string; result?: unknown };
    // status "0" with an empty result is BscScan's "no transactions" — not an
    // error, just nothing to show.
    if (body.status !== "1" || !Array.isArray(body.result)) return [];
    return body.result as RawTx[];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function normalize(r: RawTx, self: string): BnbAddressTx {
  const out = (r.from ?? "").toLowerCase() === self;
  return {
    hash: r.hash,
    from: r.from,
    to: r.to,
    valueWei: r.value,
    at: new Date(Number(r.timeStamp) * 1000).toISOString(),
    direction: out ? "out" : "in",
  };
}

// ---- Treasury wallet: every in and out (founder, 2026-09-03) ---------------
// "Show me all the in and out of this particular wallet ... all kind of
// transaction with a clickable transaction hash, so that we can see either
// everything is going on smooth or not."
//
// ⚠️ THE SOURCE OF TRUTH IS THE CHAIN, NOT OUR OWN TABLES. Reading
// withdrawal_requests / usdt_topups / sweep_jobs would only ever show movements
// WE initiated — and the entire reason to look at a treasury ledger is to catch
// the ones we did not. Our rows are used to LABEL what the chain reports, never
// to produce it.
//
// ⚠️ ON DEMAND ONLY, NEVER A POLLER. This codebase has shipped two real billing
// incidents from background chain reads (CLAUDE.md, 2026-08-13 and 2026-08-27).
// This runs when a staff member opens the tab; the 60s cache below is what makes
// a double-click free.
export type TreasuryTx = {
  hash: string;
  from: string;
  to: string;
  /** Base units: wei for BNB, and USDT's own 18 decimals on BSC. */
  value: string;
  asset: "USDT" | "BNB";
  decimals: number;
  at: string;
  direction: "in" | "out";
};

type RawTokenTx = RawTx & { tokenSymbol?: string; tokenDecimal?: string; contractAddress?: string };
const tokenCache = new Map<string, { at: number; rows: TreasuryTx[] }>();

// BSC USDT. Deliberately duplicated from payout.ts's ONCHAIN_CHAINS rather than
// imported: that map is the SIGNING config (importing it here would drag the
// viem chain objects into a read-only path), and this file already knows it
// only ever speaks to chainid 56.
const BSC_USDT = "0x55d398326f99059ff775485246999027b3197955";

export async function fetchTreasuryLedger(address: string, limit = 50): Promise<TreasuryTx[]> {
  const key = config.bscscanApiKey;
  if (!key || !/^0x[0-9a-fA-F]{40}$/.test(address)) return [];
  const addr = address.toLowerCase();
  const cacheKey = `treasury:${addr}:${limit}`;

  const hit = tokenCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;

  try {
    const [tokens, native] = await Promise.all([
      queryTokenList(addr, key, limit),
      fetchBnbAddressHistory(address),
    ]);
    const rows: TreasuryTx[] = [
      ...tokens
        // Only USDT. A treasury that has been airdropped a scam token should not
        // have it rendered next to real money as though it were a payout.
        .filter((r) => (r.contractAddress ?? "").toLowerCase() === BSC_USDT)
        .map((r) => ({
          hash: r.hash,
          from: r.from,
          to: r.to,
          value: r.value,
          asset: "USDT" as const,
          decimals: Number(r.tokenDecimal ?? 18) || 18,
          at: new Date(Number(r.timeStamp) * 1000).toISOString(),
          direction: (r.from ?? "").toLowerCase() === addr ? ("out" as const) : ("in" as const),
        })),
      ...native.map((r) => ({
        hash: r.hash, from: r.from, to: r.to, value: r.valueWei,
        asset: "BNB" as const, decimals: 18, at: r.at, direction: r.direction,
      })),
    ]
      // ⚠️ NO .slice(0, limit) ON THE MERGED LIST. Each rail is already capped
      // by its own query; slicing the MERGE would silently drop a whole asset
      // — a wallet with 50 USDT transfers newer than any BNB movement would
      // show zero BNB rows on a panel that promises both, and whose entire job
      // is spotting movement we did not start. Two capped rails, both kept.
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    tokenCache.set(cacheKey, { at: Date.now(), rows });
    return rows;
  } catch {
    return hit?.rows ?? [];
  }
}

async function queryTokenList(address: string, key: string, limit: number): Promise<RawTokenTx[]> {
  const url =
    `${API}?chainid=${CHAIN_ID}&module=account&action=tokentx&address=${address}` +
    `&contractaddress=${BSC_USDT}&startblock=0&endblock=99999999&sort=desc&page=1` +
    `&offset=${Math.min(Math.max(limit, 1), 100)}&apikey=${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    const body = (await res.json()) as { status?: string; result?: unknown };
    if (body.status !== "1" || !Array.isArray(body.result)) return [];
    return body.result as RawTokenTx[];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Is the on-demand explorer read configured at all? */
export const bscscanReady = () => Boolean(config.bscscanApiKey);
