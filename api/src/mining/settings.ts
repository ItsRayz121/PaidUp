// Every number in the mining economy, Admin-tunable at runtime with no redeploy.
//
// Backed by the existing `app_settings` key-value table (prefix `mining.`), so
// this reuses the machinery the withdrawal fee already uses rather than inventing
// a parallel one. Defaults below are the launch values from docs/MINING_SPEC.md;
// once an Admin writes a key, the stored value wins forever.
// MINING_DEFAULTS lives in core.ts, NOT here, and that placement is load-bearing:
// this module imports db.ts, which opens a database connection at module scope.
// Anything that reaches for the defaults would drag that connection in with it —
// which is exactly what made the pure-maths unit tests hang forever instead of
// exiting. core.ts has no imports at all, so tests can read the numbers without
// touching a database. Re-exported here so callers still have one obvious home.
import { sql, setSetting, type TxApi } from "../db.ts";
import { MINING_DEFAULTS, type MiningSettings } from "./core.ts";

export { MINING_DEFAULTS, type MiningSettings };

type Key = keyof MiningSettings;

const KEY = (k: Key) => `mining.${k}`;

// One round-trip for the whole config. Called on every mining request, so it
// reads all keys at once rather than N queries.
export async function loadMiningSettings(): Promise<MiningSettings> {
  const rows = await sql.all<{ key: string; value: string }>(
    "SELECT key, value FROM app_settings WHERE key LIKE 'mining.%'",
  );
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const out = { ...MINING_DEFAULTS } as Record<string, unknown>;
  for (const k of Object.keys(MINING_DEFAULTS) as Key[]) {
    const raw = stored.get(KEY(k));
    if (raw === undefined) continue;
    out[k] = typeof MINING_DEFAULTS[k] === "number" ? Number(raw) : raw;
  }
  return out as MiningSettings;
}

export async function setMiningSetting(k: Key, value: string | number): Promise<void> {
  await setSetting(KEY(k), String(value));
}

export function isMiningKey(k: string): k is Key {
  return Object.prototype.hasOwnProperty.call(MINING_DEFAULTS, k);
}

// Cumulative MICRO-ROZI ever emitted by mining. The supply cap is checked against
// this and nothing else, so it is derived from the ledger every time — never
// cached. A stale cache here would silently let us mint past the hard cap, which
// is the one number in the whole token that we promised is real.
//
// Pass `t` to read it inside the settlement transaction.
export async function totalEmittedMicro(t: Pick<TxApi, "get"> = sql): Promise<number> {
  const r = await t.get<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM rozi_ledger
     WHERE source_type = 'mining' AND direction = 'credit'`,
  );
  return Number(r?.total ?? 0);
}
