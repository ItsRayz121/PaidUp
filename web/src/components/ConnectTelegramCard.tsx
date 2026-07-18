"use client";

// One person, one account, two doors (founder, 2026-07-18). This card lets a
// signed-in user connect their Telegram to THIS account, so opening RoziPay
// inside Telegram lands on the same points and the same history:
//   • inside the Telegram Mini App: one tap — the webview's signed initData
//     proves which Telegram is asking.
//   • on the website: a BINDING LINK (founder-corrected flow) — we mint a
//     one-time code, t.me/<bot>?startapp=link-<code> opens the Telegram APP,
//     and the Mini App login binds + signs in over there. No Telegram login
//     form, ever; while they're away this card polls until the account comes
//     back connected.
// Renders NOTHING when there is nothing to do — never an orphan card.
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Button } from "./ui";
import { TelegramIcon, CheckIcon } from "./icons";
import { useI18n } from "@/lib/i18n";
import {
  linkTelegram, createTelegramLinkCode, fetchTelegramConfig, fetchMe,
  getToken, setSession, type SessionUser,
} from "@/lib/api";
import { telegramInitData, useInsideTelegram } from "@/lib/telegram";

export function ConnectTelegramCard({ user }: { user: SessionUser }) {
  const { t } = useI18n();
  const inTelegram = useInsideTelegram();
  const [linked, setLinked] = useState(Boolean(user.hasTelegram));
  const [bot, setBot] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let gone = false;
    fetchTelegramConfig()
      .then((c) => { if (!gone && c.enabled && c.botUsername) setBot(c.botUsername); })
      .catch(() => { /* API hiccup — card hides, profile still works */ });
    return () => { gone = true; };
  }, []);

  // Stop polling when the card unmounts.
  useEffect(() => () => { if (pollTimer.current) clearInterval(pollTimer.current); }, []);

  const finish = useCallback((u: SessionUser) => {
    // Persist the refreshed user so every screen (and the next visit) knows.
    const token = getToken();
    if (token) setSession(token, u);
    setLinked(true);
    setWaiting(false);
    setError(null);
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
  }, []);

  // In-Telegram: one tap, initData is the proof.
  const connectHere = useCallback(() => {
    setBusy(true);
    setError(null);
    linkTelegram({ initData: telegramInitData() })
      .then((r) => finish(r.user))
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  }, [finish]);

  // Website: mint the binding code, hand off to the Telegram app, then poll —
  // the actual binding happens over there, this tab just waits for the news.
  const connectViaTelegram = useCallback(() => {
    setBusy(true);
    setError(null);
    createTelegramLinkCode()
      .then(({ startParam }) => {
        setWaiting(true);
        // Same-tab navigation: the OS hands t.me links to the Telegram app
        // directly (no web request on blocked networks), and this page stays.
        window.location.href = `https://t.me/${bot}?startapp=${startParam}`;
        if (pollTimer.current) clearInterval(pollTimer.current);
        let polls = 0;
        pollTimer.current = setInterval(() => {
          polls += 1;
          if (polls > 45) { // ~3 minutes, then give up quietly
            if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
            setWaiting(false);
            return;
          }
          fetchMe()
            .then(({ user: u }) => { if (u.hasTelegram) finish(u); })
            .catch(() => { /* transient — keep polling */ });
        }, 4000);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  }, [bot, finish]);

  if (linked) {
    return (
      <Card className="flex items-center gap-3 p-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
          <TelegramIcon size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-brand-ink">{t("profile.telegramConnected")}</p>
          <p className="text-sm text-muted">{t("profile.telegramConnectedHint")}</p>
        </div>
        <CheckIcon size={20} className="shrink-0 text-success" />
      </Card>
    );
  }

  // Nothing to offer: Telegram off server-side and we're not inside it.
  if (!inTelegram && !bot) return null;

  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
          <TelegramIcon size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-brand-ink">{t("profile.telegram")}</p>
          <p className="text-sm text-muted">{t("profile.telegramHint")}</p>
        </div>
      </div>
      <div className="mt-3">
        {inTelegram ? (
          <Button onClick={connectHere} disabled={busy} variant="primary" size="md">
            {t("profile.telegramConnect")}
          </Button>
        ) : (
          <Button onClick={connectViaTelegram} disabled={busy || waiting} variant="primary" size="md">
            <TelegramIcon size={18} /> {waiting ? t("profile.telegramWaiting") : t("profile.telegramOpen")}
          </Button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </Card>
  );
}
