"use client";

// A single machine's own page — the detail view the rig list links out to.
// Reuses the SAME /mining/rigs payload the list page already fetches (no new
// endpoint): this page just finds one row in it by id. Adds one thing the
// list doesn't have room for: an estimated USD value next to the ROZI cost,
// at the admin-tunable roziUsdtDisplayRate — see its comment in
// api/src/mining/core.ts and web/src/lib/format.ts for why this is a display
// estimate only, never a real price.
import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Card, Button, SectionTitle } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import { rigIcon, ChipIcon, InfoIcon, ArrowRightIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchRigs, upgradeRig } from "@/lib/api";
import { formatRozi, formatUsdtMicro, roziUsdtEstimateMicro } from "@/lib/format";

export default function RigDetailPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const params = useParams<{ id: string }>();
  const id = String(params?.id ?? "");
  const rigs = useApi(fetchRigs, []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function onUpgrade(pay: "rozi" | "usdt" = "rozi") {
    setBusy(true);
    setNotice(null);
    try {
      const r = await upgradeRig(id, pay);
      setNotice(t("rigs.bought").replace("{level}", String(r.level)));
      rigs.reload();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!ready || rigs.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (rigs.error || !rigs.data) {
    return <div className="p-4 pt-6"><ErrorState message={rigs.error ?? "…"} onRetry={rigs.reload} /></div>;
  }

  const { roziMicro, usdtMicro, usdtEnabled, roziUsdtDisplayRate, rigs: list } = rigs.data;
  const r = list.find((x) => x.id === id);

  if (!r) {
    return (
      <div className="px-4 pt-5 pb-8">
        <ErrorState message="That machine could not be found." onRetry={rigs.reload} />
      </div>
    );
  }

  const Icon = rigIcon[r.icon] ?? ChipIcon;
  const maxed = r.nextCostMicro === null;
  const affordable = !maxed && roziMicro >= (r.nextCostMicro ?? 0);
  const usdtPayable = !maxed && usdtEnabled && r.nextCostUsdtMicro !== null;
  const usdtAffordable = usdtPayable && usdtMicro >= (r.nextCostUsdtMicro ?? 0);
  const estimateMicro = maxed ? 0 : roziUsdtEstimateMicro(r.nextCostMicro ?? 0, roziUsdtDisplayRate);

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header>
        <Link href="/mine/rigs" className="inline-flex items-center gap-1 text-sm font-semibold text-brand">
          <ArrowRightIcon size={16} className="rotate-180" />
          {t("rigDetail.back")}
        </Link>
        <div className="mt-3 flex items-center gap-3">
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-brand-tint text-brand">
            <Icon size={28} />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-brand-ink">{r.name}</h1>
            <p className="text-sm text-muted">
              {r.level === 0
                ? t("rigs.notOwned")
                : t("rigs.level").replace("{level}", String(r.level)).replace("{max}", String(r.maxLevel))}
            </p>
          </div>
        </div>
      </header>

      <Card className="grid grid-cols-2 divide-x divide-line p-0">
        <div className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t("rigDetail.current")}</p>
          <p className="num mt-1 text-2xl font-extrabold text-brand-ink">{r.power.toLocaleString()}</p>
        </div>
        <div className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t("rigDetail.nextLevel")}</p>
          <p className="num mt-1 text-2xl font-extrabold text-brand">
            {maxed ? "—" : r.nextPower?.toLocaleString()}
          </p>
        </div>
      </Card>

      {notice && (
        <p className="rounded-xl border border-line bg-card p-3 text-sm text-brand-ink">{notice}</p>
      )}

      {maxed ? (
        <p className="rounded-xl bg-success-tint px-4 py-3 text-center text-sm font-semibold text-success">
          {t("rigs.maxed")}
        </p>
      ) : (
        <div>
          <SectionTitle>{t("rigDetail.cost")}</SectionTitle>
          <Card className="p-4 space-y-3">
            <div className="flex items-center gap-3">
              <p className="num min-w-0 flex-1 text-lg font-bold text-brand-ink">
                {formatRozi(r.nextCostMicro ?? 0)} ROZI
              </p>
              <Button
                onClick={() => onUpgrade("rozi")}
                disabled={busy || !affordable}
                size="md"
                full={false}
                variant={affordable ? "primary" : "ghost"}
              >
                {usdtPayable ? t("rigs.payRozi") : r.level === 0 ? t("rigs.buy") : t("rigs.upgrade")}
              </Button>
            </div>

            {/* The estimate — display only, never called a price. See the
                setting's comment in api/src/mining/core.ts. */}
            <div className="rounded-lg border border-line bg-brand-tint/40 p-3">
              <p className="text-sm font-semibold text-brand-ink">
                {t("rigDetail.estimateTitle", { value: formatUsdtMicro(estimateMicro) })}
              </p>
              <p className="mt-1 flex gap-1.5 text-xs text-muted">
                <InfoIcon size={13} className="mt-0.5 shrink-0" />
                {t("rigDetail.estimateBody")}
              </p>
            </div>

            {usdtPayable && (
              <div className="flex items-center gap-3 border-t border-line pt-3">
                <p className="num min-w-0 flex-1 text-sm font-semibold text-accent-ink">
                  {formatUsdtMicro(r.nextCostUsdtMicro ?? 0)}
                </p>
                <Button
                  onClick={() => onUpgrade("usdt")}
                  disabled={busy || !usdtAffordable}
                  size="md"
                  full={false}
                  variant={usdtAffordable ? "accent" : "ghost"}
                >
                  {t("rigs.payUsdt")}
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}

      <p className="flex gap-2 rounded-xl border border-line bg-brand-tint/40 p-3 text-xs text-muted">
        <InfoIcon size={14} className="mt-0.5 shrink-0 text-brand" />
        {t("rigs.treadmill")}
      </p>
    </div>
  );
}
