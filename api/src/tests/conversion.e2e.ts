// E2E for the per-user conversion ceiling (MINING_SPEC.md § 6, founder 2026-07-29).
//
// The unit tests prove the arithmetic of conversionAllowanceMicro(). This proves
// the thing the arithmetic cannot: that the ROUTE actually enforces it, against
// a real ledger, through real HTTP.
//
// The cases that matter are the bypasses, not the happy path:
//   • splitting one big burn into many small ones
//   • being SENT ROZI by other accounts and trying to convert that
//   • two burns racing each other past the same ceiling
//
//   npm run test:conversion
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import {
  initDb, sql, now, newId, postRozi, roziBalanceMicroOf,
} from "../db.ts";
import { config } from "../config.ts";
import { miningRoutes } from "../routes/mining.ts";
import { setMiningSetting } from "../mining/settings.ts";
import { toMicro, fromMicro } from "../mining/core.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(miningRoutes);

const mkUser = async (label: string) => {
  const id = newId();
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at) VALUES (?,?,1,'Pakistan',?,'active',?)",
    id, `${label}-${id}@t.test`, id.slice(0, 8).toUpperCase(), now(),
  );
  return id;
};
const auth = (userId: string) => ({
  authorization: `Bearer ${jwt.sign({ sub: userId }, config.jwtSecret)}`,
});
const getConv = (userId: string) =>
  app.inject({ method: "GET", url: "/mining/conversion", headers: auth(userId) });
const burn = (userId: string, rozi: number) => app.inject({
  method: "POST", url: "/mining/conversion/burn", headers: auth(userId), payload: { rozi },
});

// MINED ROZI is the denominator of the ceiling, so it has to be posted with the
// real source_type — an admin_adjustment credit would not count and the whole
// test would be measuring nothing.
const mine = (userId: string, rozi: number) => postRozi({
  userId, micro: toMicro(rozi), direction: "credit",
  sourceType: "mining", sourceRefId: "conv-e2e", note: "mined",
});
const roziOf = async (userId: string) => fromMicro(await roziBalanceMicroOf(userId));

// PGlite persists between runs. Close any window left open by a previous run,
// or "a window is already open" would make every burn below fail for the wrong
// reason.
await sql.run("UPDATE conversion_windows SET status = 'settled' WHERE status = 'open'");
await setMiningSetting("conversionEnabled", 1);
await setMiningSetting("conversionMaxPctOfMined", 30);

const openWindow = async (potPoints: number) => {
  const id = newId();
  await sql.run(
    `INSERT INTO conversion_windows (id, pot_points, opens_at, closes_at, status)
     VALUES (?,?,?,?, 'open')`,
    id, potPoints, now(), new Date(Date.now() + 3_600_000).toISOString(),
  );
  return id;
};
const winId = await openWindow(500_000);

console.log("\n-- the ceiling is a percentage of what you MINED --");

const amina = await mkUser("amina");
await mine(amina, 1000);

let res = await getConv(amina);
let body = res.json();
check("the window is open and reported", res.statusCode === 200 && body.open === true);
check("allowance is 30% of mined", fromMicro(body.allowanceMicro) === 300,
  `got ${fromMicro(body.allowanceMicro)}`);
check("the ceiling percentage is reported for the copy", body.maxPctOfMined === 30);
check("nothing converted yet", fromMicro(body.convertedMicro) === 0);

res = await burn(amina, 100);
check("a burn inside the ceiling succeeds", res.statusCode === 200, res.body);
body = (await getConv(amina)).json();
check("the allowance drops by what was burned", fromMicro(body.allowanceMicro) === 200,
  `got ${fromMicro(body.allowanceMicro)}`);
check("ROZI actually left the ledger", (await roziOf(amina)) === 900,
  `got ${await roziOf(amina)}`);

res = await burn(amina, 500);
check("a burn OVER the ceiling is refused", res.statusCode === 400, res.body);
check("the refusal says how much is left", String(res.json().error).includes("200"),
  res.json().error);
check("the refused burn took nothing", (await roziOf(amina)) === 900, `got ${await roziOf(amina)}`);

console.log("\n-- splitting a burn cannot get past the ceiling --");

// The bypass a balance-based ceiling would allow: burn the max, then burn the
// max of what is left, forever. Twenty attempts against a 300 ceiling.
const bilal = await mkUser("bilal");
await mine(bilal, 1000);
let accepted = 0;
for (let i = 0; i < 20; i++) {
  const r = await burn(bilal, 50);
  if (r.statusCode === 200) accepted++;
}
check("exactly the ceiling got through, no more", accepted === 6, `accepted ${accepted} x 50`);
check("total converted equals the ceiling exactly", (await roziOf(bilal)) === 700,
  `balance ${await roziOf(bilal)}`);

console.log("\n-- ROZI received from other accounts cannot be converted --");

// THE anti-farm property. A mule wallet that mined almost nothing is sent a
// fortune by fifty other accounts; its allowance must not move.
const mule = await mkUser("mule");
await mine(mule, 10);
await postRozi({
  userId: mule, micro: toMicro(10_000), direction: "credit",
  sourceType: "transfer_in", sourceRefId: "conv-e2e", note: "sent by a farm",
});
body = (await getConv(mule)).json();
check("the mule holds a fortune", (await roziOf(mule)) === 10_010, `got ${await roziOf(mule)}`);
check("but its allowance is only 30% of the 10 it MINED",
  fromMicro(body.allowanceMicro) === 3, `got ${fromMicro(body.allowanceMicro)}`);
res = await burn(mule, 100);
check("converting the received ROZI is refused", res.statusCode === 400, res.body);
res = await burn(mule, 3);
check("converting its own mined share still works", res.statusCode === 200, res.body);

console.log("\n-- concurrent burns cannot both slip past the same ceiling --");

// Check-then-act is the bug class this whole codebase locks against. Fire ten
// burns at once, each of which would individually fit; only the ceiling's worth
// may land.
const chaos = await mkUser("chaos");
await mine(chaos, 1000); // ceiling = 300
const results = await Promise.all(Array.from({ length: 10 }, () => burn(chaos, 50)));
const ok = results.filter((r) => r.statusCode === 200).length;
check("only the ceiling's worth of concurrent burns succeeded", ok === 6,
  `${ok} of 10 x 50 succeeded against a 300 ceiling`);
check("the ledger agrees — never converted past the cap", (await roziOf(chaos)) === 700,
  `balance ${await roziOf(chaos)}`);

console.log("\n-- the admin can turn the ceiling off, and back on --");

await setMiningSetting("conversionMaxPctOfMined", 100);
const sana = await mkUser("sana");
await mine(sana, 100);
body = (await getConv(sana)).json();
check("at 100% the whole mined amount is convertible",
  fromMicro(body.allowanceMicro) === 100, `got ${fromMicro(body.allowanceMicro)}`);
res = await burn(sana, 100);
check("and it can all be burned", res.statusCode === 200, res.body);

// Lowering the cap below what someone already converted must not produce a
// negative allowance — a negative would compare as "less than the burn" and
// silently let them through.
await setMiningSetting("conversionMaxPctOfMined", 10);
body = (await getConv(sana)).json();
check("lowering the cap below what was already converted floors at zero",
  body.allowanceMicro === 0, `got ${body.allowanceMicro}`);
res = await burn(sana, 1);
check("and nothing more can be converted", res.statusCode === 400, res.body);

console.log("\n-- with conversion switched off, nothing converts --");

await setMiningSetting("conversionEnabled", 0);
const zara = await mkUser("zara");
await mine(zara, 1000);
body = (await getConv(zara)).json();
check("the screen reports it as closed", body.open === false && body.enabled === false);
check("but still tells the user what they have unlocked",
  fromMicro(body.allowanceMicro) === 100, `got ${fromMicro(body.allowanceMicro)}`);
res = await burn(zara, 1);
check("burning is refused outright", res.statusCode === 400, res.body);

// Leave the settings as they ship: conversion OFF, ceiling at the default.
await setMiningSetting("conversionEnabled", 0);
await setMiningSetting("conversionMaxPctOfMined", 30);
await sql.run("UPDATE conversion_windows SET status = 'settled' WHERE id = ?", winId);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
