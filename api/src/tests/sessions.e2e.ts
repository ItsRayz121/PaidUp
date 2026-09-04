// E2E for session revocation — audit finding A-03.
//
// WHY THIS FILE EXISTS
// --------------------
// A bearer token here is a stateless 30-day JWT. Verifying it proves a
// statement about the PAST — that we issued this, once — and says nothing about
// whether the session should still exist. The audit signed a token, reset the
// account's password, and got HTTP 200 from /auth/me with the OLD token. So the
// one action a worried user can take on their own did not actually take their
// account back: whoever held the stolen token kept it, for up to a month.
//
// The fix is one integer. `users.session_epoch` is stamped into every token as
// `se`, and every authenticated request compares the two. Bumping the column
// invalidates every token that account has ever been issued.
//
// THE PROPERTY THAT MATTERS MOST HERE IS THE BORING ONE: deploying this must
// not sign anybody out. Tokens already in the wild carry no `se` claim at all,
// and the whole rest of this repository's test suite signs exactly that shape
// of token — so "a token with no epoch claim still works" is not a nicety, it
// is the compatibility contract, and it is checked first.
//
//   npm run test:sessions
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId } from "../db.ts";
import { config } from "../config.ts";
import { authRoutes, revokeSessions } from "../auth.ts";
import { appRoutes } from "../routes/app.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(authRoutes);
await app.register(appRoutes);

const mkUser = async (label: string) => {
  const id = newId();
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at) VALUES (?,?,1,'Pakistan',?,'active',?)",
    id, `${label}-${id}@t.test`, id.slice(0, 8).toUpperCase(), now(),
  );
  return id;
};
// Same hashing auth.ts uses for a stored code (pepper + sha256).
const hashCode = (c: string) => createHash("sha256").update(`${c}:${config.otpPepper}`).digest("hex");
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
// A token as every OTHER suite in this repo mints one: no `se` claim at all.
const legacyToken = (userId: string) => jwt.sign({ sub: userId }, config.jwtSecret);
const tokenAt = (userId: string, se: number) => jwt.sign({ sub: userId, se }, config.jwtSecret);
const epochOf = async (userId: string) => Number((await sql.get<{ session_epoch: number }>(
  "SELECT session_epoch FROM users WHERE id = ?", userId))?.session_epoch ?? -1);

const user = await mkUser("session");

console.log("\n-- the compatibility contract: nobody is signed out by the migration --");
{
  check("a brand-new account starts at epoch 0", await epochOf(user) === 0);
  const me = await app.inject({ method: "GET", url: "/auth/me", headers: bearer(legacyToken(user)) });
  check("a token with NO epoch claim is still accepted", me.statusCode === 200);
  const guarded = await app.inject({ method: "GET", url: "/wallet/balance", headers: bearer(legacyToken(user)) });
  check("...and still passes a guarded earner route", guarded.statusCode === 200, `got ${guarded.statusCode}`);
}

console.log("\n-- revoking ends every token the account has --");
{
  const before = legacyToken(user);
  await revokeSessions(user);
  check("the epoch advanced", await epochOf(user) === 1);

  const me = await app.inject({ method: "GET", url: "/auth/me", headers: bearer(before) });
  check("/auth/me refuses the old token (401)", me.statusCode === 401);

  const guarded = await app.inject({ method: "GET", url: "/wallet/balance", headers: bearer(before) });
  check("a guarded earner route refuses it too (401)", guarded.statusCode === 401);

  const fresh = await app.inject({ method: "GET", url: "/auth/me", headers: bearer(tokenAt(user, 1)) });
  check("a token minted at the NEW epoch works", fresh.statusCode === 200);
}

console.log("\n-- /auth/me must agree with every other route, or the client is stranded --");
{
  // The web client decides a token is really dead by asking /auth/me (lib/api.ts
  // confirms a 401 there before clearing the session). If /auth/me kept
  // accepting a revoked token while every other route refused it, the user would
  // sit in an app where nothing worked and nothing signed them out.
  const stale = tokenAt(user, 0);
  const me = await app.inject({ method: "GET", url: "/auth/me", headers: bearer(stale) });
  const other = await app.inject({ method: "GET", url: "/wallet/balance", headers: bearer(stale) });
  check("both refuse the same stale token", me.statusCode === 401 && other.statusCode === 401,
    `me=${me.statusCode} other=${other.statusCode}`);
}

console.log("\n-- sign out everywhere keeps THIS device signed in --");
{
  const current = tokenAt(user, await epochOf(user));
  const res = await app.inject({ method: "POST", url: "/auth/logout-all", headers: bearer(current) });
  check("logout-all succeeds", res.statusCode === 200, `got ${res.statusCode} ${res.body}`);
  const body = res.json() as { token?: string };
  check("it returns a replacement token", typeof body.token === "string" && body.token.length > 0);

  const oldNow = await app.inject({ method: "GET", url: "/auth/me", headers: bearer(current) });
  check("the token used to call it is now dead", oldNow.statusCode === 401);

  const withNew = await app.inject({ method: "GET", url: "/auth/me", headers: bearer(body.token as string) });
  check("the replacement works immediately", withNew.statusCode === 200);
}

console.log("\n-- suspending an account blocks it, and says WHY (403, not 401) --");
{
  // SUSPENDING DELIBERATELY DOES NOT REVOKE, AND THIS IS THE TEST THAT PINS IT.
  // An earlier version of this change bumped the epoch on suspend. Because the
  // epoch is compared BEFORE the status check, that turned the 403 "this
  // account is suspended, contact support" into a 401 "session expired" - and
  // /auth/me, whose whole job is letting a suspended user load their account
  // and be told why, signed them out instead. The status check is the
  // mechanism; revocation is for credential changes and logout-all.
  const victim = await mkUser("suspendme");
  const t = legacyToken(victim);
  check("works before", (await app.inject({ method: "GET", url: "/auth/me", headers: bearer(t) })).statusCode === 200);

  await sql.run("UPDATE users SET status = 'suspended' WHERE id = ?", victim);
  check("the epoch is untouched by a suspension", await epochOf(victim) === 0);

  const me = await app.inject({ method: "GET", url: "/auth/me", headers: bearer(t) });
  check("...so /auth/me still loads the account, which is how the app explains itself",
    me.statusCode === 200, `got ${me.statusCode}`);

  const guarded = await app.inject({ method: "GET", url: "/wallet/balance", headers: bearer(t) });
  check("...and a guarded route says SUSPENDED (403), not 'session expired' (401)",
    guarded.statusCode === 403, `got ${guarded.statusCode} ${guarded.body.slice(0, 80)}`);

  await sql.run("UPDATE users SET status = 'active' WHERE id = ?", victim);
  check("restoring lets the same token work again",
    (await app.inject({ method: "GET", url: "/wallet/balance", headers: bearer(t) })).statusCode === 200);
}


console.log("\n-- a password reset ends the sessions, which is the whole finding --");
{
  // The audit's exact walk: hold a token, reset the password, try the token.
  // It returned 200. The code is planted directly rather than issued, because
  // issueCode sends email and this is a test about tokens, not about delivery.
  const id = newId();
  const email = `reset-${id}@t.test`;
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at) VALUES (?,?,1,'Pakistan',?,'active',?)",
    id, email, id.slice(0, 8).toUpperCase(), now(),
  );
  const stolen = legacyToken(id);
  check("the stolen token works before the reset",
    (await app.inject({ method: "GET", url: "/auth/me", headers: bearer(stolen) })).statusCode === 200);

  const code = "424242";
  await sql.run(
    "INSERT INTO email_codes (id, email, code_hash, purpose, pending_password_hash, expires_at, attempts, consumed, created_at) VALUES (?,?,?,'reset',NULL,?,0,0,?)",
    newId(), email, hashCode(code), new Date(Date.now() + 600_000).toISOString(), now(),
  );
  const res = await app.inject({
    method: "POST", url: "/auth/reset",
    payload: { email, code, password: "a-brand-new-password" },
  });
  check("the reset succeeds", res.statusCode === 200, `got ${res.statusCode} ${res.body}`);

  const after = await app.inject({ method: "GET", url: "/auth/me", headers: bearer(stolen) });
  check("THE STOLEN TOKEN IS NOW DEAD (this returned 200 before the fix)", after.statusCode === 401,
    `got ${after.statusCode}`);

  const issued = (res.json() as { token?: string }).token as string;
  check("the person who did the reset is signed in on this device",
    (await app.inject({ method: "GET", url: "/auth/me", headers: bearer(issued) })).statusCode === 200);
}

console.log("\n-- one account's revocation does not touch another's --");
{
  const a = await mkUser("iso-a");
  const b = await mkUser("iso-b");
  const tb = legacyToken(b);
  await revokeSessions(a);
  check("B is unaffected by A being revoked",
    (await app.inject({ method: "GET", url: "/auth/me", headers: bearer(tb) })).statusCode === 200);
}

console.log("\n-- the credential-linking routes are covered too (security-review finding) --");
{
  // ⚠️ THIS IS THE GAP THE FIRST CUT OF THIS FIX HAD, AND IT WAS THE WORST
  // POSSIBLE ONE TO MISS. Four routes in auth.ts called getUserId() and never
  // requireActiveUser(), so the epoch was not checked on them — and all four
  // attach a NEW CREDENTIAL to an existing account (a Telegram identity, or an
  // email and password). A revoked token could therefore be walked into
  // permanent access that no later "sign out everywhere" could dislodge: link
  // your own Telegram to the victim's account, and every future mini-app login
  // mints a fresh, valid session for it.
  //
  // Every one of these must refuse a revoked token BEFORE it does any work.
  const target = await mkUser("linkroutes");
  const dead = legacyToken(target);
  await revokeSessions(target);

  const routes: [string, Record<string, unknown>][] = [
    ["/auth/telegram/link", { initData: "x" }],
    ["/auth/telegram/link-code", {}],
    ["/auth/email/link-start", { email: "attacker@evil.test", password: "hunter2hunter2" }],
    ["/auth/email/link-confirm", { email: "attacker@evil.test", code: "000000" }],
  ];
  for (const [url, payload] of routes) {
    const res = await app.inject({ method: "POST", url, headers: bearer(dead), payload });
    // 401 = refused for the right reason. 503 is acceptable ONLY on the two
    // Telegram routes when no bot token is configured, since that check runs
    // before auth — but it must never be a 2xx.
    const refused = res.statusCode === 401 || (res.statusCode === 503 && url.includes("telegram"));
    check(`${url} refuses a revoked token`, refused, `got ${res.statusCode} ${res.body.slice(0, 90)}`);
  }

  // And the same routes must still work for a LIVE session, or the fix has
  // simply broken account linking.
  const live = tokenAt(target, await epochOf(target));
  const start = await app.inject({
    method: "POST", url: "/auth/email/link-start",
    headers: bearer(live), payload: { email: `linked-${target}@t.test`, password: "hunter2hunter2" },
  });
  check("...but a live session can still start email linking",
    start.statusCode !== 401, `got ${start.statusCode} ${start.body.slice(0, 90)}`);
}

console.log("\n-- setting a password by linking an email also ends the old sessions --");
{
  // /auth/email/link-confirm writes a password_hash. Any route that changes
  // what someone can log in with must end the sessions that existed under the
  // old credentials, exactly as /auth/reset does.
  const id = newId();
  const tgEmail = `${id}@telegram.local`;
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at) VALUES (?,?,0,'Pakistan',?,'active',?)",
    id, tgEmail, id.slice(0, 8).toUpperCase(), now(),
  );
  const before = legacyToken(id);
  const realEmail = `real-${id}@t.test`;
  const code = "313131";
  await sql.run(
    "INSERT INTO email_codes (id, email, code_hash, purpose, pending_password_hash, expires_at, attempts, consumed, created_at) VALUES (?,?,?,'link',?,?,0,0,?)",
    newId(), realEmail, hashCode(code), "scrypt$bound$pw",
    new Date(Date.now() + 600_000).toISOString(), now(),
  );
  const res = await app.inject({
    method: "POST", url: "/auth/email/link-confirm",
    headers: bearer(before), payload: { email: realEmail, code },
  });
  check("linking an email succeeds", res.statusCode === 200, `got ${res.statusCode} ${res.body.slice(0, 120)}`);
  check("the epoch advanced", await epochOf(id) === 1);

  const replacement = (res.json() as { token?: string }).token;
  check("it hands back a REPLACEMENT token", typeof replacement === "string" && replacement.length > 0);
  check("...without which the user would have signed themselves out by linking",
    (await app.inject({ method: "GET", url: "/auth/me", headers: bearer(before) })).statusCode === 401);
  check("the replacement works", replacement
    ? (await app.inject({ method: "GET", url: "/auth/me", headers: bearer(replacement) })).statusCode === 200
    : false);
}

console.log("\n-- structural tripwire --");
{
  // Same idea as otp-race.e2e.ts's tripwire and mining.e2e.ts's LOCKED_PATHS:
  // the checks above prove the behaviour, this proves the mechanism has not been
  // quietly removed by a refactor that kept the tests passing for other reasons.
  const auth = readFileSync(new URL("../auth.ts", import.meta.url), "utf8");
  check("signToken still stamps the epoch into the token", /se: Number\(row\?\.session_epoch/.test(auth));
  check("requireActiveUser still reads session_epoch", /SELECT status, session_epoch FROM users/.test(auth));
  check("requireActiveUser still compares it", /tokenEpoch !== Number\(row\.session_epoch/.test(auth));
  check("/auth/me still enforces it independently", /tokenEpochOf\(req\) !== Number\(user\.session_epoch/.test(auth));

  const staff = readFileSync(new URL("../routes/staff.ts", import.meta.url), "utf8");
  check("suspending still does NOT touch the epoch (see the suspension block above)",
    !/status = \?, session_epoch = session_epoch \+ 1 WHERE id = \?/.test(staff));

  check("linking an email still bumps it — that write sets a password",
    /password_hash = \?, session_epoch = session_epoch \+ 1 WHERE id = \?/.test(auth));

  // requireActiveUser's second argument is REQUIRED so the compiler forces every
  // authenticated path to supply it; an optional one could be silently forgotten
  // by a new route.
  check("the request argument is not optional",
    /requireActiveUser\(userId: string, req: FastifyRequest\)/.test(auth));

  // ⚠️ THE CHECK THAT WOULD HAVE CAUGHT THE ORIGINAL GAP, AND THE REASON IT IS
  // STRUCTURAL RATHER THAN BEHAVIOURAL. The two Telegram link routes answer 503
  // before they authenticate when no bot token is configured, which is the case
  // in this suite — so a request-level test cannot prove they check the epoch,
  // only that they did not succeed. This can: every `getUserId(req)` in auth.ts
  // must be followed closely by `requireActiveUser`, with `/auth/me` the single
  // deliberate exception (it must serve a SUSPENDED user their own account so
  // the app can say why, and so it repeats the epoch comparison inline instead).
  //
  // Comment-only lines are dropped before the scan. Counting raw lines would
  // make the answer depend on how much explanation sits between the two
  // statements, which is not a property of the code — an honest guard with a
  // long comment above it would read as a violation.
  const code = auth.split(/\r?\n/)
    .map((line, i) => ({ n: i + 1, text: line }))
    .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text) && text.trim() !== "");
  const unguarded: number[] = [];
  code.forEach(({ n, text }, i) => {
    if (!/=\s*getUserId\(req\)/.test(text)) return;
    const window = code.slice(i, i + 6).map((l) => l.text).join("\n");
    const isAuthMe = /tokenEpochOf\(req\) !== Number\(user\.session_epoch/.test(window);
    if (!/requireActiveUser\(\s*userId\s*,\s*req\s*\)/.test(window) && !isAuthMe) {
      unguarded.push(n);
    }
  });
  check("every getUserId in auth.ts is followed by the revocation check",
    unguarded.length === 0,
    unguarded.length ? `unguarded at auth.ts line(s) ${unguarded.join(", ")}` : "");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
