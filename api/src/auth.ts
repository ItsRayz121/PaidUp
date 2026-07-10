import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomInt } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { sql, now, newId } from "./db.ts";
import { config } from "./config.ts";
import { sendLoginCode } from "./email.ts";

// ---- helpers --------------------------------------------------------------
function hashCode(code: string): string {
  // Store only a peppered hash of the OTP, never the code itself.
  return createHash("sha256").update(`${code}:${config.otpPepper}`).digest("hex");
}

function makeCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
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
  };
}

// ---- routes ---------------------------------------------------------------
const requestSchema = z.object({ email: z.string().email() });
const verifySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
  ref: z.string().optional(), // referral code of the inviter
});

export async function authRoutes(app: FastifyInstance) {
  // Step 1: user asks for a code
  app.post("/auth/email/request", async (req, reply) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Please enter a valid email." });

    const email = parsed.data.email.toLowerCase().trim();
    const code = makeCode();

    // Invalidate any earlier unused codes for this email.
    await sql.run("UPDATE email_codes SET consumed = 1 WHERE email = ? AND consumed = 0", email);

    const expires = new Date(Date.now() + config.otpTtlMinutes * 60_000).toISOString();
    await sql.run(
      "INSERT INTO email_codes (id, email, code_hash, expires_at, attempts, consumed, created_at) VALUES (?,?,?,?,0,0,?)",
      newId(), email, hashCode(code), expires, now(),
    );

    try {
      await sendLoginCode(email, code);
    } catch (err) {
      req.log.error({ err }, "email send failed");
      return reply.code(502).send({ error: "We could not send the email. Please try again." });
    }
    // Never reveal whether the email already has an account.
    return { ok: true };
  });

  // Step 2: user submits the code -> signed in (creates account if new)
  app.post("/auth/email/verify", async (req, reply) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter the 6-number code." });

    const email = parsed.data.email.toLowerCase().trim();
    const row = await sql.get<{ id: string; code_hash: string; expires_at: string; attempts: number }>(
      "SELECT * FROM email_codes WHERE email = ? AND consumed = 0 ORDER BY created_at DESC LIMIT 1",
      email,
    );

    if (!row) return reply.code(400).send({ error: "No code found. Please ask for a new code." });
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await sql.run("UPDATE email_codes SET consumed = 1 WHERE id = ?", row.id);
      return reply.code(400).send({ error: "This code has expired. Please ask for a new code." });
    }
    if (row.attempts >= config.otpMaxAttempts) {
      await sql.run("UPDATE email_codes SET consumed = 1 WHERE id = ?", row.id);
      return reply.code(429).send({ error: "Too many tries. Please ask for a new code." });
    }

    if (hashCode(parsed.data.code) !== row.code_hash) {
      await sql.run("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?", row.id);
      return reply.code(400).send({ error: "Wrong code. Please try again." });
    }

    // Correct code — consume it and sign the user in.
    await sql.run("UPDATE email_codes SET consumed = 1 WHERE id = ?", row.id);

    let user = await sql.get<UserRow>("SELECT * FROM users WHERE email = ?", email);
    if (!user) {
      const id = newId();
      const referralCode = await uniqueReferralCode(email);
      let referredBy: string | null = null;
      if (parsed.data.ref) {
        const inviter = await sql.get<{ id: string }>(
          "SELECT id FROM users WHERE referral_code = ?", parsed.data.ref.toUpperCase(),
        );
        if (inviter) referredBy = inviter.id;
      }
      // The user row and its referral edge must land together, or an invite is
      // silently lost.
      await sql.tx(async (t) => {
        await t.run(
          "INSERT INTO users (id, email, country, referral_code, referred_by, status, created_at) VALUES (?,?,?,?,?, 'active', ?)",
          id, email, "Pakistan", referralCode, referredBy, now(),
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

    await ensureAdminRole(user!.id, user!.email);
    return { token: signToken(user!.id), user: await publicUser(user!) };
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
