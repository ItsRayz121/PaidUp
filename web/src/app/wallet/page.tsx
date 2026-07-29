"use client";

import Link from "next/link";
import { Card, Button, StatusBadge, SectionTitle } from "@/components/ui";
import { StatusLegend } from "@/components/TaskFlow";
import { InviteRewards } from "@/components/InviteRewards";
import { Loading, ErrorState, EmptyState, LogoutButton } from "@/components/state";
import { StarIcon, WalletIcon, GiftIcon, InfoIcon, MineIcon, BoltIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchBalance, fetchLedger, fetchMiningState, fetchReferrals, type LedgerEntry } from "@/lib/api";
import { formatPoints, formatMoney, formatRozi, timeAgo } from "@/lib/format";

export default function WalletPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const bal = useApi(fetchBalance, []);
  const led = useApi(fetchLedger, []);
  const mining = useApi(fetchMiningState, []);
  const ref = useApi(fetchReferrals, []);

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;

  const points = bal.data?.points ?? 0;
  const min = bal.data?.minWithdrawPoints ?? 2000;
  const canWithdraw = points >= min;
  const entries = led.data?.entries ?? [];

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-brand-ink">{t("nav.wallet")}</h1>
          <p className="text-sm text-muted">{t("wallet.subtitle")}</p>
        </div>
        <LogoutButton />
      </header>

      {/* ---- ROZI first (founder, 2026-07-29): it is the product's headline
          asset, so it is not buried under the payout card any more.
          THE GUARDRAIL IS UNCHANGED AND IS WHAT MAKES THIS SAFE: the two
          balances sit in separate cards, each labelled for what it is, and the
          only "Get my money" button on this screen lives on the POINTS card.
          Ordering says what the app is about; the copy and the buttons say what
          each currency can do, and those must never trade places. */}
      {mining.data && (
        <Link href="/mine" className="block">
          <Card className="overflow-hidden">
            <div className="bg-brand p-5 text-white">
              <p className="flex items-center gap-1.5 text-sm text-white/80">
                <MineIcon size={16} /> {t("wallet.rozi.label")}
              </p>
              <p className="num mt-1 text-4xl font-extrabold">
                {formatRozi(mining.data.roziMicro)}{" "}
                <span className="text-xl font-bold text-white/70">ROZI</span>
              </p>
            </div>
            <p className="flex gap-2 p-3.5 text-xs text-muted">
              {/* Not StarIcon: this screen already spends that one on points
                  and earnings, and reusing it here would blur the two currencies
                  in exactly the place the copy is working hardest to separate. */}
              <BoltIcon size={14} className="mt-0.5 shrink-0 text-brand" />
              {t("wallet.rozi.notcash")}
            </p>
          </Card>
        </Link>
      )}

      {bal.loading ? <Loading lines={1} /> : bal.error ? (
        <ErrorState message={bal.error} onRetry={bal.reload} />
      ) : (
        <Card className="p-5">
          <p className="text-sm text-muted">{t("common.yourPoints")}</p>
          <p className="mt-1 flex items-center gap-2">
            <StarIcon size={26} className="text-accent" />
            <span className="num text-4xl font-bold text-brand-ink">{formatPoints(points)}</span>
          </p>
          <p className="mt-1 font-semibold text-brand-ink">{t("wallet.aboutValue", { value: formatMoney(points) })}</p>
          <div className="mt-4">
            {canWithdraw ? (
              <Button href="/wallet/withdraw" variant="primary"><WalletIcon size={20} /> {t("common.getMyMoney")}</Button>
            ) : (
              <>
                <p className="flex gap-2 rounded-xl bg-pending-tint p-3 text-sm text-pending">
                  <InfoIcon size={18} className="mt-0.5 shrink-0" />
                  {t("wallet.reachAt", { points: formatPoints(min) })}
                </p>
                {/* Let users set + save their wallet address before they qualify. */}
                <Link href="/wallet/withdraw" className="mt-3 block text-center text-sm font-semibold text-brand">
                  {t("wallet.setupWallet")} →
                </Link>
              </>
            )}
          </div>
        </Card>
      )}

      {/* The verify-your-ID nudge used to sit here; it moved to Profile (which
          shows the live status badge). The withdraw screen still walls off
          unverified users, so the check itself is not weakened. */}

      {/* The money screen is where people decide the app is worth telling a
          friend about — they are looking at a balance and working out how to
          make it bigger. Doing tasks is one answer; being paid a share of what
          four friends earn is the better one, and until now this screen never
          mentioned it. */}
      {ref.data && (
        <section>
          <SectionTitle>{t("wallet.invite.title")}</SectionTitle>
          <InviteRewards rewards={ref.data.rewards} showCta />
        </section>
      )}

      <section>
        <SectionTitle>{t("wallet.history")}</SectionTitle>
        <Card className="p-2 mb-2"><div className="px-2 py-1"><StatusLegend /></div></Card>

        {led.loading ? <Loading /> : led.error ? (
          <ErrorState message={led.error} onRetry={led.reload} />
        ) : entries.length === 0 ? (
          <EmptyState title={t("wallet.noHistoryTitle")} body={t("wallet.noHistoryBody")} />
        ) : (
          <ul className="space-y-2.5">
            {entries.map((e: LedgerEntry) => {
              const credit = e.points >= 0;
              return (
                <li key={e.id}>
                  <Card className="p-3.5">
                    <div className="flex items-start gap-3">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
                        {e.kind === "referral" ? <GiftIcon size={20} /> : e.kind === "withdrawal" ? <WalletIcon size={20} /> : <StarIcon size={20} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-brand-ink leading-snug">{e.label}</p>
                        <p className="text-xs text-muted">{timeAgo(e.at)}</p>
                      </div>
                      <div className="text-right">
                        <p className={`num font-bold ${credit ? "text-success" : "text-brand-ink"}`}>
                          {credit ? "+" : "−"}{formatPoints(Math.abs(e.points))}
                        </p>
                        <div className="mt-1 flex justify-end"><StatusBadge status={e.status} /></div>
                      </div>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="text-center text-xs text-muted">
        {t("wallet.needHelp")} <Link href="/help" className="font-semibold text-brand">{t("wallet.contactSupport")}</Link>
      </p>
    </div>
  );
}
