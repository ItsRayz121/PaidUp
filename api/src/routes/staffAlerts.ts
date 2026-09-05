// Staff alert recipients — who gets paged over Telegram DM (2026-09-05).
//
// Replaces the old shared-group design (alerts.ts's header explains why).
// A super admin types a Telegram @username; this checks it against
// telegram_bot_contacts (built by routes/telegramWebhook.ts from real
// incoming messages — there is no "look up by username" API, so that table
// IS the lookup) and only allows adding someone who has actually started the
// bot and has not blocked it. Nothing here can ever DM someone who has not
// done that first — the check is re-run server-side on add, never trusted
// from an earlier client-side check.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { sql, now, logAudit } from "../db.ts";
import { requirePermission, type Role, type Permission } from "../roles.ts";

function staffGuard(
  perm: Permission,
  handler: (ctx: { userId: string; role: Role }, req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await handler(await requirePermission(req, perm), req, reply);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Something went wrong" });
    }
  };
}

// Accepts "@name", "name", mixed case — Telegram usernames are
// case-insensitive and stored lowercase in telegram_bot_contacts.
function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

type ContactRow = {
  telegram_id: string; username: string | null; first_name: string | null;
  last_name: string | null; last_seen_at: string; blocked_at: string | null;
};

async function findContactByUsername(username: string): Promise<ContactRow | null> {
  return (await sql.get<ContactRow>(
    `SELECT telegram_id, username, first_name, last_name, last_seen_at, blocked_at
     FROM telegram_bot_contacts WHERE username = ?`, username,
  )) ?? null;
}

function nameOf(c: Pick<ContactRow, "first_name" | "last_name">): string {
  return [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
}

export async function staffAlertsRoutes(app: FastifyInstance) {
  app.get("/staff/alerts/recipients", staffGuard("alerts.manage", async () => {
    const rows = await sql.all<{
      telegram_id: string; username_snapshot: string | null; label: string | null; added_at: string;
      username: string | null; first_name: string | null; last_name: string | null;
      last_seen_at: string; blocked_at: string | null;
    }>(
      `SELECT r.telegram_id, r.username_snapshot, r.label, r.added_at,
              c.username, c.first_name, c.last_name, c.last_seen_at, c.blocked_at
       FROM staff_alert_recipients r
       JOIN telegram_bot_contacts c ON c.telegram_id = r.telegram_id
       ORDER BY r.added_at DESC`,
    );
    return {
      recipients: rows.map((r) => ({
        telegramId: r.telegram_id,
        username: r.username ?? r.username_snapshot,
        name: nameOf(r) || null,
        label: r.label,
        addedAt: r.added_at,
        lastSeenAt: r.last_seen_at,
        blocked: Boolean(r.blocked_at),
      })),
    };
  }));

  const usernameSchema = z.object({ username: z.string().min(1).max(64) });

  // Look-before-you-add: tells the admin whether this person can be added at
  // all, before they commit to it. Read-only — does not touch the table.
  app.post("/staff/alerts/recipients/check", staffGuard("alerts.manage", async (_ctx, req, reply) => {
    const parsed = usernameSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter a Telegram username." });
    const username = normalizeUsername(parsed.data.username);
    if (!username) return reply.code(400).send({ error: "Enter a Telegram username." });

    const contact = await findContactByUsername(username);
    if (!contact) {
      return {
        found: false,
        note: "This person has not started the bot yet. Ask them to open the bot in Telegram and press Start, then check again.",
      };
    }
    return {
      found: true,
      telegramId: contact.telegram_id,
      username: contact.username,
      name: nameOf(contact) || null,
      blocked: Boolean(contact.blocked_at),
      lastSeenAt: contact.last_seen_at,
    };
  }));

  const addSchema = z.object({
    username: z.string().min(1).max(64),
    label: z.string().max(80).optional(),
  });

  app.post("/staff/alerts/recipients", staffGuard("alerts.manage", async ({ userId, role }, req, reply) => {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter a Telegram username." });
    const username = normalizeUsername(parsed.data.username);
    if (!username) return reply.code(400).send({ error: "Enter a Telegram username." });

    // Re-verified here, never trusted from the /check response — a client
    // could be stale by the time "Add" is pressed.
    const contact = await findContactByUsername(username);
    if (!contact) {
      return reply.code(400).send({
        error: "This person has not started the bot yet — ask them to press Start on the bot, then try again.",
      });
    }
    if (contact.blocked_at) {
      return reply.code(400).send({ error: "This person has blocked the bot, so it cannot message them." });
    }

    await sql.run(
      `INSERT INTO staff_alert_recipients (telegram_id, username_snapshot, label, added_by, added_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT (telegram_id) DO UPDATE
         SET username_snapshot = EXCLUDED.username_snapshot, label = EXCLUDED.label`,
      contact.telegram_id, contact.username, parsed.data.label ?? null, userId, now(),
    );
    await logAudit({
      actorUserId: userId, actorRole: role, action: "staff_alert_recipient_add",
      detail: `@${contact.username ?? contact.telegram_id}`, actorIp: req.ip,
    });
    return {
      ok: true,
      recipient: {
        telegramId: contact.telegram_id, username: contact.username,
        name: nameOf(contact) || null, label: parsed.data.label ?? null,
      },
    };
  }));

  app.delete("/staff/alerts/recipients/:telegramId", staffGuard("alerts.manage", async ({ userId, role }, req, reply) => {
    const telegramId = (req.params as { telegramId: string }).telegramId;
    const existing = await sql.get<{ username_snapshot: string | null }>(
      "SELECT username_snapshot FROM staff_alert_recipients WHERE telegram_id = ?", telegramId,
    );
    if (!existing) return reply.code(404).send({ error: "That recipient is not on the list." });

    await sql.run("DELETE FROM staff_alert_recipients WHERE telegram_id = ?", telegramId);
    await logAudit({
      actorUserId: userId, actorRole: role, action: "staff_alert_recipient_remove",
      detail: `@${existing.username_snapshot ?? telegramId}`, actorIp: req.ip,
    });
    return { ok: true };
  }));
}
