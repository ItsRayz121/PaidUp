"use client";

// Auto sign-in when the app is opened inside Telegram (Mini App). Telegram
// hands us a signed `initData` proving who the user is — no password, no email
// code — and the backend re-verifies the signature server-side. Runs once per
// open; a failure is a quiet no-op and the normal login screen still works.
import { useEffect } from "react";
import { getToken, setSession, loginWithTelegramMiniApp } from "@/lib/api";
import { telegramInitData, telegramReady } from "@/lib/telegram";

export function TelegramBoot() {
  useEffect(() => {
    const initData = telegramInitData();
    if (!initData) return;
    // Tell Telegram we're alive and want the full-height webview.
    telegramReady();
    // A BINDING link (Profile -> Connect Telegram on the website) must log in
    // even over an existing session: the server consumes the one-time code and
    // signs into the website account it belongs to. Once handled, remember it
    // so reloads within this webview don't re-post a spent code.
    const startParam = new URLSearchParams(initData).get("start_param") ?? "";
    const binding =
      startParam.startsWith("link-") &&
      sessionStorage.getItem("tg-link-done") !== startParam;
    if (getToken() && !binding) return; // already signed in on this device

    let cancelled = false;
    if (binding) {
      try { sessionStorage.setItem("tg-link-done", startParam); } catch { /* private mode */ }
    }
    loginWithTelegramMiniApp(initData)
      .then((res) => {
        if (cancelled) return;
        setSession(res.token, res.user);
        // Full reload so every screen re-reads the fresh session — this runs
        // once per Telegram open, so the cost is invisible.
        window.location.replace("/");
      })
      .catch(() => {
        /* fall back to the login screen — never block the app on an ad-hoc
           network failure inside the webview */
      });
    return () => { cancelled = true; };
  }, []);

  return null;
}
