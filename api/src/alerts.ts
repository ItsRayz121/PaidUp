// Staff paging over Telegram — the compensating control for a gap the docs
// have named repeatedly: "there is no paging in this codebase, so a mismatch
// sits until a human opens the panel" (deposits/reconcile.ts, Sentry declined
// per CLAUDE.md). This does not replace a real on-call system; it is the
// cheapest thing that turns "nobody knows" into "a message exists somewhere."
//
// Reuses the SAME bot as the login/mini-app integration (telegram.ts) — a
// second bot would be a second token to create and rotate for no benefit.
//
// Design rules, the same shape as push.ts:
//   • Fire-and-forget. An alert failing to send must NEVER fail the fraud
//     check, postback, or reconciliation tick that raised it.
//   • Feature-flagged: no TELEGRAM_ALERT_CHAT_ID => a quiet no-op. The bot
//     token alone is not enough to alert anyone — see .env.example for how
//     to get a chat id.
import { config } from "./config.ts";

export const alertsEnabled = Boolean(config.telegramBotToken && config.telegramAlertChatId);

export async function sendStaffAlert(text: string): Promise<void> {
  if (!alertsEnabled) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.telegramAlertChatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      console.warn(`Staff Telegram alert failed: HTTP ${r.status} ${await r.text().catch(() => "")}`);
    }
  } catch (e) {
    console.warn(`Staff Telegram alert failed: ${(e as Error).message}`);
  }
}
