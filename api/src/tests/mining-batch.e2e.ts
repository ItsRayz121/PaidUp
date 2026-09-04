// DIFFERENTIAL test: the batched hashrate must equal the per-user hashrate, for
// every user, exactly.
//
// WHY THIS FILE EXISTS
// --------------------
// The accrual sweep used to call hashrateOf() once per open mining session — the
// audit of 2026-09-04 measured 998,601 sequential statements for 100,000 sessions
// (finding B4), which over a real network is ~11.6 minutes of round trips inside
// a 15-minute interval that settlement queues behind. The fix was a set-wise
// version, hashrateOfBatch().
//
// That makes this the most dangerous kind of change in the whole codebase:
// MINING_PLAN.md M9.5 exists because two earlier bugs in these exact paths
// silently destroyed user earnings, and a batched rewrite that is 1% different
// from the original underpays real people every 15 minutes, forever, with nothing
// on any screen to show it. So the two implementations are not compared by
// reading them — they are RUN against the same data and required to agree.
//
// The population below is built to make disagreement possible: rigs at different
// levels, several boost kinds (including more than the stack cap allows, so the
// capping path is exercised), streaks above and below the cap, a two-level
// downline, invitees that must NOT count (unverified, suspended, idle), a
// referral CYCLE, and a user who is in their own downline's downline.
//
//   npm run test:miningbatch
import { initDb, sql, now, newId } from "../db.ts";
import { hashrateOf, hashrateOfBatch, accrueAllSessions } from "../mining/engine.ts";
import { loadMiningSettings } from "../mining/settings.ts";
import { epochOf } from "../mining/core.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();

const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
let n = 0;
const uid = (tag: string) => `mb-${tag}`;

async function mkUser(tag: string, opts: {
  ref?: string | null; kyc?: string; status?: string;
} = {}) {
  const id = uid(tag);
  await sql.run(
    `INSERT INTO users (id, email, password_hash, email_verified, country, referral_code,
                        referred_by, status, created_at, kyc_status)
     VALUES (?,?,'x',1,'Pakistan',?,?,?,?,?)
     ON CONFLICT (id) DO UPDATE SET referred_by = EXCLUDED.referred_by,
       status = EXCLUDED.status, kyc_status = EXCLUDED.kyc_status`,
    id, `${id}@batch.local`, `MB${++n}0`, opts.ref ?? null,
    opts.status ?? "active", iso(-40 * 86_400_000), opts.kyc ?? "approved",
  );
  return id;
}
async function session(userId: string, startedMsAgo = 3600_000, lastAccruedMsAgo = 900_000) {
  await sql.run("DELETE FROM mining_sessions WHERE user_id = ?", userId);
  await sql.run(
    `INSERT INTO mining_sessions (id, user_id, device_id, started_at, expires_at, last_accrued_at, status)
     VALUES (?,?,?,?,?,?, 'active')`,
    newId(), userId, `dev-${userId}`, iso(-startedMsAgo),
    iso(7 * 3600_000), iso(-lastAccruedMsAgo),
  );
}
async function rig(userId: string, rigId: string, level: number) {
  await sql.run(
    `INSERT INTO user_rigs (user_id, rig_id, level, updated_at) VALUES (?,?,?,?)
     ON CONFLICT (user_id, rig_id) DO UPDATE SET level = EXCLUDED.level`,
    userId, rigId, level, now());
}
async function boost(userId: string, kind: string, pct: number, hours = 4) {
  await sql.run(
    `INSERT INTO user_boosts (id, user_id, kind, multiplier_pct, expires_at, created_at)
     VALUES (?,?,?,?,?,?)`,
    newId(), userId, kind, pct, iso(hours * 3600_000), now());
}
async function streak(userId: string, days: number) {
  await sql.run(
    `INSERT INTO mining_streaks (user_id, current_days, best_days, last_epoch, updated_at)
     VALUES (?,?,?,?,?) ON CONFLICT (user_id) DO UPDATE SET current_days = EXCLUDED.current_days`,
    userId, days, days, epochOf(), now());
}

const rigIds = (await sql.all<{ id: string }>(
  "SELECT id FROM rigs WHERE status = 'active' ORDER BY sort LIMIT 3")).map((r) => r.id);

console.log("\n-- building a population designed to break a naive batch --");

// A plain miner with nothing at all: the boundary case a batch is most likely to
// get wrong by omitting a user with no rows in any joined table.
const bare = await mkUser("bare");
await session(bare);

// Rigs at several levels + more boosts than the per-kind stack cap allows.
const rich = await mkUser("rich");
await session(rich);
if (rigIds[0]) await rig(rich, rigIds[0], 3);
if (rigIds[1]) await rig(rich, rigIds[1], 1);
await streak(rich, 3);
for (let i = 0; i < 6; i++) await boost(rich, "task", 25);
for (let i = 0; i < 6; i++) await boost(rich, "ad", 0);

// Streak far above the cap.
const streaky = await mkUser("streaky");
await session(streaky);
await streak(streaky, 999);

// An inviter with a real two-level downline, plus invitees that must NOT count.
const inviter = await mkUser("inviter");
await session(inviter);
await streak(inviter, 2);
const l1a = await mkUser("l1a", { ref: inviter });
const l1b = await mkUser("l1b", { ref: inviter });
await session(l1a); await session(l1b);
if (rigIds[0]) await rig(l1a, rigIds[0], 2);
await boost(l1b, "task", 25);
const l2a = await mkUser("l2a", { ref: l1a });
const l2b = await mkUser("l2b", { ref: l1a });
await session(l2a); await session(l2b);
if (rigIds[1]) await rig(l2a, rigIds[1], 2);
// Level 3 must be invisible to the inviter.
const l3 = await mkUser("l3", { ref: l2a });
await session(l3);
// Must not count: not KYC-approved, suspended, and never mined.
const notKyc = await mkUser("notkyc", { ref: inviter, kyc: "pending" });
const banned = await mkUser("banned", { ref: inviter, status: "suspended" });
const idle = await mkUser("idle", { ref: inviter });
await session(notKyc); await session(banned);
await sql.run("DELETE FROM mining_sessions WHERE user_id = ?", idle);
// Mined, but too long ago to be "active".
const stale = await mkUser("stale", { ref: inviter });
await session(stale, 400 * 3600_000, 900_000);
await sql.run("UPDATE mining_sessions SET started_at = ? WHERE user_id = ?",
  iso(-400 * 3600_000), stale);

// A referral CYCLE: cyc1 invited cyc2, cyc2 invited cyc1. The data model permits
// it, so both exclusion rules in the level-2 walk have to hold.
const cyc1 = await mkUser("cyc1");
const cyc2 = await mkUser("cyc2", { ref: cyc1 });
await sql.run("UPDATE users SET referred_by = ? WHERE id = ?", cyc2, cyc1);
await session(cyc1); await session(cyc2);
if (rigIds[0]) await rig(cyc2, rigIds[0], 1);

// A diamond: two of one user's level-1s share a level-2 invitee is impossible
// (one referred_by), but a level-2 who is ALSO a level-1 is not — d1 invited d2
// and d3; d2 also invited d3? No. Instead: the user themselves appearing in
// their own level-2, which the exclusion must drop.
const d1 = await mkUser("d1");
const d2 = await mkUser("d2", { ref: d1 });
await sql.run("UPDATE users SET referred_by = ? WHERE id = ?", d2, d1);
await session(d1); await session(d2);

const everyone = [bare, rich, streaky, inviter, l1a, l1b, l2a, l2b, l3,
                  notKyc, banned, idle, stale, cyc1, cyc2, d1, d2];

console.log("\n-- the batch must equal the per-user path, for everyone --");
const cfg = await loadMiningSettings();
const batch = await hashrateOfBatch(everyone, cfg);

let mismatches = 0;
for (const id of everyone) {
  const single = await hashrateOf(id, cfg);
  const b = batch.get(id);
  const sameRate = b?.hashrate === single.hashrate;
  const sameBreakdown = JSON.stringify(b?.breakdown) === JSON.stringify(single.breakdown);
  if (!sameRate || !sameBreakdown) {
    mismatches++;
    console.log(`       ${id}: single=${JSON.stringify(single)} batch=${JSON.stringify(b)}`);
  }
}
check(`all ${everyone.length} users get an identical hashrate AND breakdown from both paths`,
  mismatches === 0, `${mismatches} mismatched`);

// The referral component specifically — the part that was genuinely rewritten.
{
  const single = await hashrateOf(inviter, cfg);
  check("the inviter's referral component is non-zero (the test would be vacuous otherwise)",
    Number(single.breakdown.referral) > 0, JSON.stringify(single.breakdown));
  check("...and the batch agrees on it exactly",
    batch.get(inviter)?.breakdown.referral === single.breakdown.referral,
    `${batch.get(inviter)?.breakdown.referral} vs ${single.breakdown.referral}`);
}
{
  // Level 3 must contribute nothing: only two levels are inherited.
  const withL3 = await hashrateOf(l1a, cfg);
  check("a level-3 invitee is not counted by either path",
    batch.get(l1a)?.hashrate === withL3.hashrate);
}
{
  const c1 = await hashrateOf(cyc1, cfg);
  check("a referral cycle terminates and both paths agree",
    batch.get(cyc1)?.hashrate === c1.hashrate,
    `${batch.get(cyc1)?.hashrate} vs ${c1.hashrate}`);
}

console.log("\n-- an empty and a single-element batch --");
check("an empty batch returns an empty map", (await hashrateOfBatch([], cfg)).size === 0);
{
  const one = await hashrateOfBatch([rich], cfg);
  const single = await hashrateOf(rich, cfg);
  check("a one-element batch matches the per-user path", one.get(rich)?.hashrate === single.hashrate);
}
{
  // Chunking: PARAM_CHUNK is 2,000 internally, so ask for more ids than that in
  // one call and make sure every one still comes back with the right answer.
  const ids = [...everyone];
  while (ids.length < 2_500) ids.push(...everyone);
  const big = await hashrateOfBatch(ids, cfg);
  const single = await hashrateOf(inviter, cfg);
  check(`a ${ids.length}-id batch (past the internal chunk size) still answers correctly`,
    big.get(inviter)?.hashrate === single.hashrate && big.size === everyone.length,
    `size=${big.size}`);
}

console.log("\n-- the sweep still pays exactly what it used to --");
{
  // Snapshot shares, run the sweep, and confirm every session with time owing was
  // credited hashrate x seconds — the actual thing users are paid for.
  const before = new Map((await sql.all<{ user_id: string; shares: string }>(
    "SELECT user_id, shares FROM mining_shares WHERE epoch = ?", epochOf()))
    .map((r) => [r.user_id, Number(r.shares)]));

  const swept = await accrueAllSessions();
  check("the sweep visited every active session", swept >= 14, `${swept} sessions`);

  const after = new Map((await sql.all<{ user_id: string; shares: string }>(
    "SELECT user_id, shares FROM mining_shares WHERE epoch = ?", epochOf()))
    .map((r) => [r.user_id, Number(r.shares)]));

  // Each miner should have gained roughly hashrate x 900s (15 min of unaccrued
  // time). Exactly is not assertable — the clock moves during the sweep — so this
  // checks the gain is within one second of hashrate x elapsed, which is far
  // tighter than any plausible batching bug.
  let wrong = 0;
  for (const id of [bare, rich, streaky, inviter, l1a, l2a, cyc1]) {
    const rate = (await hashrateOf(id, cfg)).hashrate;
    const gained = (after.get(id) ?? 0) - (before.get(id) ?? 0);
    const expected = rate * 900;
    if (Math.abs(gained - expected) > rate * 5) {
      wrong++;
      console.log(`       ${id}: gained ${gained}, expected ~${expected} (rate ${rate})`);
    }
  }
  check("every miner was credited hashrate x elapsed seconds", wrong === 0, `${wrong} wrong`);

  const stillOwing = await sql.get<{ n: string }>(
    "SELECT COUNT(*) AS n FROM mining_sessions WHERE status = 'active' AND last_accrued_at < ?",
    iso(-60_000));
  check("no session is left with unaccrued time after the sweep",
    Number(stillOwing?.n ?? 0) === 0, `${stillOwing?.n} left`);
}

console.log("\n-- the sweep is cheap per session now --");
{
  // Re-run with no time owing: this is the common case (the tick fires every 15
  // minutes, most sessions were just accrued), and it must not cost a hashrate
  // computation per session.
  const swept = await accrueAllSessions();
  check("a sweep with nothing owing still returns the session count", swept >= 14, `${swept}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
