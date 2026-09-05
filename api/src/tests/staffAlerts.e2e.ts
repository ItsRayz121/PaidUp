// Staff alert recipients: named Telegram DMs instead of a shared group
// (founder, 2026-09-05). See alerts.ts and routes/staffAlerts.ts for why:
// Telegram has no "look up by username" API for a private chat, so
// telegram_bot_contacts (built entirely from real webhook traffic) is the
// only way to know whether someone can be DMed at all.
//
//   npm run test:staffalerts
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId } from "../db.ts";
import { config } from "../config.ts";
import { telegramWebhookRoutes } from "../routes/telegramWebhook.ts";
import { staffAlertsRoutes } from "../routes/staffAlerts.ts";
import { alertsArmed, sendStaffAlert } from "../alerts.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
config.telegramBotToken = "test-bot-token";
config.telegramWebhookSecret = "test-webhook-secret";
config.telegramAlertChatId = ""; // isolate from the legacy group fallback path

const app = Fastify();
await app.register(telegramWebhookRoutes);
await app.register(staffAlertsRoutes);

const TAG = newId().slice(0, 8);
const authOf = (id: string) => ({ authorization: `Bearer ${jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: "1h" })}` });

let seq = 0;
async function mkUser(label: string) {
  const id = newId();
  await sql.run(
    `INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at)
     VALUES (?,?,1,'Pakistan',?,'active',?)`,
    id, `${TAG}-${label}@t.test`, `${TAG}${(seq++).toString(36)}`.toUpperCase().slice(0, 12), now(),
  );
  return id;
}
async function mkStaff(label: string, role: string) {
  const id = await mkUser(label);
  await sql.run("INSERT INTO admin_users (user_id, role, created_at) VALUES (?,?,?)", id, role, now());
  return id;
}

const admin = await mkStaff("admin", "admin");
const agent = await mkStaff("agent", "agent");

function webhookPost(body: Record<string, unknown>, secret: string | null = config.telegramWebhookSecret) {
  return app.inject({
    method: "POST", url: "/webhooks/telegram",
    headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {},
    payload: body,
  });
}

const TG_ID = 900000001;
const TG_USERNAME = `${TAG}alerttest`;

// ---------------------------------------------------------------------------
console.log("\n-- webhook: secret verification --");
{
  const wrong = await webhookPost(
    { message: { chat: { type: "private" }, from: { id: TG_ID, username: TG_USERNAME } } }, "wrong-secret",
  );
  check("wrong secret_token is refused", wrong.statusCode === 401);

  const missing = await webhookPost({ message: {} }, null);
  check("no secret header at all is refused", missing.statusCode === 401);
}

// ---------------------------------------------------------------------------
console.log("\n-- webhook: a private message records a contact --");
{
  const r = await webhookPost({
    message: { chat: { type: "private" }, from: { id: TG_ID, username: TG_USERNAME, first_name: "Test", last_name: "Person" } },
  });
  check("ack 200", r.statusCode === 200);
  const row = await sql.get<{ username: string; blocked_at: string | null }>(
    "SELECT username, blocked_at FROM telegram_bot_contacts WHERE telegram_id = ?", String(TG_ID));
  check("contact recorded with a lowercase username", row?.username === TG_USERNAME.toLowerCase(), JSON.stringify(row));
  check("not blocked", row?.blocked_at === null);
}

// ---------------------------------------------------------------------------
console.log("\n-- webhook: a GROUP message does NOT register a contact --");
{
  const GROUP_USER_ID = 900000099;
  await webhookPost({
    message: { chat: { type: "group" }, from: { id: GROUP_USER_ID, username: `${TAG}groupie` } },
  });
  const row = await sql.get("SELECT 1 AS x FROM telegram_bot_contacts WHERE telegram_id = ?", String(GROUP_USER_ID));
  check("a group message never creates a contact (cannot be DMed from this alone)", !row);
}

// ---------------------------------------------------------------------------
console.log("\n-- check endpoint: found vs not found, permission gate --");
{
  const notFound = await app.inject({
    method: "POST", url: "/staff/alerts/recipients/check", headers: authOf(admin),
    payload: { username: `${TAG}nobody` },
  });
  check("unknown username -> found:false", notFound.json().found === false);

  const found = await app.inject({
    method: "POST", url: "/staff/alerts/recipients/check", headers: authOf(admin),
    payload: { username: `@${TG_USERNAME.toUpperCase()}` }, // leading @ and mixed case
  });
  const fd = found.json() as { found: boolean; blocked: boolean };
  check("known username (with @ and mixed case) -> found:true", fd.found === true, JSON.stringify(fd));
  check("...and not blocked", fd.blocked === false);

  check("a non-admin (agent) is refused", (await app.inject({
    method: "POST", url: "/staff/alerts/recipients/check", headers: authOf(agent), payload: { username: TG_USERNAME },
  })).statusCode === 403);
}

// ---------------------------------------------------------------------------
console.log("\n-- add recipient --");
{
  const addUnknown = await app.inject({
    method: "POST", url: "/staff/alerts/recipients", headers: authOf(admin),
    payload: { username: `${TAG}ghost` },
  });
  check("adding someone who never started the bot is refused", addUnknown.statusCode === 400);

  const add = await app.inject({
    method: "POST", url: "/staff/alerts/recipients", headers: authOf(admin),
    payload: { username: TG_USERNAME, label: "Test person" },
  });
  check("adding a real contact succeeds", add.statusCode === 200, add.body);

  const list = await app.inject({ method: "GET", url: "/staff/alerts/recipients", headers: authOf(admin) });
  const recips = (list.json() as { recipients: { telegramId: string; label: string | null }[] }).recipients;
  check("recipient appears in the list", recips.some((r) => r.telegramId === String(TG_ID) && r.label === "Test person"), JSON.stringify(recips));

  check("a non-admin cannot add", (await app.inject({
    method: "POST", url: "/staff/alerts/recipients", headers: authOf(agent), payload: { username: TG_USERNAME },
  })).statusCode === 403);
}

// ---------------------------------------------------------------------------
console.log("\n-- blocked contacts cannot be added, and un-block on restart --");
{
  const BLOCKED_ID = 900000002;
  const BLOCKED_USERNAME = `${TAG}blocker`;
  await webhookPost({ message: { chat: { type: "private" }, from: { id: BLOCKED_ID, username: BLOCKED_USERNAME } } });
  await webhookPost({
    my_chat_member: {
      chat: { id: BLOCKED_ID, type: "private" }, from: { id: BLOCKED_ID, username: BLOCKED_USERNAME },
      new_chat_member: { status: "kicked" },
    },
  });
  const row = await sql.get<{ blocked_at: string | null }>(
    "SELECT blocked_at FROM telegram_bot_contacts WHERE telegram_id = ?", String(BLOCKED_ID));
  check("my_chat_member 'kicked' marks blocked_at", !!row?.blocked_at);

  const checkBlocked = await app.inject({
    method: "POST", url: "/staff/alerts/recipients/check", headers: authOf(admin),
    payload: { username: BLOCKED_USERNAME },
  });
  check("check reports blocked:true", (checkBlocked.json() as { blocked: boolean }).blocked === true);

  const addBlocked = await app.inject({
    method: "POST", url: "/staff/alerts/recipients", headers: authOf(admin),
    payload: { username: BLOCKED_USERNAME },
  });
  check("adding a blocked contact is refused", addBlocked.statusCode === 400);

  // Restart (my_chat_member -> member) clears the block.
  await webhookPost({
    my_chat_member: {
      chat: { id: BLOCKED_ID, type: "private" }, from: { id: BLOCKED_ID, username: BLOCKED_USERNAME },
      new_chat_member: { status: "member" },
    },
  });
  const row2 = await sql.get<{ blocked_at: string | null }>(
    "SELECT blocked_at FROM telegram_bot_contacts WHERE telegram_id = ?", String(BLOCKED_ID));
  check("restarting the bot clears blocked_at", row2?.blocked_at === null);
}

// ---------------------------------------------------------------------------
console.log("\n-- remove recipient --");
{
  const del = await app.inject({ method: "DELETE", url: `/staff/alerts/recipients/${TG_ID}`, headers: authOf(admin) });
  check("remove succeeds", del.statusCode === 200, del.body);
  const list = await app.inject({ method: "GET", url: "/staff/alerts/recipients", headers: authOf(admin) });
  check("recipient is gone from the list",
    !(list.json() as { recipients: { telegramId: string }[] }).recipients.some((r) => r.telegramId === String(TG_ID)));

  const delAgain = await app.inject({ method: "DELETE", url: `/staff/alerts/recipients/${TG_ID}`, headers: authOf(admin) });
  check("removing an unknown recipient is a 404", delAgain.statusCode === 404);

  check("a non-admin cannot remove", (await app.inject({
    method: "DELETE", url: "/staff/alerts/recipients/000", headers: authOf(agent),
  })).statusCode === 403);
}

// ---------------------------------------------------------------------------
console.log("\n-- alertsArmed() / sendStaffAlert() dispatch --");
{
  {
    const saved = config.telegramBotToken;
    config.telegramBotToken = "";
    check("nothing armed with no bot token at all", (await alertsArmed()) === false);
    config.telegramBotToken = saved;
  }
  check("not armed with a bot token but zero recipients", (await alertsArmed()) === false);

  // Re-add TG_ID as a recipient for the dispatch tests below.
  await webhookPost({ message: { chat: { type: "private" }, from: { id: TG_ID, username: TG_USERNAME } } });
  const readd = await app.inject({
    method: "POST", url: "/staff/alerts/recipients", headers: authOf(admin), payload: { username: TG_USERNAME },
  });
  check("re-add for the dispatch tests", readd.statusCode === 200, readd.body);
  check("armed once a non-blocked recipient exists", (await alertsArmed()) === true);

  const sent: { chatId: string; text: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, opts?: RequestInit) => {
    const body = JSON.parse(String(opts?.body ?? "{}")) as { chat_id: string; text: string };
    sent.push({ chatId: String(body.chat_id), text: body.text });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  await sendStaffAlert("test alert body");
  globalThis.fetch = originalFetch;
  check("sendStaffAlert dispatched to the recipient",
    sent.some((s) => s.chatId === String(TG_ID) && s.text === "test alert body"), JSON.stringify(sent));
}

// ---------------------------------------------------------------------------
console.log("\n-- a 403 from Telegram self-heals blocked_at --");
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: false, description: "Forbidden: bot was blocked by the user" }), { status: 403 })
  ) as typeof fetch;
  await sendStaffAlert("will be blocked");
  globalThis.fetch = originalFetch;

  const row = await sql.get<{ blocked_at: string | null }>(
    "SELECT blocked_at FROM telegram_bot_contacts WHERE telegram_id = ?", String(TG_ID));
  check("a 403 response marks the contact blocked", !!row?.blocked_at);

  check("no longer armed once the only recipient is blocked", (await alertsArmed()) === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- the legacy group id still counts as armed on its own --");
{
  config.telegramAlertChatId = "-1001234567890";
  check("armed via the legacy chat id alone, no recipients needed", (await alertsArmed()) === true);
  config.telegramAlertChatId = "";
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
