// AUDIT-ONLY benchmark. Does not modify application code or behaviour.
// Measures the two per-user sequential loops in the mining worker against a REAL
// multi-connection Postgres, at increasing miner counts.
//
//   accrueAllSessions()  - runs every 15 min, loops every ACTIVE session
//   settleEpoch()        - runs on the same tick, one transaction holding the
//                          GLOBAL advisory lock hashtext('rozi-settlement')
//
// Run from api/:  npx tsx ../audit/tests/mining-scale-bench.ts <N> [<N> ...]
import { sql, initDb } from "../../api/src/db.ts";
import { accrueAllSessions, settleEpoch } from "../../api/src/mining/engine.ts";
import { epochOf } from "../../api/src/mining/core.ts";

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
if (sizes.length === 0) sizes.push(1000);

async function statementCount(): Promise<number> {
  const r = await sql.get<{ n: string }>(
    "SELECT xact_commit AS n FROM pg_stat_database WHERE datname = current_database()");
  return Number(r?.n ?? 0);
}

async function wipe() {
  for (const t of ["mining_shares", "mining_sessions", "mining_unclaimed", "mining_epochs",
                   "mining_epoch_devices", "mining_streaks", "user_boosts", "user_rigs",
                   "rozi_ledger", "ledger_entries", "referrals", "users"]) {
    await sql.run(`DELETE FROM ${t}`);
  }
}

// Bulk-seed N verified users, each with one ACTIVE mining session that has 15
// minutes of unaccrued time, plus shares in a CLOSED epoch ready to settle.
async function seed(n: number, epoch: number) {
  const nowIso = new Date().toISOString();
  const lastAccrued = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const expires = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
  await sql.run(
    `INSERT INTO users (id, email, password_hash, email_verified, country, referral_code, status, created_at, kyc_status)
     SELECT 'u'||g, 'load'||g||'@audit.local', 'x', 1, 'Pakistan', 'AUD'||g, 'active', $1, 'none'
     FROM generate_series(1, $2) g`, nowIso, n);
  await sql.run(
    `INSERT INTO mining_sessions (id, user_id, device_id, started_at, expires_at, last_accrued_at, status)
     SELECT 's'||g, 'u'||g, 'dev'||g, $1, $2, $3, 'active'
     FROM generate_series(1, $4) g`,
    new Date(Date.now() - 4 * 3600 * 1000).toISOString(), expires, lastAccrued, n);
  // Shares in the closed epoch so settleEpoch has N miners to pay.
  await sql.run(
    `INSERT INTO mining_shares (epoch, user_id, shares, updated_at)
     SELECT $1, 'u'||g, 288000, $2 FROM generate_series(1, $3) g`, epoch, nowIso, n);
  await sql.run("ANALYZE");
}

const results: any[] = [];

await initDb();
const openEpoch = epochOf();
const closedEpoch = openEpoch - 1;

for (const n of sizes) {
  await wipe();
  const t0 = Date.now();
  await seed(n, closedEpoch);
  const seedMs = Date.now() - t0;

  const c0 = await statementCount();
  const a0 = Date.now();
  const sessions = await accrueAllSessions();
  const accrueMs = Date.now() - a0;
  const c1 = await statementCount();

  const s0 = Date.now();
  const res = await settleEpoch(closedEpoch);
  const settleMs = Date.now() - s0;
  const c2 = await statementCount();

  const row = {
    miners: n,
    seedMs,
    accrueMs,
    accrueSessions: sessions,
    accrueStatements: c1 - c0,
    accrueMsPerUser: +(accrueMs / n).toFixed(3),
    settleMs,
    settleStatements: c2 - c1,
    settleMsPerUser: +(settleMs / n).toFixed(3),
    settledMiners: res.miners,
    emittedMicro: res.emitted,
    skipped: res.skipped ?? null,
  };
  results.push(row);
  console.log(JSON.stringify(row));
}

console.log("\n=== SUMMARY (local Postgres, loopback, no network RTT) ===");
console.table(results);
process.exit(0);
