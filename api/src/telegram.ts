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
