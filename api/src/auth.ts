import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomInt } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { db, now, newId } from "./db.ts";
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

function uniqueReferralCode(email: string): string {
  const base = (email.split("@")[0] || "user").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 6) || "USER";
  for (let i = 0; i < 20; i++) {
    const candidate = `${base}${randomInt(10, 99)}`;
    const exists = db.prepare("SELECT 1 FROM users WHERE referral_code = ?").get(candidate);
    if (!exists) return candidate;
  }
  return `${base}${Date.now().toString().slice(-4)}`;
}

type UserRow = {
  id: string; email: string; country: string; referral_code: string;
  referred_by: string | null; status: string; created_at: string;
};

function publicUser(u: UserRow) {
  return {
    id: u.id, email: u.email, country: u.country,
    referralCode: u.referral_code, status: u.status,
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
    db.prepare("UPDATE email_codes SET consumed = 1 WHERE email = ? AND consumed = 0").run(email);

    const expires = new Date(Date.now() + config.otpTtlMinutes * 60_000).toISOString();
    db.prepare(
      "INSERT INTO email_codes (id, email, code_hash, expires_at, attempts, consumed, created_at) VALUES (?,?,?,?,0,0,?)",
    ).run(newId(), email, hashCode(code), expires, now());

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
    const row = db
      .prepare("SELECT * FROM email_codes WHERE email = ? AND consumed = 0 ORDER BY created_at DESC LIMIT 1")
      .get(email) as
      | { id: string; code_hash: string; expires_at: string; attempts: number }
      | undefined;

    if (!row) return reply.code(400).send({ error: "No code found. Please ask for a new code." });
    if (new Date(row.expires_at).getTime() < Date.now()) {
      db.prepare("UPDATE email_codes SET consumed = 1 WHERE id = ?").run(row.id);
      return reply.code(400).send({ error: "This code has expired. Please ask for a new code." });
    }
    if (row.attempts >= config.otpMaxAttempts) {
      db.prepare("UPDATE email_codes SET consumed = 1 WHERE id = ?").run(row.id);
      return reply.code(429).send({ error: "Too many tries. Please ask for a new code." });
    }

    if (hashCode(parsed.data.code) !== row.code_hash) {
      db.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);
      return reply.code(400).send({ error: "Wrong code. Please try again." });
    }

    // Correct code — consume it and sign the user in.
    db.prepare("UPDATE email_codes SET consumed = 1 WHERE id = ?").run(row.id);

    let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
    if (!user) {
      const id = newId();
      const referralCode = uniqueReferralCode(email);
      let referredBy: string | null = null;
      if (parsed.data.ref) {
        const inviter = db
          .prepare("SELECT id FROM users WHERE referral_code = ?")
          .get(parsed.data.ref.toUpperCase()) as { id: string } | undefined;
        if (inviter) referredBy = inviter.id;
      }
      db.prepare(
        "INSERT INTO users (id, email, country, referral_code, referred_by, status, created_at) VALUES (?,?,?,?,?, 'active', ?)",
      ).run(id, email, "Pakistan", referralCode, referredBy, now());
      if (referredBy) {
        db.prepare(
          "INSERT INTO referrals (id, referrer_user_id, referred_user_id, created_at, bonus_paid) VALUES (?,?,?,?,0)",
        ).run(newId(), referredBy, id, now());
      }
      user = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
    }

    return { token: signToken(user.id), user: publicUser(user) };
  });

  // Who am I (used by the app after it has a token)
  app.get("/auth/me", async (req, reply) => {
    try {
      const userId = getUserId(req);
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
      if (!user) return reply.code(404).send({ error: "User not found" });
      return { user: publicUser(user) };
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 401).send({ error: err.message ?? "Not signed in" });
    }
  });
}

// Referrals table is created lazily here to keep db.ts focused on core money tables.
db.exec(`
  CREATE TABLE IF NOT EXISTS referrals (
    id                TEXT PRIMARY KEY,
    referrer_user_id  TEXT NOT NULL REFERENCES users(id),
    referred_user_id  TEXT NOT NULL REFERENCES users(id),
    created_at        TEXT NOT NULL,
    bonus_paid        INTEGER NOT NULL DEFAULT 0
  );
`);
