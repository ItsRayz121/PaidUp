"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button, SectionTitle } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import { rigIcon, ChipIcon, InfoIcon, ArrowRightIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchRigs, fetchMiningState, upgradeRig } from "@/lib/api";
import { ensureVignette } from "@/lib/ads";
import { formatRozi } from "@/lib/format";

export default function RigsPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const rigs = useApi(fetchRigs, []);
  const mining = useApi(fetchMiningState, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Same vignette as the Start-mining tap (founder, 2026-07-18): once loaded it
  // decorates taps on THIS screen too, so buying a rig can show an ad. Passive,
  // Monetag's own frequency cap applies, and it grants nothing — a rig purchase
  // is a ROZI spend, not real money, so an ad here can't read as a paywall.
  useEffect(() => {
    const ads = mining.data?.ads;
    if (ads?.enabled && ads.monetagZoneId) ensureVignette(ads.monetagZoneId);
  }, [mining.data]);

  async function onUpgrade(id: string) {
    setBusy(id);
    setNotice(null);
    try {
      const r = await upgradeRig(id);
      setNotice(t("rigs.bought").replace("{level}", String(r.level)));
      rigs.reload();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!ready || rigs.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (rigs.error || !rigs.data) {
    return <div className="p-4 pt-6"><ErrorState message={rigs.error ?? "…"} onRetry={rigs.reload} /></div>;
  }

  const { roziMicro, rigs: list } = rigs.data;

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header>
        <Link href="/mine" className="inline-flex items-center gap-1 text-sm font-semibold text-brand">
          <ArrowRightIcon size={16} className="rotate-180" />
          {t("rigs.back")}
        </Link>
        <h1 className="mt-2 text-xl font-bold text-brand-ink">{t("rigs.title")}</h1>
        <p className="text-sm text-muted">{t("rigs.subtitle")}</p>
      </header>

      <Card className="flex items-center justify-between p-4">
        <span className="text-sm font-semibold text-muted">{t("rigs.yourRozi")}</span>
        <span className="num text-xl font-extrabold text-brand-ink">
          {formatRozi(roziMicro)} <span className="text-base text-brand">ROZI</span>
        </span>
      </Card>

      {notice && (
        <p className="rounded-xl border border-line bg-card p-3 text-sm text-brand-ink">{notice}</p>
      )}

      <div>
        <SectionTitle>{t("rigs.available")}</SectionTitle>
        <div className="space-y-2">
          {list.map((r) => {
            const Icon = rigIcon[r.icon] ?? ChipIcon;
            // Compared in MICRO on both sides — the balance and the cost are the
            // same unit, so no conversion is needed to decide affordability.
            const maxed = r.nextCostMicro === null;
            const affordable = !maxed && roziMicro >= (r.nextCostMicro ?? 0);

            return (
              <Card key={r.id} className="p-4">
                <div className="flex items-center gap-3">
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
                    <Icon size={24} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-brand-ink">{r.name}</p>
                    <p className="text-sm text-muted">
                      {r.level === 0
                        ? t("rigs.notOwned")
                        : t("rigs.level")
                            .replace("{level}", String(r.level))
                            .replace("{max}", String(r.maxLevel))}
                      {r.level > 0 && ` · ${t("rigs.speed")} ${r.power.toLocaleString()}`}
                    </p>
                  </div>
                </div>

                {maxed ? (
                  <p className="mt-3 rounded-lg bg-success-tint px-3 py-2 text-center text-sm font-semibold text-success">
                    {t("rigs.maxed")}
                  </p>
                ) : (
                  <div className="mt-3 flex items-center gap-3">
                    <div className="min-w-0 flex-1 text-sm">
                      <p className="text-muted">
                        {t("rigs.next")}:{" "}
                        <strong className="num text-brand-ink">
                          {r.level === 0
                            ? `${r.nextPower?.toLocaleString()}`
                            : `${r.power.toLocaleString()} → ${r.nextPower?.toLocaleString()}`}
                        </strong>
                      </p>
                      <p className="num font-semibold text-brand">
                        {formatRozi(r.nextCostMicro ?? 0)} ROZI
                      </p>
                    </div>
                    <Button
                      onClick={() => onUpgrade(r.id)}
                      disabled={busy === r.id || !affordable}
                      size="md"
                      full={false}
                      variant={affordable ? "primary" : "ghost"}
                    >
                      {r.level === 0 ? t("rigs.buy") : t("rigs.upgrade")}
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </div>

      {/* Said out loud rather than hidden in a curve: every level costs more per
          H/s than the last. Users work this out anyway, and finding it out for
          themselves after spending feels like a trick. */}
      <p className="flex gap-2 rounded-xl border border-line bg-brand-tint/40 p-3 text-xs text-muted">
        <InfoIcon size={14} className="mt-0.5 shrink-0 text-brand" />
        {t("rigs.treadmill")}
      </p>
    </div>
  );
}
