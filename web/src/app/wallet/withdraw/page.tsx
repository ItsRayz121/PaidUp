"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import { WalletIcon, CheckIcon, ClockIcon, ShieldIcon, ArrowRightIcon, StarIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchBalance, fetchPayoutAddresses, savePayoutAddress, createWithdrawal } from "@/lib/api";
import { formatPoints, formatMoney } from "@/lib/format";
import { CHAINS, addressLooksValid, type ChainId } from "@/lib/chains";

// Withdrawal request in USDT. v1 payout is MANUAL (staff approve, then send) —
// the confirmation is honest: a request we pay within the SLA, not instant.
// Usable BELOW the threshold too: a user can set + save their wallet address
// early, then submit once they have enough points.
export default function WithdrawPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const bal = useApi(fetchBalance, []);
  const saved = useApi(fetchPayoutAddresses, []);

  const [chain, setChain] = useState<ChainId>("bep20");
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [savingAddr, setSavingAddr] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const savedAddresses = saved.data?.addresses ?? {};
  // Pre-fill the saved address for the current chain once it loads (only when the
  // field is still empty, so we never clobber something the user is typing).
  useEffect(() => {
    if (!address && savedAddresses[chain]) setAddress(savedAddresses[chain]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.data]);

  function selectChain(c: ChainId) {
    setChain(c);
    setSavedMsg(false);
    // Switching chain swaps in that chain's saved address (or clears the field).
    setAddress(savedAddresses[c] ?? "");
  }

  if (!ready || bal.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (bal.error) return <div className="p-4 pt-6"><ErrorState message={bal.error} onRetry={bal.reload} /></div>;

  const balance = bal.data?.points ?? 0;
  const min = bal.data?.minWithdrawPoints ?? 2000;
  const chainMeta = CHAINS.find((c) => c.id === chain)!;
  const amt = amount || min;
  const belowMin = amt < min;
  const overBalance = amt > balance;
  const addressOk = addressLooksValid(chain, address);
  const invalid = belowMin || overBalance || !addressOk;
  const trimmed = address.trim();
  const canSaveAddr = addressOk && trimmed !== (savedAddresses[chain] ?? "");

  if (done) return <SentConfirmation amount={amt} chainLabel={chainMeta.label} address={trimmed} />;

  async function submit() {
    setBusy(true); setError(null);
    try {
      await createWithdrawal(amt, chain, address.trim());
      setDone(true);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function saveAddr() {
    setSavingAddr(true); setError(null);
    try {
      await savePayoutAddress(chain, address.trim());
      setSavedMsg(true);
      saved.reload();
    } catch (e) { setError((e as Error).message); }
    finally { setSavingAddr(false); }
  }

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-center gap-2">
        <Link href="/wallet" aria-label="Back to wallet" className="text-brand">
          <ArrowRightIcon size={22} className="rotate-180" />
        </Link>
        <h1 className="text-xl font-bold text-brand-ink">{t("common.getMyMoney")}</h1>
      </header>

      {error && <p className="rounded-xl bg-danger-tint p-3 text-sm text-danger">{error}</p>}

      <Card className="p-4">
        <p className="text-sm text-muted">{t("withdraw.youHave")}</p>
        <p className="num text-2xl font-bold text-brand-ink">{t("common.pointsAmount", { n: formatPoints(balance) })}</p>
        <p className="text-sm text-muted">{t("withdraw.aboutEquals", { value: formatMoney(balance) })}</p>
      </Card>

      {/* Network picker */}
      <div>
        <p className="mb-2 px-1 font-semibold text-brand-ink">{t("withdraw.getPaidUsdt")}</p>
        <div className="grid grid-cols-2 gap-2.5">
          {CHAINS.map((c) => {
            const active = c.id === chain;
            return (
              <button key={c.id} onClick={() => selectChain(c.id)} aria-pressed={active}
                className={`rounded-xl border p-3 text-left ${active ? "border-brand bg-brand-tint" : "border-line bg-card"}`}>
                <span className="flex items-center justify-between">
                  <span className="font-semibold text-brand-ink">{c.label}</span>
                  {active && <CheckIcon size={18} className="text-brand" />}
                </span>
                <span className="text-xs text-muted">{c.note}</span>
              </button>
            );
          })}
          {/* PKR / local money — not yet */}
          <div className="col-span-2 flex items-center justify-between rounded-xl border border-dashed border-line bg-card/50 p-3">
            <span className="font-semibold text-muted">{t("withdraw.pkrRow")}</span>
            <span className="rounded-full bg-pending-tint px-2 py-0.5 text-xs font-semibold text-pending">{t("withdraw.comingSoon")}</span>
          </div>
        </div>
      </div>

      {/* Wallet address */}
      <div>
        <label htmlFor="addr" className="mb-2 block px-1 font-semibold text-brand-ink">{t("withdraw.yourWalletAddress")}</label>
        <input id="addr" type="text" inputMode="text" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          placeholder={chain === "aptos" ? t("withdraw.addrPlaceholderAptos") : t("withdraw.addrPlaceholderEvm")}
          value={address} onChange={(e) => setAddress(e.target.value)}
          className="w-full rounded-xl border border-line bg-card p-3.5 text-brand-ink outline-none placeholder:text-muted/60 break-all" />
        {address.length > 0 && !addressOk && (
          <p className="mt-1.5 px-1 text-sm text-danger">{t("withdraw.addrInvalid", { label: chainMeta.label })}</p>
        )}
        {/* Save the address so it's pre-filled next time (works below threshold). */}
        {(canSaveAddr || savedMsg) && (
          <div className="mt-2 flex items-center gap-2">
            {savedMsg && !canSaveAddr ? (
              <span className="flex items-center gap-1 text-sm font-semibold text-success">
                <CheckIcon size={16} /> {t("withdraw.addressSaved")}
              </span>
            ) : (
              <button type="button" onClick={saveAddr} disabled={savingAddr}
                className="rounded-lg border border-brand px-3 py-1.5 text-sm font-semibold text-brand disabled:opacity-60">
                {savingAddr ? t("withdraw.sending") : t("withdraw.saveAddress")}
              </button>
            )}
          </div>
        )}
        <p className="mt-1.5 flex items-start gap-1.5 px-1 text-xs text-muted">
          <ShieldIcon size={14} className="mt-0.5 shrink-0" />
          {t("withdraw.sendRightNetwork", { label: chainMeta.label })}
        </p>
      </div>

      {/* Amount */}
      <div>
        <label htmlFor="amt" className="mb-2 block px-1 font-semibold text-brand-ink">{t("withdraw.howManyPoints")}</label>
        <div className="flex items-center gap-2 rounded-xl border border-line bg-card p-3">
          <StarIcon size={20} className="text-accent" />
          <input id="amt" type="number" inputMode="numeric" value={amount || ""}
            min={min} max={balance} step={100} placeholder={String(min)}
            onChange={(e) => setAmount(Number(e.target.value))}
            className="num w-full bg-transparent text-2xl font-bold text-brand-ink outline-none" />
        </div>
        <p className="mt-1.5 px-1 text-sm font-semibold text-brand-ink">
          {t("withdraw.weSendWorth", { points: t("common.pointsAmount", { n: formatPoints(Math.max(0, amt)) }) })}
        </p>
        <p className="px-1 text-xs text-muted">{t("withdraw.lowestPayout", { points: t("common.pointsAmount", { n: formatPoints(min) }) })}</p>
        {belowMin && <p className="mt-2 rounded-lg bg-pending-tint p-2.5 text-sm text-pending">{t("withdraw.needAtLeast", { points: t("common.pointsAmount", { n: formatPoints(min) }) })}</p>}
        {overBalance && <p className="mt-2 rounded-lg bg-danger-tint p-2.5 text-sm text-danger">{t("withdraw.notEnough")}</p>}
      </div>

      <Button variant="accent" disabled={invalid || busy} onClick={submit}>
        <WalletIcon size={20} /> {busy ? t("withdraw.sending") : t("withdraw.askForUsdt")}
      </Button>
      <p className="flex items-center justify-center gap-1.5 text-xs text-muted">
        <ShieldIcon size={14} /> {t("withdraw.safetyNote")}
      </p>
    </div>
  );
}

function SentConfirmation({ amount, chainLabel, address }: { amount: number; chainLabel: string; address: string }) {
  const { t } = useI18n();
  const shortAddr = address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
  return (
    <div className="flex min-h-[80dvh] flex-col items-center justify-center px-6 text-center">
      <div className="animate-pop grid h-24 w-24 place-items-center rounded-full bg-success text-white"><CheckIcon size={52} /></div>
      <h1 className="animate-rise mt-6 text-2xl font-bold text-brand-ink">{t("withdraw.gotRequest")}</h1>
      <p className="animate-rise mt-2 text-lg font-semibold text-brand-ink">
        {t("withdraw.onTheWay", { points: t("common.pointsAmount", { n: formatPoints(amount) }) })}
      </p>
      <div className="animate-rise mt-6 w-full max-w-sm space-y-2.5 text-left">
        <div className="rounded-xl bg-card border border-line p-3">
          <p className="text-xs text-muted">{t("withdraw.network")}</p>
          <p className="font-semibold text-brand-ink">{chainLabel}</p>
          <p className="mt-2 text-xs text-muted">{t("withdraw.toWallet")}</p>
          <p className="num break-all text-sm text-brand-ink">{shortAddr}</p>
        </div>
        <div className="flex items-center gap-3 rounded-xl bg-success-tint p-3 text-success">
          <CheckIcon size={20} className="shrink-0" /><span className="text-sm font-medium">{t("withdraw.requestReceived")}</span>
        </div>
        <div className="flex items-center gap-3 rounded-xl bg-pending-tint p-3 text-pending">
          <ClockIcon size={20} className="shrink-0" />
          <span className="text-sm font-medium">{t("withdraw.slaNote")}</span>
        </div>
      </div>
      <div className="mt-8 w-full max-w-sm space-y-2.5">
        <Button href="/wallet" variant="primary">{t("withdraw.seeWallet")}</Button>
        <Button href="/" variant="ghost">{t("withdraw.backHome")}</Button>
      </div>
    </div>
  );
}
