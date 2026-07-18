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
    if (getToken()) return; // already signed in on this device

    let cancelled = false;
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
