// E2E for ROZI mining against a real database (docs/MINING_SPEC.md).
//
// The unit tests (mining.test.ts) prove the maths. This proves the PLUMBING: that
// shares actually accrue, that settlement mints the right ROZI and is idempotent,
// that a shared device earns nothing, that a fraud flag withholds without
// inflating everyone else, that rigs burn, and that a conversion window cannot
// overpay its pot.
//
//   npm run test:mining:e2e
import {
  sql, now, newId, initDb, postRozi, postLedger, roziBalanceOf, balanceOf,
  usingRealPostgres,
} from "../db.ts";
import { setMiningSetting, loadMiningSettings } from "../mining/settings.ts";
import { settleEpoch, hashrateOf, grantBoost, accrueAllSessions } from "../mining/engine.ts";
import { epochOf, rigUpgradeCost } from "../mining/core.ts";
import { settleConversionWindow } from "../routes/mining.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();

const mkUser = async (label: string) => {
  const id = newId();
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at) VALUES (?,?,1,'Pakistan',?,'active',?)",
    id, `${label}-${id}@t.test`, id.slice(0, 8).toUpperCase(), now(),
  );
  return id;
};

// Settle PAST epochs so we never race the live one — settleEpoch refuses an
// epoch that is still open. PGlite persists between runs, so wipe these two
// epochs first: otherwise a re-run hits "already settled" and every assertion
// below would be measuring an empty pot.
const EPOCH = epochOf() - 1;
const E2 = epochOf() - 2;
for (const e of [EPOCH, E2]) {
  await sql.run("DELETE FROM mining_epochs WHERE epoch = ?", e);
  await sql.run("DELETE FROM mining_shares WHERE epoch = ?", e);
}
await sql.run("DELETE FROM rozi_ledger WHERE source_type = 'mining'");

const alice = await mkUser("alice");
const bob = await mkUser("bob");
const mallory = await mkUser("mallory");

const addShares = (userId: string, shares: number, epoch = EPOCH) => sql.run(
  `INSERT INTO mining_shares (epoch, user_id, shares, updated_at) VALUES (?,?,?,?)
   ON CONFLICT (epoch, user_id) DO UPDATE SET shares = mining_shares.shares + EXCLUDED.shares`,
  epoch, userId, shares, now(),
);

console.log("\n-- epoch settlement: pro-rata, and the pot is never exceeded --");

// This block tests the POOL model, so it pins the model explicitly rather than
// relying on the default — which is now "pi" (founder decision, 2026-07-13). The
// pool model is still the supported fallback, so it still has to work.
await setMiningSetting("emissionModel", "pool");

// Alice mined 3x what Bob did. She should get 3x the ROZI.
await addShares(alice, 3_000_000);
await addShares(bob, 1_000_000);

const s = await loadMiningSettings();
const r1 = await settleEpoch(EPOCH);

const aliceRozi = await roziBalanceOf(alice);
const bobRozi = await roziBalanceOf(bob);

check("emission for the epoch is the configured base", r1.emission === s.baseEmission, `got ${r1.emission}`);
check("both miners were paid", aliceRozi > 0 && bobRozi > 0, `alice=${aliceRozi} bob=${bobRozi}`);
check("payout is pro-rata to shares (alice mined 3x bob)",
  Math.abs(aliceRozi / bobRozi - 3) < 0.001, `ratio=${aliceRozi / bobRozi}`);
check("total emitted never exceeds the epoch emission",
  aliceRozi + bobRozi <= r1.emission, `paid=${aliceRozi + bobRozi} emission=${r1.emission}`);
check("epoch row records what was emitted", r1.emitted === aliceRozi + bobRozi);

console.log("\n-- settlement is idempotent (a retry must not double-pay) --");

const r2 = await settleEpoch(EPOCH);
check("a second settlement of the same epoch is a no-op", r2.skipped === "already settled");
check("balances did not move on the re-run", (await roziBalanceOf(alice)) === aliceRozi);

console.log("\n-- the ROZI ledger is append-only, balance = SUM --");

const rows = await sql.all<{ amount: string }>(
  "SELECT amount FROM rozi_ledger WHERE user_id = ?", alice);
check("balance is exactly the sum of the ledger rows",
  rows.reduce((a, r) => a + Number(r.amount), 0) === aliceRozi);

console.log("\n-- a fraud flag WITHHOLDS, and does not inflate honest miners --");

await addShares(alice, 1_000_000, E2);
await addShares(mallory, 1_000_000, E2);
// Mallory is caught: high-severity, unresolved.
await sql.run(
  "INSERT INTO fraud_flags (id, user_id, device_id, flag_type, severity, detail, created_at) VALUES (?,?,?,?,?,?,?)",
  newId(), mallory, "dev-mallory", "mining_device_share", "high", "test", now(),
);

const aliceBefore = await roziBalanceOf(alice);
const r3 = await settleEpoch(E2);
const aliceGain = (await roziBalanceOf(alice)) - aliceBefore;

check("the flagged miner is paid nothing", (await roziBalanceOf(mallory)) === 0);
check("their share is recorded as withheld, not voided", r3.withheld > 0, `withheld=${r3.withheld}`);
check("the honest miner still gets only HER half — fraud does not enrich others",
  Math.abs(aliceGain - r3.emission / 2) <= 1, `gain=${aliceGain} half=${r3.emission / 2}`);
// This is the subtle one. If the flagged user were dropped from the DENOMINATOR
// instead of withheld, Alice would have received the whole epoch — meaning our
// honest miners' payouts would swing with how much fraud we happened to catch.

console.log("\n-- one device, one miner, one epoch --");

const { startSession } = await import("../mining/engine.ts");
const twinA = await mkUser("twinA");
const twinB = await mkUser("twinB");
// Unique per run: the device claim is (epoch, device_id) and the database
// persists, so a fixed string would still be owned by the LAST run's twinA.
const SHARED_DEVICE = `device-shared-${newId().slice(0, 8)}`;

const sa = await startSession(twinA, SHARED_DEVICE);
const sb = await startSession(twinB, SHARED_DEVICE);
check("the first account on the device can mine", sa.ok === true);
check("the second account is NOT hard-blocked (families share phones)", sb.ok === true);

const owner = await sql.get<{ user_id: string }>(
  "SELECT user_id FROM mining_epoch_devices WHERE epoch = ? AND device_id = ?", epochOf(), SHARED_DEVICE);
check("but the device is claimed by the first account only", owner?.user_id === twinA);

const flag = await sql.get<{ severity: string }>(
  "SELECT severity FROM fraud_flags WHERE flag_type = 'mining_device_share' AND user_id = ?", twinB);
check("and the second account is flagged high-severity", flag?.severity === "high");

console.log("\n-- unverified email cannot mine (bots are cheap, verified email is not) --");

const ghost = newId();
await sql.run(
  "INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at) VALUES (?,?,0,'Pakistan',?,'active',?)",
  ghost, `ghost-${ghost}@t.test`, ghost.slice(0, 8).toUpperCase(), now(),
);
const g = await startSession(ghost, "device-ghost");
check("an unverified account is refused", g.ok === false);

console.log("\n-- rigs burn ROZI and raise hashrate --");

const miner = await mkUser("miner");
await postRozi({ userId: miner, rozi: 10_000, direction: "credit", sourceType: "admin_adjustment", note: "test float" });

const before = await hashrateOf(miner);
const rig = await sql.get<{ id: string; base_cost: number; cost_growth: number; base_power: number; power_growth: number; max_level: number }>(
  "SELECT * FROM rigs WHERE id = 'old_phone'");
const cost = rigUpgradeCost({
  baseCost: Number(rig!.base_cost), costGrowth: rig!.cost_growth,
  basePower: rig!.base_power, powerGrowth: rig!.power_growth, maxLevel: rig!.max_level,
}, 0);

await postRozi({ userId: miner, rozi: cost, direction: "debit", sourceType: "rig_purchase", sourceRefId: "old_phone", note: "L1" });
await sql.run("INSERT INTO user_rigs (user_id, rig_id, level, updated_at) VALUES (?,?,1,?)", miner, "old_phone", now());

const after = await hashrateOf(miner);
check("buying a rig burns ROZI", (await roziBalanceOf(miner)) === 10_000 - cost, `bal=${await roziBalanceOf(miner)}`);
check("buying a rig raises hashrate", after.hashrate > before.hashrate, `${before.hashrate} -> ${after.hashrate}`);

console.log("\n-- boosts stack additively and expire --");

const boosted = await mkUser("boosted");
const h0 = (await hashrateOf(boosted)).hashrate;
await grantBoost(boosted, "task", 50, 48);
await grantBoost(boosted, "ad", 100, 4);
const h1 = (await hashrateOf(boosted)).hashrate;
check("two boosts (+50%, +100%) give x2.5, not x3", h1 === Math.floor(h0 * 2.5), `${h0} -> ${h1}`);

// An expired boost must stop counting.
await sql.run(
  "UPDATE user_boosts SET expires_at = ? WHERE user_id = ?",
  new Date(Date.now() - 1000).toISOString(), boosted,
);
check("an expired boost no longer counts", (await hashrateOf(boosted)).hashrate === h0);

console.log("\n-- task boost cap: a survey farm cannot stack boosts forever --");

const stacker = await mkUser("stacker");
const base = (await hashrateOf(stacker)).hashrate;
for (let i = 0; i < 10; i++) await grantBoost(stacker, "task", 50, 48);
const stacked = (await hashrateOf(stacker)).hashrate;
const cfg = await loadMiningSettings();
const expected = Math.floor(base * (1 + (cfg.taskBoostMaxStack * cfg.taskBoostPct) / 100));
check(`10 task boosts are capped at ${cfg.taskBoostMaxStack}`, stacked === expected, `got ${stacked}, expected ${expected}`);

console.log("\n-- AD NONCE: a single ad view cannot be redeemed twice --");

// Found in security review. The redemption used to SELECT the row, check
// status='issued', and UPDATE it several statements later. Fifty concurrent POSTs
// with the SAME nonce all read 'issued', all passed, and all granted a boost.
//
// That is real theft: hashrate sets your share of the day's ROZI emission, and
// ROZI is a claim on Conversion Window pots that pay out real Points.
const adUser = await mkUser("adwatcher");
const adNonce = `nonce-${newId()}`;
await sql.run(
  `INSERT INTO ad_impressions (id, user_id, device_id, nonce, provider, status, issued_at)
   VALUES (?,?,?,?,?,'issued',?)`,
  newId(), adUser, "dev-ad", adNonce, "test",
  new Date(Date.now() - 60_000).toISOString(), // dwell minimum long satisfied
);

// Consume it the way the route now does: a conditional UPDATE whose rowCount is
// the authority. Fire ten at once and count how many actually won the row.
const attempts = await Promise.all(
  Array.from({ length: 10 }, () =>
    sql.run(
      "UPDATE ad_impressions SET status = 'rewarded', rewarded_at = ? WHERE nonce = ? AND status = 'issued'",
      now(), adNonce,
    ).then((r) => r.rowCount).catch(() => 0),
  ),
);
const winners = attempts.filter((n) => n === 1).length;
check("exactly ONE of 10 concurrent redemptions consumes the nonce", winners === 1,
  `winners=${winners} attempts=${JSON.stringify(attempts)}`);

const adRow = await sql.get<{ status: string }>(
  "SELECT status FROM ad_impressions WHERE nonce = ?", adNonce);
check("and the impression ends up rewarded exactly once", adRow?.status === "rewarded");

console.log("\n-- CONVERSION: a window can never pay out more Points than its pot --");

await setMiningSetting("conversionEnabled", 1);
const POT = 200_000;
const winId = newId();
await sql.run(
  "INSERT INTO conversion_windows (id, pot_points, opens_at, closes_at, status) VALUES (?,?,?,?, 'open')",
  winId, POT, now(), new Date(Date.now() + 3600_000).toISOString(),
);

// Three users burn wildly different amounts.
const burners: [string, number][] = [
  [await mkUser("burn1"), 1_000],
  [await mkUser("burn2"), 50_000],
  [await mkUser("burn3"), 7],
];
let totalBurn = 0;
for (const [uid, amt] of burners) {
  await postRozi({ userId: uid, rozi: amt, direction: "credit", sourceType: "admin_adjustment", note: "test" });
  await postRozi({ userId: uid, rozi: amt, direction: "debit", sourceType: "conversion_burn", sourceRefId: winId, note: "burn" });
  await sql.run(
    "INSERT INTO conversion_burns (id, window_id, user_id, rozi, created_at) VALUES (?,?,?,?,?)",
    newId(), winId, uid, amt, now(),
  );
  totalBurn += amt;
}
await sql.run("UPDATE conversion_windows SET total_burned = ? WHERE id = ?", totalBurn, winId);

const pointsBefore = await Promise.all(burners.map(([u]) => balanceOf(u)));
const conv = await settleConversionWindow(winId);
const pointsAfter = await Promise.all(burners.map(([u]) => balanceOf(u)));
const totalPaid = pointsAfter.reduce((a, b) => a + b, 0) - pointsBefore.reduce((a, b) => a + b, 0);

check("THE INVARIANT: points paid never exceed the committed pot",
  totalPaid <= POT, `paid=${totalPaid} pot=${POT}`);
check("the window records what it actually paid", conv.pointsPaid === totalPaid);
check("the big burner gets the biggest share",
  pointsAfter[1] > pointsAfter[0] && pointsAfter[0] > pointsAfter[2]);
check("burned ROZI is gone from the burners' balances",
  (await roziBalanceOf(burners[0][0])) === 0);
check("a settled window cannot be settled twice",
  await settleConversionWindow(winId).then(() => false).catch(() => true));

// points_paid must reconcile against the ledger EXACTLY. It used to be written
// per-user onto every one of that user's burn rows, so a user who burned three
// times had their full payout stamped three times — any later SUM() over the
// column would have triple-counted real money.
const burnRowsPaid = await sql.get<{ t: number }>(
  "SELECT COALESCE(SUM(points_paid), 0)::int AS t FROM conversion_burns WHERE window_id = ?", winId);
check("SUM(points_paid) over burn rows equals the points actually minted",
  (burnRowsPaid?.t ?? 0) === totalPaid, `rows=${burnRowsPaid?.t} minted=${totalPaid}`);
check("the window reports distinct PEOPLE, not burn rows", conv.users === burners.length,
  `users=${conv.users} burners=${burners.length}`);

console.log("\n-- ACCRUAL SWEEP: a user who closes the app still gets paid --");

// The bug: shares were only written when the user POLLED. Someone who tapped
// "Start mining" and closed their phone had nothing in mining_shares when their
// day was settled, and earned zero for a session they legitimately ran.
//
// Simulate exactly that: a session that started 3 hours ago and has never been
// accrued (the user never came back), and no request from them at all. The
// server-side sweep must find it and put its time on the books.
const sleeper = await mkUser("sleeper");
const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
await sql.run(
  `INSERT INTO mining_sessions (id, user_id, device_id, started_at, expires_at, last_accrued_at, status)
   VALUES (?,?,?,?,?,?, 'active')`,
  newId(), sleeper, `dev-${newId().slice(0, 8)}`, threeHoursAgo,
  new Date(Date.now() + 5 * 3600_000).toISOString(), threeHoursAgo,
);

const beforeSweep = await sql.get<{ shares: string }>(
  "SELECT shares FROM mining_shares WHERE user_id = ?", sleeper);
check("before the sweep, the sleeping user has no shares", beforeSweep === undefined);

await accrueAllSessions();

const afterSweep = await sql.get<{ shares: string }>(
  "SELECT COALESCE(SUM(shares),0) AS shares FROM mining_shares WHERE user_id = ?", sleeper);
check("the sweep books their 3 hours WITHOUT them opening the app",
  Number(afterSweep?.shares ?? 0) > 0, `shares=${afterSweep?.shares}`);

// Base hashrate 10 x 3h = 108,000 share-seconds, give or take a second of clock.
const expectedShares = 10 * 3 * 3600;
check("and books roughly the right amount",
  Math.abs(Number(afterSweep?.shares ?? 0) - expectedShares) < 10 * 60,
  `got ${afterSweep?.shares}, expected ~${expectedShares}`);

// Sweeping twice must not pay twice — last_accrued_at moved forward.
await accrueAllSessions();
const afterSecond = await sql.get<{ shares: string }>(
  "SELECT COALESCE(SUM(shares),0) AS shares FROM mining_shares WHERE user_id = ?", sleeper);
check("sweeping again does not double-credit the same seconds",
  Math.abs(Number(afterSecond?.shares ?? 0) - Number(afterSweep?.shares ?? 0)) < 10 * 60,
  `${afterSweep?.shares} -> ${afterSecond?.shares}`);

console.log("\n-- DOUBLE-SPEND: concurrent debits cannot overdraw a balance --");

// The advisory lock (lockUser) is what stops two concurrent requests both
// reading the same balance, both passing the affordability check, and both
// debiting. Without it a user with 1000 ROZI could burn 1000 twice and buy a
// bigger slice of a pot of REAL points. Prove the lock holds by racing it.
async function spendRozi(userId: string, amount: number): Promise<boolean> {
  try {
    await sql.tx(async (t) => {
      await t.run("SELECT pg_advisory_xact_lock(hashtext(?))", userId);
      const bal = await roziBalanceOf(userId, t);
      if (bal < amount) throw new Error("insufficient");
      await postRozi({
        userId, rozi: amount, direction: "debit",
        sourceType: "conversion_burn", note: "race test",
      }, t);
    });
    return true;
  } catch {
    return false;
  }
}

const racer = await mkUser("racer");
await postRozi({ userId: racer, rozi: 1_000, direction: "credit", sourceType: "admin_adjustment", note: "float" });

// Fire five simultaneous attempts to spend the entire balance.
const results = await Promise.all([1, 2, 3, 4, 5].map(() => spendRozi(racer, 1_000)));
const succeeded = results.filter(Boolean).length;

if (usingRealPostgres) {
  check("exactly ONE of five concurrent full-balance spends succeeds", succeeded === 1, `${succeeded} succeeded`);
  check("the balance lands at zero, never negative", (await roziBalanceOf(racer)) === 0,
    `bal=${await roziBalanceOf(racer)}`);
} else {
  // PGlite is a SINGLE-CONNECTION embedded Postgres. Every sql.tx() shares one
  // session, so (a) transactions do not isolate from each other and (b) an
  // advisory lock is re-entrant within its own session and therefore always
  // re-acquired. Under this driver the race is expected to "succeed" five times
  // — that is the dev driver's behaviour, not a defect in the lock.
  //
  // The lock is real against node-postgres, where each transaction gets its own
  // pooled client, which is what production (Railway) runs. The existing
  // withdrawal path has exactly the same property. Run this file with
  // DATABASE_URL set against a real Postgres to actually exercise it.
  console.log(`  skip concurrent-spend race — PGlite is single-session, so it cannot ` +
    `isolate transactions (${succeeded}/5 spends went through, balance ` +
    `${await roziBalanceOf(racer)}). Set DATABASE_URL to test this for real.`);
  // Structural tripwire, so the protection cannot be silently deleted under a
  // driver that cannot exercise it. Every user-scoped transaction that spends
  // something — ROZI, Points, or a single-use ad nonce — must take the advisory
  // lock first (guardrail #8).
  //
  // If you add a new spending path, add lockUser() to it and add it to this list.
  // A mismatch here means either the lock is missing or this list is stale; both
  // are worth stopping for.
  const LOCKED_PATHS = ["rig upgrade", "booster buy", "ROZI transfer", "conversion burn", "ad redeem"];
  const locks = (await import("node:fs")).readFileSync(
    new URL("../routes/mining.ts", import.meta.url), "utf8",
  ).match(/lockUser\(t, userId\)/g)?.length ?? 0;
  check("the advisory lock is present on every user-scoped spending path",
    locks === LOCKED_PATHS.length,
    `found ${locks} lockUser() calls, expected ${LOCKED_PATHS.length}: ${LOCKED_PATHS.join(", ")}`);
}

console.log("\n-- the two ledgers stay separate (guardrail #7) --");

const crossover = await sql.get<{ n: number }>(
  `SELECT COUNT(*)::int AS n FROM ledger_entries
   WHERE source_type NOT IN ('task_completion','referral_bonus','withdrawal',
                             'admin_adjustment','mining_conversion','booster_purchase')`,
);
check("no Points row has a source type outside the allowed set", (crossover?.n ?? 0) === 0);

// Scoped to THIS window: the database persists between runs, so a global count
// would also pick up every earlier run's rows.
const winPointsRows = await sql.get<{ n: number; total: number }>(
  `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::int AS total FROM ledger_entries
   WHERE source_type = 'mining_conversion' AND source_ref_id = ?`, winId,
);
check("every Point this window minted is attributable to it, and to nothing else",
  (winPointsRows?.n ?? 0) === burners.filter((_, i) => pointsAfter[i] - pointsBefore[i] > 0).length
  && (winPointsRows?.total ?? 0) === totalPaid,
  `rows=${winPointsRows?.n} total=${winPointsRows?.total} paid=${totalPaid}`);

await setMiningSetting("conversionEnabled", 0);

// ---- PI MODEL (founder decision, 2026-07-13) --------------------------------
// The unit tests prove the arithmetic. This proves it through the real settlement
// path: the same lock, the same cap, the same withhold rule, a real ledger.

console.log("\n-- PI model: your payout comes from YOUR shares, not a shared pot --");

await setMiningSetting("emissionModel", "pi");
await setMiningSetting("piBaseRate", 1000);
await setMiningSetting("piHalvingUsers", "10000,50000");
await setMiningSetting("piReferenceHours", 24);

const piS = await loadMiningSettings();
const FULL_DAY = piS.baseHashrate * piS.piReferenceHours * 3600; // baseline, full day

// A fresh epoch of its own, so nothing above bleeds into these numbers.
const PI_EPOCH = epochOf() - 3;
await sql.run("DELETE FROM mining_epochs WHERE epoch = ?", PI_EPOCH);
await sql.run("DELETE FROM mining_shares WHERE epoch = ?", PI_EPOCH);

const carol = await mkUser("carol");   // mines a full baseline day
const dave = await mkUser("dave");     // mines the same, x2 multiplier worth of shares
const erin = await mkUser("erin");     // mines a third of a day

await addShares(carol, FULL_DAY, PI_EPOCH);
await addShares(dave, FULL_DAY * 2, PI_EPOCH);
await addShares(erin, Math.floor(FULL_DAY / 3), PI_EPOCH);

const piR = await settleEpoch(PI_EPOCH);
const carolRozi = await roziBalanceOf(carol);
const daveRozi = await roziBalanceOf(dave);
const erinRozi = await roziBalanceOf(erin);

// The population is small in the test DB, so no milestone has been crossed and
// the rate is the full base rate.
check("PI: a baseline miner mining a full day earns exactly the base rate",
  carolRozi === 1000, `got ${carolRozi}`);
check("PI: x2 shares earns exactly x2 — multipliers multiply the rate",
  daveRozi === 2000, `got ${daveRozi}`);
check("PI: a third of a day earns a third of the rate",
  Math.abs(erinRozi - 333) <= 1, `got ${erinRozi}`);

// THE property the whole model exists for. Under the pool model, Carol's reward
// would have been diluted by Dave and Erin showing up. Here it is untouched: she
// gets the base rate whether she mines alone or beside a million people.
check("PI: NO DILUTION — Carol got the full rate despite two other miners",
  carolRozi === 1000, `got ${carolRozi}`);
check("PI: the epoch's emission is the SUM of what miners earned, not a fixed pot",
  piR.emission === carolRozi + daveRozi + erinRozi,
  `emission=${piR.emission} sum=${carolRozi + daveRozi + erinRozi}`);

console.log("\n-- PI model: halving is a clean 50% cut to the person --");

// Re-settle an adjacent epoch with the rate halved by hand. Same shares, half the
// rate => exactly half the ROZI. "Halving means halving."
const PI_EPOCH_2 = epochOf() - 4;
await sql.run("DELETE FROM mining_epochs WHERE epoch = ?", PI_EPOCH_2);
await sql.run("DELETE FROM mining_shares WHERE epoch = ?", PI_EPOCH_2);

const frank = await mkUser("frank");
await addShares(frank, FULL_DAY, PI_EPOCH_2);
await setMiningSetting("piBaseRate", 500); // one halving of 1000
await settleEpoch(PI_EPOCH_2);
const frankRozi = await roziBalanceOf(frank);

check("PI: after one halving the same mining earns exactly half",
  frankRozi === 500 && frankRozi === carolRozi / 2, `frank=${frankRozi} carol=${carolRozi}`);

console.log("\n-- PI model: the supply cap still holds when the pool runs dry --");

// The endgame, and the one thing the pi model can do that the pool model cannot:
// ask for more than the cap has left. Squeeze the cap down to just above what has
// already been emitted, so the next epoch's demand cannot possibly be met.
const emittedSoFar = await sql.get<{ t: string }>(
  `SELECT COALESCE(SUM(amount), 0) AS t FROM rozi_ledger
   WHERE source_type = 'mining' AND direction = 'credit'`);
const already = Number(emittedSoFar?.t ?? 0);

const PI_EPOCH_3 = epochOf() - 5;
await sql.run("DELETE FROM mining_epochs WHERE epoch = ?", PI_EPOCH_3);
await sql.run("DELETE FROM mining_shares WHERE epoch = ?", PI_EPOCH_3);

const gina = await mkUser("gina");
const hank = await mkUser("hank");
await addShares(gina, FULL_DAY, PI_EPOCH_3);   // wants 500
await addShares(hank, FULL_DAY, PI_EPOCH_3);   // wants 500 — 1000 total

// Only 400 of headroom for a 1000-ROZI demand.
await setMiningSetting("supplyCap", already + 400);
const capR = await settleEpoch(PI_EPOCH_3);
const ginaRozi = await roziBalanceOf(gina);
const hankRozi = await roziBalanceOf(hank);

check("PI: the supply cap is never breached, even though demand exceeded it",
  already + capR.emitted <= already + 400, `emitted=${capR.emitted} room=400`);
check("PI: everyone is scaled by the SAME factor — no one is paid in full while another gets zero",
  ginaRozi === hankRozi && ginaRozi > 0, `gina=${ginaRozi} hank=${hankRozi}`);
check("PI: the scaled payouts add up to the room that was left, not more",
  ginaRozi + hankRozi <= 400, `paid=${ginaRozi + hankRozi}`);

// Put the economy back the way we found it, so a re-run starts clean.
await setMiningSetting("supplyCap", 650_000_000);
await setMiningSetting("piBaseRate", 100);
await setMiningSetting("emissionModel", "pi");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
