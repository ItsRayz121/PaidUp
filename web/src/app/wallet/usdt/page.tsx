"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, SectionTitle, Button } from "@/components/ui";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { ArrowRightIcon, CopyIcon, CheckIcon } from "@/components/icons";
import { UsdtLogo } from "@/components/tokenIcons";
import { QrCode } from "@/components/QrCode";
import { TxDetailSheet } from "@/components/TxDetailSheet";
import { HistoryList } from "@/components/HistoryList";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchBalance, fetchLedger, fetchMiningState, fetchUsdtNoGas, fetchWithdrawals } from "@/lib/api";
import { formatUsdtMicro } from "@/lib/format";
import { chainLabel } from "@/lib/chains";
import { unifyHistory, type Row } from "@/lib/walletHistory";

// USDT works as a dedicated wallet: balance, deposit address, withdraw, and a
// USDT-only view of the same unified history the main wallet page shows —
// see lib/walletHistory.ts for how the rows are built.
export default function UsdtWalletPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const bal = useApi(fetchBalance, []);
  const led = useApi(fetchLedger, []);
  const mining = useApi(fetchMiningState, []);
  const withdrawals = useApi(fetchWithdrawals, []);
  const usdtOn = Boolean(mining.data?.usdtTopup);
  const usdt = useApi(fetchUsdtNoGas, [usdtOn], usdtOn);
  const [copied, setCopied] = useState(false);
  const [openTx, setOpenTx] = useState<Row | null>(null);
  const [showAll, setShowAll] = useState(false);

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;

  const total = bal.data?.usdtTotalMicro ?? 0;

  const address = usdt.data?.personalAddress ?? usdt.data?.treasuryAddress ?? null;
  const chain = usdt.data?.treasuryChain ?? "bep20";

  const allRows = unifyHistory({
    ledger: led.data?.entries ?? [], rozi: [], withdrawals: withdrawals.data?.requests ?? [],
    topups: usdt.data?.topups ?? [], refunds: usdt.data?.refunds ?? [], bnb: [], t,
  }).filter((r) => r.token === "USDT");
  const PREVIEW = 3;
  const rows = showAll ? allRows : allRows.slice(0, PREVIEW);
  const hiddenCount = allRows.length - rows.length;

  function copyAddress() {
    if (!address) return;
    navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-center gap-2">
        <Link href="/wallet" aria-label="Back to wallet" className="text-brand">
          <ArrowRightIcon size={22} className="rotate-180" />
        </Link>
        <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-tint text-brand"><UsdtLogo size={18} /></span>
        <h1 className="text-xl font-bold text-brand-ink">{t("wallet.token.usdt.name")}</h1>
      </header>

      {bal.error ? (
        <ErrorState message={bal.error} onRetry={bal.reload} />
      ) : (
        <Card className="p-4 space-y-1.5">
          <Row2 label={t("wallet.available")} value={formatUsdtMicro(total)} strong />
        </Card>
      )}

      {usdtOn && address && (
        <section>
          <SectionTitle>{t("wallet.token.usdt.name")} {t("wallet.deposit")}</SectionTitle>
          <Card className="p-4 space-y-3">
            <div className="flex justify-center"><QrCode value={address} /></div>
            <div className="rounded-lg border border-line p-2.5 text-xs text-muted flex justify-between">
              <span>{t("topup.token")}</span><span className="font-semibold text-brand-ink">USDT</span>
            </div>
            <div className="rounded-lg border border-line p-2.5 text-xs text-muted flex justify-between">
              <span>{t("topup.network")}</span><span className="font-semibold text-brand-ink">{chainLabel(chain)}</span>
            </div>
            <button onClick={copyAddress} className="w-full rounded-xl border border-line p-3 text-left flex items-center justify-between active:bg-brand-tint/40">
              <span className="num text-sm break-all text-brand-ink">{address}</span>
              {copied ? <CheckIcon size={18} className="shrink-0 text-success ml-2" /> : <CopyIcon size={18} className="shrink-0 text-muted ml-2" />}
            </button>
          </Card>
        </section>
      )}

      <section>
        <SectionTitle>{t("wallet.usdt.transactions")}</SectionTitle>
        {led.loading ? <Loading /> : led.error ? (
          <ErrorState message={led.error} onRetry={led.reload} />
        ) : rows.length === 0 ? (
          <EmptyState title={t("wallet.noHistoryTitle")} body={t("wallet.noHistoryBody.usdt")} />
        ) : (
          <HistoryList rows={rows} onOpen={setOpenTx} />
        )}
        {!led.loading && !led.error && (hiddenCount > 0 || showAll) && (
          <div className="mt-3">
            <Button onClick={() => setShowAll(!showAll)} variant="ghost" size="md">
              {showAll ? t("wallet.history.less") : t("wallet.history.more")}
            </Button>
          </div>
        )}
      </section>

      {openTx && <TxDetailSheet row={openTx} onClose={() => setOpenTx(null)} />}
    </div>
  );
}

function Row2({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted">{label}</span>
      <span className={`num font-bold ${strong ? "text-2xl text-brand-ink" : "text-brand-ink"}`}>{value}</span>
    </div>
  );
}
