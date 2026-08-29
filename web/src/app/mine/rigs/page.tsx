"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Button, SectionTitle } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import { rigIcon, ChipIcon, InfoIcon, ArrowRightIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchRigs, upgradeRig } from "@/lib/api";
import { formatRozi, formatUsdtMicro } from "@/lib/format";

export default function RigsPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const rigs = useApi(fetchRigs, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Same vignette as the Start-mining tap (founder, 2026-07-18): once loaded it
  // decorates taps on THIS screen too, so buying a rig can show an ad. Passive,
  // Monetag's own frequency cap applies, and it grants nothing — a rig purchase
  // is a ROZI spend, not real money, so an ad here can't read as a paywall.
  async function onUpgrade(id: string, pay: "rozi" | "usdt" = "rozi") {
    setBusy(id);
    setNotice(null);
    try {
      const r = await upgradeRig(id, pay);
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

  const { roziMicro, usdtMicro, usdtEnabled, rigs: list } = rigs.data;

  // Best value = fewest days to pay for itself. Computed here from what the API
  // already sends — no extra call — and used only to put a small badge on one
  // card, not to reorder the list (the list stays in the catalogue's own order,
  // which is a deliberate progression from cheap to powerful).
  const paybackDays = (r: (typeof list)[number]) =>
    r.nextCostMicro && r.extraRoziPerDayMicro ? r.nextCostMicro / r.extraRoziPerDayMicro : null;
  const bestValueId = list
    .map((r) => ({ id: r.id, days: paybackDays(r) }))
    .filter((x): x is { id: string; days: number } => x.days !== null && x.days > 0)
    .sort((a, b) => a.days - b.days)[0]?.id;

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

      {/* The second wallet, shown only when top-ups are switched on. It is a
          SEPARATE card from the ROZI balance and never added to it: one is mined
          and can be converted, the other is prepaid credit that can only be
          spent here. Merging them into one "your balance" figure would promise
          something about the top-up money that is not true. */}
      {usdtEnabled && (
        <Card className="flex items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-muted">{t("rigs.yourUsdt")}</p>
            <p className="num text-xl font-extrabold text-brand-ink">
              {formatUsdtMicro(usdtMicro)}
            </p>
          </div>
          <Button href="/mine/topup" size="md" full={false} variant="ghost">
            {t("rigs.addUsdt")}
          </Button>
        </Card>
      )}

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
            // A rig is payable in USDT only if top-ups are on AND an Admin gave
            // this rig a USDT price. Both, every time — a price with the feature
            // off is a button that 400s.
            const usdtPayable = !maxed && usdtEnabled && r.nextCostUsdtMicro !== null;
            const usdtAffordable = usdtPayable && usdtMicro >= (r.nextCostUsdtMicro ?? 0);

            return (
              <Card key={r.id} className="p-3">
                <Link href={`/mine/rigs/${r.id}`} className="flex items-center gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
                    <Icon size={22} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 font-bold text-brand-ink">
                      <span className="truncate">{r.name}</span>
                      {r.id === bestValueId && (
                        <span className="shrink-0 rounded-full bg-success-tint px-2 py-0.5 text-[11px] font-semibold text-success">
                          {t("rigs.bestValue")}
                        </span>
                      )}
                    </p>
                    <p className="text-sm text-muted">
                      {r.level === 0
                        ? t("rigs.notOwned")
                        : t("rigs.level")
                            .replace("{level}", String(r.level))
                            .replace("{max}", String(r.maxLevel))}
                      {r.level > 0 && ` · ${t("rigs.speed")} ${r.power.toLocaleString()}`}
                    </p>
                  </div>
                  <ArrowRightIcon size={18} className="shrink-0 text-muted" />
                </Link>

                {maxed ? (
                  <p className="mt-2.5 rounded-lg bg-success-tint px-3 py-1.5 text-center text-sm font-semibold text-success">
                    {t("rigs.maxed")}
                  </p>
                ) : (
                  <div className="mt-2.5 space-y-1.5">
                    {/* Speed change and per-day value on ONE line to keep the
                        card short enough to show three at once (founder,
                        2026-08-29). The payback-days estimate this used to
                        carry lives on the machine's own page now; per-day
                        value is absent under the pool model — see that page. */}
                    <p className="text-sm text-muted">
                      {t("rigs.next")}:{" "}
                      <strong className="num text-brand-ink">
                        {r.level === 0
                          ? `${r.nextPower?.toLocaleString()}`
                          : `${r.power.toLocaleString()} → ${r.nextPower?.toLocaleString()}`}
                      </strong>
                      {r.level > 0 && r.power > 0 && r.nextPower !== null && (
                        <span className="num ms-1.5 text-xs font-semibold text-success">
                          {t("rigs.pctIncrease", {
                            pct: String(Math.round(((r.nextPower - r.power) / r.power) * 100)),
                          })}
                        </span>
                      )}
                      {r.extraRoziPerDayMicro !== null && r.extraRoziPerDayMicro > 0 && (
                        <span className="num ms-1.5 text-xs text-muted">
                          · {t("rigs.extraPerDay", { n: formatRozi(r.extraRoziPerDayMicro) })}
                        </span>
                      )}
                    </p>

                    {/* USDT is the real way to buy a machine now (founder,
                        2026-08-29): when a rig has a USDT price and top-ups are
                        on, the USDT button leads and the ROZI price is the
                        "later" option. When there is no USDT price (the old
                        default, and dev instances), ROZI stays primary. */}
                    {usdtPayable && (
                      <div className="flex items-center gap-3">
                        <p className="num min-w-0 flex-1 text-sm font-semibold text-accent-ink">
                          {formatUsdtMicro(r.nextCostUsdtMicro ?? 0)}
                        </p>
                        <Button
                          onClick={() => onUpgrade(r.id, "usdt")}
                          disabled={busy === r.id || !usdtAffordable}
                          size="md"
                          full={false}
                          variant={usdtAffordable ? "accent" : "ghost"}
                        >
                          {r.level === 0 ? t("rigs.buy") : t("rigs.upgrade")}
                        </Button>
                      </div>
                    )}

                    <div className="flex items-center gap-3">
                      <p className="num min-w-0 flex-1 text-sm font-semibold text-brand">
                        {formatRozi(r.nextCostMicro ?? 0)} ROZI
                      </p>
                      <Button
                        onClick={() => onUpgrade(r.id, "rozi")}
                        disabled={busy === r.id || !affordable}
                        size="md"
                        full={false}
                        variant={usdtPayable ? "ghost" : affordable ? "primary" : "ghost"}
                      >
                        {usdtPayable ? t("rigs.payRozi") : r.level === 0 ? t("rigs.buy") : t("rigs.upgrade")}
                      </Button>
                    </div>
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
        {t("rigs.treadmill")} {t("rigs.rateNote")}
      </p>
    </div>
  );
}
