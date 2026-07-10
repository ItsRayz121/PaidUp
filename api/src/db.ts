// Local database using Node's built-in SQLite (zero install, no native build).
// Schema is plain SQL so it ports to Postgres on Railway later with minimal
// change. GUARDRAIL #2: balance is NEVER stored — it is always SUM(amount)
// over the append-only ledger. There is no "balance" column anywhere.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// fileURLToPath handles Windows drive letters and spaces (%20) correctly.
const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(fileURLToPath(new URL("../data/app.db", import.meta.url)));

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    telegram_id   TEXT,
    phone         TEXT,
    country       TEXT NOT NULL DEFAULT 'Pakistan',
    referral_code TEXT UNIQUE NOT NULL,
    referred_by   TEXT REFERENCES users(id),
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    TEXT NOT NULL
  );

  -- Email verification codes. We store only a HASH of the code, never the
  -- code itself, plus expiry + attempt count (auth security).
  CREATE TABLE IF NOT EXISTS email_codes (
    id         TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    code_hash  TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    consumed   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
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

  -- Created now for the postback flow (next slice). A completion only becomes
  -- 'credited' after a VERIFIED server-to-server postback (guardrail #1).
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
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    amount       INTEGER NOT NULL,
    payout_rail  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','agent_approved','manager_approved','paid','rejected')),
    reviewed_by  TEXT,
    review_note  TEXT,
    created_at   TEXT NOT NULL,
    reviewed_at  TEXT,
    paid_at      TEXT
  );
`);

export const now = () => new Date().toISOString();
export const newId = () => randomUUID();

// Balance is always derived — this is the ONLY way balance is computed.
export function balanceOf(userId: string): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS bal FROM ledger_entries WHERE user_id = ?")
    .get(userId) as { bal: number };
  return row.bal;
}
