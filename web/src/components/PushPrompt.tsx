"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "./ui";
import { BellIcon, XIcon } from "./icons";
import { useI18n } from "@/lib/i18n";
import { fetchPushConfig } from "@/lib/api";
import { enablePush, pushSupported } from "@/lib/push";

// A proactive, once-in-a-while nudge to turn push notifications on — the
// founder's own ask (2026-09-05): "you can allow the user get one time
// permission for push notifications in a very decent manner... not like a
// big big banner". The notifications TOGGLE has existed since 2026-07-13
// (NotificationsCard, on /help, /profile/settings and the withdraw success
// screen) — but it only ever helped someone who already went looking for it.
// Real money/reward/mining news (see push.ts's header) is worth surfacing
// the option for, once, without being asked.
//
// Modelled directly on InstallPrompt.tsx's own timing pattern (visible-time
// counter carried in localStorage across visits, a snooze on dismissal) —
// same "decent" shape the founder has already seen and approved for install.
// The browser's own permission prompt can only ever be shown from a tap, so
// this is a small card asking first, never Notification.requestPermission()
// called on page load.
const MIN_SECONDS_ON_SITE = 25 * 60; // "after twenty or thirty minutes"
const TICK_SECONDS = 15;
const SNOOZE_HOURS = 72; // "show that notification permission after every seventy two hours"

const KEY_SECONDS = "rozipay.push.seconds";
const KEY_SNOOZE = "rozipay.push.snoozeUntil";

function readNumber(key: string): number {
  try {
    return Number(window.localStorage.getItem(key)) || 0;
  } catch {
    return 0; // private mode — the timer just restarts, no crash
  }
}
function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode — nothing to persist to */
  }
}

// `suppressed` lets a sibling prompt (InstallPrompt) hold this one back so the
// two floating cards never stack above the tab bar at the same time — the
// timer keeps running underneath either way, so nothing is lost by waiting.
export function PushPrompt({ suppressed = false }: { suppressed?: boolean } = {}) {
  const { t } = useI18n();
  const [ready, setReady] = useState(false); // time earned, not snoozed
  const [gone, setGone] = useState(false);
  const [enabled, setEnabled] = useState(false); // server config + browser support, checked once
  const [busy, setBusy] = useState(false);

  // Nothing to offer if push can't work here at all: no VAPID keys server-side,
  // no push support in this browser (iOS Safari outside the installed app), or
  // the user already decided (granted -> NotificationsCard already covers them;
  // denied -> the browser will never let us ask again).
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!pushSupported()) return;
      if (typeof Notification !== "undefined" && Notification.permission !== "default") return;
      const cfg = await fetchPushConfig().catch(() => null);
      if (alive && cfg?.enabled && cfg.publicKey) setEnabled(true);
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let seconds = 0;
    let timer = 0;
    const start = window.setTimeout(() => {
      if (readNumber(KEY_SNOOZE) > Date.now()) return; // asked recently — leave them alone
      seconds = readNumber(KEY_SECONDS);
      if (seconds >= MIN_SECONDS_ON_SITE) {
        setReady(true);
        return;
      }
      timer = window.setInterval(() => {
        if (document.visibilityState !== "visible") return;
        seconds += TICK_SECONDS;
        write(KEY_SECONDS, String(seconds));
        if (seconds >= MIN_SECONDS_ON_SITE) setReady(true);
      }, TICK_SECONDS * 1000);
    }, 0);

    return () => {
      window.clearTimeout(start);
      window.clearInterval(timer);
    };
  }, [enabled]);

  const snooze = useCallback(() => {
    write(KEY_SNOOZE, String(Date.now() + SNOOZE_HOURS * 60 * 60 * 1000));
    setGone(true);
  }, []);

  const allow = useCallback(async () => {
    setBusy(true);
    try {
      await enablePush();
      // Whatever the outcome (on, or the user hit "not now" in the real browser
      // dialog), there is nothing more this card can do — the browser itself
      // now owns re-asking, or has permanently refused. Either way, snooze so
      // it doesn't reappear the same visit.
      write(KEY_SNOOZE, String(Date.now() + SNOOZE_HOURS * 60 * 60 * 1000));
      setGone(true);
    } finally {
      setBusy(false);
    }
  }, []);

  if (!enabled || gone || !ready || suppressed) return null;

  return (
    <div
      role="dialog"
      aria-label={t("push.prompt.title")}
      className="fixed inset-x-0 z-50 mx-auto w-full max-w-[480px] animate-rise p-3"
      style={{ bottom: "calc(var(--bottomnav-h) + env(safe-area-inset-bottom))" }}
    >
      <div className="relative rounded-2xl border border-line bg-card p-4 shadow-[0_-6px_24px_rgba(8,47,54,0.14)]">
        <button
          type="button"
          onClick={snooze}
          aria-label={t("push.prompt.later")}
          className="absolute end-3 top-3 rounded-lg p-1 text-muted hover:bg-brand-tint"
        >
          <XIcon size={20} />
        </button>

        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
            <BellIcon size={22} />
          </span>
          <div className="min-w-0 pe-6">
            <h2 className="font-display font-bold text-brand-ink">{t("push.prompt.title")}</h2>
            <p className="mt-1 text-sm text-muted">{t("push.prompt.body")}</p>
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <Button onClick={snooze} variant="ghost" size="md" disabled={busy}>
            {t("push.prompt.later")}
          </Button>
          <Button onClick={allow} size="md" disabled={busy}>
            {busy ? t("notify.enabling") : t("push.prompt.cta")}
          </Button>
        </div>
      </div>
    </div>
  );
}
