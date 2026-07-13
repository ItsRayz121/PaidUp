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

  -- Append-only record of every privileged staff action (minting points,
  -- suspending an account, changing a role). Never updated, never deleted: if a
  -- staff account is ever compromised, this is the only thing that tells you
  -- what it did. Points can be created by hand now, so this is not optional.
  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id             TEXT PRIMARY KEY,
    actor_user_id  TEXT NOT NULL REFERENCES users(id),
    actor_role     TEXT NOT NULL,
    action         TEXT NOT NULL,
    target_user_id TEXT REFERENCES users(id),
    detail         TEXT,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_actor ON admin_audit_log(actor_user_id);

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

  -- Dynamic-amount networks (real survey walls like CPX) have no fixed task row:
  -- the reward varies per survey and arrives in the SIGNED postback. So a
  -- completion now carries its own points + offer type, and task_id is optional.
  -- Fixed-catalog networks still copy these from their tasks row, so every
  -- completion is self-describing and no query needs to join tasks.
  ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS points INTEGER;
  ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS offer_type TEXT;
  ALTER TABLE task_completions ALTER COLUMN task_id DROP NOT NULL;
  -- Backfill rows created before those columns existed (idempotent).
  UPDATE task_completions tc SET points = t.points, offer_type = t.type
    FROM tasks t WHERE t.id = tc.task_id AND tc.points IS NULL;
  -- A completion can be reversed later (CPX re-calls with status=2 when a survey
  -- is found fraudulent up to 60 days on). Reversal writes a compensating debit.
  ALTER TABLE task_completions DROP CONSTRAINT IF EXISTS task_completions_status_check;
  ALTER TABLE task_completions ADD CONSTRAINT task_completions_status_check
    CHECK (status IN ('pending','verified','credited','rejected','reversed'));

  -- ---- CUSTOM TASKS -------------------------------------------------------
  -- Tasks we write ourselves in the admin panel, with no ad network behind them
  -- (join our channel, follow us, try a partner app). Guardrail #1 still holds:
  -- a custom task cannot credit itself. It carries a verify_mode saying how a
  -- completion is PROVEN:
  --
  --   'proof'    — the user submits evidence, a STAFF MEMBER approves it, and the
  --                credit is that human decision (audit-logged). Not the user's
  --                own click.
  --   'postback' — a partner's server calls our signed postback, exactly like a
  --                real ad network, using this task's own secret.
  -- 'custom' is not an ad network, but it gets a networks row so its referral
  -- rates stay Admin-tunable and all custom tasks can be switched off at once.
  ALTER TABLE networks DROP CONSTRAINT IF EXISTS networks_type_check;
  ALTER TABLE networks ADD CONSTRAINT networks_type_check
    CHECK (type IN ('offerwall','rewarded_video','custom'));

  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'network';
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verify_mode TEXT NOT NULL DEFAULT 'postback';
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS instructions TEXT;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS proof_label TEXT;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS action_url TEXT;
  -- Per-task postback secret. Only ever leaves the server to an Admin in /staff.
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS postback_secret TEXT;
  ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_type_check;
  ALTER TABLE tasks ADD CONSTRAINT tasks_type_check
    CHECK (type IN ('install','survey','video','custom'));
  ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_verify_mode_check;
  ALTER TABLE tasks ADD CONSTRAINT tasks_verify_mode_check
    CHECK (verify_mode IN ('proof','postback'));

  -- Evidence a user submits for a 'proof' custom task. One row per attempt.
  -- A rejected user may try again; an approved one may not (the unique index
  -- below stops a second approved row, so a task cannot be farmed twice).
  CREATE TABLE IF NOT EXISTS task_proofs (
    id           TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL REFERENCES tasks(id),
    user_id      TEXT NOT NULL REFERENCES users(id),
    proof_text   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected')),
    review_note  TEXT,
    reviewed_by  TEXT REFERENCES users(id),
    reviewed_at  TEXT,
    created_at   TEXT NOT NULL
  );
  -- One pending submission per user per task: stops a user flooding the review
  -- queue with the same task to get a tired Agent to approve it twice.
  CREATE UNIQUE INDEX IF NOT EXISTS task_proofs_one_open
    ON task_proofs (task_id, user_id) WHERE status = 'pending';
  -- And one APPROVED submission per user per task, ever. This is the real
  -- anti-farm index: even if two Agents approve two rows at the same instant,
  -- the second write fails rather than paying the task out twice.
  CREATE UNIQUE INDEX IF NOT EXISTS task_proofs_one_approved
    ON task_proofs (task_id, user_id) WHERE status = 'approved';
  CREATE INDEX IF NOT EXISTS task_proofs_status ON task_proofs (status, created_at);

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

// ---------------------------------------------------------------------------
// ROZI MINING (docs/MINING_SPEC.md)
//
// GUARDRAIL #7: ROZI and Points are two SEPARATE append-only ledgers, and the
// only path between them is a Conversion Window — a pre-committed, hard-capped
// pot of Points. There is no fixed ROZI->Points rate anywhere in this system,
// because a fixed rate is a promise to buy back an asset we mint for free, and
// that is an unfunded liability that grows with our own success.
//
// So: rozi_ledger is a mirror of ledger_entries, and nothing may write to both
// except conversion settlement. Balance is a SUM here too — never a column.
// ---------------------------------------------------------------------------
const MINING_SCHEMA = `
  -- Append-only, exactly like ledger_entries. Signed amounts, never updated.
  --
  -- AMOUNTS ARE MICRO-ROZI (millionths). 1 ROZI = 1_000_000 here. See ROZI_SCALE
  -- in mining/core.ts for why: with a base rate of 10/day, a whole-ROZI ledger
  -- floored an 8-hour session's honest 0.104 ROZI down to zero, and the app would
  -- have paid people nothing for real work. Settlement still floors — just six
  -- decimal places lower, so the unemitted dust is a millionth of a token rather
  -- than someone's whole day, and we stay strictly under the supply cap.
  --
  -- BIGINT because the cap in micro is 6.5e14, which is far past INTEGER.
  CREATE TABLE IF NOT EXISTS rozi_ledger (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id),
    amount        BIGINT NOT NULL,
    direction     TEXT NOT NULL CHECK (direction IN ('credit','debit')),
    source_type   TEXT NOT NULL CHECK (source_type IN
                    ('mining','rig_purchase','transfer_in','transfer_out',
                     'transfer_fee','conversion_burn','admin_adjustment','bonus')),
    source_ref_id TEXT,
    note          TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rozi_user ON rozi_ledger(user_id);
  CREATE INDEX IF NOT EXISTS idx_rozi_source ON rozi_ledger(source_type);

  -- A mining session. Hashrate only accrues while one is live; when it expires
  -- mining STOPS until the user comes back. That friction is the retention loop
  -- (and every return visit is an ad impression).
  CREATE TABLE IF NOT EXISTS mining_sessions (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id),
    device_id         TEXT,
    started_at        TEXT NOT NULL,
    expires_at        TEXT NOT NULL,
    -- Accrual is incremental: every poll credits (now - last_accrued_at) seconds
    -- at the CURRENT hashrate, so a boost that lands mid-session is honoured from
    -- that moment and not retroactively.
    last_accrued_at   TEXT NOT NULL,
    ended_at          TEXT,
    status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended'))
  );
  CREATE INDEX IF NOT EXISTS idx_mining_sessions_user ON mining_sessions(user_id);
  -- One live session per user, enforced by the database rather than by a check
  -- that a concurrent request could race past.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mining_session_active
    ON mining_sessions(user_id) WHERE status = 'active';

  -- Accrued hashrate-seconds per (epoch, user). This is the numerator of the
  -- pro-rata split; the epoch's total is the denominator.
  CREATE TABLE IF NOT EXISTS mining_shares (
    epoch      INTEGER NOT NULL,
    user_id    TEXT NOT NULL REFERENCES users(id),
    shares     BIGINT NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (epoch, user_id)
  );

  -- THE anti-farm rule (MINING_SPEC.md § 9): a device_id may accrue mining
  -- shares for exactly ONE user per epoch. A second account on the same phone
  -- may run a session, but accrues zero and is flagged. Enforced by this PK, so
  -- two concurrent requests cannot both win.
  CREATE TABLE IF NOT EXISTS mining_epoch_devices (
    epoch      INTEGER NOT NULL,
    device_id  TEXT NOT NULL,
    user_id    TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (epoch, device_id)
  );

  -- One row per settled day. Settlement is idempotent on this PK: a re-run after
  -- a crash cannot credit anybody twice.
  CREATE TABLE IF NOT EXISTS mining_epochs (
    epoch        INTEGER PRIMARY KEY,
    emission     BIGINT NOT NULL,
    total_shares BIGINT NOT NULL,
    miners       INTEGER NOT NULL DEFAULT 0,
    emitted      BIGINT NOT NULL DEFAULT 0,
    withheld     BIGINT NOT NULL DEFAULT 0,
    settled_at   TEXT NOT NULL
  );

  -- Daily streak. A day counts if the user ran at least one session in it.
  CREATE TABLE IF NOT EXISTS mining_streaks (
    user_id      TEXT PRIMARY KEY REFERENCES users(id),
    current_days INTEGER NOT NULL DEFAULT 0,
    best_days    INTEGER NOT NULL DEFAULT 0,
    last_epoch   INTEGER,
    updated_at   TEXT NOT NULL
  );

  -- The rig catalogue (Admin CRUD). Cost grows FASTER than power on purpose
  -- (1.6 vs 1.5 per level), so the tree is a treadmill that burns ROZI forever
  -- and can never be solved into infinite hashrate.
  CREATE TABLE IF NOT EXISTS rigs (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    icon         TEXT NOT NULL DEFAULT 'chip',
    base_cost    BIGINT NOT NULL,
    cost_growth  INTEGER NOT NULL DEFAULT 160,   -- x100, so 160 = 1.60
    base_power   INTEGER NOT NULL,
    power_growth INTEGER NOT NULL DEFAULT 150,   -- x100, so 150 = 1.50
    max_level    INTEGER NOT NULL DEFAULT 10,
    sort         INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_rigs (
    user_id    TEXT NOT NULL REFERENCES users(id),
    rig_id     TEXT NOT NULL REFERENCES rigs(id),
    level      INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, rig_id)
  );

  -- Temporary multipliers. kind='task' (a credited survey), 'ad' (a watched
  -- rewarded video), 'points' (bought with the CASH currency — a Points sink,
  -- which quietly reduces withdrawal pressure on the USDT treasury).
  CREATE TABLE IF NOT EXISTS user_boosts (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id),
    kind           TEXT NOT NULL CHECK (kind IN ('task','ad','points')),
    multiplier_pct INTEGER NOT NULL,   -- 50 = +50%
    expires_at     TEXT NOT NULL,
    source_ref_id  TEXT,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_boosts_user ON user_boosts(user_id, expires_at);

  -- Points-priced boosters (Admin CRUD). Off until the founder sets prices.
  CREATE TABLE IF NOT EXISTS boosters (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    price_points   INTEGER NOT NULL,
    multiplier_pct INTEGER NOT NULL,
    hours          INTEGER NOT NULL,
    status         TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('active','disabled')),
    created_at     TEXT NOT NULL
  );

  -- Every rewarded-video view. The reward is a hashrate BOOST, never currency —
  -- that is what keeps guardrail #1 intact (see MINING_SPEC.md § 8.1).
  CREATE TABLE IF NOT EXISTS ad_impressions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    device_id   TEXT,
    nonce       TEXT NOT NULL UNIQUE,
    provider    TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'issued'
                  CHECK (status IN ('issued','rewarded','rejected')),
    issued_at   TEXT NOT NULL,
    rewarded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ad_user ON ad_impressions(user_id, issued_at);

  -- ROZI -> Points. The ONLY bridge between the two ledgers, and the pot is a
  -- hard ceiling enforced inside the settlement transaction (MINING_SPEC.md § 6).
  CREATE TABLE IF NOT EXISTS conversion_windows (
    id           TEXT PRIMARY KEY,
    pot_points   INTEGER NOT NULL,
    opens_at     TEXT NOT NULL,
    closes_at    TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled','cancelled')),
    total_burned BIGINT NOT NULL DEFAULT 0,
    points_paid  INTEGER NOT NULL DEFAULT 0,
    created_by   TEXT REFERENCES users(id),
    settled_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS conversion_burns (
    id          TEXT PRIMARY KEY,
    window_id   TEXT NOT NULL REFERENCES conversion_windows(id),
    user_id     TEXT NOT NULL REFERENCES users(id),
    rozi        BIGINT NOT NULL,
    points_paid INTEGER,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_burns_window ON conversion_burns(window_id);

  -- Wallet-to-wallet ROZI transfer. NOT an order book: there is no price, no
  -- matching, and no money leg. If we matched trades or custodied the money we
  -- would BE an unlicensed exchange (MINING_SPEC.md § 7).
  CREATE TABLE IF NOT EXISTS rozi_transfers (
    id           TEXT PRIMARY KEY,
    from_user_id TEXT NOT NULL REFERENCES users(id),
    to_user_id   TEXT NOT NULL REFERENCES users(id),
    amount       BIGINT NOT NULL,   -- gross, debited from sender
    fee_burned   BIGINT NOT NULL DEFAULT 0,
    received     BIGINT NOT NULL,   -- amount - fee_burned, credited to recipient
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_transfers_from ON rozi_transfers(from_user_id);
  CREATE INDEX IF NOT EXISTS idx_transfers_to ON rozi_transfers(to_user_id);

  -- The POINTS ledger gains exactly two new source types, and no others:
  --   mining_conversion  — credit, paid out of a Conversion Window's fixed pot
  --   booster_purchase   — debit, Points spent on a hashrate booster
  -- Both are the only places the two currencies are allowed to be in the same
  -- sentence, and both are capped. Anything else writing Points from mining is
  -- a bug and this CHECK is what will catch it.
  ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_source_type_check;
  ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_source_type_check
    CHECK (source_type IN ('task_completion','referral_bonus','withdrawal',
                           'admin_adjustment','mining_conversion','booster_purchase'));

  -- ---------------------------------------------------------------------------
  -- KYC (founder decision, 2026-07-13): manual staff review of a selfie + the
  -- front and back of a national ID card.
  --
  -- A user only becomes a VALID user by passing this, and "valid" is load-bearing
  -- in three places: they are the only ones counted toward a halving milestone,
  -- the only invitees who earn their inviter anything, and the only accounts that
  -- can withdraw. That is the anti-farm line — a thousand fake signups can no
  -- longer inflate a referrer's mining rate, because a fake signup cannot hold up
  -- a real ID card to a camera.
  --
  -- Mining itself is NOT gated. A new user mines from minute one; making them wait
  -- days for a human review before the app does anything would kill signup.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status TEXT NOT NULL DEFAULT 'none'
    CHECK (kyc_status IN ('none','pending','approved','rejected'));
  CREATE INDEX IF NOT EXISTS idx_users_kyc ON users(kyc_status);

  -- When the user was first approved. This anchors the referral first-task bonus
  -- (see credit.ts): the bonus pays on the invitee's first credited task ON OR
  -- AFTER this moment, not their literal first task. Because a user verifies only
  -- when they near the withdrawal threshold — long after their real first task —
  -- the literal-first-task bonus almost never fired, so it was moved here.
  -- Backfilled once from the review row for anyone already approved (the UPDATE
  -- is below, after kyc_submissions is created); new approvals set it directly in
  -- staffKyc.ts.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_approved_at TEXT;

  -- THE IMAGES ARE ENCRYPTED AT REST (AES-256-GCM, see kyc.ts). These are
  -- Pakistani national ID cards: a plaintext dump of this table is the single
  -- worst thing that could leak out of this product. The key lives in
  -- KYC_ENCRYPTION_KEY on Railway and never in the database, so a stolen DB
  -- backup alone is not enough to read them.
  --
  -- Deliberately NOT stored: ID number, name, date of birth. We do not need them
  -- — a human is looking at the picture — and every field we do not keep is a
  -- field that cannot leak.
  CREATE TABLE IF NOT EXISTS kyc_submissions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id),
    selfie        TEXT NOT NULL,   -- encrypted, base64(iv:tag:ciphertext)
    id_front      TEXT NOT NULL,
    id_back       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected')),
    reject_reason TEXT,
    reviewed_by   TEXT REFERENCES users(id),
    reviewed_at   TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_submissions(status, created_at);
  -- One OPEN submission per user. A resubmission after a rejection is allowed
  -- (that row is no longer pending), but a user cannot flood the review queue.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_kyc_one_pending
    ON kyc_submissions(user_id) WHERE status = 'pending';

  -- One-time backfill for users approved before kyc_approved_at existed: take the
  -- time of their approving review. Runs every boot but is a cheap no-op after the
  -- first pass — it only touches approved rows whose stamp is still NULL, and new
  -- approvals fill the stamp themselves. See kyc_approved_at above / credit.ts.
  UPDATE users SET kyc_approved_at = (
    SELECT MAX(k.reviewed_at) FROM kyc_submissions k
    WHERE k.user_id = users.id AND k.status = 'approved'
  ) WHERE kyc_status = 'approved' AND kyc_approved_at IS NULL;
`;

// Launch rig catalogue (MINING_SPEC.md § 4.5). Seeded only when absent — Admin
// owns this list at runtime, so a re-deploy must never stomp their edits.
// Costs are in WHOLE ROZI (the ledger is in micro; the conversion happens at the
// moment of the debit). Rescaled 10x down when piBaseRate dropped 100 -> 10, so
// the tree paces exactly as designed: the first rig is ~5 days of baseline
// mining, not 50. If the rate is retuned again, these have to move with it or
// the whole sink silently becomes unreachable.
const SEED_RIGS: [string, string, string, number, number, number][] = [
  // id, name, icon, base_cost, base_power, sort
  ["old_phone", "Old Phone", "phone", 50, 5, 1],
  ["laptop", "Laptop", "laptop", 300, 25, 2],
  ["rig", "Mining Rig", "chip", 2_000, 150, 3],
  ["server", "Server Rack", "server", 12_000, 800, 4],
  ["datacentre", "Data Centre", "building", 75_000, 5_000, 5],
];

// ONE-TIME: rescale every ROZI amount from whole ROZI to micro-ROZI (x1e6).
//
// The ledger used to hold whole ROZI. It now holds millionths, so every historical
// row means something a million times too small until it is scaled. Rig costs are
// NOT touched — those stay in whole ROZI and are converted at the debit.
//
// THIS MUST NEVER RUN TWICE. A second pass would multiply every balance by 1e12,
// so it is gated on a marker row written inside the SAME transaction as the
// update: either both land or neither does, and a crash halfway through rolls the
// whole thing back rather than leaving half the ledger in the wrong unit.
async function migrateRoziToMicro(): Promise<void> {
  const done = await sql.get<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = 'rozi_micro_migrated'");
  if (done) return;

  await sql.tx(async (t) => {
    // Re-check inside the transaction: two API instances booting at once must not
    // both pass the check above and both scale the ledger.
    await t.run("SELECT pg_advisory_xact_lock(hashtext('rozi-micro-migration'))");
    const already = await t.get<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'rozi_micro_migrated'");
    if (already) return;

    const M = 1_000_000;
    await t.run(`UPDATE rozi_ledger SET amount = amount * ${M}`);
    await t.run(
      `UPDATE mining_epochs SET emission = emission * ${M},
                                emitted  = emitted  * ${M},
                                withheld = withheld * ${M}`);
    await t.run(
      `UPDATE rozi_transfers SET amount     = amount     * ${M},
                                 fee_burned = fee_burned * ${M},
                                 received   = received   * ${M}`);
    await t.run(`UPDATE conversion_burns SET rozi = rozi * ${M}`);
    await t.run(`UPDATE conversion_windows SET total_burned = total_burned * ${M}`);

    await t.run(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ('rozi_micro_migrated','1',?)",
      now(),
    );
  });
  console.log("MINING: rescaled the ROZI ledger to micro-ROZI (x1e6). This runs once.");
}

export async function initDb(): Promise<void> {
  await driver.exec(SCHEMA);
  await driver.exec(MIGRATIONS);
  await driver.exec(MINING_SCHEMA);
  await migrateRoziToMicro();
  for (const [id, name, icon, baseCost, basePower, sort] of SEED_RIGS) {
    await sql.run(
      `INSERT INTO rigs (id, name, icon, base_cost, base_power, sort, created_at)
       VALUES (?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`,
      id, name, icon, baseCost, basePower, sort, now(),
    );
  }
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
  // CPX Research — the first REAL (live) network. The 60/40 split is enforced by
  // the conversion rate set in the CPX dashboard (1 USD = 600 points), so the
  // amount that arrives in the postback is already the user's share; the split
  // column here is informational for this network.
  await sql.run(
    `INSERT INTO networks (id, name, type, status, commission_split_pct, referral_bonus_pct, referral_bonus_pct_l2, referral_first_task_bonus, created_at)
     VALUES ('cpx','CPX Research','offerwall','active',60,15,5,100,?)
     ON CONFLICT (id) DO NOTHING`, now(),
  );
  // 'custom' — our OWN tasks, written in /staff. Not an ad network (no external
  // payout, so its split is 0 and meaningless), but it needs a networks row so
  // custom tasks can credit, their referral rates stay Admin-tunable, and an
  // Admin can switch all custom tasks off at once. Inserted here (not only in
  // seed.ts) so a fresh deploy creates it with no manual seed step.
  await sql.run(
    `INSERT INTO networks (id, name, type, status, commission_split_pct, referral_bonus_pct, referral_bonus_pct_l2, referral_first_task_bonus, created_at)
     VALUES ('custom','Our own tasks','custom','active',0,15,5,100,?)
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
    sourceType:
      | "task_completion" | "referral_bonus" | "withdrawal" | "admin_adjustment"
      // The only two ways mining may touch the Points ledger. Both are capped.
      | "mining_conversion" | "booster_purchase";
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
// Record a privileged staff action. Append-only, like the ledger.
export async function logAudit(
  params: {
    actorUserId: string;
    actorRole: string;
    action: string;
    targetUserId?: string | null;
    detail?: string;
  },
  t: Pick<TxApi, "run"> = sql,
): Promise<string> {
  const id = newId();
  await t.run(
    `INSERT INTO admin_audit_log (id, actor_user_id, actor_role, action, target_user_id, detail, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    id, params.actorUserId, params.actorRole, params.action,
    params.targetUserId ?? null, params.detail ?? null, now(),
  );
  return id;
}

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

// ---- ROZI ledger ----------------------------------------------------------
// Deliberately a mirror of postLedger/balanceOf above. ROZI is a second
// append-only ledger with a second balance-is-always-a-SUM rule, and keeping the
// two shapes identical is what makes it obvious when something tries to write
// across them (guardrail #7 — see MINING_SCHEMA).

export type RoziSource =
  | "mining" | "rig_purchase" | "transfer_in" | "transfer_out"
  | "transfer_fee" | "conversion_burn" | "admin_adjustment" | "bonus";

// Amounts are MICRO-ROZI (millionths). The parameter is named `micro`, not
// `rozi`, on purpose: it is the one thing that makes a unit mistake a compile
// error instead of a silent factor-of-a-million in someone's balance.
export async function postRozi(
  params: {
    userId: string;
    micro: number; // always a positive magnitude, in MICRO-ROZI
    direction: "credit" | "debit";
    sourceType: RoziSource;
    sourceRefId?: string;
    note?: string;
  },
  t: Pick<TxApi, "run"> = sql,
): Promise<string> {
  const magnitude = Math.abs(Math.trunc(params.micro));
  const amount = params.direction === "credit" ? magnitude : -magnitude;
  const id = newId();
  await t.run(
    `INSERT INTO rozi_ledger (id, user_id, amount, direction, source_type, source_ref_id, note, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id, params.userId, amount, params.direction, params.sourceType,
    params.sourceRefId ?? null, params.note ?? null, now(),
  );
  return id;
}

// Returns MICRO-ROZI. Renamed from roziBalanceOf when the ledger moved to
// millionths, so that every caller had to be revisited by the compiler rather
// than silently keeping a number that now means something a million times smaller.
//
// BIGINT sums come back from node-postgres as a STRING (it will not silently
// narrow an int8), so Number() is doing real work here — without it every ROZI
// balance would be a string and every comparison against it would be nonsense.
// The largest value possible here is the supply cap in micro (650M x 1e6 =
// 6.5e14), comfortably inside 2^53, so Number is exact.
export async function roziBalanceMicroOf(
  userId: string,
  t: Pick<TxApi, "get"> = sql,
): Promise<number> {
  const row = await t.get<{ bal: string | number }>(
    "SELECT COALESCE(SUM(amount), 0) AS bal FROM rozi_ledger WHERE user_id = ?",
    userId,
  );
  return Number(row?.bal ?? 0);
}
