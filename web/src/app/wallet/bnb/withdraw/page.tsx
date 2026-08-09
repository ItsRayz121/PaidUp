"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Button } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import { ArrowRightIcon, CheckIcon, WalletIcon } from "@/components/icons";
import { BnbLogo } from "@/components/tokenIcons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchUsdt, fetchPayoutAddresses, createBnbWithdrawal, ApiError } from "@/lib/api";
import { formatBnbWei } from "@/lib/format";

export default function BnbWithdrawPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const wallet = useApi(fetchUsdt, []);
  const saved = useApi(fetchPayoutAddresses, []);
  const [addressEdit, setAddressEdit] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!ready || wallet.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (wallet.error || !wallet.data) return <div className="p-4 pt-6"><ErrorState message={wallet.error ?? "Could not load wallet."} onRetry={wallet.reload} /></div>;

  const balanceWei = wallet.data.personalGasWei;
  const feeWei = wallet.data.personalGasRequiredWei;
  const address = addressEdit ?? saved.data?.addresses?.bep20 ?? "";
  const addressOk = /^0x[0-9a-fA-F]{40}$/.test(address.trim());
  const amountOk = Number(amount) > 0 && Number.isFinite(Number(amount));

  async function submit() {
    setBusy(true); setError(null);
    try {
      await createBnbWithdrawal(address.trim(), amount.trim());
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong.");
    } finally { setBusy(false); }
  }

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-center gap-2">
        <Link href="/wallet" aria-label="Back to wallet" className="text-brand"><ArrowRightIcon size={22} className="rotate-180" /></Link>
        <BnbLogo size={30} />
        <div><h1 className="text-xl font-bold text-brand-ink">Withdraw BNB</h1><p className="text-xs text-muted">BNB Smart Chain (BEP20)</p></div>
      </header>

      <Card className="p-4">
        <p className="text-sm text-muted">From your RoziPay BNB wallet</p>
        <p className="num mt-1 text-2xl font-bold text-brand-ink">{formatBnbWei(balanceWei)}</p>
      </Card>

      {done ? (
        <Card className="p-5 text-center">
          <CheckIcon size={38} className="mx-auto text-success" />
          <p className="mt-2 font-bold text-brand-ink">{t("wallet.bnb.submitted")}</p>
          <div className="mt-4"><Button href="/wallet" variant="primary">See my wallet</Button></div>
        </Card>
      ) : (
        <Card className="p-4 space-y-4">
          {error && <p className="rounded-xl bg-danger-tint p-3 text-sm text-danger">{error}</p>}
          <div>
            <label htmlFor="bnb-address" className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-brand-ink"><WalletIcon size={18} />Send BNB to</label>
            <p className="mb-2 text-xs text-muted">Paste your BNB Smart Chain wallet address.</p>
            <input id="bnb-address" value={address} onChange={(e) => setAddressEdit(e.target.value)} placeholder="0x… (42 characters)"
              autoCapitalize="none" autoCorrect="off" spellCheck={false}
              className="num w-full rounded-xl border border-line bg-card p-3 text-sm text-brand-ink outline-none focus:border-brand" />
          </div>
          <div>
            <label htmlFor="bnb-amount" className="mb-1.5 block text-sm font-semibold text-brand-ink">How much BNB?</label>
            <input id="bnb-amount" type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.001"
              className="num w-full rounded-xl border border-line bg-card p-3 text-brand-ink outline-none focus:border-brand" />
          </div>
          {feeWei !== null && <p className="text-xs text-muted">Estimated network fee: {formatBnbWei(feeWei)}</p>}
          <Button onClick={submit} disabled={!addressOk || !amountOk || busy} variant="accent">
            {busy ? t("withdraw.sending") : "Withdraw BNB"}
          </Button>
        </Card>
      )}
    </div>
  );
}
