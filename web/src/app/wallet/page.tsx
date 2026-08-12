"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Button, SectionTitle } from "@/components/ui";
import { StatusLegend } from "@/components/TaskFlow";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { WalletIcon, SendIcon, ReceiveIcon, ArrowRightIcon } from "@/components/icons";
import { UsdtLogo, BnbLogo, RoziMark } from "@/components/tokenIcons";
import { TxDetailSheet, FilterChip } from "@/components/TxDetailSheet";
import { BottomSheet } from "@/components/BottomSheet";
import { HistoryList } from "@/components/HistoryList";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import {
  fetchBalance, fetchLedger, fetchMiningState, fetchRoziHistory, fetchUsdt,
  fetchWithdrawals, fetchBnbWithdrawals, fetchUsdtTaskRewards,
} from "@/lib/api";
import { usdtFromMicro, formatUsdtMicro, formatBnbWei } from "@/lib/format";
import { unifyHistory, preview, type Row, type TokenFilter, type KindFilter } from "@/lib/walletHistory";

// The money screen. Wallet overhaul (founder): the headline is USDT again —
// Total Balance folds real deposited USDT (usdt_ledger) together with
// withdrawable task/referral points (at the real 1000pts=$1 rate) — and the
// history is now every ledger this account has, not just points+ROZI.
//
// ⚠️ THIS IS STILL A DISPLAY MERGE. The underlying ledgers are untouched
// (guardrail #7) — see lib/walletHistory.ts's header. "Locked" is the
// points-derived half while the account sits below the withdrawal minimum;
// it becomes "Available" the instant a fresh read clears that bar, with no
// unlock event to miss.
export default function WalletPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const bal = useApi(fetchBalance, []);
  const led = useApi(fetchLedger, []);
  const rozi = useApi(fetchRoziHistory, []);
  const mining = useApi(fetchMiningState, []);
  const withdrawals = useApi(fetchWithdrawals, []);
  const bnbWithdrawals = useApi(fetchBnbWithdrawals, []);
  const taskUsdt = useApi(fetchUsdtTaskRewards, []);
  const usdtOn = Boolean(mining.data?.usdtTopup);
  const usdt = useApi(fetchUsdt, [usdtOn], usdtOn);
  const [showAll, setShowAll] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [tokenFilter, setTokenFilter] = useState<TokenFilter>("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [openTx, setOpenTx] = useState<Row | null>(null);

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;

  const points = bal.data?.points ?? 0;
  const min = bal.data?.minWithdrawPoints ?? 1000;
  const canWithdraw = points >= min;
  const usdtAvailableMicro = bal.data?.usdtAvailableMicro ?? 0;
  const usdtLockedMicro = bal.data?.usdtLockedMicro ?? 0;
  const usdtTotalMicro = bal.data?.usdtTotalMicro ?? 0;
  // ⚠️ NO NUMBER ON THIS SCREEN MAY BE A FALLBACK ZERO. Every figure above is
  // `?? 0`, which is correct arithmetic and a terrible thing to render: while
  // the request is in flight — or after it fails — it puts "0.00 USDT" in front
  // of someone who has money, on the one screen whose entire job is telling
  // them how much they have. A user reads that as their balance disappearing,
  // and support hears about it. So each figure waits for its own call, and an
  // unknown amount says so with a dash.
  const balKnown = !bal.loading && !bal.error;

  const entries = unifyHistory({
    ledger: led.data?.entries ?? [],
    rozi: rozi.data?.entries ?? [],
    withdrawals: withdrawals.data?.requests ?? [],
    topups: usdt.data?.topups ?? [],
    refunds: usdt.data?.refunds ?? [],
    bnb: bnbWithdrawals.data?.requests ?? [],
    bnbDeposits: usdt.data?.nativeDeposits ?? [],
    taskUsdt: taskUsdt.data?.rewards ?? [],
    t,
  });
  const historyLoading = led.loading || rozi.loading;
  const historyError = led.error && rozi.error ? led.error : null;
  const filtered = entries.filter(
    (e) => (tokenFilter === "all" || e.token === tokenFilter) && (kindFilter === "all" || e.kind === kindFilter),
  );
  const visible = showAll ? filtered : preview(filtered);
  const hidden = filtered.length - visible.length;

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header>
        <h1 className="text-xl font-bold text-brand-ink">{t("nav.wallet")}</h1>
        <p className="text-sm text-muted">{t("wallet.subtitle")}</p>
      </header>

      {/* ---- Total Balance (wallet overhaul) --------------------------------
          Real deposited USDT + withdrawable task/referral points, in one
          number — see the file header. Available/Locked only appears once
          there is anything actually locked, so a user already above the
          withdrawal minimum sees exactly what they saw before this shipped. */}
      {bal.loading ? (
        <Loading lines={1} />
      ) : bal.error ? (
        <ErrorState message={bal.error} onRetry={bal.reload} />
      ) : (
        <Card className="p-4">
          <p className="text-sm text-muted">{t("wallet.totalBalance")}</p>
          <p className="num text-3xl font-bold text-brand-ink">{formatUsdtMicro(usdtTotalMicro)}</p>
          {usdtLockedMicro > 0 && (
            <div className="mt-2 flex gap-4 text-sm">
              <span className="text-success font-semibold">{t("wallet.available")}: {formatUsdtMicro(usdtAvailableMicro)}</span>
              <span className="text-pending font-semibold">{t("wallet.locked")}: {formatUsdtMicro(usdtLockedMicro)}</span>
            </div>
          )}
        </Card>
      )}

      <div className="grid grid-cols-2 gap-2.5">
        <Button onClick={() => setReceiveOpen(true)} variant="ghost">
          <ReceiveIcon size={20} /> {t("wallet.deposit")}
        </Button>
        <Button onClick={() => setSendOpen(true)} variant="primary">
          <SendIcon size={20} /> {t("wallet.withdraw")}
        </Button>
      </div>

      <section>
        <SectionTitle>{t("wallet.tokens.title")}</SectionTitle>
        <Card className="divide-y divide-line">
          <Link href="/wallet/usdt" className="block active:bg-brand-tint/40">
            {usdtLockedMicro > 0 ? (
              <div className="flex items-center gap-3 p-3.5">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-tint text-brand">
                  <UsdtLogo size={20} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-brand-ink leading-snug">{t("wallet.token.usdt.name")}</p>
                  <p className="text-xs text-muted">
                    {t("wallet.available")} {formatUsdtMicro(usdtAvailableMicro)} · {t("wallet.locked")} {formatUsdtMicro(usdtLockedMicro)}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="num font-bold text-brand-ink">{usdtFromMicro(usdtTotalMicro).toFixed(2)}</p>
                  <p className="text-[11px] font-semibold text-muted">USDT</p>
                </div>
              </div>
            ) : (
              <TokenRow
                Icon={UsdtLogo} name={t("wallet.token.usdt.name")} sub={t("wallet.token.usdt.sub")}
                symbol="USDT" muted={!balKnown}
                amount={balKnown ? usdtFromMicro(usdtTotalMicro).toFixed(2) : "—"}
              />
            )}
          </Link>
          <Link href="/wallet/bnb" className="block active:bg-brand-tint/40">
            {usdtOn && usdt.data?.personalGasWei !== null && usdt.data?.personalGasWei !== undefined ? (
              <TokenRow
                Icon={BnbLogo} name={t("wallet.token.bnb.name")} sub={t("wallet.token.bnb.gasSub")}
                symbol="BNB" amount={formatBnbWei(usdt.data.personalGasWei).replace(" BNB", "")}
              />
            ) : (
              <TokenRow
                Icon={BnbLogo} name={t("wallet.token.bnb.name")} sub={t("wallet.token.bnb.sub")}
                symbol="BNB" amount={t("wallet.token.soon")} muted
              />
            )}
          </Link>
          {/* ⚠️ MINED ROZI ONLY — never totalRoziMicro(). The task/referral half
              of a user's earnings is already counted in the Total Balance card
              above, as USDT; adding it here as ROZI too would show the same
              money twice on one screen. See the i18n note on
              wallet.token.rozi.sub. */}
          <Link href="/wallet/rozi" className="block active:bg-brand-tint/40">
            <TokenRow
              Icon={RoziMark} name={t("wallet.token.rozi.name")} sub={t("wallet.token.rozi.sub")}
              symbol="" muted
              amount={t("wallet.token.comingSoon")}
            />
          </Link>
        </Card>
      </section>

      {/* The balance's own failure state now lives with the balance card above,
          where the wrong number would otherwise be. This is only the cash-out
          shortcut, which simply does not appear until we know it applies. */}
      {canWithdraw && (
        <Button href="/wallet/withdraw" variant="primary">
          <WalletIcon size={20} /> {t("common.getMyMoney")}
        </Button>
      )}

      <section>
        <SectionTitle>{t("wallet.history")}</SectionTitle>
        <p className="mb-2 px-1 text-xs text-muted">{t("wallet.history.sub")}</p>

        {/* ONE ROW OF FILTERS, NOT THREE (founder, 2026-08-09). The token row
            is the one people actually use, so it stays visible; the kind
            filters sit behind a Filter control that names its own current
            value, so a filter can never be silently left on with the row that
            set it collapsed out of view. */}
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {(["all", "USDT", "BNB", "ROZI"] as TokenFilter[]).map((f) => (
            <FilterChip key={f} active={tokenFilter === f} onClick={() => setTokenFilter(f)}>
              {f === "all" ? t("wallet.filter.all") : f}
            </FilterChip>
          ))}
          <span className="ms-auto">
            <FilterChip active={kindFilter !== "all"} onClick={() => setFiltersOpen(!filtersOpen)}>
              {kindFilter === "all" ? t("wallet.filter.button") : t(`wallet.filter.${kindFilter}`)}
            </FilterChip>
          </span>
        </div>
        {filtersOpen && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {(["all", "received", "sent", "reward", "mining"] as KindFilter[]).map((f) => (
              <FilterChip key={f} active={kindFilter === f}
                onClick={() => { setKindFilter(f); setFiltersOpen(false); }}>
                {t(`wallet.filter.${f}`)}
              </FilterChip>
            ))}
          </div>
        )}

        <Card className="p-2 mb-2"><div className="px-2 py-1"><StatusLegend /></div></Card>

        {historyLoading ? <Loading /> : historyError ? (
          <ErrorState message={historyError} onRetry={() => { led.reload(); rozi.reload(); }} />
        ) : filtered.length === 0 ? (
          <EmptyState title={t("wallet.noHistoryTitle")} body={t("wallet.noHistoryBody")} />
        ) : (
          <HistoryList rows={visible} onOpen={setOpenTx} />
        )}

        {!historyLoading && !historyError && (hidden > 0 || showAll) && (
          <div className="mt-3">
            <Button onClick={() => setShowAll(!showAll)} variant="ghost" size="md">
              {showAll ? t("wallet.history.less") : t("wallet.history.seeAll", { count: String(hidden) })}
            </Button>
          </div>
        )}
      </section>

      <p className="text-center text-xs text-muted">
        {t("wallet.needHelp")} <Link href="/help" className="font-semibold text-brand">{t("wallet.contactSupport")}</Link>
      </p>

      {sendOpen && (
        <ChooserSheet titleId="send-chooser-title" title={t("wallet.chooser.send.title")} onClose={() => setSendOpen(false)}>
          <ChooserRow
            Icon={RoziMark} title={t("wallet.token.rozi.name")} sub={t("wallet.chooser.rozi.sendSub")}
            href="/mine/send" disabled={!mining.data?.transfersEnabled} reason={t("wallet.sendOff")}
          />
          <ChooserRow
            Icon={UsdtLogo} title={t("wallet.token.usdt.name")} sub={t("wallet.chooser.usdt.withdrawSub")}
            href="/wallet/withdraw"
          />
          <ChooserRow
            Icon={BnbLogo} title={t("wallet.chooser.bnb.title")} sub={t("wallet.chooser.bnb.withdrawSub")} href="/wallet/bnb/withdraw"
          />
        </ChooserSheet>
      )}

      {receiveOpen && (
        <ChooserSheet titleId="receive-chooser-title" title={t("wallet.chooser.receive.title")} onClose={() => setReceiveOpen(false)}>
          <ChooserRow
            Icon={RoziMark} title={t("wallet.token.rozi.name")} sub={t("wallet.chooser.rozi.receiveSub")}
            href="/mine/receive"
          />
          {usdtOn && (
            <ChooserRow
              Icon={UsdtLogo} title={t("wallet.chooser.usdt.deposit.title")} sub={t("wallet.chooser.usdt.deposit.sub")}
              href="/wallet/usdt"
            />
          )}
          {usdtOn && (
            <ChooserRow
              Icon={BnbLogo} title={t("wallet.chooser.bnb.title")} sub={t("wallet.chooser.bnb.depositSub")}
              href="/wallet/bnb?action=deposit"
            />
          )}
        </ChooserSheet>
      )}

      {openTx && <TxDetailSheet row={openTx} onClose={() => setOpenTx(null)} />}
    </div>
  );
}

// ---- Send / Receive token chooser ------------------------------------------
// Chrome, focus handling and Escape all come from BottomSheet — see the note
// at the top of that file for what these sheets used to get wrong.
function ChooserSheet({
  titleId, title, onClose, children,
}: { titleId: string; title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <BottomSheet labelledBy={titleId} onClose={onClose}>
      <h2 id={titleId} className="mb-3 pe-10 text-lg font-bold text-brand-ink">{title}</h2>
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
        {children}
      </div>
    </BottomSheet>
  );
}

function ChooserRow({
  Icon, title, sub, href, disabled = false, reason,
}: {
  Icon: (p: { size?: number; className?: string }) => React.ReactElement;
  title: string; sub: string; href: string; disabled?: boolean; reason?: string;
}) {
  const inner = (
    <div className={`flex items-center gap-3 p-4 ${disabled ? "opacity-50" : "active:bg-brand-tint/40"}`}>
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
        <Icon size={22} />
      </span>
      <div className="min-w-0 flex-1 text-left">
        <p className="font-bold text-brand-ink">{title}</p>
        <p className="text-xs text-muted">{disabled && reason ? reason : sub}</p>
      </div>
      {!disabled && <ArrowRightIcon size={18} className="shrink-0 text-muted" />}
    </div>
  );
  if (disabled) return <div title={reason}>{inner}</div>;
  return <Link href={href} className="block">{inner}</Link>;
}

export function TokenRow({
  Icon, name, sub, symbol, amount, muted = false,
}: {
  Icon: (p: { size?: number; className?: string }) => React.ReactElement;
  name: string; sub: string; symbol: string; amount: string; muted?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 p-3.5">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-tint text-brand">
        <Icon size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-bold text-brand-ink leading-snug">{name}</p>
        <p className="text-xs text-muted">{sub}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className={`num font-bold ${muted ? "text-muted" : "text-brand-ink"}`}>{amount}</p>
        <p className="text-[11px] font-semibold text-muted">{symbol}</p>
      </div>
    </div>
  );
}
