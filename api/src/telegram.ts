// Telegram bot self-configuration.
//
// api.telegram.org is BLOCKED on the founder's own network, so anything that
// CAN be configured through the Bot API is done from here — the server (US
// region) reaches Telegram fine. What cannot be automated stays a BotFather
// step (/setdomain for the login widget, enabling the Main Mini App for
// t.me/<bot>?startapp links) — see docs/LAUNCH_CHECKLIST.md § 6.
import { config } from "./config.ts";

// Point the bot's menu button (the button beside the message box in every chat
// with the bot) at the web app, so the bot opens RoziPay in one tap with no
// BotFather ceremony. Idempotent: setting the same button twice is a no-op on
// Telegram's side. Fire-and-forget at boot; a failure only costs the button.
export async function configureTelegramMenuButton(): Promise<void> {
  const token = config.telegramBotToken;
  if (!token) return;
  // Telegram refuses non-HTTPS web_app URLs, so local dev (localhost) skips.
  const url = config.webOrigins.find((o) => o.startsWith("https://"));
  if (!url) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        menu_button: { type: "web_app", text: "Open RoziPay", web_app: { url } },
      }),
      signal: AbortSignal.timeout(8000),
    });
    const j = (await r.json()) as { ok?: boolean; description?: string };
    if (j.ok) console.log(`Telegram menu button -> ${url}`);
    else console.warn(`Telegram menu button not set: ${j.description ?? r.status}`);
  } catch (e) {
    console.warn(`Telegram menu button not set: ${(e as Error).message}`);
  }
}

// ---- Backfilling a Telegram identity (founder, 2026-09-03) ----------------
// Staff screens showed rows reading "Telegram user" because two things were
// true: the website-side "Connect Telegram" path never stored a username (now
// fixed in auth.ts), and accounts that predate those columns were never
// backfilled. Nothing about a normal login can fix an account that is not
// logging in right now — but the Bot API can be asked directly.
//
// `getChat` on a user id works for any user who has ever started the bot,
// which every Mini App and binding-link user has by definition.
export type TelegramChatIdentity = { username: string | null; name: string | null };

export async function fetchTelegramChatIdentity(
  telegramId: string,
): Promise<TelegramChatIdentity | null> {
  const token = config.telegramBotToken;
  if (!token) return null;
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(telegramId)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    const j = (await r.json()) as {
      ok?: boolean;
      result?: { username?: string; first_name?: string; last_name?: string };
    };
    if (!j.ok || !j.result) return null;
    const name = [j.result.first_name, j.result.last_name].filter(Boolean).join(" ").trim();
    return { username: j.result.username?.trim() || null, name: name || null };
  } catch {
    // A Telegram outage must never be an error on a staff screen. The caller
    // reports "not found" for this one id and carries on with the rest.
    return null;
  }
}
