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
import { charge } from "./costGuard.ts";

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

// ⚠️ BOTH CACHES IN THIS FILE ARE BOUNDED, AND THAT IS NOT TIDINESS.
// The key is a user's own address, so an unbounded Map is one entry per user
// who has ever opened /wallet/bnb — each holding up to 25 transaction rows,
// held for the life of the process. It is a leak that only appears once the
// app is working, and memory is billed. `remember` sweeps what has expired
// and then evicts oldest-first if that was not enough.
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;
const MAX_ENTRIES = 2_000;

function remember<T>(m: Map<string, T & { at: number }>, key: string, value: T & { at: number }): void {
  if (m.size >= MAX_ENTRIES) {
    const cutoff = Date.now() - TTL_MS;
    for (const [k, v] of m) if (v.at < cutoff) m.delete(k);
    while (m.size >= MAX_ENTRIES) {
      const oldest = m.keys().next();
      if (oldest.done) break;
      m.delete(oldest.value);
    }
  }
  // delete-then-set so a refreshed key moves to the end — a plain `set` on an
  // existing key keeps its original position, and the eviction above would
  // then drop the hottest entries first.
  m.delete(key);
  m.set(key, value);
}
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
    remember(cache, addr, { at: Date.now(), rows });
    return rows;
  } catch {
    return hit?.rows ?? [];
  }
}

// Etherscan/BscScan answers EVERY call with {status, result} — including a
// real failure (a bad API key, an unsupported chain, a rate limit) — using the
// SAME shape as a genuine "no transactions found". The two look identical at a
// glance: `status: "0"`. The only thing that tells them apart is what `result`
// actually holds: a genuinely empty history still comes back as an ARRAY
// (empty); an error comes back with `result` as a STRING describing what went
// wrong (e.g. "Invalid API Key", "Max rate limit reached", "Missing/Invalid
// API Key"). Treating both alike is exactly the bug that let an invalid key
// masquerade as a treasury wallet with "nothing has ever moved through it"
// while it visibly held a live balance and had just sent two real payouts
// (2026-09-05) — found live, not in a test, because this path is deliberately
// untested (see this file's own throwing convention below: proving the real
// API answer needs a real key, not a stub).
export function parseExplorerResult(body: { status?: string; result?: unknown }): { rows: unknown[] } | { error: string } {
  if (Array.isArray(body.result)) return { rows: body.result };
  return { error: typeof body.result === "string" ? body.result : "unrecognised explorer response" };
}

async function queryList(action: string, address: string, key: string): Promise<RawTx[]> {
  const url =
    `${API}?chainid=${CHAIN_ID}&module=account&action=${action}&address=${address}` +
    `&startblock=0&endblock=99999999&sort=desc&page=1&offset=25&apikey=${key}`;
  // The explorer allowance is a DAILY quota, and this read is per user — so
  // its cost grows with the user base. costGuard.ts caps it.
  //
  // ⚠️ A REFUSAL THROWS. It must NOT return an empty list, and the difference
  // is not cosmetic: `[]` is indistinguishable from "this address has no
  // transactions", so the caller takes its SUCCESS path and writes that empty
  // result into the cache — overwriting a good 25-row entry and then serving
  // the empty one for the next 60 seconds. Throwing lands in the caller's
  // existing catch, which returns the previously cached rows and leaves the
  // cache alone: exactly what already happens when the provider is down.
  // Found in review; the first version of this returned `[]`.
  if (!charge("explorer", 1, "low")) {
    throw new Error("explorer read not attempted: daily call ceiling reached (EXPLORER_MAX_CALLS_PER_DAY)");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`explorer HTTP ${res.status}`);
    const body = (await res.json()) as { status?: string; result?: unknown };
    const parsed = parseExplorerResult(body);
    if ("error" in parsed) throw new Error(`explorer error: ${parsed.error}`);
    return parsed.rows as RawTx[];
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

// Returns the error message too, unlike every other function in this file —
// deliberately. Everywhere else (fetchBnbAddressHistory, and this same file's
// own header) a failed explorer read should degrade silently on a money
// screen a user is looking at; the TREASURY panel is staff-only, and hiding a
// real API failure behind "nothing has moved through this wallet" is exactly
// the bug that let an invalid/incompatible key go unnoticed while the wallet
// visibly held a live balance and had just sent two real payouts (2026-09-05).
// Staff need to be able to tell "genuinely empty" from "could not ask" apart.
export async function fetchTreasuryLedger(
  address: string, limit = 50,
): Promise<{ rows: TreasuryTx[]; error: string | null }> {
  const key = config.bscscanApiKey;
  if (!key || !/^0x[0-9a-fA-F]{40}$/.test(address)) return { rows: [], error: null };
  const addr = address.toLowerCase();
  const cacheKey = `treasury:${addr}:${limit}`;

  const hit = tokenCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return { rows: hit.rows, error: null };

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
    remember(tokenCache, cacheKey, { at: Date.now(), rows });
    return { rows, error: null };
  } catch (e) {
    // A cached hit (even a stale one) is a better answer than an error banner
    // — same reasoning as every other explorer read in this file. Only surface
    // the error when there is nothing at all to fall back on.
    if (hit) return { rows: hit.rows, error: null };
    return { rows: [], error: (e as Error)?.message || "could not read the chain" };
  }
}

async function queryTokenList(address: string, key: string, limit: number): Promise<RawTokenTx[]> {
  const url =
    `${API}?chainid=${CHAIN_ID}&module=account&action=tokentx&address=${address}` +
    `&contractaddress=${BSC_USDT}&startblock=0&endblock=99999999&sort=desc&page=1` +
    `&offset=${Math.min(Math.max(limit, 1), 100)}&apikey=${key}`;
  // Throws rather than returning [] — see queryList above for why an empty
  // list here would poison the cache with a false "no transactions".
  if (!charge("explorer", 1, "low")) {
    throw new Error("explorer read not attempted: daily call ceiling reached (EXPLORER_MAX_CALLS_PER_DAY)");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`explorer HTTP ${res.status}`);
    const body = (await res.json()) as { status?: string; result?: unknown };
    const parsed = parseExplorerResult(body);
    if ("error" in parsed) throw new Error(`explorer error: ${parsed.error}`);
    return parsed.rows as RawTokenTx[];
  } finally {
    clearTimeout(timer);
  }
}

/** Is the on-demand explorer read configured at all? */
export const bscscanReady = () => Boolean(config.bscscanApiKey);
