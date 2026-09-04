// AUDIT-ONLY regression probe.
// Copy this file to api/src/tests/auth-resilience.e2e.ts before running so the
// relative imports resolve. Run against a disposable database only.
import { createHash } from "node:crypto";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { authRoutes } from "../auth.ts";
import { config } from "../config.ts";
import { initDb, newId, now, sql } from "../db.ts";
import { sendLoginCode } from "../email.ts";

await initDb();
const app = Fastify();
await app.register(authRoutes);

const email = `audit-auth-${newId()}@test.invalid`;
const userId = newId();
await sql.run(
  `INSERT INTO users
   (id,email,email_verified,country,referral_code,status,created_at)
   VALUES (?,?,1,'Pakistan',?,'active',?)`,
  userId, email, newId().replaceAll("-", "").slice(0, 12).toUpperCase(), now(),
);

const oldToken = jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: "30d" });
const code = "123456";
const codeHash = createHash("sha256")
  .update(`${code}:${config.otpPepper}`)
  .digest("hex");
await sql.run(
  `INSERT INTO email_codes
   (id,email,code_hash,purpose,pending_password_hash,expires_at,attempts,consumed,created_at)
   VALUES (?,?,?,'reset',NULL,?,0,0,?)`,
  newId(), email, codeHash, new Date(Date.now() + 60_000).toISOString(), now(),
);

// A single-use code should let exactly one racing request win.
const racing = await Promise.all(
  Array.from({ length: 8 }, (_, i) => app.inject({
    method: "POST",
    url: "/auth/reset",
    payload: { email, code, password: `Audit-password-${i}!` },
  })),
);
const resetSuccesses = racing.filter((r) => r.statusCode === 200).length;

// A password reset should invalidate sessions minted before the reset.
const oldSessionAfterReset = await app.inject({
  method: "GET",
  url: "/auth/me",
  headers: { authorization: `Bearer ${oldToken}` },
});

// Production without an email provider should fail closed, not report success
// while printing a live OTP and address to centralized logs.
const originalKey = config.resendApiKey;
config.resendApiKey = "";
const captured: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
let emailThrew = false;
try {
  await sendLoginCode("audit-recipient@test.invalid", "654321");
} catch {
  emailThrew = true;
} finally {
  console.log = originalLog;
  config.resendApiKey = originalKey;
}
const loggedSecret = captured.some((line) =>
  line.includes("audit-recipient@test.invalid") && line.includes("654321"));

console.log(`reset successes from one OTP: ${resetSuccesses} (secure expectation: 1)`);
console.log(`old JWT after password reset: HTTP ${oldSessionAfterReset.statusCode} (secure expectation: 401)`);
console.log(`missing email provider threw: ${emailThrew} (secure expectation in production: true)`);
console.log(`plaintext OTP and recipient logged: ${loggedSecret} (secure expectation in production: false)`);

const secure = resetSuccesses === 1
  && oldSessionAfterReset.statusCode === 401
  && emailThrew
  && !loggedSecret;
await app.close();
if (!secure) process.exitCode = 1;

