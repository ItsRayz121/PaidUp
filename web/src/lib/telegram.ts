// Telegram Mini App glue — WITHOUT Telegram's helper script.
//
// The obvious integration loads telegram-web-app.js from telegram.org, but
// Telegram is blocked on many Pakistani networks: for every normal visitor
// that script would be a request to a blackholed host, and inside Telegram
// (reached via VPN/proxy) it could hang exactly when it's needed. So this file
// talks to the webview directly instead — zero external requests:
//
//   • initData arrives in the page URL fragment (#tgWebAppData=...), put there
//     by Telegram itself when it opens a Mini App. We read it straight off the
//     hash and keep it in sessionStorage so client-side navigation and reloads
//     inside the webview don't lose it.
//   • ready/expand events go through the bridge Telegram injects natively
//     (TelegramWebviewProxy on mobile, window.external.notify on desktop,
//     postMessage on Telegram Web) — present before any script runs.
import { useSyncExternalStore } from "react";

const KEY = "tg-init-data";
let cached: string | null = null;

// The signed initData string, or "" when not inside Telegram. Cached: the
// answer cannot change within a page's lifetime, and useSyncExternalStore
// needs a stable snapshot.
export function telegramInitData(): string {
  if (typeof window === "undefined") return "";
  if (cached !== null) return cached;
  let data = "";
  try {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    data = fragment.get("tgWebAppData") ?? "";
    if (data) sessionStorage.setItem(KEY, data);
    else data = sessionStorage.getItem(KEY) ?? "";
  } catch { /* sessionStorage can throw in lockdown modes — treat as browser */ }
  cached = data;
  return data;
}

export function insideTelegram(): boolean {
  return telegramInitData() !== "";
}

// Render-safe version: false during SSR, the real answer on the client.
const subscribeNever = () => () => {};
const serverSnapshot = () => false;
export function useInsideTelegram(): boolean {
  return useSyncExternalStore(subscribeNever, insideTelegram, serverSnapshot);
}

// Speak the webview's native event protocol (what telegram-web-app.js does
// under the hood). Best-effort: on any failure the app simply renders at
// whatever size Telegram gave it.
function postEvent(eventType: string): void {
  const w = window as unknown as {
    TelegramWebviewProxy?: { postEvent: (t: string, d: string) => void };
    external?: { notify?: (s: string) => void };
  };
  try {
    if (w.TelegramWebviewProxy) w.TelegramWebviewProxy.postEvent(eventType, "{}");
    else if (typeof w.external?.notify === "function") {
      w.external.notify(JSON.stringify({ eventType, eventData: {} }));
    } else if (window.parent !== window) {
      // Telegram Web runs Mini Apps in an iframe. The message carries no
      // secrets (it's "I'm ready"), so the wildcard target is fine.
      window.parent.postMessage(JSON.stringify({ eventType, eventData: {} }), "*");
    }
  } catch { /* no bridge — not a real Telegram webview */ }
}

// Tell Telegram the app is alive and wants the full-height webview.
export function telegramReady(): void {
  if (!insideTelegram()) return;
  postEvent("web_app_ready");
  postEvent("web_app_expand");
}
