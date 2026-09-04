// Unit tests for the spend ceiling on paid external calls (costGuard.ts).
//
// Pure unit test: costGuard.ts imports only config.ts, which opens no database
// connection — the same reason flagsCore.ts and mining/core.ts were split out
// of their bigger siblings (see mining/core.ts's header for the node:test hang
// a stray connection causes).
//
// WHAT THESE ARE ACTUALLY PROTECTING. This file exists because two real billing
// incidents on this project had the same shape: a loop polled a paid provider
// at a rate set by code rather than by demand, and it was found by looking at a
// bill. The properties below are the ones that make a ceiling a ceiling — that
// it counts, that it refuses, that refusing the cheap work does not also refuse
// a payout, and that the window actually rolls instead of counting forever.
//
//   npm run test:costguard
import { strict as assert } from "node:assert";
import test, { beforeEach } from "node:test";
import { config, num } from "../config.ts";
import { charge, usage, __resetForTests } from "../costGuard.ts";

const withLimit = (n: number, fn: () => void) => {
  const before = config.rpcMaxCallsPerHour;
  (config as { rpcMaxCallsPerHour: number }).rpcMaxCallsPerHour = n;
  try { fn(); } finally {
    (config as { rpcMaxCallsPerHour: number }).rpcMaxCallsPerHour = before;
  }
};

beforeEach(() => __resetForTests());

test("calls under the ceiling are allowed and counted", () => {
  withLimit(100, () => {
    for (let i = 0; i < 10; i++) assert.equal(charge("rpc", 1, "low"), true);
    assert.equal(usage().rpc.used, 10);
    assert.equal(usage().rpc.refusedLow, 0);
  });
});

test("low priority is cut off at the SOFT ceiling, leaving headroom for money paths", () => {
  // The whole point of two tiers. A scanner filling the budget must not be able
  // to stop the relay confirming a transaction it has already broadcast, or a
  // cost control becomes an outage.
  withLimit(100, () => {
    const soft = usage().rpc.softCeiling;
    assert.equal(soft, 80);
    for (let i = 0; i < soft; i++) assert.equal(charge("rpc", 1, "low"), true);

    assert.equal(charge("rpc", 1, "low"), false, "low priority should be refused at the soft ceiling");
    assert.equal(charge("rpc", 1, "high"), true, "high priority must still have room");
    assert.equal(usage().rpc.refusedLow, 1);
    assert.equal(usage().rpc.refusedHigh, 0);
  });
});

test("high priority is still bounded — the reserve is headroom, not an exemption", () => {
  withLimit(100, () => {
    for (let i = 0; i < 100; i++) charge("rpc", 1, "high");
    assert.equal(charge("rpc", 1, "high"), false, "even the money tier has a ceiling");
    assert.equal(usage().rpc.refusedHigh, 1);
  });
});

test("a batch that would cross the ceiling is refused WHOLE, never part-spent", () => {
  // reconcile.ts charges one estimate for a whole tick. Letting a batch through
  // partially would spend right up to the line and still not complete the work
  // it paid for.
  withLimit(100, () => {
    assert.equal(charge("rpc", 70, "low"), true);
    assert.equal(charge("rpc", 20, "low"), false, "70 + 20 crosses the soft ceiling of 80");
    assert.equal(usage().rpc.used, 70, "the refused batch must not have been counted");
  });
});

test("limit 0 means no ceiling — the deliberate escape hatch", () => {
  withLimit(0, () => {
    for (let i = 0; i < 50_000; i++) assert.equal(charge("rpc", 1, "low"), true);
    assert.equal(usage().rpc.refusedLow, 0);
  });
});

test("the window ROLLS — an hour of quiet restores the whole budget", () => {
  // A counter that only ever went up would refuse everything forever after one
  // bad hour, which is an outage with extra steps rather than a cost control.
  withLimit(100, () => {
    for (let i = 0; i < 80; i++) charge("rpc", 1, "low");
    assert.equal(charge("rpc", 1, "low"), false);

    // 60 one-minute buckets: advancing past all of them must age every one out.
    // Done with a fake clock rather than by waiting an hour, obviously.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 61 * 60_000;
      assert.equal(usage().rpc.used, 0, "an hour later, nothing in the window");
      assert.equal(charge("rpc", 1, "low"), true);
    } finally {
      Date.now = realNow;
    }
  });
});

test("an EMPTY env var falls back to the default, it does not disable the ceiling", () => {
  // ⚠️ THE CASE THAT ACTUALLY HAPPENS. `Number("")` is 0 — finite, so a NaN
  // guard alone waves it straight through, and 0 means "no ceiling". On Railway,
  // CLEARING a variable's value rather than deleting the variable is a routine
  // action and leaves exactly this. The same slip on DEPOSIT_SCAN_INTERVAL_MS,
  // which is set to 90000 live because of a past billing incident, would drop it
  // to the floor. Found in review before this shipped.
  assert.equal(num("", 5_000), 5_000);
  assert.equal(num("   ", 5_000), 5_000);
  assert.equal(num("\n", 5_000), 5_000);
  assert.equal(num(undefined, 5_000), 5_000);
  assert.equal(num("abc", 5_000), 5_000);
  // ...while an explicit 0 still means what it is documented to mean.
  assert.equal(num("0", 5_000), 0);
  assert.equal(num("250", 5_000), 250);
  // And a floor really floors, so an interval can never become a busy loop.
  assert.equal(num("0", 20_000, 5_000), 5_000);
});

test("a disabled ceiling reports as disabled, not as a breach", () => {
  // `{used: 12000, limit: 0, softCeiling: 0}` reads as a catastrophic overrun on
  // the one screen built to answer "did the ceiling bite" — when in fact there
  // is no ceiling at all.
  withLimit(0, () => {
    charge("rpc", 12_000, "low");
    const u = usage().rpc;
    assert.equal(u.enabled, false);
    assert.equal(u.softCeiling, null);
    assert.equal(u.refusedLow, 0, "nothing was refused, because nothing was limited");
  });
  withLimit(100, () => {
    const u = usage().rpc;
    assert.equal(u.enabled, true);
    assert.equal(u.softCeiling, 80);
  });
});

test("a tiny limit rations low priority rather than refusing it outright", () => {
  // Math.floor(1 * 0.8) is 0, which would refuse every low-priority call at zero
  // usage. "1 means nothing works" is a bad answer to a number someone chose.
  withLimit(1, () => {
    assert.equal(usage().rpc.softCeiling, 1);
    assert.equal(charge("rpc", 1, "low"), true);
    assert.equal(charge("rpc", 1, "low"), false);
  });
});

test("the two meters are independent — RPC and the explorer have separate allowances", () => {
  // They bill separately and run out separately; one exhausting the other would
  // take out a screen for a reason that has nothing to do with it.
  withLimit(10, () => {
    for (let i = 0; i < 8; i++) charge("rpc", 1, "low");
    assert.equal(charge("rpc", 1, "low"), false);
    assert.equal(charge("explorer", 1, "low"), true, "the explorer budget is its own");
  });
});
