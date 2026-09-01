// Feature flags — reading and writing them (brief part 44).
//
// The registry (what each flag IS) lives in flagsCore.ts, which imports nothing;
// this file is the half that touches the database. See that file's header.
import { sql, setSetting, getSetting } from "./db.ts";
import { loadMiningSettings, setMiningSetting } from "./mining/settings.ts";
import { FLAGS, FLAG_IDS, isFlagId, type FlagId } from "./flagsCore.ts";

export { FLAGS, FLAG_IDS, isFlagId, type FlagId };
export type { Store, FlagDef } from "./flagsCore.ts";

const flagKey = (id: FlagId) => `flag.${id}`;

/**
 * Read every flag in ONE pass.
 *
 * Batched deliberately: `enabled()` on its own would be a query per call, and
 * several of these are read on hot paths. Callers that need a single flag on a
 * request path use `enabled()`, which reads only what it needs.
 */
export async function allFlags(): Promise<Record<FlagId, boolean>> {
  const mining = await loadMiningSettings();
  const rows = await sql.all<{ key: string; value: string }>(
    "SELECT key, value FROM app_settings WHERE key LIKE 'flag.%' OR key = 'kyc_enabled'",
  );
  const stored = new Map(rows.map((r) => [r.key, r.value]));

  const out = {} as Record<FlagId, boolean>;
  for (const id of FLAG_IDS) {
    const s = FLAGS[id].store;
    // Most flags default ON (their feature was live before the switch); a flag
    // marked defaultOff belongs to something not yet launched.
    const dflt = FLAGS[id].defaultOff ? "0" : "1";
    if (s.kind === "mining") {
      out[id] = Number(mining[s.key]) === 1;
    } else if (s.kind === "setting") {
      out[id] = (stored.get(s.key) ?? dflt) === (s.onValue ?? "1");
    } else {
      out[id] = (stored.get(flagKey(id)) ?? dflt) === "1";
    }
  }
  return out;
}

/** Read one flag. Defaults to ON, or OFF for a flag marked defaultOff. */
export async function enabled(id: FlagId): Promise<boolean> {
  const s = FLAGS[id].store;
  const dflt = FLAGS[id].defaultOff ? "0" : "1";
  if (s.kind === "mining") {
    const mining = await loadMiningSettings();
    return Number(mining[s.key]) === 1;
  }
  if (s.kind === "setting") {
    return (await getSetting(s.key, dflt)) === (s.onValue ?? "1");
  }
  return (await getSetting(flagKey(id), dflt)) === "1";
}

/**
 * Throw a 403 if the feature is off. The one-liner every enforcement point uses,
 * so the message a user sees is the same wherever they hit a closed door.
 */
export async function requireFeature(id: FlagId): Promise<void> {
  if (await enabled(id)) return;
  throw {
    statusCode: 403,
    message: "This is turned off right now. Please try again later.",
  };
}

/** Write a flag through to wherever it actually lives. */
export async function setFlag(id: FlagId, on: boolean): Promise<void> {
  const s = FLAGS[id].store;
  if (s.kind === "mining") {
    await setMiningSetting(s.key, on ? 1 : 0);
  } else if (s.kind === "setting") {
    await setSetting(s.key, on ? (s.onValue ?? "1") : "0");
  } else {
    await setSetting(flagKey(id), on ? "1" : "0");
  }
}
