"use client";

// One person, one account, two doors (founder, 2026-07-18). This card lets a
// signed-in user connect their Telegram to THIS account, so opening RoziPay
// inside Telegram lands on the same points and the same history:
//   • inside the Telegram Mini App: one tap — the webview's signed initData
//     proves which Telegram is asking.
//   • on the website: Telegram's Login Widget provides the signed payload.
// Either way the backend re-verifies the signature; being signed in here is
// never proof of owning a Telegram account.
//
// Renders NOTHING when there is nothing to do (Telegram off server-side and
// not inside Telegram) — never an orphan card.
import { useCallback, useEffect, useState } from "react";
import { Card, Button } from "./ui";
import { TelegramIcon, CheckIcon } from "./icons";
import { TelegramWidget } from "./TelegramWidget";
import { useI18n } from "@/lib/i18n";
import {
  linkTelegram, fetchTelegramConfig, getToken, setSession, type SessionUser,
} from "@/lib/api";
import { telegramInitData, useInsideTelegram } from "@/lib/telegram";

export function ConnectTelegramCard({ user }: { user: SessionUser }) {
  const { t } = useI18n();
  const inTelegram = useInsideTelegram();
  const [linked, setLinked] = useState(Boolean(user.hasTelegram));
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    fetchTelegramConfig()
      .then((c) => { if (!gone) setEnabled(c.enabled); })
      .catch(() => { /* API hiccup — card hides, profile still works */ });
    return () => { gone = true; };
  }, []);

  const finish = useCallback((u: SessionUser) => {
    // Persist the refreshed user so every screen (and the next visit) knows.
    const token = getToken();
    if (token) setSession(token, u);
    setLinked(true);
    setError(null);
  }, []);

  const connect = useCallback((payload: { initData?: string; widget?: Record<string, unknown> }) => {
    setBusy(true);
    setError(null);
    linkTelegram(payload)
      .then((r) => finish(r.user))
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  }, [finish]);

  const fromWidget = useCallback(
    (u: Record<string, unknown>) => connect({ widget: u }),
    [connect],
  );

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

  if (!inTelegram && !enabled) return null;

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
          <Button
            onClick={() => connect({ initData: telegramInitData() })}
            disabled={busy}
            variant="primary"
            size="md"
          >
            {t("profile.telegramConnect")}
          </Button>
        ) : (
          <TelegramWidget onAuth={fromWidget} />
        )}
      </div>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </Card>
  );
}
