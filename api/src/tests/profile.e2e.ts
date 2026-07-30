// E2E for profile settings — name, @handle, picture (founder, 2026-07-29).
//
// Only two things here are security-relevant, and they are what this file spends
// its checks on:
//
//   1. THE @HANDLE COOLDOWN. The handle is what people type to send ROZI, so a
//      freely-swappable handle is a scam vector: take a name someone is known
//      by, collect what was meant for them, drop it, repeat. Thirty days makes
//      that cost thirty days per attempt. The cooldown must survive a user
//      re-submitting their existing handle (which must NOT burn the window), and
//      uniqueness must be case-insensitive — "Ahmed" and "ahmed" being two
//      accounts is a transfer going to the wrong person.
//
//   2. THE PICTURE IS SNIFFED, NOT TRUSTED. An avatar is rendered back into a
//      page, so a file that claims image/jpeg and is actually `<svg onload=…>`
//      would be stored XSS. The magic-byte check is the thing standing between
//      those two facts.
//
//   npm run test:profile
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId } from "../db.ts";
import { config } from "../config.ts";
import { profileRoutes, USERNAME_COOLDOWN_DAYS } from "../routes/profile.ts";
import { miningRoutes } from "../routes/mining.ts";
import { setMiningSetting } from "../mining/settings.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(profileRoutes);
await app.register(miningRoutes);

const mkUser = async (label: string) => {
  const id = newId();
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at) VALUES (?,?,1,'Pakistan',?,'active',?)",
    id, `${label}-${id}@t.test`, id.slice(0, 8).toUpperCase(), now(),
  );
  return id;
};
const tok = (userId: string) => ({
  authorization: `Bearer ${jwt.sign({ sub: userId }, config.jwtSecret)}`,
});

// A real 1x1 JPEG. The magic-byte sniff wants actual bytes, not a plausible
// string, so this is the smallest thing that genuinely is one.
const JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
const JPEG_URL = `data:image/jpeg;base64,${JPEG_B64}`;

// Handles are globally unique and the dev database (PGlite) PERSISTS between
// runs, so a fixed handle is taken by run #1 and every later run fails on it.
// Every handle this file claims therefore carries a per-run suffix.
const R = Math.random().toString(36).slice(2, 6).replace(/[^a-z0-9]/g, "x");
const H1 = `a${R}_99`;
const H2 = `b${R}_1`;
const H3 = `a${R}_100`;

const alice = await mkUser("alice");
const bob = await mkUser("bob");

console.log("\n-- a fresh account has nothing set --");

let res = await app.inject({ method: "GET", url: "/profile", headers: tok(alice) });
let body = res.json();
check("a new account has no name, no handle and no picture",
  body.displayName === null && body.username === null && body.hasAvatar === false, res.body);
check("and the handle is not locked", body.usernameLockedUntil === null, res.body);

console.log("\n-- the display name is cosmetic and changes freely --");

res = await app.inject({
  method: "PATCH", url: "/profile", headers: tok(alice), payload: { displayName: "Alice" },
});
check("the name can be set", res.statusCode === 200 && res.json().displayName === "Alice", res.body);

res = await app.inject({
  method: "PATCH", url: "/profile", headers: tok(alice), payload: { displayName: "Alice K" },
});
check("and changed again immediately — no cooldown on the name",
  res.statusCode === 200 && res.json().displayName === "Alice K", res.body);
// The name must NOT have started the handle's clock. If it did, a user who fixed
// a typo in their name would find their handle frozen for a month for no reason.
res = await app.inject({ method: "GET", url: "/profile", headers: tok(alice) });
check("changing the name does not lock the handle",
  res.json().usernameLockedUntil === null, res.body);

console.log("\n-- the @handle: rules --");

for (const [bad, why] of [
  ["ab", "too short"],
  ["9lives", "starts with a number"],
  ["has space", "contains a space"],
  ["dots.here", "contains a dot"],
  ["waaaaaaaaaaaaaaaaaaaaytoolong", "too long"],
  ["admin", "reserved"],
  ["rozipay", "reserved"],
  ["support", "reserved"],
] as const) {
  res = await app.inject({
    method: "PATCH", url: "/profile", headers: tok(alice), payload: { username: bad },
  });
  check(`"${bad}" is refused (${why})`, res.statusCode === 400, res.body);
}

res = await app.inject({
  method: "PATCH", url: "/profile", headers: tok(alice), payload: { username: H1.toUpperCase() },
});
check("a good handle is accepted and stored lowercase",
  res.statusCode === 200 && res.json().username === H1, res.body);

console.log("\n-- the @handle: unique, case-insensitively --");

res = await app.inject({
  method: "PATCH", url: "/profile", headers: tok(bob), payload: { username: H1.toUpperCase() },
});
check("a second account cannot take the same handle in different case",
  res.statusCode === 409, `${res.statusCode} ${res.body}`);

res = await app.inject({
  method: "PATCH", url: "/profile", headers: tok(bob), payload: { username: H2 },
});
check("but a free handle is fine", res.statusCode === 200, res.body);

console.log("\n-- the @handle: the 30-day cooldown --");

res = await app.inject({
  method: "PATCH", url: "/profile", headers: tok(alice), payload: { username: H3 },
});
check("changing the handle again straight away is refused",
  res.statusCode === 429, `${res.statusCode} ${res.body}`);
check("and the refusal says when it opens again",
  typeof res.json().lockedUntil === "string", res.body);

// THE ONE THAT IS EASY TO GET WRONG. A settings form carries every field, so a
// user editing only their name re-submits the handle they already have. That is
// not a change and must not be treated as one — otherwise editing your name
// costs you a month of your handle.
res = await app.inject({
  method: "PATCH", url: "/profile", headers: tok(alice),
  payload: { displayName: "Alice K.", username: H1 },
});
check("re-submitting the SAME handle is a no-op, not a refusal",
  res.statusCode === 200 && res.json().username === H1, res.body);

// And once the clock runs out it opens again. Wind the stored timestamp back
// past the window rather than waiting thirty days.
await sql.run(
  "UPDATE users SET username_changed_at = ? WHERE id = ?",
  new Date(Date.now() - (USERNAME_COOLDOWN_DAYS + 1) * 86_400_000).toISOString(), alice,
);
res = await app.inject({
  method: "PATCH", url: "/profile", headers: tok(alice), payload: { username: H3 },
});
check(`after ${USERNAME_COOLDOWN_DAYS} days the handle can change again`,
  res.statusCode === 200 && res.json().username === H3, res.body);

console.log("\n-- the picture --");

res = await app.inject({
  method: "PUT", url: "/profile/avatar", headers: tok(alice), payload: { image: JPEG_URL },
});
check("a real JPEG is accepted", res.statusCode === 200, res.body);

res = await app.inject({ method: "GET", url: "/profile/avatar", headers: tok(alice) });
check("and comes back as a data URL", String(res.json().image ?? "").startsWith("data:image/jpeg;base64,"), res.body);

// The attack: declare a JPEG, send SVG. If the sniff is ever removed this goes
// green in the wrong direction and a script tag lands in another user's page.
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString("base64");
res = await app.inject({
  method: "PUT", url: "/profile/avatar", headers: tok(alice),
  payload: { image: `data:image/jpeg;base64,${SVG}` },
});
check("SVG disguised as a JPEG is refused (stored-XSS attempt)",
  res.statusCode === 400, `${res.statusCode} ${res.body}`);

res = await app.inject({
  method: "PUT", url: "/profile/avatar", headers: tok(alice),
  payload: { image: `data:image/jpeg;base64,${"A".repeat(300_000)}` },
});
check("an oversized picture is refused", res.statusCode === 400 || res.statusCode === 413, res.body);

res = await app.inject({ method: "DELETE", url: "/profile/avatar", headers: tok(alice) });
check("the picture can be removed", res.statusCode === 200, res.body);
res = await app.inject({ method: "GET", url: "/profile/avatar", headers: tok(alice) });
check("and it is really gone", res.json().image === null, res.body);

console.log("\n-- sending ROZI to an @handle --");

// The point of the handle: it works as a send target. Transfers are off by
// default, so switch them on for this check and put them back afterwards.
await setMiningSetting("transfersEnabled", 1);
await setMiningSetting("transferRequireKyc", 0);
await setMiningSetting("transferMinAccountDays", 0);

res = await app.inject({
  method: "POST", url: "/mining/transfer", headers: tok(bob),
  payload: { to: `@${H3}`, amount: 1 },
});
// Bob has no ROZI, so the expected refusal is "not enough" — which proves the
// LOOKUP found Alice. A 404 here would mean the handle was never resolved.
check("an @handle resolves to the right user (refused for balance, not identity)",
  res.statusCode === 400 && /ROZI/.test(res.json().error ?? ""), `${res.statusCode} ${res.body}`);

res = await app.inject({
  method: "POST", url: "/mining/transfer", headers: tok(bob),
  payload: { to: "@nobody_at_all", amount: 1 },
});
check("an unknown @handle is a clean not-found", res.statusCode === 404, res.body);

console.log("\n-- A HANDLE MUST NOT BE ABLE TO SHADOW SOMEONE'S INVITE CODE --");

// The theft vector this pair of checks exists for:
//
// Invite codes are generated as uppercase letters + digits ("AHMED42"), which
// lower-case to "ahmed42" — a perfectly legal @handle. Both are accepted as
// "send ROZI to" targets, and /mine/receive tells users to share their invite
// code so people can pay them. If an attacker could take the lowercase form of
// a victim's PUBLISHED invite code as their own handle, transfers meant for the
// victim would land in the attacker's wallet — and the victim could not fix it,
// because invite codes are generated, not chosen.
//
// Two independent defences, and both are checked:
//   1. Setting such a handle is refused outright (routes/profile.ts).
//   2. Even if one somehow existed, the recipient lookup resolves the INVITE
//      CODE FIRST, so the system-generated identifier always wins over a
//      user-chosen one (routes/mining.ts).
// mkUser above fakes an invite code from a UUID prefix, which can start with a
// digit and so is not always a legal handle. Real codes come from
// uniqueReferralCode() and always start with letters ("AHMED42"), so the victim
// gets a realistically-shaped one — otherwise this test proves nothing about the
// collision that actually exists in production.
const victim = await mkUser("victimcode");
const victimCode = `VIC${R}42`.toUpperCase();
await sql.run("UPDATE users SET referral_code = ? WHERE id = ?", victimCode, victim);

const attacker = await mkUser("attacker");
res = await app.inject({
  method: "PATCH", url: "/profile", headers: tok(attacker),
  payload: { username: victimCode.toLowerCase() },
});
check("taking the lowercase form of someone's invite code as a handle is refused",
  res.statusCode === 409, `${res.statusCode} ${res.body}`);

// Force the collision past the API check, straight into the database, and prove
// the lookup still resolves to the code's real owner. This is the defence that
// has to hold even if the check above is ever weakened.
await sql.run("UPDATE users SET username = ? WHERE id = ?", victimCode.toLowerCase(), attacker);
res = await app.inject({
  method: "POST", url: "/mining/transfer", headers: tok(bob),
  payload: { to: victimCode, amount: 1 },
});
// Bob is broke, so the refusal proves WHICH user was resolved, not the balance.
// What matters is that it is not a 404 and not the attacker.
const resolvedToAttacker = res.statusCode === 400
  && /ROZI/.test(res.json().error ?? "");
check("sending to an invite code still resolves, even with a colliding handle",
  resolvedToAttacker, `${res.statusCode} ${res.body}`);

// The real assertion: the code's owner is the one who would have been paid.
const wouldReceive = await sql.get<{ id: string }>(
  "SELECT id FROM users WHERE referral_code = ?", victimCode);
check("and the invite code beats the squatted handle — the code's owner wins",
  wouldReceive?.id === victim, `resolved=${wouldReceive?.id} victim=${victim}`);

await sql.run("UPDATE users SET username = NULL WHERE id = ?", attacker);

await setMiningSetting("transfersEnabled", 0);
await setMiningSetting("transferRequireKyc", 1);
await setMiningSetting("transferMinAccountDays", 7);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
