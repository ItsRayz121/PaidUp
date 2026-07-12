"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { Button } from "./ui";
import { XIcon } from "./icons";
import { useI18n } from "@/lib/i18n";

// "Add RoziPay to your phone" — the web app installs to the home screen and
// opens like a normal app. It is NOT an APK: nothing is downloaded and there is
// no Play Store step. The copy has to say that plainly (DESIGN_BRIEF: no jargon,
// never over-promise), because "install" makes people expect a download.
//
// We hold the prompt back until the user has actually spent MIN_SECONDS_ON_SITE
// on the site. Asking a stranger to install in their first seconds is how you
// get a permanent "no" — the browser only ever lets you ask once per snooze, so
// we spend that one ask on someone who has already seen the app work.

const MIN_SECONDS_ON_SITE = 5 * 60;
const TICK_SECONDS = 15;
const SNOOZE_DAYS = 3;

const KEY_SECONDS = "rozipay.pwa.seconds";
const KEY_SNOOZE = "rozipay.pwa.snoozeUntil";

// Chrome fires this instead of showing its own mini-infobar. It is not in the
// DOM lib types (not a cross-browser standard — Safari has no equivalent).
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

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

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari's own flag, predates the standard
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

// iOS has no install API at all: Safari never fires beforeinstallprompt, so the
// only thing we can do is tell the user where the button is.
function isIosSafari(): boolean {
  const ua = window.navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && "ontouchend" in document);
  const webkit = /WebKit/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return ios && webkit;
}

export function InstallPrompt() {
  const { t } = useI18n();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [ready, setReady] = useState(false); // 5 minutes reached, not snoozed
  const [gone, setGone] = useState(false);
  // Read once, at mount. Safe to differ from the server (which has no navigator):
  // the component renders nothing until `ready`, so the hydrated DOM still matches.
  const [ios] = useState(() => typeof window !== "undefined" && isIosSafari());

  // The app is only installable over HTTPS with a service worker that answers
  // offline. Dev is skipped: a worker caching /_next/static would fight HMR.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* worker failed: the site still works, it just won't be installable */
    });
  }, []);

  useEffect(() => {
    if (isStandalone()) return; // already installed — never nag

    const onBeforeInstall = (e: Event) => {
      e.preventDefault(); // stop Chrome's own banner; we show ours on our schedule
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setGone(true);
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    // Count only time the tab is actually in front, and carry it across visits:
    // "5 minutes with the app" is the signal, not "5 minutes since page load".
    // The first read is deferred by a tick so no state is set while the effect
    // is still running (that cascades renders).
    let seconds = 0;
    let timer = 0;
    const start = window.setTimeout(() => {
      if (readNumber(KEY_SNOOZE) > Date.now()) return; // asked recently — leave them alone
      seconds = readNumber(KEY_SECONDS);
      if (seconds >= MIN_SECONDS_ON_SITE) {
        setReady(true);
        return; // already earned the ask; no need to keep counting
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
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismiss = useCallback(() => {
    write(KEY_SNOOZE, String(Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000));
    setGone(true);
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt(); // hands over to the browser's real install dialog
    const { outcome } = await deferred.userChoice;
    setDeferred(null);
    setGone(true);
    // Said no? Don't ask again for a few days. Said yes? "appinstalled" handles it.
    if (outcome === "dismissed") write(KEY_SNOOZE, String(Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000));
  }, [deferred]);

  // Nothing to offer: not installable here (or already installed), or too early.
  if (gone || !ready || (!deferred && !ios)) return null;

  return (
    <div
      role="dialog"
      aria-label={t("install.title")}
      className="fixed inset-x-0 z-50 mx-auto w-full max-w-[480px] animate-rise p-3"
      // Floats above the tab bar rather than over it — a sheet that sits there
      // until dismissed must never block Home/Tasks/Wallet.
      style={{ bottom: "calc(var(--bottomnav-h) + env(safe-area-inset-bottom))" }}
    >
      <div className="relative rounded-2xl border border-line bg-card p-4 shadow-[0_-6px_24px_rgba(8,47,54,0.14)]">
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("install.later")}
          className="absolute end-3 top-3 rounded-lg p-1 text-muted hover:bg-brand-tint"
        >
          <XIcon size={20} />
        </button>

        <div className="flex items-start gap-3">
          <Image
            src="/icons/icon-192.png"
            alt=""
            width={48}
            height={48}
            className="h-12 w-12 shrink-0 rounded-xl"
          />
          <div className="min-w-0 pe-6">
            <h2 className="font-display font-bold text-brand-ink">{t("install.title")}</h2>
            <p className="mt-1 text-sm text-muted">{ios ? t("install.iosBody") : t("install.body")}</p>
          </div>
        </div>

        {!ios && (
          <div className="mt-4 flex gap-2">
            <Button onClick={dismiss} variant="ghost" size="md">
              {t("install.later")}
            </Button>
            <Button onClick={install} size="md">
              {t("install.cta")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
