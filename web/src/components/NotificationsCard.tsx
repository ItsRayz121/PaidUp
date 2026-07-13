"use client";

// The notifications opt-in card. Lives on Help (the "settings" the founder
// asked for) and on the withdraw success screen (the moment a user most wants
// to hear "your money is sent").
//
// Renders NOTHING when the feature can't work: server has no VAPID keys,
// browser has no push support (iOS Safari outside the installed app), or we
// are server-rendering. A toggle that can't deliver would only burn trust.
import { useEffect, useState } from "react";
import { Card, Button } from "./ui";
import { BellIcon } from "./icons";
import { useI18n } from "@/lib/i18n";
import { fetchPushConfig } from "@/lib/api";
import { getPushState, enablePush, disablePush, pushSupported, type PushState } from "@/lib/push";

export function NotificationsCard({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const [state, setState] = useState<PushState | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!pushSupported()) return; // stays "loading" => renders nothing
      const cfg = await fetchPushConfig().catch(() => null);
      if (!alive || !cfg?.enabled) return;
      const s = await getPushState();
      if (alive) setState(s);
    })();
    return () => { alive = false; };
  }, []);

  if (state === "loading" || state === "unsupported") return null;

  async function toggle() {
    setBusy(true);
    setFailed(false);
    try {
      setState(state === "on" ? await disablePush() : await enablePush());
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
          <BellIcon size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-brand-ink">
            {state === "on" ? t("notify.on") : compact ? t("notify.withdraw.hook") : t("notify.title")}
          </p>
          <p className="mt-0.5 text-sm text-muted">
            {state === "on" ? t("notify.onBody") : state === "denied" ? t("notify.denied") : t("notify.body")}
          </p>
          {failed && <p className="mt-1 text-sm text-danger">{t("notify.error")}</p>}
          {state !== "denied" && (
            <div className="mt-3">
              {state === "on" ? (
                <Button variant="ghost" size="md" full={false} onClick={toggle} disabled={busy}>
                  {t("notify.disable")}
                </Button>
              ) : (
                <Button variant="primary" size="md" full={false} onClick={toggle} disabled={busy}>
                  {busy ? t("notify.enabling") : t("notify.enable")}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
