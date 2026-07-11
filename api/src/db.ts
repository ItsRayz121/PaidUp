// Postgres. GUARDRAIL #2: balance is NEVER stored — it is always SUM(amount)
// over the append-only ledger. There is no "balance" column anywhere.
//
// Two drivers, one dialect:
//   - DATABASE_URL set  -> node-postgres against the real server (Railway).
//   - DATABASE_URL unset -> PGlite, Postgres compiled to WASM, persisted under
//     ../data/pg. Local dev needs no Postgres install, and runs the same SQL.
//
// Query helpers take `?` placeholders and rewrite them to $1..$n, so callers
// keep writing portable SQL.
import { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";

export const now = () => new Date().toISOString();
export const newId = () => randomUUID();

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };
type Driver = {
  query: (text: string, params: unknown[]) => Promise<QueryResult>;
  exec: (text: string) => Promise<void>;
  begin: () => Promise<Tx>;
};
type Tx = {
  query: (text: string, params: unknown[]) => Promise<QueryResult>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

// `?` -> `$1, $2, ...`. Our SQL has no `?` inside string literals.
function toPg(text: string): string {
  let i = 0;
  return text.replace(/\?/g, () => `$${++i}`);
}

function makePgDriver(connectionString: string): Driver {
  // Railway's private network (*.railway.internal) speaks plain TCP. The public
  // proxy requires TLS but presents a cert for a different host.
  const internal = /\.railway\.internal|localhost|127\.0\.0\.1/.test(connectionString);
  const pool = new Pool({
    connectionString,
    ssl: internal ? undefined : { rejectUnauthorized: false },
    max: 10,
  });
  const norm = (r: { rows: unknown[]; rowCount: number | null }): QueryResult => ({
    rows: r.rows as Record<string, unknown>[],
    rowCount: r.rowCount ?? 0,
  });
  return {
    query: async (text, params) => norm(await pool.query(toPg(text), params)),
    exec: async (text) => void (await pool.query(text)),
    begin: async () => {
      const client = await pool.connect();
      await client.query("BEGIN");
      return {
        query: async (text, params) => norm(await client.query(toPg(text), params)),
        commit: async () => {
          await client.query("COMMIT");
          client.release();
        },
        rollback: async () => {
          await client.query("ROLLBACK");
          client.release();
        },
      };
    },
  };
}

function makePgliteDriver(): Driver {
  const dir = fileURLToPath(new URL("../data/pg/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const lite = new PGlite(dir);
  const norm = (r: { rows: unknown[]; affectedRows?: number }): QueryResult => ({
    rows: r.rows as Record<string, unknown>[],
    rowCount: r.affectedRows ?? (r.rows as unknown[]).length,
  });
  const q = async (text: string, params: unknown[]) =>
    norm(await lite.query(toPg(text), params as never[]));
  return {
    query: q,
    exec: async (text) => void (await lite.exec(text)),
    // PGlite is single-connection; BEGIN/COMMIT on it directly is equivalent.
    begin: async () => {
      await lite.exec("BEGIN");
      return {
        query: q,
        commit: async () => void (await lite.exec("COMMIT")),
        rollback: async () => void (await lite.exec("ROLLBACK")),
      };
    },
  };
}

const driver: Driver = config.databaseUrl
  ? makePgDriver(config.databaseUrl)
  : makePgliteDriver();

export const usingRealPostgres = Boolean(config.databaseUrl);

export const sql = {
  async run(text: string, ...params: unknown[]): Promise<{ rowCount: number }> {
    const r = await driver.query(text, params);
    return { rowCount: r.rowCount };
  },
  async get<T>(text: string, ...params: unknown[]): Promise<T | undefined> {
    const r = await driver.query(text, params);
    return r.rows[0] as T | undefined;
  },
  async all<T>(text: string, ...params: unknown[]): Promise<T[]> {
    const r = await driver.query(text, params);
    return r.rows as T[];
  },
  // Money moves inside this. If the callback throws, nothing is written.
  async tx<T>(fn: (t: TxApi) => Promise<T>): Promise<T> {
    const t = await driver.begin();
    const api: TxApi = {
      run: async (text, ...params) => ({ rowCount: (await t.query(text, params)).rowCount }),
      get: async <R>(text: string, ...params: unknown[]) =>
        (await t.query(text, params)).rows[0] as R | undefined,
      all: async <R>(text: string, ...params: unknown[]) =>
        (await t.query(text, params)).rows as R[],
    };
    try {
      const out = await fn(api);
      await t.commit();
      return out;
    } catch (err) {
      await t.rollback();
      throw err;
    }
  },
};

export type TxApi = {
  run: (text: string, ...params: unknown[]) => Promise<{ rowCount: number }>;
  get: <R>(text: string, ...params: unknown[]) => Promise<R | undefined>;
  all: <R>(text: string, ...params: unknown[]) => Promise<R[]>;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    email          TEXT UNIQUE NOT NULL,
    password_hash  TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0,
    telegram_id    TEXT,
    phone          TEXT,
    country        TEXT NOT NULL DEFAULT 'Pakistan',
    referral_code  TEXT UNIQUE NOT NULL,
    referred_by    TEXT REFERENCES users(id),
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TEXT NOT NULL
  );

  -- Email verification codes. We store only a HASH of the code, never the
  -- code itself, plus expiry + attempt count (auth security).
  CREATE TABLE IF NOT EXISTS email_codes (
    id                   TEXT PRIMARY KEY,
    email                TEXT NOT NULL,
    code_hash            TEXT NOT NULL,
    purpose              TEXT NOT NULL DEFAULT 'verify',
    -- Password chosen at register, applied only when THIS code is confirmed, so
    -- an unverified account's password can't be set by an unauthenticated caller.
    pending_password_hash TEXT,
    expires_at           TEXT NOT NULL,
    attempts             INTEGER NOT NULL DEFAULT 0,
    consumed             INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email);

  -- Append-only ledger. amount is signed: credit > 0, debit < 0.
  -- Rows are never updated or deleted. Balance = SUM(amount) per user.
  CREATE TABLE IF NOT EXISTS ledger_entries (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    amount       INTEGER NOT NULL,
    direction    TEXT NOT NULL CHECK (direction IN ('credit','debit')),
    source_type  TEXT NOT NULL CHECK (source_type IN
                   ('task_completion','referral_bonus','withdrawal','admin_adjustment')),
    source_ref_id TEXT,
    note         TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entries(user_id);

  -- Who invited whom. Written at signup; the bonus itself is a ledger entry
  -- posted when the invitee's task is credited (see webhooks).
  CREATE TABLE IF NOT EXISTS referrals (
    id               TEXT PRIMARY KEY,
    referrer_user_id TEXT NOT NULL REFERENCES users(id),
    referred_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
    created_at       TEXT NOT NULL,
    bonus_paid       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id);

  CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL CHECK (type IN ('install','survey','video')),
    title        TEXT NOT NULL,
    points       INTEGER NOT NULL,
    network      TEXT NOT NULL,
    advertiser   TEXT NOT NULL,
    minutes      INTEGER NOT NULL,
    requirement  TEXT,
    country      TEXT NOT NULL DEFAULT 'Pakistan',
    status       TEXT NOT NULL DEFAULT 'active',
    created_at   TEXT NOT NULL
  );

  -- A completion only becomes 'credited' after a VERIFIED server-to-server
  -- postback (guardrail #1).
  CREATE TABLE IF NOT EXISTS task_completions (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id),
    task_id        TEXT NOT NULL REFERENCES tasks(id),
    network        TEXT NOT NULL,
    external_id    TEXT,
    status         TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','verified','credited','rejected')),
    postback_payload TEXT,
    created_at     TEXT NOT NULL,
    verified_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id),
    amount         INTEGER NOT NULL,
    payout_rail    TEXT NOT NULL,          -- chain id: bep20 | polygon | base | aptos
    payout_address TEXT,                   -- destination USDT wallet address
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','agent_approved','manager_approved','paid','rejected')),
    tx_hash        TEXT,                   -- on-chain hash once paid (send scaffold)
    reviewed_by    TEXT,
    review_note    TEXT,
    created_at     TEXT NOT NULL,
    reviewed_at    TEXT,
    paid_at        TEXT
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    user_id    TEXT PRIMARY KEY REFERENCES users(id),
    role       TEXT NOT NULL CHECK (role IN ('agent','manager','admin')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS fraud_flags (
    id           TEXT PRIMARY KEY,
    user_id      TEXT REFERENCES users(id),
    device_id    TEXT,
    flag_type    TEXT NOT NULL,
    severity     TEXT NOT NULL DEFAULT 'low',
    detail       TEXT,
    created_at   TEXT NOT NULL,
    resolved_by  TEXT,
    resolution_note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_fraud_user ON fraud_flags(user_id);

  -- Idempotency: a given network completion id can only be processed once.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_completion_ext
    ON task_completions(network, external_id);

  -- Log of EVERY postback received (verified or not) so Agents can resolve
  -- "why didn't I get credited" disputes (docs/ARCHITECTURE.md step 5).
  CREATE TABLE IF NOT EXISTS postback_log (
    id          TEXT PRIMARY KEY,
    network     TEXT NOT NULL,
    external_id TEXT,
    verified    INTEGER NOT NULL,
    outcome     TEXT NOT NULL,
    raw         TEXT,
    created_at  TEXT NOT NULL
  );

  -- Ad networks, Admin-configurable. id = the adapter key used in the postback
  -- URL (/webhooks/:id/postback). commission_split_pct and referral_bonus_pct
  -- are stored here, NEVER hardcoded (docs/ARCHITECTURE.md § Commission split).
  -- A 'disabled' network's postbacks are rejected and its tasks are hidden.
  CREATE TABLE IF NOT EXISTS networks (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    type                 TEXT NOT NULL CHECK (type IN ('offerwall','rewarded_video')),
    status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    -- % of the net network payout we model as the user's points reward. Used to
    -- SET a task's points and for margin reporting; the credited amount always
    -- comes from the task row, so changing this never alters a promised reward.
    -- Launch default 60 (founder decision 2026-07-11: 60% to users / 40% margin).
    commission_split_pct INTEGER NOT NULL DEFAULT 60,
    -- Level-1 (direct): % of a referred user's task points paid to their direct
    -- inviter as a bonus. Launch default 15 (founder decision 2026-07-11).
    referral_bonus_pct   INTEGER NOT NULL DEFAULT 15,
    -- Level-2 (indirect): % paid to the inviter's inviter (2-level referral).
    -- Launch default 5. Set 0 to turn off the second level for a network.
    referral_bonus_pct_l2 INTEGER NOT NULL DEFAULT 5,
    -- Flat one-time bonus (points) paid to the direct inviter when their invited
    -- user completes their FIRST credited task. Rewards real, active referrals —
    -- not empty signups (anti-farm). Launch default 100. 0 disables it.
    referral_first_task_bonus INTEGER NOT NULL DEFAULT 100,
    -- Referral bonus WINDOW: pay the inviter only while the invited account is
    -- younger than this many days. 0 = lifetime (no window). Admin-tunable.
    referral_bonus_days  INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL,
    updated_at           TEXT
  );

  -- Device fingerprints (guardrail #5: fingerprint at the device level from day
  -- one). device_id is a client-computed hash of browser/device signals — NO
  -- PII. One row per (user, device); we also keep the signup/last-seen IP so the
  -- fraud layer can spot referral rings sharing a device or IP.
  CREATE TABLE IF NOT EXISTS user_devices (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    device_id  TEXT NOT NULL,
    ip         TEXT,
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_user_device ON user_devices(user_id, device_id);
  CREATE INDEX IF NOT EXISTS idx_device ON user_devices(device_id);

  -- Support tickets (Agent queue). Simple-English, earner-facing on one side;
  -- staff-facing on the other. Messages are append-only per ticket.
  CREATE TABLE IF NOT EXISTS support_tickets (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    subject    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);
  CREATE INDEX IF NOT EXISTS idx_tickets_user ON support_tickets(user_id);

  CREATE TABLE IF NOT EXISTS ticket_messages (
    id          TEXT PRIMARY KEY,
    ticket_id   TEXT NOT NULL REFERENCES support_tickets(id),
    author_role TEXT NOT NULL CHECK (author_role IN ('user','staff')),
    author_id   TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ticket_messages ON ticket_messages(ticket_id);
`;

// Idempotent column adds for databases created before these columns existed
// (the live DB predates password auth). Safe to run on every boot.
const MIGRATIONS = `
  ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE email_codes ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'verify';
  ALTER TABLE email_codes ADD COLUMN IF NOT EXISTS pending_password_hash TEXT;
  ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS payout_address TEXT;
  ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS tx_hash TEXT;
  ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS usdt_amount TEXT;
  ALTER TABLE networks ADD COLUMN IF NOT EXISTS referral_bonus_days INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE networks ADD COLUMN IF NOT EXISTS referral_bonus_pct_l2 INTEGER NOT NULL DEFAULT 5;
  ALTER TABLE networks ADD COLUMN IF NOT EXISTS referral_first_task_bonus INTEGER NOT NULL DEFAULT 100;

  -- Saved payout addresses: a user sets a USDT address per chain ONCE and reuses
  -- it. The withdraw screen pre-fills from here; a new address overwrites it.
  CREATE TABLE IF NOT EXISTS payout_addresses (
    user_id    TEXT NOT NULL REFERENCES users(id),
    chain      TEXT NOT NULL,
    address    TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, chain)
  );

  -- Global key-value app settings (Admin-tunable), e.g. the withdrawal fee.
  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Fee (in points) charged on a withdrawal, snapshotted from app_settings at
  -- request time so a later Admin change never alters an in-flight request.
  ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS fee_points INTEGER NOT NULL DEFAULT 0;
`;

export async function initDb(): Promise<void> {
  await driver.exec(SCHEMA);
  await driver.exec(MIGRATIONS);
  // Ensure the known adapter networks have a config row in every environment,
  // so the Admin panel and the disabled-network checks always have something to
  // read. Split percentages are the modeled defaults; Admin tunes them live.
  // Launch referral defaults: L1 15% + L2 5% + 100pt first-task bonus (founder
  // decision 2026-07-11). Only inserted when a row is absent; a re-seed
  // (npm run seed) pushes these to existing rows.
  await sql.run(
    `INSERT INTO networks (id, name, type, status, commission_split_pct, referral_bonus_pct, referral_bonus_pct_l2, referral_first_task_bonus, created_at)
     VALUES ('offerhub','OfferHub','offerwall','active',60,15,5,100,?)
     ON CONFLICT (id) DO NOTHING`, now(),
  );
  await sql.run(
    `INSERT INTO networks (id, name, type, status, commission_split_pct, referral_bonus_pct, referral_bonus_pct_l2, referral_first_task_bonus, created_at)
     VALUES ('tapvid','TapVid','rewarded_video','active',60,15,5,100,?)
     ON CONFLICT (id) DO NOTHING`, now(),
  );
  await sql.run(
    `INSERT INTO networks (id, name, type, status, commission_split_pct, referral_bonus_pct, referral_bonus_pct_l2, referral_first_task_bonus, created_at)
     VALUES ('surveyx','SurveyX','offerwall','active',60,15,5,100,?)
     ON CONFLICT (id) DO NOTHING`, now(),
  );
  // Default global settings (only inserted when absent). Withdrawal fee off (0)
  // by default so no user is surprised by a deduction until Admin sets one.
  await sql.run(
    "INSERT INTO app_settings (key, value, updated_at) VALUES ('withdrawal_fee_points','0',?) ON CONFLICT (key) DO NOTHING",
    now(),
  );
}

// Read a global app setting, falling back if unset. Values are stored as text.
export async function getSetting(key: string, fallback: string): Promise<string> {
  const row = await sql.get<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", key);
  return row?.value ?? fallback;
}
export async function setSetting(key: string, value: string): Promise<void> {
  await sql.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    key, value, now(),
  );
}

// The ONLY way points move. Append-only: inserts a signed ledger row.
// `amount` sign is derived from direction so callers can't get it wrong.
// Pass `t` to enlist in a caller's transaction.
export async function postLedger(
  params: {
    userId: string;
    points: number; // always positive magnitude
    direction: "credit" | "debit";
    sourceType: "task_completion" | "referral_bonus" | "withdrawal" | "admin_adjustment";
    sourceRefId?: string;
    note?: string;
  },
  t: Pick<TxApi, "run"> = sql,
): Promise<string> {
  const magnitude = Math.abs(Math.trunc(params.points));
  const amount = params.direction === "credit" ? magnitude : -magnitude;
  const id = newId();
  await t.run(
    `INSERT INTO ledger_entries (id, user_id, amount, direction, source_type, source_ref_id, note, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id, params.userId, amount, params.direction, params.sourceType,
    params.sourceRefId ?? null, params.note ?? null, now(),
  );
  return id;
}

// Balance is always derived — this is the ONLY way balance is computed.
// ::int because Postgres returns SUM() of an integer column as bigint (a string).
export async function balanceOf(
  userId: string,
  t: Pick<TxApi, "get"> = sql,
): Promise<number> {
  const row = await t.get<{ bal: number }>(
    "SELECT COALESCE(SUM(amount), 0)::int AS bal FROM ledger_entries WHERE user_id = ?",
    userId,
  );
  return row?.bal ?? 0;
}
