import type { FastifyInstance } from "fastify";
import { sql, now } from "../db.ts";
import { config } from "../config.ts";

// Inbound Telegram updates — the ONLY way this app learns "this username has
// started the bot". Telegram has no "look up by username" API for a private
// chat, so this webhook IS the lookup: every message (including /start) and
// every block/unblock event that ever arrives here upserts
// telegram_bot_contacts, one row per person who has ever messaged the bot.
// routes/staffAlerts.ts reads that table to decide whether an admin-entered
// username can be added as a staff-alert recipient.
//
// Verified via the secret_token header Telegram echoes back on every request
// once telegram.ts's configureTelegramWebhook() registers it — anyone else
// POSTing here without knowing that secret is refused before touching the
// database.
type TgUser = { id: number; username?: string; first_name?: string; last_name?: string };
type TgUpdate = {
  message?: { chat: { type: string }; from?: TgUser };
  my_chat_member?: {
    chat: { id: number; type: string };
    from: TgUser;
    new_chat_member: { status: string };
  };
};

async function upsertContact(u: TgUser): Promise<void> {
  const id = String(u.id);
  const username = u.username?.trim().toLowerCase() || null;
  const existing = await sql.get<{ telegram_id: string }>(
    "SELECT telegram_id FROM telegram_bot_contacts WHERE telegram_id = ?", id,
  );
  if (existing) {
    await sql.run(
      `UPDATE telegram_bot_contacts
       SET username = ?, first_name = ?, last_name = ?, last_seen_at = ?, blocked_at = NULL
       WHERE telegram_id = ?`,
      username, u.first_name ?? null, u.last_name ?? null, now(), id,
    );
  } else {
    await sql.run(
      `INSERT INTO telegram_bot_contacts
         (telegram_id, username, first_name, last_name, first_seen_at, last_seen_at, blocked_at)
       VALUES (?,?,?,?,?,?,NULL)`,
      id, username, u.first_name ?? null, u.last_name ?? null, now(), now(),
    );
  }
}

export async function telegramWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/telegram", async (req, reply) => {
    // No secret configured => the feature is off; refuse rather than accept
    // unauthenticated writes to the contacts table.
    if (!config.telegramWebhookSecret
      || req.headers["x-telegram-bot-api-secret-token"] !== config.telegramWebhookSecret) {
      return reply.code(401).send({ error: "bad secret" });
    }

    const update = (typeof req.body === "object" && req.body ? req.body : {}) as TgUpdate;
    try {
      // Only a PRIVATE chat with the bot proves "this person can be DMed" —
      // a message in a group the bot happens to sit in says nothing about
      // whether the bot could ever message that person directly.
      if (update.message?.from && update.message.chat.type === "private") {
        await upsertContact(update.message.from);
      }
      if (update.my_chat_member && update.my_chat_member.chat.type === "private") {
        const status = update.my_chat_member.new_chat_member.status;
        const id = String(update.my_chat_member.chat.id);
        if (status === "kicked") {
          await sql.run(
            "UPDATE telegram_bot_contacts SET blocked_at = ? WHERE telegram_id = ?", now(), id,
          );
        } else if (status === "member") {
          // Restarted after blocking, or a first-ever interaction that arrived
          // as this event type rather than a message.
          await upsertContact(update.my_chat_member.from);
          await sql.run(
            "UPDATE telegram_bot_contacts SET blocked_at = NULL WHERE telegram_id = ?", id,
          );
        }
      }
    } catch (e) {
      // A malformed or unexpected update must never break Telegram's delivery
      // loop — log and still ack 200, same fire-and-forget spirit as push.ts.
      console.warn(`Telegram webhook update not processed: ${(e as Error).message}`);
    }
    return reply.code(200).send({ ok: true });
  });
}
