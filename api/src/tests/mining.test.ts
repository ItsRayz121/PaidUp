// Unit tests for the ROZI economy (docs/MINING_SPEC.md).
//
// These are the tests that matter most in the repo. Everything else can be fixed
// with a patch; an economy that silently over-issues cannot be un-issued.
//
//   npm run test:mining
import { strict as assert } from "node:assert";
import test from "node:test";
// core.ts ONLY. Importing from mining/settings.ts here would pull in db.ts, which
// opens a database connection at module scope — and a unit-test file holding a
// live connection never exits, so node:test hangs until it times out and reports
// the whole file as failed even though every assertion passed. That is exactly
// what happened, and it is why MINING_DEFAULTS lives in core.ts.
import {
  emissionMicroAt, cappedEmissionMicro, computeHashrate, payoutMicroFor,
  rigUpgradeCost, rigPower, rigIsDeflationary, conversionPayout,
  epochOf, epochEndMs, splitByEpoch, MINING_GENESIS_MS,
  parseMilestones, piBaseRateFor, piPayoutMicroFor, capScaleFactor,
  ROZI_SCALE, toMicro, fromMicro,
  MINING_DEFAULTS as D,
} from "../mining/core.ts";

const EMISSION = {
  baseEmission: D.baseEmission,
  halvingEpochs: D.halvingEpochs,
  supplyCap: D.supplyCap,
};

// The core functions all speak MICRO-ROZI now. These wrappers convert back to
// whole ROZI so the assertions below read as economics ("a full day pays 10")
// rather than as arithmetic ("a full day pays 10000000"). Where the MICRO value
// is the actual point of the test — the flooring ones — the raw function is
// called directly.
const emissionRozi = (epoch: number) => fromMicro(emissionMicroAt(epoch, EMISSION));
const cappedRozi = (epoch: number, emittedRozi: number, e = EMISSION) =>
  fromMicro(cappedEmissionMicro(epoch, toMicro(emittedRozi), e));
const pool = (shares: number, total: number, emissionRozi: number) =>
  fromMicro(payoutMicroFor(shares, total, toMicro(emissionRozi)));

test("epochs are whole UTC days from genesis", () => {
  assert.equal(epochOf(new Date(MINING_GENESIS_MS)), 0);
  assert.equal(epochOf(new Date(MINING_GENESIS_MS + 86_400_000 - 1)), 0);
  assert.equal(epochOf(new Date(MINING_GENESIS_MS + 86_400_000)), 1);
  assert.equal(epochOf(new Date(MINING_GENESIS_MS + 250 * 86_400_000)), 250);
});

test("a session crossing midnight is split across BOTH days", () => {
  // The bug this exists to prevent: an 8-hour session started at 20:00 UTC ran
  // four hours into the next day, but ALL of it was booked to the start day. The
  // user's mining after midnight was credited to a day that may already have been
  // settled — in which case it vanished entirely.
  const day0 = MINING_GENESIS_MS;
  const start = day0 + 20 * 3_600_000;  // 20:00 on day 0
  const end = start + 8 * 3_600_000;    // 04:00 on day 1

  const slices = splitByEpoch(start, end);
  assert.equal(slices.length, 2);
  assert.deepEqual(slices[0], { epoch: 0, seconds: 4 * 3600 });  // 20:00 -> midnight
  assert.deepEqual(slices[1], { epoch: 1, seconds: 4 * 3600 });  // midnight -> 04:00

  // Nothing is lost or double-counted in the split.
  const total = slices.reduce((a, s) => a + s.seconds, 0);
  assert.equal(total, Math.floor((end - start) / 1000));
});

test("a session inside one day is a single slice", () => {
  const start = MINING_GENESIS_MS + 2 * 3_600_000;
  const slices = splitByEpoch(start, start + 3 * 3_600_000);
  assert.deepEqual(slices, [{ epoch: 0, seconds: 3 * 3600 }]);
});

test("a session spanning several days lands on every one of them", () => {
  const start = MINING_GENESIS_MS + 12 * 3_600_000; // midday, day 0
  const slices = splitByEpoch(start, start + 3 * 86_400_000);
  assert.deepEqual(slices.map((s) => s.epoch), [0, 1, 2, 3]);
  assert.equal(slices.reduce((a, s) => a + s.seconds, 0), 3 * 86_400);
});

test("epochEndMs is the exact start of the next day", () => {
  assert.equal(epochEndMs(0), MINING_GENESIS_MS + 86_400_000);
  assert.equal(epochOf(new Date(epochEndMs(0))), 1);
  assert.equal(epochOf(new Date(epochEndMs(0) - 1)), 0);
});

test("emission halves every halvingEpochs", () => {
  assert.equal(emissionRozi(0), 3_000_000);
  assert.equal(emissionRozi(99), 3_000_000);
  assert.equal(emissionRozi(100), 1_500_000);
  assert.equal(emissionRozi(200), 750_000);
  assert.equal(emissionRozi(300), 375_000);
});

test("total emission over all time converges under the supply cap", () => {
  // Sum 10,000 epochs (~27 years). The geometric series converges to
  // E0 * halving * 2 = 600M, comfortably under the 650M cap — and the headroom
  // is what absorbs referral overhead without ever breaching the hard limit.
  let total = 0;
  for (let e = 0; e < 10_000; e++) total += emissionRozi(e);
  assert.ok(total <= 600_000_000, `emitted ${total} > 600M`);
  assert.ok(total > 599_000_000, `emitted ${total}, expected ~600M`);
  assert.ok(total < EMISSION.supplyCap);
});

test("the supply cap is a hard ceiling even if an Admin fat-fingers the emission", () => {
  const reckless = { ...EMISSION, baseEmission: 999_999_999_999 };
  // Already emitted 649M of the 650M cap: only 1M may be minted, whatever the
  // settings say. This is the last line of defence and it must not depend on the
  // Admin being careful.
  assert.equal(cappedRozi(0, 649_000_000, reckless), 1_000_000);
  assert.equal(cappedRozi(0, 650_000_000, reckless), 0);
  assert.equal(cappedRozi(0, 999_000_000, reckless), 0); // never negative
});

test("the supply cap holds in MICRO — the unit change did not widen the ceiling", () => {
  // The cap is 650M ROZI = 6.5e14 micro. That is the number the ledger is
  // actually checked against now, and it has to be exact: it sits well inside
  // 2^53 (9.007e15), so it is representable, but it would NOT be if the scale
  // were raised much further. This test is the tripwire on that headroom.
  assert.equal(toMicro(EMISSION.supplyCap), 650_000_000_000_000);
  assert.ok(Number.isSafeInteger(toMicro(EMISSION.supplyCap)));
  assert.equal(cappedEmissionMicro(0, toMicro(650_000_000), EMISSION), 0);
});

test("a miner's payout is a SHARE of the pot, so the pot can never be exceeded", () => {
  const emissionMicro = toMicro(3_000_000);
  const shares = [500, 1500, 3000, 17, 999_999];
  const total = shares.reduce((a, b) => a + b, 0);
  const paid = shares.reduce((a, s) => a + payoutMicroFor(s, total, emissionMicro), 0);
  assert.ok(paid <= emissionMicro, `paid ${paid} > emission ${emissionMicro}`);
  // Flooring leaves dust unemitted. The error is always in the treasury's
  // favour — never the other way. The dust is now at most one MICRO per miner,
  // i.e. a millionth of a ROZI each, rather than a whole ROZI each.
  assert.ok(emissionMicro - paid < shares.length);
});

test("no shares mined => nothing is emitted", () => {
  assert.equal(payoutMicroFor(0, 0, toMicro(3_000_000)), 0);
  assert.equal(payoutMicroFor(100, 0, toMicro(3_000_000)), 0);
});

test("adding miners dilutes everyone — difficulty self-adjusts", () => {
  const solo = pool(1000, 1000, 3_000_000);
  const crowded = pool(1000, 1_000_000, 3_000_000);
  assert.equal(solo, 3_000_000);
  assert.ok(crowded < solo / 100);
});

test("rig cost outruns rig power — the upgrade tree is a treadmill", () => {
  const def = { baseCost: 500, costGrowth: 160, basePower: 5, powerGrowth: 150, maxLevel: 10 };
  assert.ok(rigIsDeflationary(def));

  assert.equal(rigUpgradeCost(def, 0), 500);   // buy level 1
  assert.equal(rigUpgradeCost(def, 1), 800);   // level 1 -> 2
  assert.equal(rigPower(def, 0), 0);           // not owned
  assert.equal(rigPower(def, 1), 5);
  assert.equal(rigPower(def, 2), 7);           // floor(5 * 1.5)

  // Cumulative cost grows faster than power at every level. If this ever
  // inverts, a whale can buy infinite hashrate and the economy is over.
  let cost = 0;
  for (let lvl = 0; lvl < def.maxLevel; lvl++) {
    cost += rigUpgradeCost(def, lvl);
    const power = rigPower(def, lvl + 1);
    const costPerPower = cost / power;
    if (lvl > 0) assert.ok(costPerPower > 100, `level ${lvl + 1} got cheaper per H/s`);
  }
});

test("hashrate: boosts stack additively, not multiplicatively", () => {
  const base = {
    base: 10, rigPower: 90, streakDays: 0, streakStepPct: 5, streakCapDays: 20,
    referralHashrate: 0, referralCapPct: 100, maxHashrate: 100_000,
  };
  // flat 100. Two +50% task boosts and one +100% ad boost => x3.0, not x4.5.
  assert.equal(computeHashrate({ ...base, boostPcts: [] }), 100);
  assert.equal(computeHashrate({ ...base, boostPcts: [50, 50, 100] }), 300);
});

test("hashrate: streak maxes out at 2x and stops there", () => {
  const base = {
    base: 100, rigPower: 0, streakStepPct: 5, streakCapDays: 20, boostPcts: [],
    referralHashrate: 0, referralCapPct: 100, maxHashrate: 100_000,
  };
  assert.equal(computeHashrate({ ...base, streakDays: 0 }), 100);
  assert.equal(computeHashrate({ ...base, streakDays: 20 }), 200);
  assert.equal(computeHashrate({ ...base, streakDays: 500 }), 200); // capped
});

test("hashrate: a referral parasite cannot out-earn a real miner", () => {
  // No rigs, no streak, no tasks — living entirely off a huge downline.
  const parasite = computeHashrate({
    base: 10, rigPower: 0, streakDays: 0, streakStepPct: 5, streakCapDays: 20,
    boostPcts: [], referralHashrate: 9_999_999, referralCapPct: 100,
    maxHashrate: 100_000,
  });
  // Capped at 100% of own hashrate => at most double. Signing up a thousand
  // phones buys you 10 extra H/s, not the network.
  assert.equal(parasite, 20);
});

test("hashrate: the per-user cap holds no matter what", () => {
  const monster = computeHashrate({
    base: 1_000_000, rigPower: 1_000_000, streakDays: 20, streakStepPct: 5,
    streakCapDays: 20, boostPcts: [500, 500], referralHashrate: 1_000_000,
    referralCapPct: 100, maxHashrate: 100_000,
  });
  assert.equal(monster, 100_000);
});

test("CONVERSION: a window can never pay out more Points than its pot", () => {
  // The single most important invariant in the codebase. If this fails, we have
  // minted cash-redeemable Points that no revenue backs.
  const pot = 200_000;
  for (const burns of [
    [1000],
    [1000, 1000, 1000],
    [1, 999_999_999],
    [7, 13, 17, 19, 23],
    Array.from({ length: 500 }, (_, i) => i + 1),
  ]) {
    const total = burns.reduce((a, b) => a + b, 0);
    const paid = burns.reduce((a, b) => a + conversionPayout(b, total, pot), 0);
    assert.ok(paid <= pot, `paid ${paid} > pot ${pot} for ${burns.length} burners`);
  }
});

test("CONVERSION: the rate floats — more burners means a smaller share each", () => {
  const pot = 200_000;
  const alone = conversionPayout(1000, 1000, pot);
  const crowded = conversionPayout(1000, 100_000, pot);
  assert.equal(alone, 200_000);
  assert.equal(crowded, 2_000);
  // There is no fixed ROZI->Points rate anywhere, by construction. A fixed rate
  // would be a promise to buy back an asset we mint for free.
});

test("CONVERSION: burning nothing pays nothing", () => {
  assert.equal(conversionPayout(0, 1000, 200_000), 0);
  assert.equal(conversionPayout(100, 0, 200_000), 0);
});

// ---- PI MODEL (founder decision, 2026-07-13) -------------------------------
// The model users actually asked for: your reward comes from YOUR shares, not
// from a slice of a pot that shrinks as the crowd grows.

const FULL_DAY_SECS = D.piReferenceHours * 3600;
const pi = (shares: number, rate: number) =>
  fromMicro(piPayoutMicroFor(shares, rate, D.baseHashrate, FULL_DAY_SECS));

// The same thing in raw MICRO, for the tests where the sub-unit IS the point.
const piMicro = (shares: number, rate: number) =>
  piPayoutMicroFor(shares, rate, D.baseHashrate, FULL_DAY_SECS);

// Shares a baseline miner (no multipliers) books over a full reference day.
const BASELINE_FULL_DAY = D.baseHashrate * FULL_DAY_SECS;

test("PI: a baseline miner mining a full day earns exactly the base rate", () => {
  assert.equal(pi(BASELINE_FULL_DAY, 100), 100);
});

test("PI: multipliers multiply the rate, exactly", () => {
  // hashrate x2 for a full day => twice the shares => twice the ROZI.
  assert.equal(pi(BASELINE_FULL_DAY * 2, 100), 200);
  assert.equal(pi(BASELINE_FULL_DAY * 3, 100), 300);
});

test("PI: mining a third of a day earns a third of the rate", () => {
  // One 8h session out of a 24h reference day. This is the retention loop:
  // come back ~3x a day, or earn proportionally less.
  assert.equal(pi(BASELINE_FULL_DAY / 3, 300), 100);
});

test("PI: NO DILUTION — another miner joining cannot reduce your payout", () => {
  // THE property the whole model exists for. Under the pool model, payoutFor()
  // divides by totalShares, so a second miner halves the first one's reward. Here
  // the second miner is not even an input, so the first one's payout is untouched.
  const alone = pi(BASELINE_FULL_DAY, 100);
  const crowded = pi(BASELINE_FULL_DAY, 100); // 10,000 others changed nothing
  assert.equal(alone, crowded);
  assert.equal(alone, 100);

  // Contrast, so the difference is pinned by a test rather than by a comment:
  // under the pool model the same miner's share collapses as others arrive.
  assert.equal(pool(1000, 1000, 3_000_000), 3_000_000);
  assert.equal(pool(1000, 1_000_000, 3_000_000), 3_000);
});

test("PI: halving is a clean 50% cut to the PERSON, not a 20x collapse", () => {
  // The founder's requirement, verbatim: "halving means halving."
  const before = pi(BASELINE_FULL_DAY, 100);
  const after = pi(BASELINE_FULL_DAY, 50);
  assert.equal(before, 100);
  assert.equal(after, 50);
  assert.equal(after, before / 2);
});

test("PI: a x2 multiplier exactly offsets one halving", () => {
  // Why streaks and referrals matter after a halving: they can hold you level.
  assert.equal(pi(BASELINE_FULL_DAY * 2, 50), pi(BASELINE_FULL_DAY, 100));
});

test("PI: base rate halves once per milestone the population has passed", () => {
  const ms = parseMilestones("10000,50000,250000");
  assert.equal(piBaseRateFor(0, 800, ms), 800);        // no milestone yet
  assert.equal(piBaseRateFor(9_999, 800, ms), 800);
  assert.equal(piBaseRateFor(10_000, 800, ms), 400);   // 1st
  assert.equal(piBaseRateFor(50_000, 800, ms), 200);   // 2nd
  assert.equal(piBaseRateFor(250_000, 800, ms), 100);  // 3rd
  assert.equal(piBaseRateFor(9_999_999, 800, ms), 100); // no more milestones
});

test("PI: milestone list is order-insensitive and drops junk without throwing", () => {
  // An Admin fat-fingering this box must not be able to take settlement down.
  assert.deepEqual(parseMilestones("50000, 10000 ,250000"), [10_000, 50_000, 250_000]);
  assert.deepEqual(parseMilestones("10000,abc,-5,0,50000"), [10_000, 50_000]);
  assert.deepEqual(parseMilestones(""), []);
});

test("PI: the supply cap still holds — payouts scale down when the pool runs dry", () => {
  // The endgame. The pi model's daily total floats, so unlike the pool model it
  // CAN ask for more than the cap has left. It must never get it.
  assert.equal(capScaleFactor(1000, 10_000), 1);   // plenty of room
  assert.equal(capScaleFactor(1000, 1000), 1);     // exactly enough
  assert.equal(capScaleFactor(1000, 250), 0.25);   // only a quarter left
  assert.equal(capScaleFactor(1000, 0), 0);        // pool is spent
  assert.equal(capScaleFactor(0, 0), 1);           // nobody mined; no divide-by-zero

  // Applied: three miners want 400 each (1200) but only 600 is left. Everyone is
  // cut by the same factor — nobody is paid in full while a later row gets zero.
  const wanted = [400, 400, 400];
  const scale = capScaleFactor(1200, 600);
  const paid = wanted.map((w) => Math.floor(w * scale));
  assert.deepEqual(paid, [200, 200, 200]);
  assert.ok(paid.reduce((a, b) => a + b, 0) <= 600);
});

test("PI: flooring keeps the error in the treasury's favour, never the user's", () => {
  // Same invariant the pool model has: dust stays unemitted, so we can never pay
  // out more than we owe. What changed is the SIZE of the dust: the floor is now
  // one micro (0.000001 ROZI) instead of one whole ROZI.
  //
  // Note the thing this test previously got wrong: a miner one SHARE short of a
  // full day is not one micro short of the rate. A share is a hashrate-second,
  // worth ~116 micro at rate 100 — so they honestly earn ~116 micro less. The
  // flooring dust is the separate, tiny gap between the exact owed value and the
  // integer we actually pay, and THAT is what must stay under one micro.
  const shares = BASELINE_FULL_DAY - 1;
  const exactMicro = 100 * ROZI_SCALE * (shares / BASELINE_FULL_DAY);
  const paidMicro = piMicro(shares, 100);

  assert.ok(paidMicro <= exactMicro, "must never pay more than is owed");
  assert.ok(exactMicro - paidMicro < 1, "the dust we keep is under one micro");
  assert.ok(paidMicro < toMicro(100), "a partial day never pays a full day's rate");

  assert.equal(pi(0, 100), 0);
  assert.equal(pi(BASELINE_FULL_DAY, 0), 0);
});

test("PI: THE OLD FAILURE MODE IS FIXED — a low rate still pays a partial day", () => {
  // This test used to assert the OPPOSITE, and it was right to: the ledger held
  // whole ROZI, so a rate of 2/day paid a third-of-a-day miner floor(0.66) = ZERO.
  // The app took eight hours of someone's time and gave them nothing. That is the
  // bug the micro-ROZI migration exists to kill, so the test is inverted rather
  // than deleted — if anyone reintroduces a whole-ROZI floor, this goes red.
  assert.ok(piMicro(BASELINE_FULL_DAY / 3, 2) > 0);
  assert.equal(pi(BASELINE_FULL_DAY / 3, 2), 0.666666); // floored to the millionth

  // The real launch numbers. Base rate 10/day, one 8-hour session out of a 24h
  // reference day => a third of 10.
  assert.equal(pi(BASELINE_FULL_DAY / 3, D.piBaseRate), 3.333333);

  // And it survives all five halvings. 10 -> 5 -> 2.5 -> 1.25 -> 0.625 -> 0.3125.
  // A single 8h session at the FINAL rate still pays a real, non-zero number.
  const finalRate = piBaseRateFor(
    9_999_999, D.piBaseRate, parseMilestones(D.piHalvingUsers));
  assert.equal(finalRate, 0.3125);
  assert.ok(piMicro(BASELINE_FULL_DAY / 3, finalRate) > 0,
    "an 8h session at the fully-halved rate must still pay something");
  assert.equal(pi(BASELINE_FULL_DAY / 3, finalRate), 0.104166);
});

test("PI: the launch rate of 10/day is what the founder asked for", () => {
  // A baseline miner, mining a full reference day, earns exactly 10 ROZI.
  assert.equal(D.piBaseRate, 10);
  assert.equal(pi(BASELINE_FULL_DAY, D.piBaseRate), 10);
  // Scarcity is the product: this is a number a person can hold in their head.
  assert.ok(D.piBaseRate <= 10);
});
