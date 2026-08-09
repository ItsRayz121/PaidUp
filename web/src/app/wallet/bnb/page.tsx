"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Button, SectionTitle } from "@/components/ui";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { ArrowRightIcon, CopyIcon, CheckIcon } from "@/components/icons";
import { BnbLogo } from "@/components/tokenIcons";
import { QrCode } from "@/components/QrCode";
import { TxDetailSheet } from "@/components/TxDetailSheet";
import { HistoryList } from "@/components/HistoryList";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchMiningState, fetchUsdt, fetchBnbWithdrawals, createBnbWithdrawal, ApiError } from "@/lib/api";
import { formatBnbWei } from "@/lib/format";
import { chainLabel } from "@/lib/chains";
import { unifyHistory, type Row } from "@/lib/walletHistory";

// BNB works as its own wallet too — live balance (a real on-chain read of the
// user's own derived custody address), the SAME deposit address USDT uses
// (same chain, same address), a real Withdraw (signs a native transfer from
// that address — api/src/bnbWithdraw.ts, zero treasury involvement), and a
// BNB-only view of the unified history.
export default function BnbWalletPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const mining = useApi(fetchMiningState, []);
  const usdtOn = Boolean(mining.data?.usdtTopup);
  const usdt = useApi(fetchUsdt, [usdtOn], usdtOn);
  const bnbWithdrawals = useApi(fetchBnbWithdrawals, []);
  const [copied, setCopied] = useState(false);
  const [openTx, setOpenTx] = useState<Row | null>(null);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;

  const gasWei = usdt.data?.personalGasWei ?? null;
  const requiredWei = usdt.data?.personalGasRequiredWei ?? null;
  const gasReady = usdt.data?.personalGasReady ?? null;
  const depositAddress = usdt.data?.personalAddress ?? null;
  const chain = usdt.data?.treasuryChain ?? "bep20";

  const addressOk = /^0x[0-9a-fA-F]{40}$/.test(address.trim());
  const amountOk = Number(amount) > 0 && Number.isFinite(Number(amount));

  const rows = unifyHistory({
    ledger: [], rozi: [], withdrawals: [], topups: [], refunds: [],
    bnb: bnbWithdrawals.data?.requests ?? [], t,
  });

  function copyAddress() {
    if (!depositAddress) return;
    navigator.clipboard?.writeText(depositAddress).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  async function submit() {
    setBusy(true); setError(null);
    try {
      await createBnbWithdrawal(address.trim(), amount.trim());
      setDone(true);
      bnbWithdrawals.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-center gap-2">
        <Link href="/wallet" aria-label="Back to wallet" className="text-brand">
          <ArrowRightIcon size={22} className="rotate-180" />
        </Link>
        <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-tint text-brand"><BnbLogo size={18} /></span>
        <h1 className="text-xl font-bold text-brand-ink">{t("wallet.token.bnb.name")}</h1>
      </header>

      <Card className="p-4">
        <p className="text-sm text-muted">{t("wallet.available")}</p>
        <p className="num text-3xl font-bold text-brand-ink">
          {gasWei !== null ? formatBnbWei(gasWei) : t("wallet.token.soon")}
        </p>
      </Card>

      {usdtOn && depositAddress && (
        <section>
          <SectionTitle>{t("wallet.token.bnb.name")} {t("wallet.deposit")}</SectionTitle>
          <Card className="p-4 space-y-3">
            <div className="flex justify-center"><QrCode value={depositAddress} /></div>
            <div className="rounded-lg border border-line p-2.5 text-xs text-muted flex justify-between">
              <span>{t("topup.token")}</span><span className="font-semibold text-brand-ink">BNB</span>
            </div>
            <div className="rounded-lg border border-line p-2.5 text-xs text-muted flex justify-between">
              <span>{t("topup.network")}</span><span className="font-semibold text-brand-ink">{chainLabel(chain)}</span>
            </div>
            <button onClick={copyAddress} className="w-full rounded-xl border border-line p-3 text-left flex items-center justify-between active:bg-brand-tint/40">
              <span className="num text-sm break-all text-brand-ink">{depositAddress}</span>
              {copied ? <CheckIcon size={18} className="shrink-0 text-success ml-2" /> : <CopyIcon size={18} className="shrink-0 text-muted ml-2" />}
            </button>
          </Card>
        </section>
      )}

      {!showWithdraw ? (
        <Button onClick={() => setShowWithdraw(true)} variant="primary" disabled={gasReady === null}>
          {t("wallet.withdraw")}
        </Button>
      ) : done ? (
        <Card className="p-4 text-center space-y-2">
          <CheckIcon size={32} className="mx-auto text-success" />
          <p className="font-bold text-brand-ink">{t("wallet.bnb.submitted")}</p>
          <Button onClick={() => { setDone(false); setShowWithdraw(false); setAmount(""); setAddress(""); }} variant="ghost">
            {t("common.close")}
          </Button>
        </Card>
      ) : (
        <Card className="p-4 space-y-3">
          {error && <p className="rounded-xl bg-danger-tint p-3 text-sm text-danger">{error}</p>}
          {gasReady === false && (
            <p className="rounded-lg bg-danger-tint p-2.5 text-sm text-danger">{t("wallet.bnb.notEnough")}</p>
          )}
          <div>
            <label htmlFor="bnb-addr" className="mb-1.5 block text-sm font-semibold text-brand-ink">{t("withdraw.yourWalletAddress")}</label>
            <input id="bnb-addr" value={address} onChange={(e) => setAddress(e.target.value)}
              placeholder={t("withdraw.addrPlaceholderEvm")}
              className="w-full rounded-xl border border-line bg-card p-3 text-brand-ink outline-none break-all" />
          </div>
          <div>
            <label htmlFor="bnb-amt" className="mb-1.5 block text-sm font-semibold text-brand-ink">{t("wallet.bnb.amount")}</label>
            <input id="bnb-amt" type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
              placeholder="0.001"
              className="num w-full rounded-xl border border-line bg-card p-3 text-brand-ink outline-none" />
          </div>
          {requiredWei !== null && (
            <p className="text-xs text-muted">{t("wallet.bnb.feeNote", { fee: formatBnbWei(requiredWei) })}</p>
          )}
          <Button onClick={submit} disabled={!addressOk || !amountOk || busy} variant="accent">
            {busy ? t("withdraw.sending") : t("wallet.withdraw")}
          </Button>
        </Card>
      )}

      <section>
        <SectionTitle>{t("wallet.bnb.transactions")}</SectionTitle>
        {bnbWithdrawals.loading ? <Loading /> : bnbWithdrawals.error ? (
          <ErrorState message={bnbWithdrawals.error} onRetry={bnbWithdrawals.reload} />
        ) : rows.length === 0 ? (
          <EmptyState title={t("wallet.noHistoryTitle")} body={t("wallet.noHistoryBody.generic")} />
        ) : (
          <HistoryList rows={rows} onOpen={setOpenTx} />
        )}
      </section>

      {openTx && <TxDetailSheet row={openTx} onClose={() => setOpenTx(null)} />}
    </div>
  );
}
