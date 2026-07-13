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
  emissionAt, cappedEmission, computeHashrate, payoutFor,
  rigUpgradeCost, rigPower, rigIsDeflationary, conversionPayout,
  epochOf, epochEndMs, splitByEpoch, MINING_GENESIS_MS,
  MINING_DEFAULTS as D,
} from "../mining/core.ts";

const EMISSION = {
  baseEmission: D.baseEmission,
  halvingEpochs: D.halvingEpochs,
  supplyCap: D.supplyCap,
};

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
  assert.equal(emissionAt(0, EMISSION), 3_000_000);
  assert.equal(emissionAt(99, EMISSION), 3_000_000);
  assert.equal(emissionAt(100, EMISSION), 1_500_000);
  assert.equal(emissionAt(200, EMISSION), 750_000);
  assert.equal(emissionAt(300, EMISSION), 375_000);
});

test("total emission over all time converges under the supply cap", () => {
  // Sum 10,000 epochs (~27 years). The geometric series converges to
  // E0 * halving * 2 = 600M, comfortably under the 650M cap — and the headroom
  // is what absorbs referral overhead without ever breaching the hard limit.
  let total = 0;
  for (let e = 0; e < 10_000; e++) total += emissionAt(e, EMISSION);
  assert.ok(total <= 600_000_000, `emitted ${total} > 600M`);
  assert.ok(total > 599_000_000, `emitted ${total}, expected ~600M`);
  assert.ok(total < EMISSION.supplyCap);
});

test("the supply cap is a hard ceiling even if an Admin fat-fingers the emission", () => {
  const reckless = { ...EMISSION, baseEmission: 999_999_999_999 };
  // Already emitted 649M of the 650M cap: only 1M may be minted, whatever the
  // settings say. This is the last line of defence and it must not depend on the
  // Admin being careful.
  assert.equal(cappedEmission(0, 649_000_000, reckless), 1_000_000);
  assert.equal(cappedEmission(0, 650_000_000, reckless), 0);
  assert.equal(cappedEmission(0, 999_000_000, reckless), 0); // never negative
});

test("a miner's payout is a SHARE of the pot, so the pot can never be exceeded", () => {
  const emission = 3_000_000;
  const shares = [500, 1500, 3000, 17, 999_999];
  const total = shares.reduce((a, b) => a + b, 0);
  const paid = shares.reduce((a, s) => a + payoutFor(s, total, emission), 0);
  assert.ok(paid <= emission, `paid ${paid} > emission ${emission}`);
  // Flooring leaves dust unemitted. The error is always in the treasury's
  // favour — never the other way.
  assert.ok(emission - paid < shares.length);
});

test("no shares mined => nothing is emitted", () => {
  assert.equal(payoutFor(0, 0, 3_000_000), 0);
  assert.equal(payoutFor(100, 0, 3_000_000), 0);
});

test("adding miners dilutes everyone — difficulty self-adjusts", () => {
  const solo = payoutFor(1000, 1000, 3_000_000);
  const crowded = payoutFor(1000, 1_000_000, 3_000_000);
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
