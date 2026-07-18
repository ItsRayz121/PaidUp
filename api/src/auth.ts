import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, createHmac, randomInt, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { sql, now, newId } from "./db.ts";
import { config } from "./config.ts";
import { sendLoginCode } from "./email.ts";
import { recordDevice } from "./fraud.ts";

// The frontend computes a device fingerprint (no PII) and sends it here so the
// fraud layer can spot one device farming many accounts (guardrail #5).
function deviceOf(req: FastifyRequest): string | undefined {
  const raw = req.headers["x-device-id"];
  const id = Array.isArray(raw) ? raw[0] : raw;
  return id ? String(id).slice(0, 100) : undefined;
}

const scryptAsync = promisify(scrypt);

// ---- helpers --------------------------------------------------------------
function hashCode(code: string): string {
  // Store only a peppered hash of the OTP, never the code itself.
  return createHash("sha256").update(`${code}:${config.otpPepper}`).digest("hex");
}

function makeCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

// Password hashing with scrypt (built into Node — no dependency). Format:
// "scrypt$<salt-hex>$<hash-hex>". Salt is per-password; compare is constant-time.
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

// A real scrypt hash of a random secret nobody knows. Login verifies against
// this when the email has no account, so "unknown email" and "wrong password"
// take the same time — the timing can't be used to discover which emails exist.
const DECOY_PASSWORD_HASH = await hashPassword(randomBytes(32).toString("hex"));

async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [algo, saltHex, hashHex] = stored.split("$");
  if (algo !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const derived = (await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// Issue a fresh OTP for a purpose ('verify' at signup, 'reset' for password
// reset), invalidating earlier unused codes of that purpose. For signup the
// caller passes the chosen password hash; it rides on the code and is applied
// only when the code is confirmed, so an unverified account's password can't be
// set by anyone who doesn't control the inbox. Throws if the email can't be sent.
async function issueCode(
  email: string,
  purpose: "verify" | "reset",
  pendingPasswordHash: string | null = null,
): Promise<void> {
  const code = makeCode();
  await sql.run(
    "UPDATE email_codes SET consumed = 1 WHERE email = ? AND purpose = ? AND consumed = 0",
    email, purpose,
  );
  const expires = new Date(Date.now() + config.otpTtlMinutes * 60_000).toISOString();
  await sql.run(
    "INSERT INTO email_codes (id, email, code_hash, purpose, pending_password_hash, expires_at, attempts, consumed, created_at) VALUES (?,?,?,?,?,?,0,0,?)",
    newId(), email, hashCode(code), purpose, pendingPasswordHash, expires, now(),
  );
  await sendLoginCode(email, code);
}

// Validate + consume an OTP for a purpose. Returns a structured result (with the
// password bound to the code, if any) so each route can map it to a status code.
type CodeResult =
  | { ok: true; pendingPasswordHash: string | null }
  | { ok: false; statusCode: number; error: string };
async function consumeCode(email: string, code: string, purpose: "verify" | "reset"): Promise<CodeResult> {
  const row = await sql.get<{ id: string; code_hash: string; expires_at: string; attempts: number; pending_password_hash: string | null }>(
    "SELECT * FROM email_codes WHERE email = ? AND purpose = ? AND consumed = 0 ORDER BY created_at DESC LIMIT 1",
    email, purpose,
  );
  if (!row) return { ok: false, statusCode: 400, error: "No code found. Please ask for a new code." };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await sql.run("UPDATE email_codes SET consumed = 1 WHERE id = ?", row.id);
    return { ok: false, statusCode: 400, error: "This code has expired. Please ask for a new code." };
  }
  if (row.attempts >= config.otpMaxAttempts) {
    await sql.run("UPDATE email_codes SET consumed = 1 WHERE id = ?", row.id);
    return { ok: false, statusCode: 429, error: "Too many tries. Please ask for a new code." };
  }
  if (hashCode(code) !== row.code_hash) {
    await sql.run("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?", row.id);
    return { ok: false, statusCode: 400, error: "Wrong code. Please try again." };
  }
  await sql.run("UPDATE email_codes SET consumed = 1 WHERE id = ?", row.id);
  return { ok: true, pendingPasswordHash: row.pending_password_hash ?? null };
}

function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: "30d" });
}

export function getUserId(req: FastifyRequest): string {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw { statusCode: 401, message: "Not signed in" };
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub: string };
    return payload.sub;
  } catch {
    throw { statusCode: 401, message: "Session expired. Please sign in again." };
  }
}

// Verifying the JWT proves WHO you are, not that you are still allowed in — a
// token issued before a suspension stays cryptographically valid until it
// expires. Every earner route must therefore re-check the account's status, or
// "suspend" would be a button that does nothing while the user keeps earning
// and withdrawing.
export async function requireActiveUser(userId: string): Promise<void> {
  const row = await sql.get<{ status: string }>("SELECT status FROM users WHERE id = ?", userId);
  if (!row) throw { statusCode: 401, message: "Session expired. Please sign in again." };
  if (row.status !== "active") {
    throw { statusCode: 403, message: "This account is suspended. Please contact support." };
  }
}

async function uniqueReferralCode(email: string): Promise<string> {
  const base = (email.split("@")[0] || "user").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 6) || "USER";
  for (let i = 0; i < 20; i++) {
    const candidate = `${base}${randomInt(10, 99)}`;
    const exists = await sql.get("SELECT 1 FROM users WHERE referral_code = ?", candidate);
    if (!exists) return candidate;
  }
  return `${base}${Date.now().toString().slice(-4)}`;
}

type UserRow = {
  id: string; email: string; country: string; referral_code: string;
  referred_by: string | null; status: string; created_at: string;
  telegram_id: string | null;
};

async function roleOf(userId: string): Promise<string | null> {
  const row = await sql.get<{ role: string }>("SELECT role FROM admin_users WHERE user_id = ?", userId);
  return row?.role ?? null;
}

// Promote founder emails (config.adminEmails) to admin on login.
async function ensureAdminRole(userId: string, email: string): Promise<void> {
  if (!config.adminEmails.includes(email.toLowerCase())) return;
  await sql.run(
    "INSERT INTO admin_users (user_id, role, created_at) VALUES (?, 'admin', ?) " +
    "ON CONFLICT(user_id) DO UPDATE SET role = 'admin'",
    userId, now(),
  );
}

async function publicUser(u: UserRow) {
  return {
    id: u.id, email: u.email, country: u.country,
    referralCode: u.referral_code, status: u.status,
    role: await roleOf(u.id), // null for normal earners; 'agent'|'manager'|'admin' for staff
    // Presence only, never the id itself — the UI just needs "connected or not".
    hasTelegram: Boolean(u.telegram_id),
  };
}

// Per-route rate-limit budgets (the plugin is registered global:false in
// server.ts — see the note there for why only these routes are limited).
// Keyed by IP: on CGNAT that is a shared budget, so the numbers are sized for
// a busy shared network, not a single user.
const limited = (max: number, timeWindow: string) => ({
  config: { rateLimit: { max, timeWindow } },
});

// ---- routes ---------------------------------------------------------------
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "at least 8 letters").max(200),
  ref: z.string().optional(), // referral code of the inviter
});
const verifyEmailSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
});
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
const forgotSchema = z.object({ email: z.string().email() });
const resetSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
  password: z.string().min(8).max(200),
});

export async function authRoutes(app: FastifyInstance) {
  // Register: create an UNVERIFIED account with a password, then email a code
  // to prove the address. The account can't log in until the email is verified.
  // Each register sends an email — the budget bounds inbox bombing and what an
  // attacker can burn of our Resend quota from one address.
  app.post("/auth/register", limited(10, "10 minutes"), async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Enter a valid email and a password of at least 8 letters." });
    }
    const email = parsed.data.email.toLowerCase().trim();

    const existing = await sql.get<{ id: string; email_verified: number }>(
      "SELECT id, email_verified FROM users WHERE email = ?", email,
    );
    if (existing && existing.email_verified) {
      return reply.code(409).send({ error: "This email already has an account. Please log in." });
    }

    // Hash only now that we know the request can proceed (scrypt is deliberately
    // expensive — don't pay it for a 409). Do NOT write it to the account yet:
    // the password is bound to the verification code and applied only when that
    // code is confirmed — otherwise anyone could overwrite an unverified
    // account's password (account takeover).
    const passwordHash = await hashPassword(parsed.data.password);

    if (!existing) {
      // Create the account with NO password yet (email_verified = 0). The
      // password lands at verification. The user row and its referral edge must
      // commit together, or an invite is silently lost.
      const id = newId();
      const referralCode = await uniqueReferralCode(email);
      let referredBy: string | null = null;
      if (parsed.data.ref) {
        const inviter = await sql.get<{ id: string }>(
          "SELECT id FROM users WHERE referral_code = ?", parsed.data.ref.toUpperCase(),
        );
        if (inviter) referredBy = inviter.id;
      }
      await sql.tx(async (t) => {
        await t.run(
          "INSERT INTO users (id, email, email_verified, country, referral_code, referred_by, status, created_at) VALUES (?,?,0,?,?,?, 'active', ?)",
          id, email, "Pakistan", referralCode, referredBy, now(),
        );
        if (referredBy) {
          await t.run(
            "INSERT INTO referrals (id, referrer_user_id, referred_user_id, created_at, bonus_paid) VALUES (?,?,?,?,0)",
            newId(), referredBy, id, now(),
          );
        }
      });
    }

    try {
      await issueCode(email, "verify", passwordHash);
    } catch (err) {
      req.log.error({ err }, "email send failed");
      return reply.code(502).send({ error: "We could not send the email. Please try again." });
    }
    return { ok: true };
  });

  // Verify the email with the signup code -> mark verified and sign in.
  app.post("/auth/verify-email", limited(30, "10 minutes"), async (req, reply) => {
    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter the 6-number code." });
    const email = parsed.data.email.toLowerCase().trim();

    const result = await consumeCode(email, parsed.data.code, "verify");
    if (!result.ok) return reply.code(result.statusCode).send({ error: result.error });

    // Apply the password chosen at register (bound to this code) and mark
    // verified together. Without a bound password the account can't be used.
    if (!result.pendingPasswordHash) {
      return reply.code(400).send({ error: "Please sign up again to set your password." });
    }
    await sql.run(
      "UPDATE users SET password_hash = ?, email_verified = 1 WHERE email = ?",
      result.pendingPasswordHash, email,
    );
    const user = await sql.get<UserRow>("SELECT * FROM users WHERE email = ?", email);
    if (!user) return reply.code(404).send({ error: "Account not found. Please sign up again." });

    await ensureAdminRole(user.id, user.email);
    await recordDevice(user.id, deviceOf(req), req.ip);
    return { token: signToken(user.id), user: await publicUser(user) };
  });

  // Log in with email + password. No code needed once the email is verified.
  // Brute-force cap. scrypt already makes each guess expensive for US; this
  // makes volume impossible for THEM. 30/min is generous for a shared NAT.
  app.post("/auth/login", limited(30, "1 minute"), async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter your email and password." });
    const email = parsed.data.email.toLowerCase().trim();

    const user = await sql.get<UserRow & { password_hash: string | null; email_verified: number }>(
      "SELECT * FROM users WHERE email = ?", email,
    );
    // Same generic message whether the email is unknown or the password is
    // wrong, so the endpoint can't be used to discover which emails exist —
    // and the same scrypt cost on both paths (verify against a decoy hash when
    // the account doesn't exist), so response TIMING doesn't reveal it either.
    const passwordOk = await verifyPassword(
      parsed.data.password, user?.password_hash ?? DECOY_PASSWORD_HASH,
    );
    if (!user || !passwordOk) {
      return reply.code(401).send({ error: "Wrong email or password." });
    }
    // A set password implies a verified email (password is only written at
    // verify/reset), so this is a defensive guard, not a normal path. No resend:
    // a verify code must carry a pending password, which we don't have here.
    if (!user.email_verified) {
      return reply.code(403).send({ error: "Please verify your email first.", needsVerify: true });
    }

    await ensureAdminRole(user.id, user.email);
    await recordDevice(user.id, deviceOf(req), req.ip);
    return { token: signToken(user.id), user: await publicUser(user) };
  });

  // Forgot password: email a reset code. Always returns ok so the endpoint
  // can't reveal whether an account exists.
  app.post("/auth/forgot", limited(5, "10 minutes"), async (req, reply) => {
    const parsed = forgotSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Please enter a valid email." });
    const email = parsed.data.email.toLowerCase().trim();

    const user = await sql.get<{ id: string }>("SELECT id FROM users WHERE email = ?", email);
    if (user) {
      try { await issueCode(email, "reset"); } catch (err) { req.log.error({ err }, "email send failed"); }
    }
    return { ok: true };
  });

  // Reset password with the reset code -> set new password and sign in. A
  // successful reset also verifies the email (they proved control of it).
  app.post("/auth/reset", limited(30, "10 minutes"), async (req, reply) => {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Enter the code and a new password of at least 8 letters." });
    }
    const email = parsed.data.email.toLowerCase().trim();

    const result = await consumeCode(email, parsed.data.code, "reset");
    if (!result.ok) return reply.code(result.statusCode).send({ error: result.error });

    const passwordHash = await hashPassword(parsed.data.password);
    await sql.run("UPDATE users SET password_hash = ?, email_verified = 1 WHERE email = ?", passwordHash, email);
    const user = await sql.get<UserRow>("SELECT * FROM users WHERE email = ?", email);
    if (!user) return reply.code(404).send({ error: "Account not found." });

    await ensureAdminRole(user.id, user.email);
    await recordDevice(user.id, deviceOf(req), req.ip);
    return { token: signToken(user.id), user: await publicUser(user) };
  });

  // Telegram login fallback (P2). The web Telegram Login Widget posts the signed
  // auth payload here. We re-verify the signature server-side (never trust the
  // client) per Telegram's spec: HMAC-SHA256 of the sorted "key=value" lines,
  // keyed by SHA256(bot_token). A first-time Telegram user is created with a
  // synthetic, never-emailed address (Telegram gives no email) and no password,
  // so they can only ever sign in through Telegram. Off unless a bot token is set.
  app.post("/auth/telegram", limited(30, "1 minute"), async (req, reply) => {
    if (!config.telegramBotToken) {
      return reply.code(503).send({ error: "Telegram login is not set up yet. Please use email." });
    }
    const v = verifyWidgetPayload(req.body);
    if (!v.ok) return reply.code(v.code).send({ error: v.error });

    const user = await findOrCreateTelegramUser(v.telegramId, v.username, v.startParam);
    if (!user) return reply.code(500).send({ error: "Could not sign you in. Please try again." });

    await ensureAdminRole(user.id, user.email);
    await recordDevice(user.id, deviceOf(req), req.ip);
    return { token: signToken(user.id), user: await publicUser(user) };
  });

  // Telegram MINI APP login (2026-07-18). Inside Telegram the app receives a
  // signed `initData` querystring instead of the Login Widget payload. Its HMAC
  // scheme differs from the widget's on purpose (Telegram's spec): the key is
  // HMAC-SHA256("WebAppData", bot_token), not SHA256(bot_token). A referral
  // rides in `start_param` (t.me/<bot>/<app>?startapp=<code>) — INSIDE the
  // signed set, so an invite code can't be tampered with after signing.
  app.post("/auth/telegram/miniapp", limited(30, "1 minute"), async (req, reply) => {
    if (!config.telegramBotToken) {
      return reply.code(503).send({ error: "Telegram login is not set up yet. Please use email." });
    }
    const v = verifyMiniAppInitData(req.body);
    if (!v.ok) return reply.code(v.code).send({ error: v.error });

    const user = await findOrCreateTelegramUser(v.telegramId, v.username, v.startParam);
    if (!user) return reply.code(500).send({ error: "Could not sign you in. Please try again." });

    await ensureAdminRole(user.id, user.email);
    await recordDevice(user.id, deviceOf(req), req.ip);
    return { token: signToken(user.id), user: await publicUser(user) };
  });

  // Which Telegram bot to render the login widget for — served by the API so
  // the bot username never has to be hand-copied into a web env var. Cached
  // after the first successful getMe; on failure it retries next call.
  app.get("/auth/telegram/config", async () => {
    const enabled = Boolean(config.telegramBotToken);
    if (enabled && !cachedBotUsername) {
      try {
        const r = await fetch(
          `https://api.telegram.org/bot${config.telegramBotToken}/getMe`,
          { signal: AbortSignal.timeout(5000) },
        );
        const j = (await r.json()) as { ok?: boolean; result?: { username?: string } };
        if (j.ok && j.result?.username) cachedBotUsername = j.result.username;
      } catch { /* transient — leave empty, the widget just stays hidden */ }
    }
    return { enabled, botUsername: cachedBotUsername };
  });

  // Connect Telegram to an EXISTING signed-in account (founder, 2026-07-18):
  // one person, one account, two doors. The body carries either the Mini App's
  // initData or the Login Widget's signed payload — both re-verified exactly as
  // at login; being signed in is never proof of owning a Telegram account.
  app.post("/auth/telegram/link", limited(30, "1 minute"), async (req, reply) => {
    if (!config.telegramBotToken) {
      return reply.code(503).send({ error: "Telegram is not set up yet." });
    }
    let userId: string;
    try {
      userId = getUserId(req);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 401).send({ error: err.message ?? "Not signed in" });
    }
    const me = await sql.get<UserRow>("SELECT * FROM users WHERE id = ?", userId);
    if (!me) return reply.code(404).send({ error: "User not found" });
    // Idempotent: already connected is a success, not an error.
    if (me.telegram_id) return { ok: true, user: await publicUser(me) };

    const body = (typeof req.body === "object" && req.body ? req.body : {}) as
      { initData?: unknown; widget?: unknown };
    const v = body.initData !== undefined
      ? verifyMiniAppInitData(body)
      : verifyWidgetPayload(body.widget);
    if (!v.ok) return reply.code(v.code).send({ error: v.error });

    const owner = await sql.get<UserRow>(
      "SELECT * FROM users WHERE telegram_id = ?", v.telegramId,
    );
    if (owner && owner.id !== me.id) {
      // Opening the Mini App before linking auto-creates a Telegram-only shell
      // account. An EMPTY shell may be absorbed — unlink it so the real account
      // wins. Any activity at all (points, ROZI, a withdrawal) and we refuse
      // rather than guess which account the person meant.
      const isShell = owner.email.endsWith("@telegram.local");
      const [led, rozi, wd] = await Promise.all([
        sql.get("SELECT 1 AS x FROM ledger_entries WHERE user_id = ? LIMIT 1", owner.id),
        sql.get("SELECT 1 AS x FROM rozi_ledger WHERE user_id = ? LIMIT 1", owner.id),
        sql.get("SELECT 1 AS x FROM withdrawal_requests WHERE user_id = ? LIMIT 1", owner.id),
      ]);
      if (!isShell || led || rozi || wd) {
        return reply.code(409).send({ error: "This Telegram is already connected to another account." });
      }
      await sql.tx(async (t) => {
        await t.run("UPDATE users SET telegram_id = NULL WHERE id = ?", owner.id);
        await t.run("UPDATE users SET telegram_id = ? WHERE id = ?", v.telegramId, me.id);
      });
    } else if (!owner) {
      await sql.run("UPDATE users SET telegram_id = ? WHERE id = ?", v.telegramId, me.id);
    }
    const fresh = await sql.get<UserRow>("SELECT * FROM users WHERE id = ?", userId);
    if (!fresh) return reply.code(500).send({ error: "Could not connect. Please try again." });
    return { ok: true, user: await publicUser(fresh) };
  });

  // Who am I (used by the app after it has a token)
  app.get("/auth/me", async (req, reply) => {
    try {
      const userId = getUserId(req);
      const user = await sql.get<UserRow>("SELECT * FROM users WHERE id = ?", userId);
      if (!user) return reply.code(404).send({ error: "User not found" });
      return { user: await publicUser(user) };
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 401).send({ error: err.message ?? "Not signed in" });
    }
  });
}

let cachedBotUsername = "";

// The two Telegram verification schemes. Both end in the same shape so login
// and account-linking can share them. NOTE they are deliberately different
// per Telegram's spec — a payload signed for one can never validate as the
// other:
//   Login Widget:  HMAC key = SHA256(bot_token)
//   Mini App:      HMAC key = HMAC-SHA256("WebAppData", bot_token)
type TgVerified =
  | { ok: true; telegramId: string; username: string; startParam?: string }
  | { ok: false; code: number; error: string };

const TG_FAIL = { ok: false as const, code: 401, error: "Telegram login failed. Please try again." };
const TG_BAD = { ok: false as const, code: 400, error: "Telegram login failed. Please try again." };
const TG_STALE = { ok: false as const, code: 401, error: "This login expired. Please try again." };

// The Login Widget's signed payload (an object of fields). `ref` is OUR
// referral param, not part of Telegram's signed set, so it is pulled out
// before building the check string.
function verifyWidgetPayload(body: unknown): TgVerified {
  const raw = (typeof body === "object" && body ? body : {}) as Record<string, unknown>;
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) data[k] = String(v);
  }
  const hash = data.hash;
  const ref = data.ref;
  delete data.hash;
  delete data.ref;
  if (!hash || !data.id || !data.auth_date) return TG_BAD;

  const checkString = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  const secret = createHash("sha256").update(config.telegramBotToken).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest();
  const got = Buffer.from(hash, "hex");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return TG_FAIL;
  // Freshness: reject a captured payload older than a day (Telegram's guidance)
  // or dated in the future beyond a little clock skew — defends against replay.
  const ageSec = Date.now() / 1000 - Number(data.auth_date);
  if (!Number.isFinite(ageSec) || ageSec > 86_400 || ageSec < -300) return TG_STALE;

  return { ok: true, telegramId: data.id, username: data.username || "", startParam: ref };
}

// The Mini App's initData (a signed querystring). The referral code rides in
// start_param INSIDE the signed set, so it cannot be tampered with.
function verifyMiniAppInitData(body: unknown): TgVerified {
  const b = (typeof body === "object" && body ? body : {}) as { initData?: unknown };
  const initData = typeof b.initData === "string" ? b.initData : "";
  if (!initData || initData.length > 8192) return TG_BAD;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash") ?? "";
  params.delete("hash");
  // Sorted by KEY (not by whole "k=v" string — '=' would misorder keys that
  // prefix each other), joined by newlines, exactly per Telegram's spec.
  const checkString = [...params.entries()]
    .sort(([a], [b2]) => (a < b2 ? -1 : a > b2 ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(config.telegramBotToken).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest();
  const got = Buffer.from(hash, "hex");
  if (!hash || got.length !== expected.length || !timingSafeEqual(got, expected)) return TG_FAIL;
  // initData is minted fresh every time Telegram opens the app, so a tight
  // replay window costs honest users nothing.
  const ageSec = Date.now() / 1000 - Number(params.get("auth_date"));
  if (!Number.isFinite(ageSec) || ageSec > 3600 || ageSec < -300) return TG_STALE;

  let tgUser: { id?: number | string; username?: string } = {};
  try {
    tgUser = JSON.parse(params.get("user") ?? "{}");
  } catch { /* fall through to the id check below */ }
  if (!tgUser.id) return TG_BAD;

  return {
    ok: true,
    telegramId: String(tgUser.id),
    username: tgUser.username ?? "",
    startParam: params.get("start_param") ?? undefined,
  };
}

// Find-or-create shared by the Login Widget and Mini App routes — the two
// differ only in how the signature is checked, never in what an account is.
async function findOrCreateTelegramUser(
  telegramId: string,
  username: string,
  ref: string | undefined,
): Promise<UserRow | undefined> {
  let user = await sql.get<UserRow>("SELECT * FROM users WHERE telegram_id = ?", telegramId);
  {
    if (!user) {
      const id = newId();
      // No email from Telegram: store a stable synthetic address so the NOT NULL
      // + UNIQUE email column holds. It is never sent mail; auth is Telegram-only.
      const email = `tg${telegramId}@telegram.local`;
      const referralCode = await uniqueReferralCode(username || `tg${telegramId}`);
      let referredBy: string | null = null;
      if (ref) {
        const inviter = await sql.get<{ id: string }>(
          "SELECT id FROM users WHERE referral_code = ?", ref.toUpperCase(),
        );
        if (inviter) referredBy = inviter.id;
      }
      // User row + referral edge must commit together, or an invite is lost.
      await sql.tx(async (t) => {
        await t.run(
          "INSERT INTO users (id, email, email_verified, telegram_id, country, referral_code, referred_by, status, created_at) VALUES (?,?,1,?,?,?,?, 'active', ?)",
          id, email, telegramId, "Pakistan", referralCode, referredBy, now(),
        );
        if (referredBy) {
          await t.run(
            "INSERT INTO referrals (id, referrer_user_id, referred_user_id, created_at, bonus_paid) VALUES (?,?,?,?,0)",
            newId(), referredBy, id, now(),
          );
        }
      });
      user = await sql.get<UserRow>("SELECT * FROM users WHERE id = ?", id);
    }
  }
  return user;
}
