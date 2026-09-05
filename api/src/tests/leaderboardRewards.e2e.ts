// E2E for weekly/monthly ROZI leaderboard reward pools (founder, 2026-09-05).
//
// Mirrors mining.e2e.ts's own supply-cap test (setMiningSetting("supplyCap",
// alreadyRozi + headroom), squeeze the room, settle, assert the scaled
// payouts never breach it, then restore the default) — same technique,
// applied to leaderboardRewards.ts's settlement instead of mining's daily one.
//
//   npm run test:leaderboardrewards
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId, roziBalanceMicroOf } from "../db.ts";
import { config } from "../config.ts";
import { staffGrowthRoutes } from "../routes/staffGrowth.ts";
import { appRoutes } from "../routes/app.ts";
import { invalidateLeaderboard } from "../leaderboard.ts";
import {
  settleLeaderboardCycle, tickLeaderboardRewards,
  previousPeriodBounds, currentPeriodBounds,
} from "../leaderboardRewards.ts";
import {
  loadLeaderboardRewardSettings, saveLeaderboardRewardSettings,
  LEADERBOARD_REWARD_DEFAULTS, type LeaderboardRewardSettings,
} from "../leaderboardRewardSettings.ts";
import { setMiningSetting, MINING_DEFAULTS } from "../mining/settings.ts";
import { fromMicro } from "../mining/core.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(staffGrowthRoutes);
await app.register(appRoutes);

const TAG = newId().slice(0, 8);
let seq = 0;
const tok = (id: string) => jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: "1h" });
const authOf = (id: string) => ({ authorization: `Bearer ${tok(id)}` });

async function mkUser(label: string) {
  const id = newId();
  await sql.run(
    `INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at)
     VALUES (?,?,1,'Pakistan',?,'active',?)`,
    id, `${TAG}-${label}@t.test`, `${TAG}${(seq++).toString(36)}`.toUpperCase().slice(0, 12), now(),
  );
  return id;
}
async function mkStaff(label: string, role: string) {
  const id = await mkUser(label);
  await sql.run("INSERT INTO admin_users (user_id, role, created_at) VALUES (?,?,?)", id, role, now());
  return id;
}

// A raw insert (not postLedger) so `created_at` can be pinned inside a
// specific, already-CLOSED period — the exact thing settlement scores over.
async function seedTaskPoints(userId: string, points: number, createdAtISO: string) {
  await sql.run(
    `INSERT INTO ledger_entries (id, user_id, amount, direction, source_type, source_ref_id, note, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    newId(), userId, points, "credit", "task_completion", null, "e2e", createdAtISO,
  );
}
async function seedReferralPoints(userId: string, points: number, createdAtISO: string) {
  await sql.run(
    `INSERT INTO ledger_entries (id, user_id, amount, direction, source_type, source_ref_id, note, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    newId(), userId, points, "credit", "referral_bonus", null, "e2e", createdAtISO,
  );
}

const admin = await mkStaff("admin", "admin");
const support = await mkStaff("support", "support"); // holds no leaderboard.manage permission

const prevWeek = previousPeriodBounds("weekly");
const insideAt = new Date(new Date(prevWeek.startISO).getTime() + 3600_000).toISOString(); // 1h into the closed week

async function setSettings(next: LeaderboardRewardSettings) {
  await saveLeaderboardRewardSettings(next);
}
async function resetSettings() {
  await saveLeaderboardRewardSettings(LEADERBOARD_REWARD_DEFAULTS);
}

// ---------------------------------------------------------------------------
console.log("\n-- disabled by default: a fresh install settles nothing --");
{
  await resetSettings();
  const before = await sql.get<{ n: string }>("SELECT COUNT(*)::text AS n FROM leaderboard_reward_cycles");
  await tickLeaderboardRewards();
  const after = await sql.get<{ n: string }>("SELECT COUNT(*)::text AS n FROM leaderboard_reward_cycles");
  check("no cycles are created while the feature is off", before?.n === after?.n, `${before?.n} -> ${after?.n}`);

  const r = await settleLeaderboardCycle("weekly", "earners", prevWeek.startISO, prevWeek.endISO);
  check("a direct settlement call also refuses while disabled", r.skipped === "disabled", JSON.stringify(r));
}

console.log("\n-- a real settlement: ranks, tiers, and the ledger it actually mints into --");
const gold = await mkUser("gold"), silver = await mkUser("silver"), bronze = await mkUser("bronze");
{
  await seedTaskPoints(gold, 3000, insideAt);
  await seedTaskPoints(silver, 2000, insideAt);
  await seedTaskPoints(bronze, 1000, insideAt);
  invalidateLeaderboard();

  await setSettings({
    ...LEADERBOARD_REWARD_DEFAULTS,
    enabled: true,
    weekly: { enabled: true, tiersEarnersRozi: [100, 50, 25], tiersReferrersRozi: [] },
  });

  const before = { gold: await roziBalanceMicroOf(gold), silver: await roziBalanceMicroOf(silver), bronze: await roziBalanceMicroOf(bronze) };
  const result = await settleLeaderboardCycle("weekly", "earners", prevWeek.startISO, prevWeek.endISO);
  check("the settlement actually ran (a cycleId came back)", !!result.cycleId, JSON.stringify(result));
  check("all 3 ranked winners were paid", result.winners === 3, JSON.stringify(result));

  const goldAfter = await roziBalanceMicroOf(gold);
  const silverAfter = await roziBalanceMicroOf(silver);
  const bronzeAfter = await roziBalanceMicroOf(bronze);
  check("rank 1 got the rank-1 tier (100 ROZI)", fromMicro(goldAfter - before.gold) === 100, `${fromMicro(goldAfter - before.gold)}`);
  check("rank 2 got the rank-2 tier (50 ROZI)", fromMicro(silverAfter - before.silver) === 50, `${fromMicro(silverAfter - before.silver)}`);
  check("rank 3 got the rank-3 tier (25 ROZI)", fromMicro(bronzeAfter - before.bronze) === 25, `${fromMicro(bronzeAfter - before.bronze)}`);

  const cycleRow = await sql.get<{ paid_micro: string; scale_factor: number }>(
    "SELECT paid_micro, scale_factor FROM leaderboard_reward_cycles WHERE id = ?", result.cycleId);
  check("the cycle row records the real paid total", Number(cycleRow?.paid_micro) === fromMicro(175) * 1_000_000 || Number(cycleRow?.paid_micro) === 175_000_000);
  check("no scaling happened — plenty of room under the cap", cycleRow?.scale_factor === 1);

  const payoutRows = await sql.all<{ user_id: string; rank: number }>(
    "SELECT user_id, rank FROM leaderboard_reward_payouts WHERE cycle_id = ? ORDER BY rank", result.cycleId);
  check("3 payout rows, ranked 1..3", payoutRows.length === 3 && payoutRows.every((r, i) => r.rank === i + 1),
    JSON.stringify(payoutRows));
}

console.log("\n-- idempotent settlement: the same closed period cannot be paid twice --");
{
  const goldBefore = await roziBalanceMicroOf(gold);
  const cyclesBefore = await sql.get<{ n: string }>("SELECT COUNT(*)::text AS n FROM leaderboard_reward_cycles");

  const again = await settleLeaderboardCycle("weekly", "earners", prevWeek.startISO, prevWeek.endISO);
  check("a re-run reports 'already settled'", again.skipped === "already settled", JSON.stringify(again));

  const goldAfter = await roziBalanceMicroOf(gold);
  const cyclesAfter = await sql.get<{ n: string }>("SELECT COUNT(*)::text AS n FROM leaderboard_reward_cycles");
  check("no second mint happened", goldAfter === goldBefore, `${goldBefore} -> ${goldAfter}`);
  check("no second cycle row was inserted", cyclesBefore?.n === cyclesAfter?.n, `${cyclesBefore?.n} -> ${cyclesAfter?.n}`);

  // tickLeaderboardRewards() drives the SAME period every hourly tick until the
  // period rolls over — proves the "cheap no-op once settled" claim end to end,
  // not just via the direct function call above.
  await tickLeaderboardRewards();
  const cyclesAfterTick = await sql.get<{ n: string }>("SELECT COUNT(*)::text AS n FROM leaderboard_reward_cycles");
  check("the recurring tick is also a no-op once settled", cyclesAfter?.n === cyclesAfterTick?.n);
}

console.log("\n-- exclusions are respected: an excluded top-ranked user is paid nothing --");
const hidden = await mkUser("hidden");
{
  const monthPrev = previousPeriodBounds("monthly");
  const insideMonth = new Date(new Date(monthPrev.startISO).getTime() + 3600_000).toISOString();
  await seedTaskPoints(hidden, 9_000_000, insideMonth); // would be rank 1 by a mile
  await seedTaskPoints(gold, 3000, insideMonth);
  await sql.run(
    "INSERT INTO leaderboard_exclusions (user_id, reason, excluded_by, created_at) VALUES (?,?,?,?)",
    hidden, "e2e exclusion", admin, now(),
  );
  invalidateLeaderboard();

  await setSettings({
    ...LEADERBOARD_REWARD_DEFAULTS,
    enabled: true,
    monthly: { enabled: true, tiersEarnersRozi: [600], tiersReferrersRozi: [] },
  });

  const result = await settleLeaderboardCycle("monthly", "earners", monthPrev.startISO, monthPrev.endISO);
  check("the monthly cycle settled", !!result.cycleId, JSON.stringify(result));
  const payouts = await sql.all<{ user_id: string }>(
    "SELECT user_id FROM leaderboard_reward_payouts WHERE cycle_id = ?", result.cycleId);
  check("the excluded user received NOTHING", !payouts.some((p) => p.user_id === hidden), JSON.stringify(payouts));
  check("the next-ranked eligible user won instead", payouts.some((p) => p.user_id === gold), JSON.stringify(payouts));

  await sql.run("DELETE FROM leaderboard_exclusions WHERE user_id = ?", hidden);
  invalidateLeaderboard();
}

console.log("\n-- cap-safety: a pool cannot mint past the 21M-style supply cap --");
{
  const emittedSoFar = await sql.get<{ t: string }>(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM rozi_ledger
     WHERE source_type IN ('mining','task_reward','leaderboard_reward') AND direction = 'credit'`);
  const alreadyRozi = fromMicro(Number(emittedSoFar?.t ?? 0));

  // Only 30 ROZI of headroom for a 100+50+25=175 ROZI weekly demand next period.
  await setMiningSetting("supplyCap", alreadyRozi + 30);
  // Re-state weekly explicitly — the exclusions block above called
  // setSettings() with LEADERBOARD_REWARD_DEFAULTS (weekly.enabled: false) as
  // its base to configure monthly, which silently turned weekly back off. A
  // test block should never depend on another block's config surviving.
  await setSettings({
    ...LEADERBOARD_REWARD_DEFAULTS,
    enabled: true,
    weekly: { enabled: true, tiersEarnersRozi: [100, 50, 25], tiersReferrersRozi: [] },
  });

  const nextGold = await mkUser("gold2"), nextSilver = await mkUser("silver2"), nextBronze = await mkUser("bronze2");
  // Use a DIFFERENT (older) closed week so this cycle's unique key is fresh.
  const twoWeeksAgo = { startISO: new Date(new Date(prevWeek.startISO).getTime() - 7 * 86_400_000).toISOString(), endISO: prevWeek.startISO };
  const insideTwoWeeksAgo = new Date(new Date(twoWeeksAgo.startISO).getTime() + 3600_000).toISOString();
  await seedTaskPoints(nextGold, 3000, insideTwoWeeksAgo);
  await seedTaskPoints(nextSilver, 2000, insideTwoWeeksAgo);
  await seedTaskPoints(nextBronze, 1000, insideTwoWeeksAgo);
  invalidateLeaderboard();

  const before = {
    gold: await roziBalanceMicroOf(nextGold), silver: await roziBalanceMicroOf(nextSilver), bronze: await roziBalanceMicroOf(nextBronze),
  };
  const result = await settleLeaderboardCycle("weekly", "earners", twoWeeksAgo.startISO, twoWeeksAgo.endISO);
  check("the squeezed cycle still settles (scaled, not skipped)", !!result.cycleId, JSON.stringify(result));

  const paidGold = fromMicro((await roziBalanceMicroOf(nextGold)) - before.gold);
  const paidSilver = fromMicro((await roziBalanceMicroOf(nextSilver)) - before.silver);
  const paidBronze = fromMicro((await roziBalanceMicroOf(nextBronze)) - before.bronze);
  const totalPaid = paidGold + paidSilver + paidBronze;
  check("the cap is never breached — paid <= the 30 ROZI room", totalPaid <= 30 + 1e-9, `paid=${totalPaid}`);
  check("every winner was scaled by the SAME factor, not paid in row order",
    Math.abs(paidGold / 100 - paidSilver / 50) < 1e-6 && Math.abs(paidSilver / 50 - paidBronze / 25) < 1e-6,
    `gold=${paidGold} silver=${paidSilver} bronze=${paidBronze}`);
  check("nobody was paid zero while another was paid in full", paidGold > 0 && paidSilver > 0 && paidBronze > 0);

  await setMiningSetting("supplyCap", MINING_DEFAULTS.supplyCap);
}

console.log("\n-- backfill: a tick catches up on MORE THAN ONE missed period, not just the newest --");
{
  // weekly/referrers has never been settled anywhere above (only
  // weekly/earners and monthly/earners were) — a genuinely fresh track/cadence
  // combination, so both the immediately-previous week AND the one before it
  // are still unsettled, exactly the shape a long outage (or a cadence turned
  // on well after launch) leaves behind.
  const older = { startISO: new Date(new Date(prevWeek.startISO).getTime() - 7 * 86_400_000).toISOString(), endISO: prevWeek.startISO };
  const p1 = await mkUser("backfill-newer"), p2 = await mkUser("backfill-older");
  await seedReferralPoints(p1, 400, new Date(new Date(prevWeek.startISO).getTime() + 3600_000).toISOString());
  await seedReferralPoints(p2, 400, new Date(new Date(older.startISO).getTime() + 3600_000).toISOString());
  invalidateLeaderboard();

  await setSettings({
    ...LEADERBOARD_REWARD_DEFAULTS,
    enabled: true,
    weekly: { enabled: true, tiersEarnersRozi: [], tiersReferrersRozi: [40] },
  });

  const before = { n: await sql.get<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM leaderboard_reward_cycles WHERE cycle_type='weekly' AND track='referrers'") };
  await tickLeaderboardRewards();
  const after = await sql.get<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM leaderboard_reward_cycles WHERE cycle_type='weekly' AND track='referrers'");
  check("ONE tick settled BOTH missed weekly/referrers periods, not just the newest",
    Number(after?.n) - Number(before.n?.n) === 2, `before=${before.n?.n} after=${after?.n}`);

  const newerRow = await sql.get<{ id: string }>(
    "SELECT id FROM leaderboard_reward_cycles WHERE cycle_type='weekly' AND track='referrers' AND period_start=?", prevWeek.startISO);
  const olderRow = await sql.get<{ id: string }>(
    "SELECT id FROM leaderboard_reward_cycles WHERE cycle_type='weekly' AND track='referrers' AND period_start=?", older.startISO);
  check("the NEWER missed period settled", !!newerRow);
  check("the OLDER missed period settled TOO — this is what backfill means", !!olderRow);

  // A second tick must be a clean no-op — nothing left to backfill.
  const beforeSecond = await sql.get<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM leaderboard_reward_cycles WHERE cycle_type='weekly' AND track='referrers'");
  await tickLeaderboardRewards();
  const afterSecond = await sql.get<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM leaderboard_reward_cycles WHERE cycle_type='weekly' AND track='referrers'");
  check("once caught up, the next tick settles nothing further", beforeSecond?.n === afterSecond?.n);
}

console.log("\n-- structural: the settlement lock is the SAME global key mining settlement uses --");
{
  // A per-cycle lock key (e.g. hashtext(cycleType+track+period)) only stops
  // two leaderboard settlements colliding with EACH OTHER — it does nothing to
  // stop this job and mining/engine.ts's settleEpoch() from interleaving their
  // reads of totalEmittedMicro() and jointly minting past the 21M cap. Caught
  // in review before this ever shipped (leaderboardRewards.ts originally used
  // a per-cycle key). PGlite is single-connection and cannot reproduce the
  // actual race the way a real Postgres multi-connection test could — same
  // limitation this file's own header already accepts for the mining
  // double-spend race — so this reads the source directly, same tripwire
  // shape as otp-race.e2e.ts and sessions.e2e.ts use for their own
  // un-reproducible races.
  const src = readFileSync(fileURLToPath(new URL("../leaderboardRewards.ts", import.meta.url)), "utf8");
  check("settleLeaderboardCycle locks on the SAME key as mining settlement ('rozi-settlement')",
    src.includes("pg_try_advisory_xact_lock(hashtext('rozi-settlement'))"));
  check("it does NOT lock on a per-cycle key (the bug this guards against)",
    !src.includes("hashtext(?)"));
}

console.log("\n-- permission gating: only leaderboard.manage reaches the admin endpoints --");
{
  const getR = await app.inject({ method: "GET", url: "/staff/leaderboard/rewards/settings", headers: authOf(support) });
  check("support cannot read the reward settings", getR.statusCode === 403, `${getR.statusCode}`);
  const patchR = await app.inject({
    method: "PATCH", url: "/staff/leaderboard/rewards/settings", headers: authOf(support),
    payload: LEADERBOARD_REWARD_DEFAULTS,
  });
  check("support cannot write the reward settings", patchR.statusCode === 403, `${patchR.statusCode}`);
  const cyclesR = await app.inject({ method: "GET", url: "/staff/leaderboard/rewards/cycles", headers: authOf(support) });
  check("support cannot read the cycle history", cyclesR.statusCode === 403, `${cyclesR.statusCode}`);

  const adminGet = await app.inject({ method: "GET", url: "/staff/leaderboard/rewards/settings", headers: authOf(admin) });
  check("admin CAN read the reward settings", adminGet.statusCode === 200, adminGet.body);
  const adminCycles = await app.inject({ method: "GET", url: "/staff/leaderboard/rewards/cycles", headers: authOf(admin) });
  check("admin CAN read the cycle history", adminCycles.statusCode === 200, adminCycles.body);
  const cyclesJson = adminCycles.json();
  check("the cycle history lists real winners with real ranks", Array.isArray(cyclesJson.cycles) && cyclesJson.cycles.length > 0);
}

console.log("\n-- admin settings validation: a cadence cannot be enabled with no tiers --");
{
  const bad = await app.inject({
    method: "PATCH", url: "/staff/leaderboard/rewards/settings", headers: authOf(admin),
    payload: {
      ...LEADERBOARD_REWARD_DEFAULTS,
      weekly: { enabled: true, tiersEarnersRozi: [], tiersReferrersRozi: [] },
    },
  });
  check("turning weekly on with no tiers at all is refused", bad.statusCode === 400, bad.body);

  const good = await app.inject({
    method: "PATCH", url: "/staff/leaderboard/rewards/settings", headers: authOf(admin),
    payload: {
      ...LEADERBOARD_REWARD_DEFAULTS,
      weekly: { enabled: false, tiersEarnersRozi: [10, 5], tiersReferrersRozi: [] },
    },
  });
  check("a disabled cadence with tiers set is fine", good.statusCode === 200, good.body);
}

console.log("\n-- public API: window param scopes the board, and myStanding tracks a real tier --");
{
  await resetSettings();
  await saveLeaderboardRewardSettings({
    ...LEADERBOARD_REWARD_DEFAULTS,
    enabled: true,
    weekly: { enabled: true, tiersEarnersRozi: [77, 33], tiersReferrersRozi: [] },
  });
  invalidateLeaderboard();

  const curWeek = currentPeriodBounds("weekly");
  const insideCurWeek = new Date(new Date(curWeek.startISO).getTime() + 3600_000).toISOString();
  const winner = await mkUser("live-winner");
  await seedTaskPoints(winner, 500, insideCurWeek);
  invalidateLeaderboard();

  const weekView = await app.inject({ method: "GET", url: "/leaderboard?window=week", headers: authOf(winner) });
  check("window=week is accepted", weekView.statusCode === 200, weekView.body);
  const wj = weekView.json();
  check("the caller appears on the windowed board", (wj.topEarners as { isMe: boolean }[]).some((r) => r.isMe));
  check("myStanding reports the real configured tier for their rank",
    wj.myStanding?.earners?.roziReward === 77, JSON.stringify(wj.myStanding));

  const allView = (await app.inject({ method: "GET", url: "/leaderboard?window=all", headers: authOf(winner) })).json();
  check("window=all never carries a standing (all-time has no cadence)", allView.myStanding === null);

  await resetSettings();
  const offView = (await app.inject({ method: "GET", url: "/leaderboard?window=week", headers: authOf(winner) })).json();
  check("with rewards disabled, myStanding is null even at a winning rank", offView.myStanding?.earners === null,
    JSON.stringify(offView.myStanding));
}

await resetSettings();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
