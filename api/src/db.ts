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
import { deriveAddress } from "./custody.ts";

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
  -- One-time codes that BIND a Telegram to an existing account. The website
  -- mints one, the t.me link carries it into the Mini App, the Mini App login
  -- consumes it (start_param "link-<code>"). Hash only, 10-minute expiry,
  -- single use — a leaked link must not let someone else attach THEIR
  -- Telegram to your account later.
  CREATE TABLE IF NOT EXISTS telegram_link_codes (
    code_hash  TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL
  );

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
    payout_rail    TEXT NOT NULL,          -- chain id: bep20 | base | aptos (old rows may hold the dropped "polygon")
    payout_address TEXT,                   -- destination USDT wallet address
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','agent_approved','manager_approved','sending','paid','rejected')),
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

  -- ---- ACTIVITY (brief part 48: DAU / WAU / MAU / retention) ---------------
  -- One row per user per UTC day on which they made an authenticated request.
  --
  -- WHY A TABLE AND NOT A COLUMN. A users.last_active_at column answers "are they
  -- active now" and nothing else: it holds one value, so it cannot say whether
  -- someone was active last Tuesday, which is the only thing retention is made
  -- of. A row per day is the smallest structure that can answer both.
  --
  -- It is cheap because it is written at most ONCE per user per day per process
  -- (analytics.ts memoises the write), and because the conflict is a primary-key
  -- probe that does nothing. It holds no PII beyond the user id already
  -- everywhere else in this schema.
  CREATE TABLE IF NOT EXISTS user_activity_days (
    user_id TEXT NOT NULL REFERENCES users(id),
    day     TEXT NOT NULL,
    PRIMARY KEY (user_id, day)
  );
  CREATE INDEX IF NOT EXISTS idx_activity_day ON user_activity_days(day);

  -- ---- LEADERBOARD EXCLUSIONS (brief part 42) ------------------------------
  -- Who must NOT appear on the public boards. Two real cases, and both of them
  -- happen before the first real user does:
  --   • our own staff and test accounts, which are seeded with balances and
  --     would otherwise sit at rank 1 on a board whose entire job is social
  --     proof — the one place a fake number does the most damage;
  --   • an account under fraud review, which must not be held up as an example
  --     of what honest work earns while we are deciding whether to claw it back.
  --
  -- A row here is a SUPPRESSION, never a punishment: it hides the user from two
  -- read-only boards and touches no balance, no ledger and no ability to earn.
  -- That is why it is a separate table rather than a column on users — nothing
  -- about the account changes, only what one page draws.
  CREATE TABLE IF NOT EXISTS leaderboard_exclusions (
    user_id     TEXT PRIMARY KEY REFERENCES users(id),
    reason      TEXT NOT NULL,
    excluded_by TEXT,
    created_at  TEXT NOT NULL
  );

  -- ---- NOTIFICATIONS (brief part 39) ---------------------------------------
  -- An in-app inbox. One row per user per message.
  --
  -- ⚠️ THE INBOX IS THE CHANNEL; PUSH IS AN EXTRA, AND THAT ORDER IS THE WHOLE
  -- DESIGN. push.ts states outright that a push is sent on exactly four events
  -- and never for marketing, because a subscription burnt on announcements is a
  -- subscription revoked before the withdrawal-paid notification it existed
  -- for. An inbox interrupts nobody, so a staff announcement lands HERE by
  -- default; sending a push alongside it is a separate, explicit choice on the
  -- compose screen. See routes/staffNotify.ts.
  --
  -- ⚠️ THE AUDIENCE IS MATERIALISED AT SEND TIME, not re-evaluated at read
  -- time. "Everyone who had a balance on Tuesday" must not silently come to
  -- mean "everyone who has one today" — a message about a specific moment
  -- would keep finding new recipients forever, and the record of who was told
  -- what would be unanswerable.
  CREATE TABLE IF NOT EXISTS notifications (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    -- Where tapping it goes, e.g. "/wallet". Internal paths only (validated at
    -- the route): an inbox row is written by staff and rendered inside the app,
    -- so an external link here is a phishing vector wearing our own chrome.
    url          TEXT,
    -- Which broadcast produced it, or NULL for a one-to-one message.
    broadcast_id TEXT,
    read_at      TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);
  -- The unread badge is read on every screen that shows the top bar, so the
  -- count has its own partial index rather than scanning a user's whole inbox.
  CREATE INDEX IF NOT EXISTS idx_notifications_unread
    ON notifications(user_id) WHERE read_at IS NULL;

  -- What was sent, to whom, by whom. Kept separately from the per-user rows so
  -- "what did we announce last week" survives a user deleting their inbox, and
  -- so the audience rule that was USED is recorded rather than re-guessed.
  CREATE TABLE IF NOT EXISTS notification_broadcasts (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    url         TEXT,
    audience    TEXT NOT NULL,
    recipients  INTEGER NOT NULL DEFAULT 0,
    pushed      INTEGER NOT NULL DEFAULT 0,
    sent_by     TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  -- ---- HOME CONTENT (brief part 43) ----------------------------------------
  -- Announcement cards on the earner home screen, editable without a deploy.
  --
  -- ⚠️ THE ICON IS A CLOSED LIST, NEVER A URL — the same rule as task icons.
  -- These cards sit directly above a balance, and an admin-supplied remote
  -- image there is a third-party request on a money screen.
  --
  -- ⚠️ THE LINK IS AN INTERNAL PATH BY DEFAULT. An https link is allowed
  -- (someone will want to point at a Telegram channel) but is validated at the
  -- route and rendered with an outward-link marker, so a card that leaves the
  -- app says so before it is tapped.
  CREATE TABLE IF NOT EXISTS content_blocks (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    icon        TEXT NOT NULL DEFAULT 'info',
    link_url    TEXT,
    link_label  TEXT,
    tone        TEXT NOT NULL DEFAULT 'info' CHECK (tone IN ('info','good','warn')),
    status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live')),
    -- A scheduling window. Both optional: NULL start = live now, NULL end =
    -- until switched off. Checked at READ time, so a card that has expired
    -- stops appearing without anything having to run on a timer and remember.
    starts_at   TEXT,
    ends_at     TEXT,
    sort        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  -- ---- SUPPORT: internal notes + assignment (brief part 40) ----------------
  -- ⚠️ 'internal' IS A NOTE THE USER MUST NEVER SEE, and the CHECK constraint
  -- is not what protects them — the earner-facing query is. See the filter in
  -- routes/app.ts's GET /support/tickets, and the regression test that posts an
  -- internal note and then reads the ticket as the user.
  --
  -- Postgres has no "ALTER CONSTRAINT", and CREATE TABLE IF NOT EXISTS is a
  -- no-op on an existing table, so an existing database keeps the old
  -- two-value constraint unless it is dropped and re-added explicitly — the
  -- same dance usdt_ledger's CHECK needed when 'refund' was added.
  ALTER TABLE ticket_messages DROP CONSTRAINT IF EXISTS ticket_messages_author_role_check;
  ALTER TABLE ticket_messages ADD CONSTRAINT ticket_messages_author_role_check
    CHECK (author_role IN ('user','staff','internal'));
  ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_to TEXT;

  -- ---- STAFF ROLES & AUDIT ------------------------------------------------
  -- Roles are job-shaped now, not a three-rung ladder (see permissions.ts for
  -- why a ladder cannot express "Finance but not campaigns"). The three old
  -- strings stay legal and keep exactly the reach they had — live rows hold
  -- them, and renaming them would be a migration that buys nothing.
  ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_role_check;
  ALTER TABLE admin_users ADD CONSTRAINT admin_users_role_check
    CHECK (role IN ('agent','manager','admin',
                    'operations','task_manager','finance','support','marketing','analyst'));

  -- An audit row now records WHAT CHANGED, not just that something did.
  -- "Admin X changed the mining rate" is not answerable at 3am; "from 0.5 to
  -- 50" is. Both are nullable: plenty of actions (approve, resolve) have no
  -- before/after, and forcing a value there would only invite a fake one.
  ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS previous_value TEXT;
  ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS new_value TEXT;
  -- Where the action came from. Kept coarse on purpose: enough to spot a
  -- compromised staff account signing in from somewhere new, not a location
  -- history of an employee.
  ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS actor_ip TEXT;
  CREATE INDEX IF NOT EXISTS idx_audit_action ON admin_audit_log(action, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_target ON admin_audit_log(target_user_id, created_at DESC);

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
  -- Which logo the task card shows, keyed the same way rigs are (a short name an
  -- Admin picks from a list, not a URL). A name rather than an uploaded image on
  -- purpose: task cards render inside the app, so an admin-supplied image URL
  -- would be a third-party request on a money screen and a way to smuggle
  -- tracking pixels into it. NULL falls back to the icon for the task's type.
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS icon TEXT;

  -- ---- PER-CAMPAIGN BUDGET AND REVENUE (brief parts 15 + 16) ---------------
  --
  -- ⚠️ WITHOUT A BUDGET THERE IS NO AUTO-PAUSE, and without an auto-pause a
  -- partner who bought 2,000 conversions can be given 20,000. A task row had one
  -- reward field and nothing that said how many times it was allowed to pay out,
  -- so "stop this campaign" was a human noticing and clicking Disable. Adding
  -- the column now is free; retrofitting it onto live campaigns is a migration
  -- done under pressure, which is why it goes in ahead of the rest of the task
  -- engine work.
  --
  -- NULL means UNLIMITED on both caps, so every existing row keeps exactly the
  -- behaviour it has today. A cap is opt-in per campaign.
  --
  --   budget_conversions — how many credited completions this campaign may ever
  --                        pay for. The primary control: it is the unit a
  --                        partner actually buys.
  --   budget_points      — a hard ceiling on the POINTS this campaign may pay in
  --                        task rewards. A second brake for the case where the
  --                        reward is edited mid-flight.
  --
  -- ⚠️ budget_points COUNTS TASK REWARDS ONLY, NOT THE REFERRAL BONUSES a
  -- completion triggers. Those are real spend and they ARE reported in the
  -- margin below — but they are a growth cost paid out of our margin, and
  -- nothing in a partner's contract mentions them. Charging them against the
  -- campaign budget would stop a campaign early for a reason the partner's own
  -- numbers cannot explain, which is the harder conversation of the two.
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS budget_conversions INTEGER;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS budget_points BIGINT;
  -- What the PARTNER PAYS US per credited conversion, in micro-USD (1e6 = $1).
  -- Part 15: without it, "is this campaign profitable" is unanswerable — the
  -- ledger records every point we paid out and nothing at all about what came
  -- in. 0 (the default) means "not recorded", which reads as unknown margin
  -- rather than as a campaign that earns nothing.
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS revenue_per_conversion_micro BIGINT NOT NULL DEFAULT 0;
  -- Set when a cap was reached and the campaign auto-paused itself. Kept as a
  -- stamp rather than inferred from status = 'exhausted', so raising the budget
  -- and reactivating still leaves the record that it ran out once.
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS budget_exhausted_at TEXT;

  -- Whether a 'proof' task ASKS THE USER FOR EVIDENCE (founder, 2026-08-01).
  --
  -- 1 (the default, and what every existing row keeps): the user types their
  --   username / a description of what they did, and staff read it.
  -- 0: the user taps "I did it" and the claim goes to the same queue with no
  --   text. For "join our WhatsApp channel" there is nothing worth typing —
  --   asking for it just loses people at the last step.
  --
  -- ⚠️ THIS IS NOT A SELF-CREDIT SWITCH, and it must never become one. Both
  -- settings end in exactly the same place: a pending row in task_proofs that a
  -- STAFF MEMBER approves before any points move (guardrail #1). What changes is
  -- only whether the app collects a sentence on the way there.
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS proof_required INTEGER NOT NULL DEFAULT 1;
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

  -- Set when the user PROVED they hold this address, by signing our challenge
  -- with the wallet itself (src/wallet.ts). NULL means the address was typed or
  -- pasted, which is all we ever had before and is still allowed — a smart-
  -- contract wallet cannot personal_sign, and not every phone has a wallet app.
  --
  -- ⚠️ CHANGING THE ADDRESS MUST CLEAR THIS. See saveAddress() in
  -- routes/withdrawals.ts: a proof is a proof about ONE address, and letting the
  -- badge survive an edit would show "verified" over an address nobody verified
  -- — worse than never showing it, because staff and users would both trust it.
  ALTER TABLE payout_addresses ADD COLUMN IF NOT EXISTS verified_at TEXT;
  ALTER TABLE payout_addresses ADD COLUMN IF NOT EXISTS verify_method TEXT;

  -- One-time challenges for the wallet proof above. The row holds the exact
  -- message we issued rather than the parts to rebuild it from: verification
  -- then reads back the same bytes the wallet signed, instead of reconstructing
  -- a string that must match it character for character forever.
  --
  -- Single-use is enforced by an atomic claim on used_at, not by deleting the
  -- row — two taps arriving together must not both succeed.
  CREATE TABLE IF NOT EXISTS wallet_link_nonces (
    nonce      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    chain      TEXT NOT NULL,
    -- The address the user CLAIMED when asking for the challenge, lowercased.
    -- The signature must recover to exactly this, so a signature obtained for
    -- one address can never be submitted for another.
    address    TEXT NOT NULL,
    message    TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wallet_nonces_user ON wallet_link_nonces(user_id);

  -- Global key-value app settings (Admin-tunable), e.g. the withdrawal fee.
  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Fee (in points) charged on a withdrawal, snapshotted from app_settings at
  -- request time so a later Admin change never alters an in-flight request.
  ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS fee_points INTEGER NOT NULL DEFAULT 0;

  -- Whether the destination address had been PROVED by the user (they signed
  -- for it with the wallet — see src/wallet.ts) at the moment they asked to be
  -- paid. Shown to whoever approves the payout, because sending USDT on-chain
  -- cannot be undone and this is the strongest signal we have that the money is
  -- going to the account holder rather than to someone who talked them into
  -- pasting an address.
  --
  -- ⚠️ SNAPSHOTTED, for the same reason fee_points is. The saved address can
  -- change after the request is filed; the reviewer must see what was true when
  -- the user asked, and it must not shift under them while the request sits in
  -- the queue. Recomputing it at read time would do both.
  --
  -- 0 for every row that predates connect-wallet, which is honest: nobody
  -- proved those.
  ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS address_verified INTEGER NOT NULL DEFAULT 0;

  -- ---- Web push subscriptions ----------------------------------------------
  -- One row per browser/device a user turned notifications on for. The endpoint
  -- is the push service's URL for that browser and is unique by construction;
  -- UNIQUE lets a re-subscribe (or the same phone switching accounts) upsert
  -- instead of piling up dead rows. Rows are pruned when the push service says
  -- the subscription is gone (404/410 on send).
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

  -- ---- Hot-path indexes -----------------------------------------------------
  -- Each of these backs a query that runs on EVERY login or EVERY postback.
  -- Without them those are sequential scans that get slower with every user.

  -- Velocity caps (credit.ts): two COUNTs per postback over the user's
  -- completions today, plus the first-task-since-KYC-approval count.
  CREATE INDEX IF NOT EXISTS idx_completions_user_created
    ON task_completions(user_id, created_at);
  -- flagOnce dedupe (fraud.ts): looked up on every login and every flag check.
  CREATE INDEX IF NOT EXISTS idx_fraud_scope
    ON fraud_flags(flag_type, device_id) WHERE resolved_by IS NULL;
  -- ip_reuse detection (fraud.ts): DISTINCT user_id per IP, on every login.
  CREATE INDEX IF NOT EXISTS idx_user_devices_ip ON user_devices(ip);
  -- One Telegram, one account — enforced in auth.ts, but the database is the
  -- last line: two concurrent link/login requests must not both win the id.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id
    ON users(telegram_id) WHERE telegram_id IS NOT NULL;
  -- The user's own withdrawal history, and the staff status queues.
  CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawal_requests(user_id);
  CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawal_requests(status);
  -- payout_address_reuse (fraud.ts) compares LOWER(payout_address) across all
  -- requests at withdrawal time — an expression index or it scans the table.
  CREATE INDEX IF NOT EXISTS idx_withdrawals_addr
    ON withdrawal_requests(LOWER(payout_address));
  -- Telegram login looks a user up by telegram_id (no index meant a full scan).
  CREATE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_id);
  -- referrals/me (SUM of referral_bonus per user) and the leaderboard.
  CREATE INDEX IF NOT EXISTS idx_ledger_user_source
    ON ledger_entries(user_id, source_type);

  -- ---- PROFILE: name, handle, picture (founder, 2026-07-29) ----------------
  --
  -- display_name is cosmetic and free to change. username is the PUBLIC HANDLE
  -- people send ROZI to, which makes it a different kind of thing entirely:
  --
  --   • It is rate-limited to one change every 30 days (username_changed_at).
  --     A handle that can be swapped at will is a scam vector — take a name,
  --     collect a few transfers meant for its old owner, drop it, repeat. The
  --     cooldown is the whole reason the column exists.
  --   • It is UNIQUE, case-insensitively. "Ahmed" and "ahmed" must not be two
  --     different people on a screen where the difference is one transfer going
  --     to the wrong account, so the index is on LOWER(username).
  ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS username_changed_at TEXT;

  -- The account's REAL Telegram identity, captured from the signed initData at
  -- login/link (founder, 2026-09-02: staff were seeing tg1038...@telegram.local
  -- everywhere). Purely informational — never a send target, never unique (a
  -- Telegram username can be changed or reused); the RoziPay username handle
  -- above is still the only thing transfers resolve against.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_username TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_name TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
    ON users(LOWER(username)) WHERE username IS NOT NULL;

  -- The picture lives in its OWN table, not a column on users, and that is
  -- load-bearing rather than tidy-minded: auth.ts reads the user row with
  -- SELECT * on every single authenticated request, so a ~40KB image on that
  -- row would be dragged across the wire on every call the app makes.
  CREATE TABLE IF NOT EXISTS user_avatars (
    user_id    TEXT PRIMARY KEY REFERENCES users(id),
    image      TEXT NOT NULL,   -- data: URL, JPEG, downscaled in the browser
    updated_at TEXT NOT NULL
  );

  -- ---- USDT TOP-UP CREDIT (founder, 2026-07-29) ---------------------------
  --
  -- The founder asked to let people pay real USDT for mining machines. This is
  -- the narrowest shape that answers that, and every narrowing is deliberate:
  --
  --   1. IT IS SPEND-OR-REFUND. ⚠️ AMENDED BY THE FOUNDER 2026-08-01 — read
  --      this whole note before touching the refund path, because the original
  --      rule here was "spend-only, and one must not be added".
  --
  --      What changed: a user may now ask for their own UNSPENT deposit back.
  --      What did NOT change: this balance still cannot be transferred to
  --      another user, converted to Points or ROZI, or used to cash out
  --      EARNINGS. It goes back to the person who sent it, and nowhere else.
  --
  --      Be honest about what that costs. Returning customer money on request
  --      is custody in the plain sense, and custody is the licensed activity
  --      (PVARA) this product routes around everywhere else — see
  --      MINING_SPEC.md § 7 and CUSTODY_SPEC.md § 2c. The founder was told
  --      this and chose it, on the reasoning that money a user can never get
  --      back is a harder sell than the licence question is a risk. That is a
  --      business judgement, recorded here so it is not mistaken for an
  --      oversight and quietly "fixed" by a later reader.
  --
  --      The refund is deliberately the NARROWEST shape that honours it:
  --        • capped at the user's own remaining deposit balance, so no earned
  --          money and no minted ROZI can ever leave through this door;
  --        • staff-approved and sent BY HAND from the treasury, same as every
  --          payout — no hot wallet, no signer, no automation;
  --        • debited at REQUEST time under the advisory lock, so it cannot be
  --          double-spent against a rig purchase while it queues.
  --      A general 'withdrawal' source_type is STILL refused below, and that
  --      is not an oversight either: it is what keeps "refund your deposit"
  --      from drifting into "withdraw any balance" by one careless commit.
  --   2. DEPOSITS ARE MANUAL AND STAFF-CONFIRMED. The user sends USDT to our
  --      published treasury address and submits the transaction hash; a human
  --      checks it on-chain and confirms. No hot wallet, no derived per-user
  --      addresses, no chain listener, no private key anywhere in this system.
  --      Same posture as the payout side, which has run manually since launch.
  --   3. IT SHIPS OFF (usdtTopupEnabled = 0) and stays off until the founder
  --      sets a treasury address.
  --
  -- Amounts are micro-USDT (1 USDT = 1,000,000) in a BIGINT, for the same
  -- reason ROZI is: a float ledger is how money systems lose cents.
  CREATE TABLE IF NOT EXISTS usdt_ledger (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    -- Signed, exactly like the other two ledgers: a debit is a negative row, so
    -- the balance is always a plain SUM and no row is ever updated. Never
    -- "amount > 0" — that would reject every debit this table exists to record.
    amount      BIGINT NOT NULL CHECK (amount <> 0),
    direction   TEXT NOT NULL CHECK (direction IN ('credit','debit')),
    source_type TEXT NOT NULL
                  CHECK (source_type IN ('topup','rig_purchase','admin_adjustment','refund')),
    source_ref_id TEXT,
    note        TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_usdt_ledger_user ON usdt_ledger(user_id, created_at);

  -- Existing databases were created with the pre-refund CHECK, and
  -- CREATE TABLE IF NOT EXISTS above is a no-op for them — so the new value has
  -- to be granted explicitly or every refund fails at the constraint on a
  -- deployed instance while passing on a fresh one.
  --
  -- ⚠️ 'withdrawal' is STILL NOT IN THIS LIST, on purpose. Deposit credit
  -- leaves by 'refund' (bounded by what the user themselves put in) and by
  -- nothing else. If you are adding a value here, you are changing what this
  -- balance is — go and read the note above the table first.
  ALTER TABLE usdt_ledger DROP CONSTRAINT IF EXISTS usdt_ledger_source_type_check;
  ALTER TABLE usdt_ledger ADD CONSTRAINT usdt_ledger_source_type_check
    CHECK (source_type IN ('topup','rig_purchase','admin_adjustment','refund'));

  -- One request to send a user's own unspent deposit back to them. Mirrors
  -- withdrawal_requests deliberately: same pending/approved/paid/rejected walk,
  -- same human sending it, same tx hash recorded as proof.
  CREATE TABLE IF NOT EXISTS usdt_refund_requests (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id),
    chain         TEXT NOT NULL,
    address       TEXT NOT NULL,
    -- micro-USDT, held by a ledger debit written in the same transaction.
    amount        BIGINT NOT NULL CHECK (amount > 0),
    -- Gas-cost fee (micro-USDT), snapshotted from app_settings at request
    -- time -- same reason withdrawal_requests.fee_points is snapshotted: a
    -- later Admin change must not alter an in-flight request. amount above
    -- is still what gets DEBITED from the user (the full amount they asked
    -- for leaves their deposit balance); this is subtracted only from what
    -- actually gets SENT -- see fee_micro's use in autoRefund.ts and the
    -- staff "mark paid" panel.
    fee_micro     BIGINT NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sending','paid','rejected')),
    -- Snapshotted at request time for the same reason withdrawal_requests
    -- snapshots fee_points and address_verified: the person approving an
    -- irreversible on-chain send must see what was true when the user asked.
    address_verified INTEGER NOT NULL DEFAULT 0,
    tx_hash       TEXT,
    reject_reason TEXT,
    -- No REFERENCES users(id): autoRefund.ts stamps this 'system:auto' for a
    -- refund that settled itself, the same sentinel withdrawal_requests.reviewed_by
    -- already uses for the identical reason on the withdrawal side (see that
    -- table above — its column was never given this FK for exactly this reason).
    reviewed_by   TEXT,
    reviewed_at   TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_usdt_refunds_status ON usdt_refund_requests(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_usdt_refunds_user ON usdt_refund_requests(user_id, created_at);
  -- Existing databases were created with the FK above; DROP so 'system:auto'
  -- (autoRefund.ts) does not fail the constraint on a deployed instance while
  -- passing on a fresh one — same reason the CHECK constraint below is
  -- re-granted explicitly instead of relying on CREATE TABLE IF NOT EXISTS.
  ALTER TABLE usdt_refund_requests DROP CONSTRAINT IF EXISTS usdt_refund_requests_reviewed_by_fkey;
  ALTER TABLE usdt_refund_requests ADD COLUMN IF NOT EXISTS fee_micro BIGINT NOT NULL DEFAULT 0;

  -- One claimed deposit. Credit is posted ONLY when a staff member confirms.
  CREATE TABLE IF NOT EXISTS usdt_topups (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id),
    chain         TEXT NOT NULL,
    tx_hash       TEXT NOT NULL,
    amount        BIGINT NOT NULL CHECK (amount > 0),  -- micro-USDT, as claimed
    status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','confirmed','rejected')),
    reject_reason TEXT,
    reviewed_by   TEXT REFERENCES users(id),
    reviewed_at   TEXT,
    created_at    TEXT NOT NULL
  );
  -- ONE CLAIM PER TRANSACTION, EVER, ACROSS ALL USERS. Without this, the same
  -- real deposit can be pasted by ten accounts and confirmed ten times by a
  -- tired reviewer who recognises the hash but not that they have seen it
  -- before. This index is the actual defence; the human is the second one.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_usdt_topups_tx
    ON usdt_topups(LOWER(chain), LOWER(tx_hash));
  CREATE INDEX IF NOT EXISTS idx_usdt_topups_status ON usdt_topups(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_usdt_topups_user ON usdt_topups(user_id, created_at);

  -- Per-user deposit addresses (CUSTODY_SPEC.md § 5, step 1 — READ-ONLY: this
  -- table only records an address that was shown to a user. Nothing sweeps,
  -- nothing auto-credits; a deposit made to one of these still gets confirmed
  -- the same way every deposit has been confirmed since launch, by a staff
  -- member matching a pasted tx hash. See custody.ts for the derivation itself
  -- — it holds no private key, only the account xpub named in config.ts.
  CREATE SEQUENCE IF NOT EXISTS deposit_wallet_index_seq;
  CREATE TABLE IF NOT EXISTS deposit_wallets (
    user_id    TEXT NOT NULL REFERENCES users(id),
    chain      TEXT NOT NULL,
    addr_index BIGINT NOT NULL,
    address    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, chain)
  );
  -- Two different accounts must never be handed the same address, and the
  -- same (chain, index) must never be derived twice — either one would mean
  -- a deposit could land somewhere staff cannot tell apart.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_deposit_wallets_index ON deposit_wallets(chain, addr_index);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_deposit_wallets_address ON deposit_wallets(chain, LOWER(address));

  -- The safety valve for automatic on-chain withdrawal (founder, 2026-08-05):
  -- "fully automatic, staff can hold/pause/restrict an account or funds". A
  -- withdrawal request from a held account is never auto-settled — it drops
  -- into the exact same manual queue every withdrawal used to go through, so
  -- "held" costs nothing extra to implement on the paying side. NULL reason =
  -- not held. A hold with a NULL until date is PERMANENT until a staff member
  -- explicitly clears it; a hold with a date lifts itself the moment that date
  -- passes, checked at the point of use, never swept or cleaned up separately.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS withdrawal_hold_reason TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS withdrawal_hold_until TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS withdrawal_hold_by TEXT REFERENCES users(id);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS withdrawal_hold_at TEXT;

  -- A formal "under review" state (founder, 2026-08-27) — distinct from BOTH
  -- active and suspended, and from the Users panel's "suspect (N)" badge, which
  -- is only a live COUNT of open fraud flags: it clears itself the instant those
  -- flags resolve, so it cannot record "we are looking into this" across a
  -- multi-day investigation. This is the opposite — a real, staff-SETTABLE
  -- marker a person turns on and off deliberately. NULL reason = not under
  -- review.
  --
  -- ⚠️ THIS DOES NOT GATE ANYTHING, ON PURPOSE. It is a triage label, the exact
  -- same shape as withdrawal_hold_* just above, not a third value squeezed into
  -- status — requireActiveUser (auth.ts) treats any status other than
  -- 'active' as suspended, so a real third status value would silently lock the
  -- account out the moment it was set. "Distinct from active/suspended" means
  -- this must NOT do that.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS under_review_reason TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS under_review_by TEXT REFERENCES users(id);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS under_review_at TEXT;

  -- CUSTODY_SPEC.md § 5 steps 2-3: the chain listener + sweeper. This is where
  -- deposits stop needing a staff member to paste a tx hash.

  -- One row per on-chain transfer the listener (or a webhook, later) has
  -- OBSERVED paying one of our deposit addresses. Mirrors usdt_topups' walk
  -- (pending-ish -> confirmed -> credited) but system-detected, not
  -- staff-confirmed, and general across chains rather than BEP20-only.
  CREATE TABLE IF NOT EXISTS chain_deposits (
    id                     TEXT PRIMARY KEY,
    user_id                TEXT NOT NULL REFERENCES users(id),
    chain                  TEXT NOT NULL,
    address                TEXT NOT NULL,
    tx_hash                TEXT NOT NULL,
    -- NULL for chains with no concept of "which event in this tx" (UTXO vout,
    -- account-based chains): COALESCE'd to -1 in the unique index below so
    -- every chain shares one idempotency shape.
    log_index              INTEGER,
    amount                 BIGINT NOT NULL CHECK (amount > 0), -- micro-token, as OBSERVED on-chain
    token                  TEXT NOT NULL,
    block_number           BIGINT NOT NULL,
    block_hash              TEXT NOT NULL,
    confirmations_required INTEGER NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'seen'
                            CHECK (status IN ('seen','confirmed','credited','reorged_out')),
    credited_ledger_id     TEXT,
    -- Set once the sweeper has moved this deposit's share of the address's
    -- balance into treasury. NULL = still sitting on the deposit address.
    -- Sweeping never re-touches usdt_ledger; this column is purely how
    -- deposits/sweep.ts knows what still needs consolidating.
    swept_at               TEXT,
    first_seen_at          TEXT NOT NULL,
    confirmed_at           TEXT,
    credited_at            TEXT,
    created_at             TEXT NOT NULL
  );
  -- ONE CLAIM PER (chain, tx, event), EVER. A single EVM transaction can emit
  -- several Transfer events to DIFFERENT known addresses (e.g. a router
  -- splitting a payment) — without log_index in the key those would collide
  -- and only the first would ever be recorded. This is the actual defence
  -- against crediting the same on-chain event twice, same role idx_usdt_topups_tx
  -- plays for staff-confirmed deposits.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_chain_deposits_event
    ON chain_deposits(LOWER(chain), LOWER(tx_hash), COALESCE(log_index, -1));
  CREATE INDEX IF NOT EXISTS idx_chain_deposits_status ON chain_deposits(chain, status);
  CREATE INDEX IF NOT EXISTS idx_chain_deposits_user ON chain_deposits(user_id, created_at);

  -- How far the deposit scanner has scanned, per chain. Read+advanced inside
  -- the same locked tick as the scan itself (deposits/scanner.ts), so two API
  -- instances never scan the same block range twice or skip one.
  CREATE TABLE IF NOT EXISTS deposit_scan_cursors (
    chain                 TEXT PRIMARY KEY,
    last_scanned_block    BIGINT NOT NULL,
    last_scanned_block_hash TEXT,
    updated_at            TEXT NOT NULL
  );
  -- The native-value scanner (deposits/adapters/evmNative.ts) shares this same
  -- table under a distinct pseudo-chain key ("<chain>:native") rather than a
  -- schema change — it is a plain TEXT primary key with no FK to a real chain
  -- list, and giving it its own row keeps its cadence independent of the
  -- ERC-20 log-scan cursor for the same chain (a heavier per-block RPC shape).

  -- A plain native-value (BNB) transfer INTO one of our deposit addresses.
  -- Deliberately separate from chain_deposits, not a 'bnb' row in it: BNB has
  -- ZERO ledger entry, ever (bnbWithdraw.ts's own rule — the balance shown on
  -- /wallet/bnb is a live eth_getBalance read, never a stored liability). This
  -- table exists ONLY to give a real deposit a history row; it has no
  -- credited_ledger_id column and NEVER GETS ONE — do not wire this into
  -- postUsdt or any ledger-crediting path. A native transfer emits no log
  -- event, so this can only be found by walking full block bodies
  -- (eth_getBlockByNumber(..., true)) and matching top-level tx.to — internal
  -- value transfers from a contract call are out of scope, same "no full
  -- trace-based indexer" boundary this codebase already draws elsewhere.
  CREATE TABLE IF NOT EXISTS native_deposits (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id),
    chain          TEXT NOT NULL,
    address        TEXT NOT NULL,
    tx_hash        TEXT NOT NULL,
    from_address   TEXT NOT NULL,
    amount_wei     TEXT NOT NULL,
    block_number   BIGINT NOT NULL,
    block_hash     TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'seen'
                    CHECK (status IN ('seen','confirmed','reorged_out')),
    first_seen_at  TEXT NOT NULL,
    confirmed_at   TEXT,
    created_at     TEXT NOT NULL
  );
  -- One native transfer = one top-level transaction; no log_index concept.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_native_deposits_tx
    ON native_deposits(LOWER(chain), LOWER(tx_hash));
  CREATE INDEX IF NOT EXISTS idx_native_deposits_user ON native_deposits(user_id, created_at);

  -- One sweep (deposit address -> treasury) per row. Two-phase for chains that
  -- need native gas funded to the deposit address before it can send the token
  -- itself (deposits/sweep.ts): pending -> gas_sent -> gas_confirmed -> swept.
  -- Sweeping NEVER touches usdt_ledger — crediting already happened when
  -- chain_deposits flipped to 'credited'. This table is pure treasury
  -- consolidation bookkeeping.
  CREATE TABLE IF NOT EXISTS sweep_jobs (
    id                    TEXT PRIMARY KEY,
    chain                 TEXT NOT NULL,
    deposit_wallet_ref    TEXT NOT NULL, -- the deposit address being swept
    token                 TEXT NOT NULL,
    amount_at_sweep_start BIGINT NOT NULL, -- micro-token, snapshotted when the job opened
    status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','gas_sent','gas_confirmed','swept','failed')),
    gas_tx_hash           TEXT,
    sweep_tx_hash         TEXT,
    attempts              INTEGER NOT NULL DEFAULT 0,
    last_error            TEXT,
    created_at            TEXT NOT NULL,
    completed_at          TEXT
  );
  -- THE double-sweep guard. Only one job that is not yet swept/failed may
  -- exist per (chain, address) at a time — a duplicate sweep trigger (a
  -- restarted process, a re-run tick, a staff retry) hits this constraint
  -- instead of funding gas or sending the token twice.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sweep_jobs_active
    ON sweep_jobs(chain, deposit_wallet_ref) WHERE status NOT IN ('swept','failed');
  CREATE INDEX IF NOT EXISTS idx_sweep_jobs_status ON sweep_jobs(status, created_at);

  -- Pre-generated address inventory for chains where watch-only derivation is
  -- cryptographically impossible (Solana, Aptos — ed25519 has no public-only
  -- child derivation; see custodySeeds.ts). Generated OFFLINE in batches,
  -- imported once, assigned to users like numbered stock rather than derived
  -- live. private_key_encrypted uses its OWN AES secret (POOL_KEY_ENCRYPTED_SECRET,
  -- config.ts), separate from every other encrypted secret in this system.
  CREATE TABLE IF NOT EXISTS deposit_address_pool (
    id                    TEXT PRIMARY KEY,
    chain                 TEXT NOT NULL CHECK (chain IN ('solana','aptos')),
    address               TEXT NOT NULL,
    private_key_encrypted TEXT NOT NULL,
    assigned_to_user_id   TEXT REFERENCES users(id),
    assigned_at           TEXT,
    created_at            TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_address ON deposit_address_pool(chain, LOWER(address));
  -- One pool row per (user, chain) — the assigned half mirrors deposit_wallets'
  -- own (user_id, chain) primary key, just expressed as a partial index because
  -- this table's own primary key is the pool row, not the (user, chain) pair.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_one_per_user
    ON deposit_address_pool(chain, assigned_to_user_id) WHERE assigned_to_user_id IS NOT NULL;

  -- Which pool row a deposit_wallets row for an ed25519 chain points back to.
  -- secp256k1 chains (bep20 today) leave this NULL and keep using addr_index.
  ALTER TABLE deposit_wallets ADD COLUMN IF NOT EXISTS pool_ref_id TEXT REFERENCES deposit_address_pool(id);

  -- Which chain a usdt_ledger row's deposit/withdrawal touched. Lets
  -- reconciliation (deposits/reconcile.ts) compare "on-chain balance for THIS
  -- chain" against "what we owe for THIS chain" without joining through three
  -- tables. NULL on every row written before this column existed (an
  -- admin_adjustment has no chain at all) — reconciliation treats NULL as
  -- "not attributable to a specific chain" and excludes it from the per-chain
  -- comparison, which is honest: we never knew which chain those rows meant.
  ALTER TABLE usdt_ledger ADD COLUMN IF NOT EXISTS chain TEXT;

  -- Reconciliation trail (deposits/reconcile.ts): one row per scheduled check
  -- per chain, so the staff panel can show a timeline, not just "right now".
  -- Append-only, same posture as postback_log — an audit record, not a table
  -- anything on the live path reads back.
  CREATE TABLE IF NOT EXISTS treasury_balance_snapshots (
    id              TEXT PRIMARY KEY,
    chain           TEXT NOT NULL,
    token           TEXT NOT NULL,
    onchain_balance BIGINT NOT NULL, -- micro-token: treasury + known-unswept deposit addresses
    ledger_total    BIGINT NOT NULL, -- micro-token: SUM(usdt_ledger) for this chain
    delta           BIGINT NOT NULL,
    checked_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_treasury_snapshots_chain ON treasury_balance_snapshots(chain, checked_at);

  -- Existing databases were created with the pre-'sending' CHECK, same reason
  -- usdt_ledger's source_type constraint above is re-granted explicitly
  -- instead of relying on CREATE TABLE IF NOT EXISTS (a no-op on a table that
  -- already exists).
  ALTER TABLE withdrawal_requests DROP CONSTRAINT IF EXISTS withdrawal_requests_status_check;
  ALTER TABLE withdrawal_requests ADD CONSTRAINT withdrawal_requests_status_check
    CHECK (status IN ('pending','agent_approved','manager_approved','sending','paid','rejected'));
  ALTER TABLE usdt_refund_requests DROP CONSTRAINT IF EXISTS usdt_refund_requests_status_check;
  ALTER TABLE usdt_refund_requests ADD CONSTRAINT usdt_refund_requests_status_check
    CHECK (status IN ('pending','sending','paid','rejected'));

  -- payoutRelay.ts — the per-user-wallet payout relay (founder, 2026-08-08).
  -- One job per withdrawal/refund request that the treasury is going to route
  -- THROUGH the user's own derived deposit address rather than pay directly.
  -- Two shapes, picked by needs_prefund:
  --   refund     (needs_prefund = false): the user's address already holds
  --               this USDT (their own prior deposit) — no prefund step,
  --               just gas + forward.
  --   withdrawal (needs_prefund = true):  the money has never been at this
  --               address (task/referral earnings only ever existed as a
  --               treasury balance) — treasury funds gas AND the exact net
  --               USDT amount into the user's address first, which then
  --               forwards it on. This is the founder's informed "pass
  --               through the user's own wallet anyway" choice — see
  --               payoutRelay.ts's header for why it costs 2-3x the gas of a
  --               direct treasury send and does not reduce custody exposure.
  --
  -- Phases (needs_prefund=false): pending -> gas_sent -> gas_confirmed ->
  --   forward_sent -> forward_confirmed.
  -- Phases (needs_prefund=true):  pending -> gas_sent -> gas_confirmed ->
  --   prefund_sent -> prefund_confirmed -> forward_sent -> forward_confirmed.
  -- 'failed' is terminal and NOT auto-retried (same convention as
  -- sweep_jobs) — a genuine on-chain revert needs a human, not a loop that
  -- might resend into the same failure.
  CREATE TABLE IF NOT EXISTS payout_relay_jobs (
    id             TEXT PRIMARY KEY,
    purpose        TEXT NOT NULL CHECK (purpose IN ('withdrawal','refund')),
    request_id     TEXT NOT NULL, -- withdrawal_requests.id or usdt_refund_requests.id, per purpose
    chain          TEXT NOT NULL,
    user_id        TEXT NOT NULL REFERENCES users(id),
    from_address   TEXT NOT NULL, -- the user's own derived deposit address
    addr_index     BIGINT NOT NULL,
    to_address     TEXT NOT NULL, -- the withdrawal/refund destination
    amount_micro   BIGINT NOT NULL CHECK (amount_micro > 0), -- net, post-fee, micro-USDT
    needs_prefund  INTEGER NOT NULL, -- 1 = withdrawal pass-through, 0 = refund (already there)
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN (
                     'pending','gas_sent','gas_confirmed',
                     'prefund_sent','prefund_confirmed',
                     'forward_sent','forward_confirmed','failed'
                   )),
    gas_tx_hash     TEXT,
    prefund_tx_hash TEXT,
    forward_tx_hash TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TEXT NOT NULL,
    completed_at    TEXT
  );
  -- One job per request, ever — createRelayJob is called from both the
  -- auto-settle path and the staff "approve & send" path, and either could
  -- run twice (a retried request, a double-click); this is what makes that
  -- safe rather than a second live job racing the first for the same money.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_relay_jobs_request
    ON payout_relay_jobs(purpose, request_id);
  CREATE INDEX IF NOT EXISTS idx_payout_relay_jobs_status ON payout_relay_jobs(status, created_at);

  -- BNB withdraw (wallet overhaul). Lets a user pull their OWN gas balance out
  -- of their derived custody address — reuses the exact signing primitive
  -- payoutRelay.ts's refund path already uses (deriveChildPrivateKey), but this
  -- is a native-value transfer, not an ERC-20 transfer, so it is a separate,
  -- simpler single-phase job, not a payout_relay_jobs row (that table's
  -- amount_micro column is USDT-scaled at 6dp; BNB needs 18dp wei).
  --
  -- ⚠️ NO LEDGER ENTRY, ANYWHERE, FOR THIS TABLE. Unlike every other request
  -- table in this file, nothing here is ever held by a debit — there is
  -- nothing TO hold. The balance being withdrawn is the address's live
  -- on-chain balance, read fresh at request time and again right before
  -- signing (payoutRelay.ts's requireGasOrFail pattern). A failed job needs no
  -- compensating credit, because nothing was ever taken out of an internal
  -- balance in the first place.
  CREATE TABLE IF NOT EXISTS bnb_withdrawal_requests (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    chain        TEXT NOT NULL,
    address      TEXT NOT NULL,
    amount_wei   TEXT NOT NULL, -- decimal string; wei doesn't fit BIGINT for larger balances
    status       TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','sending','paid','failed')),
    tx_hash      TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_bnb_withdrawals_user ON bnb_withdrawal_requests(user_id, created_at);
  -- At most one request in flight per user at a time — the amount is computed
  -- from a live balance read, so two concurrent requests could otherwise both
  -- pass their own "enough balance" check and race to spend the same BNB.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bnb_withdrawals_inflight
    ON bnb_withdrawal_requests(user_id) WHERE status IN ('pending','sending');

  -- ---- TASK ENGINE: FIELDS, CATEGORIES, TARGETING (Stage 7) ----------------
  --
  -- Until now a task asked for evidence in ONE free-text box. That is fine for
  -- "join our channel" and useless for anything with more than one answer: a
  -- signup task needs the email they used AND their username, and a reviewer
  -- reading a paragraph has to guess which half is which. Worse, there was no
  -- way to tell a user what shape the answer should take, so the queue filled
  -- with unreviewable text and the rejection note became the instruction.
  --
  -- A field is a question the Admin writes. The user answers it on the task's
  -- own page, and the reviewer sees label -> answer pairs.
  CREATE TABLE IF NOT EXISTS task_fields (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL REFERENCES tasks(id),
    label       TEXT NOT NULL,
    -- A CLOSED LIST, checked at the API boundary (routes/staffTasks.ts) and
    -- again when an answer is validated (taskFields.ts). The type decides how
    -- the answer is checked, so an unknown type would mean an unchecked answer.
    kind        TEXT NOT NULL DEFAULT 'text'
                  CHECK (kind IN ('text','longtext','number','email','url','phone','choice')),
    required    INTEGER NOT NULL DEFAULT 1,
    placeholder TEXT,
    help        TEXT,
    -- Newline-separated choices, only for kind = 'choice'. Newline rather than
    -- JSON so an Admin types one option per line and nothing has to parse.
    options     TEXT,
    max_len     INTEGER,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_fields_task ON task_fields(task_id, sort_order);

  -- The structured answers, as a JSON array of {label, kind, value}.
  --
  -- ⚠️ THE LABEL IS SNAPSHOTTED ONTO THE ANSWER, for the same reason
  -- withdrawal_requests.fee_points is snapshotted: an Admin editing "Your
  -- username" to "Your email" afterwards would silently relabel evidence that
  -- was already submitted, and a reviewer would then reject a correct answer
  -- for being the wrong kind of thing. What the user was asked is part of what
  -- they answered.
  --
  -- proof_text is still written on every row (a readable rendering of the same
  -- answers) so every existing reader — the queue, exports, an old client —
  -- keeps working with no branch. answers is the richer copy, not a
  -- replacement.
  ALTER TABLE task_proofs ADD COLUMN IF NOT EXISTS answers TEXT;

  -- ---- Categories ---------------------------------------------------------
  -- Closed list again (TASK_CATEGORIES in routes/staffTasks.ts), for the same
  -- reason the icon is: the category renders as a labelled chip in the earner
  -- app, and free text there means the app shows whatever an Admin typed,
  -- including nothing at all. NULL = uncategorised, which is what every
  -- existing row keeps.
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS category TEXT;

  -- ---- Targeting ----------------------------------------------------------
  --
  -- ⚠️ TARGETING IS AN ELIGIBILITY GATE, NOT A FEED FILTER. Hiding a task from
  -- the list does not stop a user who knows its id from POSTing to it, so
  -- every rule below is enforced in ONE place (taskTargeting.ts) that both the
  -- feed and the submit path call. Adding a rule here without adding it there
  -- gives you a task that is invisible and still claimable.
  --
  -- target_countries is the authority for country targeting and holds a
  -- COMMA-WRAPPED list — ',Pakistan,India,' — so a LIKE '%,X,%' cannot match a
  -- country whose name is a prefix of another. ',ALL,' means everywhere. It is
  -- backfilled from the older single "country" column below, and both are
  -- written together on save: "country" stays as the human-readable summary
  -- that the staff panel and older queries already read.
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS target_countries TEXT;
  UPDATE tasks SET target_countries = ',' || country || ',' WHERE target_countries IS NULL;
  -- Account age in days. min = "not brand-new accounts" (a fresh signup farming
  -- a high-value task is the shape this stops); max = "new users only", for a
  -- welcome task that should not keep paying out to a six-month-old account.
  -- NULL on either = no limit, which is what every existing row keeps.
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS target_min_account_days INTEGER;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS target_max_account_days INTEGER;
  -- "Finish N tasks before this one is offered." A quality gate on the
  -- expensive campaigns, counted from CREDITED completions only — a pending
  -- claim is not evidence of anything.
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS target_min_completed INTEGER;

  -- ---- TASK MARKETPLACE: REWARDS, LIFECYCLE, SCHEDULE AND ASSETS ---------
  -- Existing rows are points-only and active. New columns deliberately default
  -- to that exact behaviour so deploying the migration cannot alter a live
  -- campaign's promise or visibility.
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reward_type TEXT NOT NULL DEFAULT 'points';
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reward_usdt_micro BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS budget_usdt_micro BIGINT;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS proof_heading TEXT;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS proof_help TEXT;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS button_label TEXT;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS starts_at TEXT;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ends_at TEXT;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS featured INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS logo_asset_id TEXT;
  -- ---- ROZI TASK REWARDS (founder, 2026-08-29) --------------------------
  -- The word "points" is gone from the earner app. A custom/RoziPay task's
  -- reward is now set in whole ROZI and/or USDT. ROZI here is the REAL mined
  -- token (rozi_ledger, non-withdrawable, counts against the 21M cap — see
  -- totalEmittedMicro), credited by creditCompletion(). Network offerwall
  -- tasks are untouched: they keep reward_type='points' and the points
  -- ledger, which is what the earn->withdraw loop runs on.
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reward_rozi_micro BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE task_proofs ADD COLUMN IF NOT EXISTS reward_rozi_micro BIGINT;
  ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS reward_rozi_micro BIGINT NOT NULL DEFAULT 0;

  ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_reward_type_check;
  ALTER TABLE tasks ADD CONSTRAINT tasks_reward_type_check
    CHECK (reward_type IN ('points','rozi','usdt','both'));
  ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_reward_amounts_check;
  ALTER TABLE tasks ADD CONSTRAINT tasks_reward_amounts_check CHECK (
    (reward_type = 'points' AND points > 0 AND reward_usdt_micro = 0 AND reward_rozi_micro = 0) OR
    (reward_type = 'rozi'   AND reward_rozi_micro > 0 AND reward_usdt_micro = 0) OR
    (reward_type = 'usdt'   AND points = 0 AND reward_usdt_micro > 0 AND reward_rozi_micro = 0) OR
    (reward_type = 'both'   AND (reward_rozi_micro > 0 OR points > 0) AND reward_usdt_micro > 0)
  );

  -- Migrate existing custom tasks 1:1 — "50 points" becomes "50 ROZI"
  -- (founder's own framing). Idempotent: after it runs there is no
  -- source='custom' + reward_type='points' row left to re-match.
  UPDATE tasks
     SET reward_type = 'rozi',
         reward_rozi_micro = points * 1000000,
         points = 0
   WHERE source = 'custom' AND reward_type = 'points' AND points > 0;
  -- ⚠️ MUST list every status the later migration (see 'deleted' below) allows.
  -- This block runs first; once a task has been soft-deleted, re-adding a
  -- constraint WITHOUT 'deleted' fails ("violated by some row") and the API
  -- crash-loops on boot before it ever reaches the fuller definition.
  ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
  ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
    CHECK (status IN ('draft','scheduled','active','paused','disabled','exhausted','ended','deleted'));

  -- Owned task images. Keeping the bytes in Postgres makes this deployment-safe
  -- on Railway/Vercel without trusting a remote tracking URL or writing to an
  -- ephemeral serverless filesystem. The public API exposes only the opaque id.
  CREATE TABLE IF NOT EXISTS task_assets (
    id            TEXT PRIMARY KEY,
    mime_type     TEXT NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
    bytes         BYTEA NOT NULL,
    byte_size     INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 524288),
    created_by    TEXT REFERENCES users(id),
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_assets_created ON task_assets(created_at);

  -- A participation row records a user's intentional start. Proofs/completions
  -- remain the authorities for submitted/paid states; this only fills the gap
  -- between opening an offer and filing evidence.
  CREATE TABLE IF NOT EXISTS task_participation (
    user_id       TEXT NOT NULL REFERENCES users(id),
    task_id       TEXT NOT NULL REFERENCES tasks(id),
    started_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (user_id, task_id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_participation_user
    ON task_participation(user_id, updated_at);

  -- Promised rewards are snapshotted when proof is submitted. A later campaign
  -- edit cannot change what an already-waiting user receives.
  ALTER TABLE task_proofs ADD COLUMN IF NOT EXISTS reward_points INTEGER;
  ALTER TABLE task_proofs ADD COLUMN IF NOT EXISTS reward_usdt_micro BIGINT;
  ALTER TABLE task_proofs ADD COLUMN IF NOT EXISTS task_title_snapshot TEXT;
  ALTER TABLE task_proofs ADD COLUMN IF NOT EXISTS task_icon_snapshot TEXT;
  ALTER TABLE task_proofs ADD COLUMN IF NOT EXISTS task_logo_asset_snapshot TEXT;

  -- TWO-STEP REWARD RELEASE (founder, 2026-09-01). Approving a proof no longer
  -- credits it: status 'approved' now means "an Agent has accepted the evidence
  -- and decided the amounts" (the Agent may adjust reward_rozi_micro /
  -- reward_usdt_micro at that point). The reward lands only when a second
  -- action releases it, which is what runs creditCompletion(). So the user's
  -- visible journey is: Under review -> Approved (reward on the way) -> Reward
  -- sent. reward_status: NULL while pending/rejected, 'pending' after approve,
  -- 'sent' once creditCompletion() has run.
  ALTER TABLE task_proofs ADD COLUMN IF NOT EXISTS reward_status TEXT
    CHECK (reward_status IN ('pending','sent'));
  ALTER TABLE task_proofs ADD COLUMN IF NOT EXISTS released_by TEXT REFERENCES users(id);
  ALTER TABLE task_proofs ADD COLUMN IF NOT EXISTS released_at TEXT;
  -- Backfill: every row already 'approved' was credited under the old one-step
  -- flow, so its reward is 'sent'. Without this, all historical completed tasks
  -- would show "reward on the way" forever.
  UPDATE task_proofs SET reward_status = 'sent'
    WHERE status = 'approved' AND reward_status IS NULL;

  -- Credited completions carry both reward magnitudes for budget reporting,
  -- history and replay-safe combined payouts.
  ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS usdt_micro BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS reward_type TEXT NOT NULL DEFAULT 'points';

  -- Optional closed validator configuration for structured proof fields. For a
  -- crypto_address field this is evm, tron, solana or generic.
  ALTER TABLE task_fields ADD COLUMN IF NOT EXISTS validation TEXT;
  ALTER TABLE task_fields DROP CONSTRAINT IF EXISTS task_fields_kind_check;
  ALTER TABLE task_fields ADD CONSTRAINT task_fields_kind_check
    CHECK (kind IN ('text','longtext','number','email','url','phone','choice','username','crypto_address'));

  -- Earned task USDT must never be mixed with refundable deposit USDT. Deposit
  -- funds have a deliberately deposit-bounded refund path; task earnings are a
  -- separate liability with their own append-only history.
  CREATE TABLE IF NOT EXISTS earned_usdt_ledger (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id),
    amount        BIGINT NOT NULL,
    direction     TEXT NOT NULL CHECK (direction IN ('credit','debit')),
    source_type   TEXT NOT NULL CHECK (source_type IN ('task_reward','withdrawal','withdrawal_return','admin_adjustment')),
    source_ref_id TEXT,
    note          TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_earned_usdt_user ON earned_usdt_ledger(user_id, created_at);

  ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'points';
  ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS earned_usdt_micro BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE withdrawal_requests DROP CONSTRAINT IF EXISTS withdrawal_requests_source_kind_check;
  ALTER TABLE withdrawal_requests ADD CONSTRAINT withdrawal_requests_source_kind_check
    CHECK (source_kind IN ('points','earned_usdt'));

  -- ---- DASHBOARD "NEEDS ATTENTION": CLEARED vs OPEN (founder, 2026-08-30) ---
  -- A resolved fraud flag / a handled failed payout job should stop reading as
  -- a red "open" item and instead show as "cleared" -- the dashboard tile then
  -- says "5 total, 3 cleared, 2 open" instead of a single red count that only
  -- ever climbs. resolved_at on fraud_flags is what dates a clear; the handled_
  -- columns on the two terminal failed-money tables are a staff acknowledgement
  -- ("I checked the chain, the money was returned, nothing more to do") -- they
  -- never retry or move money, only take the row out of the red count.
  ALTER TABLE fraud_flags ADD COLUMN IF NOT EXISTS resolved_at TEXT;
  ALTER TABLE payout_relay_jobs ADD COLUMN IF NOT EXISTS handled_at TEXT;
  ALTER TABLE payout_relay_jobs ADD COLUMN IF NOT EXISTS handled_by TEXT;
  ALTER TABLE payout_relay_jobs ADD COLUMN IF NOT EXISTS handled_note TEXT;
  ALTER TABLE bnb_withdrawal_requests ADD COLUMN IF NOT EXISTS handled_at TEXT;
  ALTER TABLE bnb_withdrawal_requests ADD COLUMN IF NOT EXISTS handled_by TEXT;
  ALTER TABLE bnb_withdrawal_requests ADD COLUMN IF NOT EXISTS handled_note TEXT;
  -- Backfill: a flag resolved before this column existed gets its created_at as
  -- a best-effort resolved_at, so it isn't counted as "cleared just now"
  -- forever. Only touches already-resolved rows.
  UPDATE fraud_flags SET resolved_at = created_at
   WHERE resolved_by IS NOT NULL AND resolved_at IS NULL;

  -- ---- TASK & REWARDS ADMIN (founder, 2026-09-01) ------------------------
  -- A task can now be soft-deleted from the admin panel. A 'deleted' task is
  -- hidden from the earner feed and from the default admin list, but the row
  -- stays so historical task_completions / task_proofs still join to it.
  ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
  ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
    CHECK (status IN ('draft','scheduled','active','paused','disabled','exhausted','ended','deleted'));
  -- A view-level signal, separate from task_participation (which is a START —
  -- and drives "My tasks"). This one only counts a user OPENING the task's
  -- detail page, so per-task analytics can show an
  -- opened -> started -> proof -> approved -> credited funnel. Deliberately its
  -- own table so writing to it never changes what the earner feed shows.
  CREATE TABLE IF NOT EXISTS task_opens (
    task_id   TEXT NOT NULL REFERENCES tasks(id),
    user_id   TEXT NOT NULL REFERENCES users(id),
    opens     INTEGER NOT NULL DEFAULT 1,
    first_at  TEXT NOT NULL,
    last_at   TEXT NOT NULL,
    PRIMARY KEY (task_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_opens_task ON task_opens(task_id);

  -- ---- ADMIN-DRIVEN REWARD DISBURSEMENT (founder, 2026-09-02) --------------
  -- Until now the ONLY way money left the platform was a user-filed withdrawal
  -- request (routes/withdrawals.ts). There was no admin-initiated "send the
  -- rewards" step and no batching. This adds it: group approved-but-unreleased
  -- rewards into a BATCH and push them out in one action.
  --
  --   'balance' mode  — runs the existing releaseProof()/creditCompletion()
  --                     path per recipient. Credits the in-app balance. No gas,
  --                     no treasury, no destination address. The default, and
  --                     the safe one (append-only credits, idempotent on the
  --                     completion's (network, external_id) index).
  --   'onchain' / 'manual' / 'csv' — release to balance, THEN create a
  --                     withdrawal_request to the user's SAVED payout address
  --                     and let the existing settle / relay / manual-queue
  --                     machinery run. A recipient with no saved address is
  --                     'needs_address' and skipped; it never blocks the batch.
  --
  -- ⚠️ Every per-recipient action is its OWN decision, never one transaction —
  -- one blocked user (velocity cap, exhausted campaign budget, no address)
  -- must not undo the others. Same rule as the Stage-7 bulk proof decide.
  CREATE TABLE IF NOT EXISTS payout_batches (
    id               TEXT PRIMARY KEY,
    mode             TEXT NOT NULL CHECK (mode IN ('balance','onchain','manual','csv')),
    status           TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','processing','completed','partly_failed','cancelled')),
    note             TEXT,
    created_by       TEXT NOT NULL REFERENCES users(id),
    created_at       TEXT NOT NULL,
    completed_at     TEXT,
    -- Roll-up counters, recomputed from payout_disbursements after each run.
    -- A convenience for the list screen, never the source of truth.
    count_total      INTEGER NOT NULL DEFAULT 0,
    points_total     BIGINT NOT NULL DEFAULT 0,
    usdt_micro_total BIGINT NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_payout_batches_status ON payout_batches(status, created_at DESC);

  CREATE TABLE IF NOT EXISTS payout_disbursements (
    id             TEXT PRIMARY KEY,
    batch_id       TEXT NOT NULL REFERENCES payout_batches(id),
    user_id        TEXT NOT NULL REFERENCES users(id),
    -- The approved-but-unreleased proof this row pays. Nullable so the model
    -- can grow other eligible sources later without a schema change.
    proof_id       TEXT REFERENCES task_proofs(id),
    amount_points  INTEGER NOT NULL DEFAULT 0,
    usdt_micro     BIGINT NOT NULL DEFAULT 0,
    rozi_micro     BIGINT NOT NULL DEFAULT 0,
    source_kind    TEXT NOT NULL DEFAULT 'points'
                     CHECK (source_kind IN ('points','earned_usdt')),
    dest_chain     TEXT,
    dest_address   TEXT,
    status         TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','needs_address','released','sending','paid','failed','skipped')),
    tx_hash        TEXT,
    error          TEXT,
    -- The withdrawal_requests row created for an onchain/manual/csv disbursement.
    withdrawal_request_id TEXT REFERENCES withdrawal_requests(id),
    created_at     TEXT NOT NULL,
    settled_at     TEXT
  );
  -- Idempotency: one disbursement per PROOF per batch. Re-running a batch
  -- re-reads existing rows instead of inserting again, and a proof already
  -- released in an earlier batch can never be added to a second one.
  CREATE UNIQUE INDEX IF NOT EXISTS payout_disbursements_one_per_proof
    ON payout_disbursements(batch_id, proof_id) WHERE proof_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_payout_disbursements_batch ON payout_disbursements(batch_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_payout_disbursements_status ON payout_disbursements(status);
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

  -- Settled but not yet claimed. Settlement (settleEpoch, mining/engine.ts) used
  -- to credit rozi_ledger directly the moment a day closed; founder decision
  -- 2026-08-12 made claiming a real user action (the "claim your gems" flow), so
  -- settlement now parks the owed amount here instead, and POST /mining/claim is
  -- the only thing that ever turns a row here into an actual rozi_ledger credit.
  -- Deleted once claimed — the credit itself, in rozi_ledger, is the permanent
  -- record, so a row surviving here always means "still unclaimed."
  CREATE TABLE IF NOT EXISTS mining_unclaimed (
    epoch      INTEGER NOT NULL,
    user_id    TEXT NOT NULL REFERENCES users(id),
    micro      BIGINT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (epoch, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_mining_unclaimed_user ON mining_unclaimed(user_id);

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

  -- What a rig costs in real money. NULL means "cannot be bought with USDT",
  -- and that is the shipped default for every rig on purpose.
  --
  -- ⚠️ SETTING THIS PRICE PUBLISHES AN IMPLIED ROZI EXCHANGE RATE. If a rig
  -- costs 100 ROZI or $10, every user can divide, and $0.10 per ROZI is the
  -- number they will repeat to their friends — for a token we say has no price
  -- and cannot be cashed out. Price the USDT option WELL ABOVE what the ROZI
  -- price implies (real money buys convenience, not a discount), or leave it
  -- NULL. This is a founder decision each time, which is why nothing is seeded.
  --
  -- ⚠️ MUST LIVE HERE, AFTER rigs IS CREATED ABOVE — it used to sit in
  -- MIGRATIONS (which runs BEFORE this MINING_SCHEMA block; see the exec
  -- order at the bottom of this file), an ALTER TABLE rigs on a table that
  -- did not exist yet. Harmless on every developer's already-migrated local
  -- database (the table was always already there from an earlier run), which
  -- is exactly why nobody had hit it — but a genuinely FRESH database (a new
  -- deploy, a new contributor's first npm run dev, CI) ran SCHEMA then
  -- MIGRATIONS then MINING_SCHEMA in order and failed at boot with
  -- relation "rigs" does not exist, before a single route could serve a
  -- request. Found while proving the wallet-overhaul migration runs clean
  -- against a fresh database — fixed here, not papered over.
  ALTER TABLE rigs ADD COLUMN IF NOT EXISTS base_cost_usdt BIGINT;

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

  -- ---------------------------------------------------------------------------
  -- ROZI STORE (founder, 2026-07-29). Spend ROZI on real things — mobile top-up,
  -- a data bundle — at a price WE set and can move.
  --
  -- This is a SINK, and the distinction from a fixed ROZI->USD rate is the whole
  -- point. We are not promising to buy ROZI back at any rate; we are selling a
  -- fixed number of items at a price we control, funded from margin we have
  -- already banked. If ROZI ever inflates, the price goes up and nothing breaks.
  -- A fixed buy-back rate is an unfunded liability that grows with our success
  -- (MINING_SPEC.md § 6); this cannot grow past stock, which is the difference.
  CREATE TABLE IF NOT EXISTS rozi_store_items (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT,
    -- WHOLE ROZI, like the rig catalogue: this is a human-facing admin number and
    -- is converted to micro at the moment it meets the ledger.
    cost_rozi   BIGINT NOT NULL,
    -- What the user must tell us to receive it (a phone number, usually). NULL
    -- means nothing is needed.
    input_label TEXT,
    -- HARD CEILING on our exposure. Every redemption decrements it, so the most
    -- this table can ever cost the business is SUM(stock * what it costs us).
    -- An admin who wants unlimited exposure has to type a big number and see it.
    stock       INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden')),
    sort        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );

  -- A redemption is a REQUEST, fulfilled by a human, exactly like a withdrawal.
  -- The ROZI is debited when the request is made (so it cannot be double-spent
  -- while pending) and CREDITED BACK if staff reject it.
  CREATE TABLE IF NOT EXISTS rozi_redemptions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    item_id      TEXT NOT NULL REFERENCES rozi_store_items(id),
    -- Price SNAPSHOT in micro-ROZI. An admin raising the price must never change
    -- what an in-flight request already charged, and a refund must return exactly
    -- what was taken — same reasoning as withdrawal_requests.fee_points.
    cost_micro   BIGINT NOT NULL,
    -- Where it goes. User-supplied, shown to staff, never interpolated anywhere.
    target       TEXT,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','fulfilled','rejected')),
    staff_note   TEXT,
    decided_by   TEXT REFERENCES users(id),
    decided_at   TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_redemptions_user ON rozi_redemptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_redemptions_status ON rozi_redemptions(status);

  -- The ROZI ledger gains one source type for the store. Debit on redeem, credit
  -- on refund — same row type both ways, direction tells them apart, which is how
  -- transfers already work.
  ALTER TABLE rozi_ledger DROP CONSTRAINT IF EXISTS rozi_ledger_source_type_check;
  ALTER TABLE rozi_ledger ADD CONSTRAINT rozi_ledger_source_type_check
    CHECK (source_type IN ('mining','rig_purchase','transfer_in','transfer_out',
                           'transfer_fee','conversion_burn','admin_adjustment',
                           'bonus','store_redemption','task_reward'));

  -- ---- TOKEN ALLOCATION MODEL (founder, 2026-09-01) --------------------------
  -- A PLANNING / BOOKKEEPING view of how the full ROZI supply is meant to be
  -- split (MINING_SPEC.md § 3.1): community mining vs team / liquidity /
  -- ecosystem / reserve, each with an optional vesting schedule.
  --
  -- WARNING: NOTHING HERE MINTS OR MOVES ROZI. ROZI is not on-chain; there is no
  -- balance behind a non-mining bucket. supplyCap in mining/core.ts stays the
  -- ONE enforced number and equals the community-mining bucket. This table only
  -- records the plan and lets it be edited.
  CREATE TABLE IF NOT EXISTS rozi_allocations (
    id            TEXT PRIMARY KEY,
    bucket        TEXT NOT NULL,           -- machine key: mining / team / liquidity / ecosystem / reserve / ...
    label         TEXT NOT NULL,           -- what it's called on screen
    amount_rozi   BIGINT NOT NULL,        -- whole ROZI allotted to this bucket
    cliff_months  INTEGER NOT NULL DEFAULT 0,  -- nothing releases before this
    vest_months   INTEGER NOT NULL DEFAULT 0,  -- then linear over this many (0 = fully unlocked at start)
    start_date    TEXT,                    -- ISO date the schedule begins (null = not started)
    notes         TEXT,
    sort          INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  );
`;

// Launch rig catalogue (MINING_SPEC.md § 4.5). Seeded only when absent — Admin
// owns this list at runtime, so a re-deploy must never stomp their edits.
// Costs are in WHOLE ROZI (the ledger is in micro; the conversion happens at the
// moment of the debit).
//
// ⚠️ RIG PRICES ARE A FUNCTION OF piBaseRate AND MUST MOVE WITH IT. Rescaled:
// 10x down (rate 100 -> 10), 20x down again (10 -> 0.5, 2026-07-29 with the 21M
// cap), 10x UP (2026-08-29), and re-based to a FIXED $0.10/ROZI on 2026-09-01
// when the base rate went 0.5 -> 2.5.
//
// ⚠️ THE ROZI PRICE IS NOW SET FROM THE USDT PRICE AT A FIXED $0.10/ROZI (founder,
// 2026-09-01): base_cost (whole ROZI) = base_cost_usdt_micro / 100_000. So the
// $5 Old Phone costs 50 ROZI. This is a KNOWING re-open of guardrail #7 — a fixed
// ROZI<->USD basis publishes an implied valuation — chosen by the founder and
// recorded as a dated override in CLAUDE.md / MINING_SPEC.md § 6.2. ROZI stays
// non-withdrawable; there is no buy-back. See migrateRigPricesDime below.
//
// base_cost / base_cost_usdt_micro are BOTH seeded here; base_cost is WHOLE ROZI
// (converted to micro at the debit), base_cost_usdt_micro is MICRO-USDT.
const SEED_RIGS: [string, string, string, number, number, number, number][] = [
  // id, name, icon, base_cost (= usdt / 0.10), base_power, sort, base_cost_usdt_micro
  ["old_phone", "Old Phone", "phone", 50, 5, 1, 5_000_000],
  ["laptop", "Laptop", "laptop", 150, 25, 2, 15_000_000],
  ["rig", "Mining Rig", "chip", 400, 150, 3, 40_000_000],
  ["server", "Server Rack", "server", 1_200, 800, 4, 120_000_000],
  ["datacentre", "Data Centre", "building", 4_000, 5_000, 5, 400_000_000],
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

// ONE-TIME: bring existing rig prices down with the 21M supply cut (2026-07-29).
//
// The seed above only ever INSERTs, so a database that already has the rig rows
// would have kept prices priced against a 10/day mining rate while the rate
// became 0.5/day — a 20x mismatch that makes the cheapest rig 100 days of
// baseline mining instead of 5, and quietly kills the sink.
//
// Divides by 20 with a floor of 1 (base_cost is BIGINT, so it cannot hold the
// 2.5 that "Old Phone" wants; 3 is what the seed uses and what an untouched row
// lands on). Gated on a marker written in the SAME transaction, for the same
// reason migrateRoziToMicro is: running it twice would make every rig free.
async function migrateRigCosts21m(): Promise<void> {
  const done = await sql.get<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = 'rig_costs_21m'");
  if (done) return;

  await sql.tx(async (t) => {
    await t.run("SELECT pg_advisory_xact_lock(hashtext('rig-costs-21m'))");
    const already = await t.get<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'rig_costs_21m'");
    if (already) return;

    await t.run("UPDATE rigs SET base_cost = GREATEST(1, ROUND(base_cost / 20.0))");
    await t.run(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ('rig_costs_21m','1',?)",
      now(),
    );
  });
  console.log("MINING: rescaled rig prices for the 21M supply (/20). This runs once.");
}

// ONE-TIME: 10x the ROZI rig prices and give the launch rigs a USDT price
// (founder, 2026-08-29). See the SEED_RIGS comment: the ROZI price becomes an
// aspirational number and USDT becomes the real way to buy a machine. Only
// fills base_cost_usdt where it is still NULL, so an Admin's own USDT price is
// never stomped. Gated on a marker in the same transaction, same reason as the
// migrations above — running it twice would 100x the ROZI prices.
async function migrateRigPrices2026Usdt(): Promise<void> {
  const done = await sql.get<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = 'rig_prices_2026_usdt'");
  if (done) return;

  await sql.tx(async (t) => {
    await t.run("SELECT pg_advisory_xact_lock(hashtext('rig-prices-2026-usdt'))");
    const already = await t.get<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'rig_prices_2026_usdt'");
    if (already) return;

    await t.run("UPDATE rigs SET base_cost = base_cost * 10");
    for (const [id, , , , , , usdtMicro] of SEED_RIGS) {
      await t.run(
        "UPDATE rigs SET base_cost_usdt = ? WHERE id = ? AND base_cost_usdt IS NULL",
        usdtMicro, id,
      );
    }
    await t.run(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ('rig_prices_2026_usdt','1',?)",
      now(),
    );
  });
  console.log("MINING: 10x ROZI rig prices + seeded USDT rig prices (2026-08-29). This runs once.");
}

// ONE-TIME: re-base every rig's ROZI price to a FIXED $0.10/ROZI (founder,
// 2026-09-01, alongside piBaseRate 0.5 -> 2.5). base_cost (whole ROZI) becomes
// base_cost_usdt_micro / 100_000 — so a $5 machine costs 50 ROZI. Rows whose
// USDT price an Admin cleared/never set keep their existing ROZI price. Gated on
// a marker in the same transaction, same reason as the migrations above.
async function migrateRigPricesDime(): Promise<void> {
  const done = await sql.get<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = 'rig_prices_dime'");
  if (done) return;

  await sql.tx(async (t) => {
    await t.run("SELECT pg_advisory_xact_lock(hashtext('rig-prices-dime'))");
    const already = await t.get<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'rig_prices_dime'");
    if (already) return;

    // $0.10/ROZI: micro-USDT / 100_000 = whole ROZI. Only where a USDT price exists.
    await t.run(
      "UPDATE rigs SET base_cost = GREATEST(1, ROUND(base_cost_usdt / 100000.0)) WHERE base_cost_usdt IS NOT NULL AND base_cost_usdt > 0",
    );
    await t.run(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ('rig_prices_dime','1',?)",
      now(),
    );
  });
  console.log("MINING: re-based rig ROZI prices to $0.10/ROZI (2026-09-01). This runs once.");
}

export async function initDb(): Promise<void> {
  await driver.exec(SCHEMA);
  await driver.exec(MIGRATIONS);
  await driver.exec(MINING_SCHEMA);
  await migrateRoziToMicro();
  await migrateRigCosts21m();
  await migrateRigPrices2026Usdt();
  await migrateRigPricesDime();
  for (const [id, name, icon, baseCost, basePower, sort, baseCostUsdtMicro] of SEED_RIGS) {
    await sql.run(
      `INSERT INTO rigs (id, name, icon, base_cost, base_power, sort, base_cost_usdt, created_at)
       VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`,
      id, name, icon, baseCost, basePower, sort, baseCostUsdtMicro, now(),
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
  // Two example boosters, seeded DISABLED (founder, 2026-09-01). A booster is a
  // temporary hashrate multiplier bought with Points (the cash currency, not
  // ROZI) — a sink for Points that eases withdrawal pressure. These give an
  // Admin something concrete to price and switch on in /staff → Mining →
  // Boosters, rather than a blank form. Only inserted when absent.
  for (const [id, name, pricePoints, multPct, hours] of [
    ["boost_2x_24h", "2x speed — 24 hours", 300, 100, 24],
    ["boost_3x_12h", "3x speed — 12 hours", 500, 200, 12],
  ] as const) {
    await sql.run(
      `INSERT INTO boosters (id, name, price_points, multiplier_pct, hours, status, created_at)
       VALUES (?,?,?,?,?, 'disabled', ?) ON CONFLICT (id) DO NOTHING`,
      id, name, pricePoints, multPct, hours, now(),
    );
  }
  // Default ROZI allocation buckets (MINING_SPEC.md § 3.1) — total 32,300,000,
  // of which 21,000,000 is the enforced community-mining cap. Seeded only when
  // absent, like the rig catalogue: an Admin owns this list at runtime.
  for (const [id, bucket, label, amount, cliff, vest, sort] of [
    ["alloc_mining",   "mining",    "Community mining",       21_000_000, 0, 0, 1],
    ["alloc_liquidity","liquidity", "Liquidity",               3_230_000, 0, 0, 2],
    ["alloc_team",     "team",      "Team / founder",          3_230_000, 6, 24, 3],
    ["alloc_ecosystem","ecosystem", "Ecosystem & partnerships",3_230_000, 0, 12, 4],
    ["alloc_reserve",  "reserve",   "Reserve",                 1_610_000, 0, 0, 5],
  ] as const) {
    await sql.run(
      `INSERT INTO rozi_allocations (id, bucket, label, amount_rozi, cliff_months, vest_months, sort, created_at)
       VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`,
      id, bucket, label, amount, cliff, vest, sort, now(),
    );
  }
  // Default global settings (only inserted when absent). Withdrawal fee off (0)
  // by default so no user is surprised by a deduction until Admin sets one.
  await sql.run(
    "INSERT INTO app_settings (key, value, updated_at) VALUES ('withdrawal_fee_points','0',?) ON CONFLICT (key) DO NOTHING",
    now(),
  );
  // Gas-cost fee (founder, 2026-08-08): sending USDT on BEP20 costs the
  // platform real gas, and neither a refund nor a withdrawal recovered any of
  // it before this. Percent + a fixed floor, same shape as the founder's own
  // example (5% + $0.01 on a $1 request) — a pure percentage alone would
  // undercharge on the smallest requests, where the fixed gas cost is a
  // bigger share of the total. Off (0/0) by default, same reasoning as the
  // withdrawal fee above. See getGasFee() in fees.ts.
  await sql.run(
    "INSERT INTO app_settings (key, value, updated_at) VALUES ('gas_fee_percent','0',?) ON CONFLICT (key) DO NOTHING",
    now(),
  );
  await sql.run(
    "INSERT INTO app_settings (key, value, updated_at) VALUES ('gas_fee_fixed_micro','0',?) ON CONFLICT (key) DO NOTHING",
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
//
// `previousValue` / `newValue` are what make a row answerable months later: an
// action name alone tells you a rate was changed, not what it was changed FROM,
// which is the only version of the question anyone actually asks. Both are free
// text — a number, a status word, a small JSON blob — because the alternative is
// a typed column per settings key.
export async function logAudit(
  params: {
    actorUserId: string;
    actorRole: string;
    action: string;
    targetUserId?: string | null;
    detail?: string;
    previousValue?: string | number | null;
    newValue?: string | number | null;
    actorIp?: string | null;
  },
  t: Pick<TxApi, "run"> = sql,
): Promise<string> {
  const id = newId();
  const str = (v: string | number | null | undefined) =>
    v === undefined || v === null ? null : String(v);
  await t.run(
    `INSERT INTO admin_audit_log
       (id, actor_user_id, actor_role, action, target_user_id, detail,
        previous_value, new_value, actor_ip, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, params.actorUserId, params.actorRole, params.action,
    params.targetUserId ?? null, params.detail ?? null,
    str(params.previousValue), str(params.newValue), params.actorIp ?? null, now(),
  );
  return id;
}

// Is this account currently held from automatic withdrawal? A permanent hold
// (withdrawal_hold_until IS NULL) stays held until a staff member clears it; a
// timed hold lifts itself the instant `until` passes — checked right here, at
// the point of use, so there is nothing to sweep or expire on a schedule.
export async function isWithdrawalHeld(
  userId: string,
  t: Pick<TxApi, "get"> = sql,
): Promise<{ held: boolean; reason: string | null }> {
  const row = await t.get<{ withdrawal_hold_reason: string | null; withdrawal_hold_until: string | null }>(
    "SELECT withdrawal_hold_reason, withdrawal_hold_until FROM users WHERE id = ?", userId,
  );
  if (!row?.withdrawal_hold_reason) return { held: false, reason: null };
  if (row.withdrawal_hold_until && row.withdrawal_hold_until <= now()) return { held: false, reason: null };
  return { held: true, reason: row.withdrawal_hold_reason };
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
  | "transfer_fee" | "conversion_burn" | "admin_adjustment" | "bonus"
  // Store: debit when a redemption is requested, credit back if staff reject it.
  | "store_redemption"
  // Custom/RoziPay task reward (founder, 2026-08-29). Real mined-token ROZI,
  // credited by creditCompletion(); counts against the 21M cap.
  | "task_reward";

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

// ---- USDT top-up credit ---------------------------------------------------
// A THIRD append-only ledger, same shape as the two above for the same reason.
//
// Credit enters by a staff-confirmed deposit and leaves in exactly two ways:
// buying a rig, or being REFUNDED to the user who deposited it (founder,
// 2026-08-01 — see the long note above usdt_ledger in the schema for what that
// changed and what it deliberately did not).
//
// There is still no transfer to another user and no conversion to Points or
// ROZI, and earnings still cannot leave through here at all. If you are adding
// a third way out, you are changing what this balance is — read the schema note.
export const USDT_SCALE = 1_000_000;
export const usdtToMicro = (usdt: number) => Math.round(usdt * USDT_SCALE);
export const usdtFromMicro = (micro: number) => micro / USDT_SCALE;

export type UsdtSource = "topup" | "rig_purchase" | "admin_adjustment" | "refund";

export async function postUsdt(
  params: {
    userId: string;
    micro: number; // positive magnitude, in MICRO-USDT
    direction: "credit" | "debit";
    sourceType: UsdtSource;
    sourceRefId?: string;
    note?: string;
    // Which chain this row is attributable to — lets reconciliation
    // (deposits/reconcile.ts) compare a chain's on-chain balance against what
    // we owe for THAT chain without joining through chain_deposits/usdt_topups.
    // Omitted (NULL) for rows with no single chain (an admin_adjustment).
    chain?: string;
  },
  t: Pick<TxApi, "run"> = sql,
): Promise<string> {
  const magnitude = Math.abs(Math.trunc(params.micro));
  const amount = params.direction === "credit" ? magnitude : -magnitude;
  const id = newId();
  await t.run(
    `INSERT INTO usdt_ledger (id, user_id, amount, direction, source_type, source_ref_id, note, chain, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id, params.userId, amount, params.direction, params.sourceType,
    params.sourceRefId ?? null, params.note ?? null, params.chain ?? null, now(),
  );
  return id;
}

export async function usdtBalanceMicroOf(
  userId: string,
  t: Pick<TxApi, "get"> = sql,
): Promise<number> {
  const row = await t.get<{ bal: string | number }>(
    "SELECT COALESCE(SUM(amount), 0) AS bal FROM usdt_ledger WHERE user_id = ?",
    userId,
  );
  return Number(row?.bal ?? 0);
}

export type EarnedUsdtSource = "task_reward" | "withdrawal" | "withdrawal_return" | "admin_adjustment";

export async function postEarnedUsdt(
  params: {
    userId: string;
    micro: number;
    direction: "credit" | "debit";
    sourceType: EarnedUsdtSource;
    sourceRefId?: string;
    note?: string;
  },
  t: Pick<TxApi, "run"> = sql,
): Promise<string> {
  const magnitude = Math.abs(Math.trunc(params.micro));
  const id = newId();
  await t.run(
    `INSERT INTO earned_usdt_ledger (id,user_id,amount,direction,source_type,source_ref_id,note,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id, params.userId, params.direction === "credit" ? magnitude : -magnitude,
    params.direction, params.sourceType, params.sourceRefId ?? null, params.note ?? null, now(),
  );
  return id;
}

export async function earnedUsdtBalanceMicroOf(
  userId: string,
  t: Pick<TxApi, "get"> = sql,
): Promise<number> {
  const row = await t.get<{ bal: string | number }>(
    "SELECT COALESCE(SUM(amount),0) AS bal FROM earned_usdt_ledger WHERE user_id = ?", userId,
  );
  return Number(row?.bal ?? 0);
}

// Find-or-create the user's own deposit address on `chain` (CUSTODY_SPEC.md
// § 5 step 1). Read-only: this writes a row that records what address was
// shown, nothing more — no balance is touched, nothing sweeps or credits.
//
// No advisory lock (guardrail #8 is about read-balance-then-debit races; this
// is neither). Instead: insert-if-absent, and on a lost race just re-read the
// winner's row. The sequence value we drew is simply skipped — sequences are
// allowed gaps, and skipping one derivation index costs nothing.
export async function getOrCreateDepositAddress(
  userId: string,
  chain: "bep20",
): Promise<string> {
  return (await getOrCreateDepositWallet(userId, chain)).address;
}

// Same as getOrCreateDepositAddress, but also returns addr_index — needed by
// payoutRelay.ts to derive the SPENDING key for this same address
// (custodySeeds.deriveChildPrivateKey), not just show the address.
export async function getOrCreateDepositWallet(
  userId: string,
  chain: "bep20",
): Promise<{ address: string; addrIndex: number }> {
  const existing = await sql.get<{ address: string; addr_index: string }>(
    "SELECT address, addr_index FROM deposit_wallets WHERE user_id = ? AND chain = ?", userId, chain);
  if (existing) return { address: existing.address, addrIndex: Number(existing.addr_index) };

  const idx = await sql.get<{ nextval: string }>(
    "SELECT nextval('deposit_wallet_index_seq') AS nextval");
  const index = Number(idx!.nextval);
  const address = deriveAddress(chain, index);

  const inserted = await sql.get<{ address: string; addr_index: string }>(
    `INSERT INTO deposit_wallets (user_id, chain, addr_index, address, created_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT (user_id, chain) DO NOTHING
     RETURNING address, addr_index`,
    userId, chain, index, address, now(),
  );
  if (inserted) return { address: inserted.address, addrIndex: Number(inserted.addr_index) };

  // Lost the race to a concurrent request for the same user+chain.
  const winner = await sql.get<{ address: string; addr_index: string }>(
    "SELECT address, addr_index FROM deposit_wallets WHERE user_id = ? AND chain = ?", userId, chain);
  return { address: winner!.address, addrIndex: Number(winner!.addr_index) };
}
