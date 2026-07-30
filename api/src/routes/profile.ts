// Profile — the user's own name, handle and picture (founder, 2026-07-29).
//
// Three fields, and they are NOT the same kind of thing:
//
//   display_name  cosmetic. Free to change, whenever. Nothing depends on it.
//   username      the PUBLIC HANDLE other people send ROZI to. Unique, and
//                 changeable only once every 30 days.
//   avatar        a picture, stored in its own table.
//
// THE COOLDOWN ON THE HANDLE IS A SECURITY CONTROL, not a product rule the
// founder happened to ask for. A handle that can be swapped freely is a scam
// vector with a name: take a handle someone is known by, collect the transfers
// meant for them, release it, repeat. Thirty days makes that attack cost thirty
// days per attempt, which is enough to kill it. If a future ticket asks to relax
// this, it needs to answer that attack first.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { sql, now } from "../db.ts";
import { getUserId, requireActiveUser } from "../auth.ts";
import { parseDataUrl } from "../kyc.ts";

function guard(
  handler: (userId: string, req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = getUserId(req);
      await requireActiveUser(userId);
      return await handler(userId, req, reply);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Something went wrong" });
    }
  };
}

export const USERNAME_COOLDOWN_DAYS = 30;

// A profile picture is shown at 56px. 150KB is already generous for that, and it
// is two orders of magnitude below the KYC limit on purpose: these are served
// back to the owner constantly, where an ID photo is opened once by one reviewer.
const AVATAR_MAX_BYTES = 150 * 1024;

// Handles people will type into a "send money to" box, so the character set is
// deliberately boring: no dots (they read as file extensions), no dashes (they
// read as hyphenated line breaks), no unicode (a Cyrillic "а" in a Latin handle
// is a different account that looks identical — the classic homograph attack on
// exactly this kind of field).
const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/;

// Names nobody may take, because a transfer to "support" or "rozipay" must never
// land in a real user's wallet, and a leaderboard row reading "admin" is a
// ready-made phishing tool.
const RESERVED = new Set([
  "admin", "administrator", "root", "system", "staff", "support", "help",
  "rozipay", "rozi", "official", "team", "moderator", "mod", "security",
  "wallet", "money", "payment", "payments", "withdraw", "bot", "null", "undefined",
]);

export function validateUsername(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.trim().toLowerCase();
  if (!USERNAME_RE.test(value)) {
    return {
      ok: false,
      error: "Use 3 to 20 letters, numbers or _. Start with a letter.",
    };
  }
  if (RESERVED.has(value)) return { ok: false, error: "That name is not available." };
  return { ok: true, value };
}

// When this user may next change their handle. null = right now.
export function nextUsernameChangeAt(changedAt: string | null): string | null {
  if (!changedAt) return null;
  const next = Date.parse(changedAt) + USERNAME_COOLDOWN_DAYS * 86_400_000;
  return next > Date.now() ? new Date(next).toISOString() : null;
}

type ProfileRow = {
  display_name: string | null;
  username: string | null;
  username_changed_at: string | null;
};

export async function profileRoutes(app: FastifyInstance) {
  app.get("/profile", guard(async (userId) => {
    const [me, avatar] = await Promise.all([
      sql.get<ProfileRow>(
        "SELECT display_name, username, username_changed_at FROM users WHERE id = ?", userId),
      sql.get<{ user_id: string }>("SELECT user_id FROM user_avatars WHERE user_id = ?", userId),
    ]);
    return {
      displayName: me?.display_name ?? null,
      username: me?.username ?? null,
      // The UI needs both: whether the field is open, and when it opens again.
      // Showing a locked field with no date is the version of this screen people
      // write support tickets about.
      usernameLockedUntil: nextUsernameChangeAt(me?.username_changed_at ?? null),
      cooldownDays: USERNAME_COOLDOWN_DAYS,
      hasAvatar: Boolean(avatar),
    };
  }));

  const patchSchema = z.object({
    displayName: z.string().trim().min(1).max(30).optional(),
    username: z.string().trim().min(1).max(30).optional(),
  });

  app.patch("/profile", guard(async (userId, req, reply) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Check what you typed." });
    const { displayName, username } = parsed.data;
    if (displayName === undefined && username === undefined) {
      return reply.code(400).send({ error: "Nothing to change." });
    }

    const me = await sql.get<ProfileRow>(
      "SELECT display_name, username, username_changed_at FROM users WHERE id = ?", userId);
    if (!me) return reply.code(404).send({ error: "Account not found." });

    // Display name: cosmetic, so it just goes in.
    if (displayName !== undefined) {
      await sql.run("UPDATE users SET display_name = ? WHERE id = ?", displayName, userId);
    }

    if (username !== undefined) {
      const check = validateUsername(username);
      if (!check.ok) return reply.code(400).send({ error: check.error });

      // Re-submitting the handle you already have is a no-op, NOT a change that
      // burns the 30-day window. Someone who edits their display name on a form
      // that also carries their existing handle must not lose a month for it.
      if (check.value !== (me.username ?? "")) {
        // A HANDLE MAY NOT COLLIDE WITH SOMEONE'S INVITE CODE, and this is a
        // theft check rather than a tidiness one.
        //
        // Invite codes are up-to-6 uppercase letters plus two digits
        // ("AHMED42"), which lower-cases to "ahmed42" — a legal handle. Both are
        // accepted as "send ROZI to" targets, and /mine/receive tells users to
        // share their invite code precisely so people can pay them. Without this
        // check an attacker takes the lowercase form of a victim's published
        // code as their own handle and receives transfers meant for them.
        //
        // The unique index on LOWER(username) cannot catch this: it compares
        // usernames to usernames. The two namespaces have to be checked against
        // each other explicitly, here.
        const clash = await sql.get<{ id: string }>(
          "SELECT id FROM users WHERE LOWER(referral_code) = ? AND id <> ?",
          check.value, userId,
        );
        if (clash) return reply.code(409).send({ error: "That name is not available." });

        const lockedUntil = nextUsernameChangeAt(me.username_changed_at);
        if (lockedUntil) {
          return reply.code(429).send({
            error: `You can change your username once every ${USERNAME_COOLDOWN_DAYS} days.`,
            lockedUntil,
          });
        }
        try {
          await sql.run(
            "UPDATE users SET username = ?, username_changed_at = ? WHERE id = ?",
            check.value, now(), userId,
          );
        } catch {
          // The unique index on LOWER(username) is what actually decides this —
          // a SELECT-then-INSERT check would let two people racing for the same
          // handle both pass it. Whoever loses gets told the truth.
          return reply.code(409).send({ error: "Someone already has that name. Try another." });
        }
      }
    }

    const fresh = await sql.get<ProfileRow>(
      "SELECT display_name, username, username_changed_at FROM users WHERE id = ?", userId);
    return {
      displayName: fresh?.display_name ?? null,
      username: fresh?.username ?? null,
      usernameLockedUntil: nextUsernameChangeAt(fresh?.username_changed_at ?? null),
    };
  }));

  // ---- Picture --------------------------------------------------------------

  app.get("/profile/avatar", guard(async (userId) => {
    const row = await sql.get<{ image: string }>(
      "SELECT image FROM user_avatars WHERE user_id = ?", userId);
    return { image: row?.image ?? null };
  }));

  app.put("/profile/avatar", guard(async (userId, req, reply) => {
    const parsed = z.object({ image: z.string().min(1).max(400_000) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Pick a photo first." });

    // Reuses the KYC parser, which sniffs MAGIC BYTES rather than trusting the
    // data: URL's declared type. That matters more here than it does for KYC:
    // an avatar is served back into a page, so a file claiming to be a JPEG and
    // actually being `<svg onload=…>` would be stored XSS. The sniff is what
    // makes that a 400 instead.
    const { bytes, mime } = parseDataUrl(parsed.data.image, "profile");
    if (bytes.length > AVATAR_MAX_BYTES) {
      return reply.code(413).send({ error: "That photo is too big. Try a smaller one." });
    }

    // Re-encoded from the sniffed bytes, so what we store can only ever be the
    // image we verified — never whatever prefix the client put in front of it.
    const clean = `data:${mime};base64,${bytes.toString("base64")}`;
    await sql.run(
      `INSERT INTO user_avatars (user_id, image, updated_at) VALUES (?,?,?)
       ON CONFLICT (user_id) DO UPDATE SET image = excluded.image, updated_at = excluded.updated_at`,
      userId, clean, now(),
    );
    return { ok: true };
  }));

  app.delete("/profile/avatar", guard(async (userId) => {
    await sql.run("DELETE FROM user_avatars WHERE user_id = ?", userId);
    return { ok: true };
  }));
}
