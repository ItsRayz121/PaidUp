"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Button } from "@/components/ui";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { ArrowRightIcon, CheckIcon, BoltIcon, ClockIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchBoosters, buyBooster, type Booster } from "@/lib/api";
import { formatMoney } from "@/lib/format";

// Spend Points on a temporary mining-speed multiplier.
//
// Points, not ROZI: this is the "sink for the cash currency" CLAUDE.md
// describes — spending here quietly reduces USDT withdrawal pressure, the
// same reasoning as the ROZI store one level up, just the other ledger. The
// route (POST /mining/boosters/:id/buy) already applies the boost the moment
// it debits; the effect shows up on /mine's existing "Boosts" row, so this
// screen only needs to sell the thing, not also render the result.
export default function BoostersPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const boosters = useApi(fetchBoosters, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!ready || boosters.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (boosters.error || !boosters.data) {
    return <div className="p-4 pt-6"><ErrorState message={boosters.error ?? "…"} onRetry={boosters.reload} /></div>;
  }

  const { points, boosters: items } = boosters.data;

  async function buy(item: Booster) {
    if (!window.confirm(t("boosters.confirm", { n: formatMoney(item.price_points), title: item.name }))) return;
    setBusy(item.id);
    setError(null);
    setNotice(null);
    try {
      await buyBooster(item.id);
      setNotice(t("boosters.bought"));
      boosters.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-center gap-2">
        <Link href="/mine" aria-label="Back to mining" className="text-brand">
          <ArrowRightIcon size={22} className="rotate-180" />
        </Link>
        <h1 className="text-xl font-bold text-brand-ink">{t("boosters.title")}</h1>
      </header>
      <p className="px-1 text-sm text-muted">{t("boosters.subtitle")}</p>

      <Card className="flex items-center justify-between p-4">
        <span className="text-sm text-muted">{t("boosters.yourMoney")}</span>
        <span className="num font-bold text-brand-ink">{formatMoney(points)}</span>
      </Card>

      {notice && (
        <Card className="flex items-center gap-3 border-success/30 bg-success-tint/50 p-4">
          <CheckIcon size={22} className="shrink-0 text-success" />
          <p className="font-semibold text-brand-ink">{notice}</p>
        </Card>
      )}
      {error && <p className="rounded-xl bg-danger-tint p-3 text-sm text-danger">{error}</p>}

      {items.length === 0 ? (
        <EmptyState title={t("boosters.empty.title")} body={t("boosters.empty.body")} />
      ) : (
        <ul className="space-y-2.5">
          {items.map((item) => {
            const affordable = points >= item.price_points;
            return (
              <li key={item.id}>
                <Card className="p-4">
                  <div className="flex items-start gap-3">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
                      <BoltIcon size={22} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-brand-ink">{item.name}</p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
                        <ClockIcon size={14} className="shrink-0" />
                        {t("boosters.effect", { pct: String(item.multiplier_pct), hours: String(item.hours) })}
                      </p>
                      <p className="num mt-1 font-bold text-accent-ink">{formatMoney(item.price_points)}</p>
                    </div>
                  </div>
                  <div className="mt-3">
                    <Button
                      onClick={() => buy(item)}
                      disabled={busy === item.id || !affordable}
                      variant={affordable ? "accent" : "ghost"}
                      full
                    >
                      {affordable ? t("boosters.get") : t("boosters.notEnough")}
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
