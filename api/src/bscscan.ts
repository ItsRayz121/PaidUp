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
const API = "https://api.bscscan.com/api";
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
    `${API}?module=account&action=${action}&address=${address}` +
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
