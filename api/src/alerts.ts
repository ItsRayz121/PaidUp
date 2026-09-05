// Staff paging over Telegram — the compensating control for a gap the docs
// have named repeatedly: "there is no paging in this codebase, so a mismatch
// sits until a human opens the panel" (deposits/reconcile.ts, Sentry declined
// per CLAUDE.md). This does not replace a real on-call system; it is the
// cheapest thing that turns "nobody knows" into "a message exists somewhere."
//
// Reuses the SAME bot as the login/mini-app integration (telegram.ts) — a
// second bot would be a second token to create and rotate for no benefit.
//
// ⚠️ REDESIGNED 2026-09-05 (founder): the original version paged one shared
// Telegram GROUP. The founder pointed out a group risks being (or becoming)
// more public than a fraud/reconciliation alert should ever reach, and asked
// for named individuals instead — the same shape as the admin-email
// allowlist, extended to Telegram. Recipients now live in
// staff_alert_recipients (managed in /staff -> Feature flags -> Staff alerts,
// routes/staffAlerts.ts) and are only addable once telegram_bot_contacts
// proves that person has actually started the bot (routes/telegramWebhook.ts
// is what builds that directory — there is no "look up by username" API).
// TELEGRAM_ALERT_CHAT_ID is kept as a legacy fallback so nothing silently
// stops working mid-migration; once every intended recipient is added as a
// named DM, that env var should be cleared.
//
// Design rules, the same shape as push.ts:
//   • Fire-and-forget. An alert failing to send must NEVER fail the fraud
//     check, postback, or reconciliation tick that raised it.
//   • Feature-flagged: no bot token, no group id, and no live recipients =>
//     a quiet no-op.
import { config } from "./config.ts";
import { sql, now } from "./db.ts";

// Is ANYTHING configured to receive a page — the legacy group, or at least
// one non-blocked DM recipient? Async because recipients live in the DB, not
// config; used by the "Send test alert" button to tell an admin whether
// alerting is armed at all before they rely on it.
export async function alertsArmed(): Promise<boolean> {
  if (!config.telegramBotToken) return false;
  if (config.telegramAlertChatId) return true;
  const row = await sql.get<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM staff_alert_recipients r
     JOIN telegram_bot_contacts c ON c.telegram_id = r.telegram_id
     WHERE c.blocked_at IS NULL`,
  );
  return (row?.n ?? 0) > 0;
}

async function sendOne(chatId: string, text: string): Promise<void> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 403) {
      // "Forbidden: bot was blocked by the user" — self-heal so a future
      // alert does not keep paying the round trip to someone who can never
      // receive it. The webhook clears this the moment they message again.
      await sql.run(
        "UPDATE telegram_bot_contacts SET blocked_at = ? WHERE telegram_id = ?", now(), chatId,
      ).catch(() => {});
      return;
    }
    if (!r.ok) {
      console.warn(`Staff Telegram alert failed: HTTP ${r.status} ${await r.text().catch(() => "")}`);
    }
  } catch (e) {
    console.warn(`Staff Telegram alert failed: ${(e as Error).message}`);
  }
}

export async function sendStaffAlert(text: string): Promise<void> {
  if (!config.telegramBotToken) return;

  const targets: string[] = [];
  if (config.telegramAlertChatId) targets.push(config.telegramAlertChatId);
  try {
    const rows = await sql.all<{ telegram_id: string }>(
      `SELECT r.telegram_id FROM staff_alert_recipients r
       JOIN telegram_bot_contacts c ON c.telegram_id = r.telegram_id
       WHERE c.blocked_at IS NULL`,
    );
    targets.push(...rows.map((row) => row.telegram_id));
  } catch (e) {
    // A DB hiccup here must not also take down the fraud/reconciliation check
    // that called this — same fire-and-forget rule as everything else here.
    console.warn(`Staff alert recipient lookup failed: ${(e as Error).message}`);
  }
  if (!targets.length) return;

  await Promise.all(targets.map((t) => sendOne(t, text)));
}
