// E2E for two register/verify fixes (2026-09-07):
//   - audit finding A-13: /auth/register no longer reveals whether an email
//     already has an account (same {ok:true} shape either way).
//   - a dedicated /auth/resend-code endpoint, with a real per-email cooldown,
//     that keeps whatever password was already chosen at signup.
//
//   npm run test:authregister
import Fastify from "fastify";
import { initDb, sql, now, newId } from "../db.ts";
import { config } from "../config.ts";
import { authRoutes } from "../auth.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(authRoutes);

const TAG = newId().slice(0, 8);

console.log("\n-- /auth/register: no enumeration (audit A-13) --");
{
  const freshEmail = `${TAG}-fresh@t.test`;
  const r1 = await app.inject({
    method: "POST", url: "/auth/register", headers: { "content-type": "application/json" },
    payload: { email: freshEmail, password: "correcthorse1" },
  });
  check("registering a brand-new email succeeds", r1.statusCode === 200, r1.body);
  check("the response is a plain {ok:true}, nothing more", JSON.stringify(r1.json()) === '{"ok":true}', r1.body);

  // Verify it, so the SAME email is now a real, verified account.
  const codeRow = await sql.get<{ code_hash: string }>(
    "SELECT code_hash FROM email_codes WHERE email = ? AND purpose = 'verify' ORDER BY created_at DESC LIMIT 1",
    freshEmail,
  );
  check("a verify code row exists", Boolean(codeRow));
  // We cannot recover the plaintext code from its hash, so exercise the
  // enumeration fix directly against the DB state instead: mark verified.
  await sql.run("UPDATE users SET email_verified = 1 WHERE email = ?", freshEmail);

  const r2 = await app.inject({
    method: "POST", url: "/auth/register", headers: { "content-type": "application/json" },
    payload: { email: freshEmail, password: "someOtherPassw0rd" },
  });
  check("registering an ALREADY-VERIFIED email is not refused with a distinct error",
    r2.statusCode === 200, r2.body);
  check("...and the response body is IDENTICAL in shape to the fresh-signup case",
    JSON.stringify(r2.json()) === '{"ok":true}', r2.body);
  check("...and no second account / row was created",
    Number((await sql.get<{ n: string }>("SELECT COUNT(*)::int AS n FROM users WHERE email = ?", freshEmail))?.n ?? 0) === 1,
  );
}

console.log("\n-- /auth/resend-code: keeps the password, adds a real cooldown --");
{
  const email = `${TAG}-resend@t.test`;
  const reg = await app.inject({
    method: "POST", url: "/auth/register", headers: { "content-type": "application/json" },
    payload: { email, password: "myFirstPassword1" },
  });
  check("register succeeds", reg.statusCode === 200, reg.body);

  const firstCode = await sql.get<{ id: string; pending_password_hash: string }>(
    "SELECT id, pending_password_hash FROM email_codes WHERE email = ? AND purpose = 'verify' ORDER BY created_at DESC LIMIT 1",
    email,
  );
  check("the code carries the chosen password's hash", Boolean(firstCode?.pending_password_hash));

  // Immediately resending should be blocked by the per-email cooldown.
  const tooSoon = await app.inject({
    method: "POST", url: "/auth/resend-code", headers: { "content-type": "application/json" },
    payload: { email },
  });
  check("200 even inside the cooldown (anti-enumeration shape)", tooSoon.statusCode === 200, tooSoon.body);
  const tooSoonBody = tooSoon.json() as { ok: true; retryAfterSeconds?: number };
  check("...but no new code was sent — retryAfterSeconds is reported",
    typeof tooSoonBody.retryAfterSeconds === "number" && tooSoonBody.retryAfterSeconds > 0, JSON.stringify(tooSoonBody));

  const stillOneCode = await sql.get<{ n: string }>(
    "SELECT COUNT(*)::int AS n FROM email_codes WHERE email = ? AND purpose = 'verify'", email,
  );
  check("still exactly one code row — nothing was issued during the cooldown", Number(stillOneCode?.n) === 1);

  // Back-date the existing code past the cooldown window, then resend for real.
  await sql.run(
    "UPDATE email_codes SET created_at = ? WHERE id = ?",
    new Date(Date.now() - (config.resendCodeCooldownSeconds + 5) * 1000).toISOString(), firstCode!.id,
  );
  const resent = await app.inject({
    method: "POST", url: "/auth/resend-code", headers: { "content-type": "application/json" },
    payload: { email },
  });
  check("200 once past the cooldown", resent.statusCode === 200, resent.body);
  check("...and no retryAfterSeconds — a real code went out", (resent.json() as { retryAfterSeconds?: number }).retryAfterSeconds === undefined);

  const secondCode = await sql.get<{ id: string; pending_password_hash: string; consumed: number }>(
    "SELECT id, pending_password_hash, consumed FROM email_codes WHERE email = ? AND purpose = 'verify' ORDER BY created_at DESC LIMIT 1",
    email,
  );
  check("a NEW code row was written", secondCode!.id !== firstCode!.id);
  check("the ORIGINAL code is now consumed (invalidated)",
    Number((await sql.get<{ consumed: number }>("SELECT consumed FROM email_codes WHERE id = ?", firstCode!.id))?.consumed) === 1);
  check("the new code inherits the SAME password hash the user originally chose",
    secondCode!.pending_password_hash === firstCode!.pending_password_hash);
}

console.log("\n-- /auth/resend-code: anti-enumeration for unknown / already-verified emails --");
{
  const unknown = await app.inject({
    method: "POST", url: "/auth/resend-code", headers: { "content-type": "application/json" },
    payload: { email: `${TAG}-nobody@t.test` },
  });
  check("an email with no account: 200, {ok:true}, no cooldown info",
    unknown.statusCode === 200 && JSON.stringify(unknown.json()) === '{"ok":true}', unknown.body);

  const verifiedEmail = `${TAG}-already-verified@t.test`;
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at) VALUES (?,?,1,'Pakistan',?,'active',?)",
    newId(), verifiedEmail, `${TAG}RC`.toUpperCase().slice(0, 12), now(),
  );
  const alreadyVerified = await app.inject({
    method: "POST", url: "/auth/resend-code", headers: { "content-type": "application/json" },
    payload: { email: verifiedEmail },
  });
  check("an already-verified email: the SAME shape, nothing sent",
    alreadyVerified.statusCode === 200 && JSON.stringify(alreadyVerified.json()) === '{"ok":true}', alreadyVerified.body);
}

console.log("\n-- a broken email provider must not leak enumeration via status code (security review, 2026-09-07) --");
{
  // Forces email.ts's sendLoginCode to actually throw (it only does so in
  // production with no RESEND_API_KEY) — the exact real-world state this
  // finding was reachable in, per email.ts's own history.
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const brandNew = await app.inject({
      method: "POST", url: "/auth/register", headers: { "content-type": "application/json" },
      payload: { email: `${TAG}-newbroken@t.test`, password: "somePassword1" },
    });
    check("a brand-new signup still answers 200 when the send fails",
      brandNew.statusCode === 200, brandNew.body);
    check("...with the same bare {ok:true} shape, no error surfaced",
      JSON.stringify(brandNew.json()) === '{"ok":true}', brandNew.body);

    const verifiedEmail = `${TAG}-verifiedbroken@t.test`;
    await sql.run(
      "INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at) VALUES (?,?,1,'Pakistan',?,'active',?)",
      newId(), verifiedEmail, `${TAG}VB`.toUpperCase().slice(0, 12), now(),
    );
    const existingVerified = await app.inject({
      method: "POST", url: "/auth/register", headers: { "content-type": "application/json" },
      payload: { email: verifiedEmail, password: "someOtherPw1" },
    });
    check("an existing verified account ALSO answers 200 when the send fails",
      existingVerified.statusCode === 200, existingVerified.body);
    check("...IDENTICAL to the brand-new case — no 200-vs-502 split to read",
      JSON.stringify(existingVerified.json()) === JSON.stringify(brandNew.json()));

    const resendEmail = `${TAG}-resendbroken@t.test`;
    process.env.NODE_ENV = originalEnv; // register a real account first, unbroken
    await app.inject({
      method: "POST", url: "/auth/register", headers: { "content-type": "application/json" },
      payload: { email: resendEmail, password: "aPassword123" },
    });
    process.env.NODE_ENV = "production";
    // Past the cooldown, so resend-code actually attempts a real send.
    await sql.run(
      "UPDATE email_codes SET created_at = ? WHERE email = ? AND purpose = 'verify'",
      new Date(Date.now() - (config.resendCodeCooldownSeconds + 5) * 1000).toISOString(), resendEmail,
    );
    const resendBroken = await app.inject({
      method: "POST", url: "/auth/resend-code", headers: { "content-type": "application/json" },
      payload: { email: resendEmail },
    });
    check("/auth/resend-code also answers 200 when the send fails, not 502",
      resendBroken.statusCode === 200, resendBroken.body);
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
