// Unit tests for the feature-flag registry (brief part 44).
//
// Pure unit test: flagsCore.ts imports nothing that opens a database connection,
// which is exactly why the registry was split out of flags.ts. (See
// mining/core.ts's header for the node:test hang a stray connection causes.)
//
// The tests here are all about the two rules in flagsCore.ts's own header —
// a flag delegates to the switch that already exists, and a flag must do
// something. Both are properties a reviewer would otherwise have to check by
// hand every time someone adds a row.
//
//   npm run test:flags
import { strict as assert } from "node:assert";
import test from "node:test";
import { FLAGS, FLAG_IDS, isFlagId } from "../flagsCore.ts";

test("no two flags write to the same place", () => {
  // The failure this catches: someone adds a "USDT deposits" flag with its own
  // `flag.` row while `usdt_deposits` already delegates to the mining setting.
  // Two switches for one feature, disagreeing, and no way to tell from the
  // panel which one is actually stopping the thing.
  const seen = new Map<string, string>();
  for (const id of FLAG_IDS) {
    const s = FLAGS[id].store;
    const where =
      s.kind === "mining" ? `mining.${s.key}` :
      s.kind === "setting" ? `setting.${s.key}` :
      `flag.${id}`;
    const other = seen.get(where);
    assert.equal(other, undefined, `${id} and ${other} both write to ${where}`);
    seen.set(where, id);
  }
});

test("the five pre-existing switches still delegate to their original key", () => {
  // These features had a working, tested switch before flags existed. If one of
  // them ever turns into `{ kind: "flag" }`, the panel silently stops driving
  // the switch the enforcement point actually reads — the flag would toggle
  // happily and change nothing.
  assert.deepEqual(FLAGS.rozi_transfers.store, { kind: "mining", key: "transfersEnabled" });
  assert.deepEqual(FLAGS.usdt_deposits.store, { kind: "mining", key: "usdtTopupEnabled" });
  assert.deepEqual(FLAGS.advertisements.store, { kind: "mining", key: "adsEnabled" });
  assert.deepEqual(FLAGS.rozi_conversion.store, { kind: "mining", key: "conversionEnabled" });
  assert.deepEqual(FLAGS.kyc.store, { kind: "setting", key: "kyc_enabled" });
});

test("every flag says what it does and where it is enforced", () => {
  // `enforcedAt` is not decoration. A flag whose enforcement point is empty is
  // a switch that reads back what you set and changes nothing — which is worse
  // than no switch, because it will be trusted during an incident.
  for (const id of FLAG_IDS) {
    const f = FLAGS[id];
    assert.ok(f.label.length > 0, `${id} has no label`);
    assert.ok(f.effect.length > 10, `${id} does not say what turning it off does`);
    assert.ok(f.enforcedAt.length > 0, `${id} names no enforcement point`);
  }
});

test("only the flag that genuinely cannot be enforced is marked display-only", () => {
  // A BNB deposit is someone sending to an address on a public chain. Nothing
  // we deploy stops that; we can only stop advertising the address. Every OTHER
  // flag has a route that refuses, and marking one display-only is how a real
  // switch quietly becomes a decorative one.
  const displayOnly = FLAG_IDS.filter((id) => FLAGS[id].displayOnly);
  assert.deepEqual(displayOnly, ["bnb_deposits"]);
});

test("the brief's fourteen features are all present", () => {
  // Part 44 lists these by name. Missing one means a feature nobody can switch
  // off in an incident.
  for (const id of [
    "rozi_transfers", "usdt_deposits", "usdt_withdrawals",
    "bnb_deposits", "bnb_withdrawals",
    "mining", "machines", "tasks", "surveys", "advertisements",
    "referrals", "kyc", "telegram", "leaderboard",
  ]) {
    assert.ok(isFlagId(id), `${id} is not a known flag`);
  }
});

test("the KYC flag's copy does not claim to make anything safer", () => {
  // The one genuinely confusing switch on the screen: OFF WAIVES the ID check,
  // so it makes withdrawals, refunds and transfers EASIER, not safer. Somebody
  // reaching for a kill switch in an incident must not flip this one by mistake.
  const effect = FLAGS.kyc.effect.toLowerCase();
  assert.ok(effect.includes("waives"), "the KYC flag must say it WAIVES the check");
  assert.ok(effect.includes("not a kill switch"));
});

test("isFlagId fails closed", () => {
  // The PATCH route runs this on a path parameter before writing a setting.
  assert.ok(isFlagId("mining"));
  assert.ok(!isFlagId("Mining"));
  assert.ok(!isFlagId("../kyc_enabled"));
  assert.ok(!isFlagId(""));
  assert.ok(!isFlagId(null));
  assert.ok(!isFlagId(42));
});

test("a flag id is safe to use as a settings key", () => {
  // `flag.${id}` becomes an app_settings key. Restricting the shape means a new
  // flag can never collide with, or shadow, an existing key like
  // `mining.piBaseRate` or `treasury_address_bep20`.
  for (const id of FLAG_IDS) {
    assert.match(id, /^[a-z][a-z0-9_]*$/, `${id} is not a safe settings key fragment`);
  }
});
