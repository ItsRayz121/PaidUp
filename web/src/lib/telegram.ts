// Telegram Mini App glue.
//
// The app is ONE codebase: the same site, opened inside Telegram's webview,
// detects that fact and adapts (auto-login from signed initData, no install
// prompt, rewarded video ads instead of the direct link). Detection needs
// Telegram's own script — loaded in the root layout — which populates
// window.Telegram.WebApp only when actually running inside Telegram.
import { useSyncExternalStore } from "react";

type TelegramWebApp = {
  // Signed querystring proving which Telegram user opened the app. Empty when
  // the site runs in a normal browser (even with the script loaded).
  initData: string;
  ready?: () => void;
  expand?: () => void;
};

export function tgWebApp(): TelegramWebApp | null {
  if (typeof window === "undefined") return null;
  const wa = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
  return wa && wa.initData ? wa : null;
}

export function insideTelegram(): boolean {
  return tgWebApp() !== null;
}

// Render-safe version: false during SSR and hydration, the real answer right
// after (Telegram's script is beforeInteractive, so it never appears "later").
// useSyncExternalStore is the sanctioned way to read a browser-only global
// without a setState-in-effect cascade.
const subscribeNever = () => () => {};
const serverSnapshot = () => false;
export function useInsideTelegram(): boolean {
  return useSyncExternalStore(subscribeNever, insideTelegram, serverSnapshot);
}
