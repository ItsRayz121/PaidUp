"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Button } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import { NotificationsCard } from "@/components/NotificationsCard";
import { QuickFillChips } from "@/components/QuickFillChips";
import { WalletIcon, CheckIcon, ClockIcon, ArrowRightIcon } from "@/components/icons";
import { UsdtLogo } from "@/components/tokenIcons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import {
  fetchBalance, fetchPayoutAddresses, createWalletWithdrawal, requestWithdrawalStepUp, ApiError,
} from "@/lib/api";
import { formatMoney, usdtToPoints, formatBnbWei, formatUsdtMicro } from "@/lib/format";
import { CHAINS, addressLooksValid, type ChainId } from "@/lib/chains";
import { shortAddress } from "@/lib/wallet";

// ONE WALLET, TWO REAL SOURCES (founder, 2026-09-03, un-blended same day).
//
// The user reads ONE "you have" figure (the same total /wallet shows) and one
// address box — no "Take from" chips, no Available/Locked split. They type an
// amount and it just works, up to the whole total, for one platform minimum
// ($1). Behind POST /wallet/withdraw the server draws it from money added and
// task USDT already earned — see that route's header in
// api/src/routes/withdrawals.ts. Task/referral points are NOT part of this
// total any more (founder reviewed the blended figure live and asked it
// removed — points settle from the treasury, not from anything actually
// deposited); they cash out on their own screen, /wallet/earnings/withdraw.
//
// A Max button + quick-percent chips (founder, same day: "most exchanges have
// this on withdraw") fill the amount field from the real available total.
export default function WithdrawPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const bal = useApi(fetchBalance, []);
  const saved = useApi(fetchPayoutAddresses, []);

  const [chain] = useState<ChainId>("bep20");
  const [address, setAddress] = useState("");
  // THE USER TYPES USDT; the raw string is held so "2." and "0.05" are typeable.
  const [usdtInput, setUsdtInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [resultStatus, setResultStatus] = useState<"paid" | "sending" | "pending">("pending");
  // Points value of what was sent, for the confirmation card's formatMoney().
  const [confirmPoints, setConfirmPoints] = useState(0);
  const [needsKyc, setNeedsKyc] = useState(false);
  const [kycStatus, setKycStatus] = useState("none");
  // Large withdrawals need a fresh emailed code (stepUpMinPoints).
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const [stepUpCode, setStepUpCode] = useState("");
  const [resendBusy, setResendBusy] = useState(false);
  const [justResent, setJustResent] = useState(false);

  const savedAddresses = saved.data?.addresses ?? {};

  if (!ready || bal.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (bal.error) return <div className="p-4 pt-6"><ErrorState message={bal.error} onRetry={bal.reload} /></div>;

  // ONE combined total — no per-source breakdown, nothing "locked".
  const usdtAvailableMicro = bal.data?.usdtTotalMicro ?? 0;
  const flatFee = bal.data?.withdrawalFeePoints ?? 0;
  const gasFeePercent = bal.data?.gasFeePercent ?? 0;
  const gasFeeFixedMicro = bal.data?.gasFeeFixedMicro ?? 0;
  const chainMeta = CHAINS.find((c) => c.id === chain)!;

  const minMicro = bal.data?.minWithdrawUsdtMicro ?? 1_000_000;
  const minUsdt = minMicro / 1_000_000;

  const typedUsdt = Number(usdtInput);
  const hasTyped = usdtInput.trim() !== "" && Number.isFinite(typedUsdt);
  const enteredUsdt = hasTyped ? typedUsdt : minUsdt;
  const enteredMicro = Math.round(enteredUsdt * 1_000_000);
  const amtPoints = usdtToPoints(enteredUsdt); // fee-preview only — the server re-computes for real

  const belowMin = enteredMicro < minMicro;
  const overBalance = enteredMicro > usdtAvailableMicro;

  // Quick-fill chips (Max + 25/50/75%), like the amount field on most exchange
  // withdraw screens. Always computed off the real available total, never a
  // typed value — picking one always lands exactly on-balance, never over.
  function fillPct(pct: number) {
    const micro = Math.floor((usdtAvailableMicro * pct) / 100);
    setUsdtInput((micro / 1_000_000).toString());
  }

  // Fee preview. The server re-computes and snapshots it (api/src/fees.ts) per
  // leg; this just mirrors the formula so the number shown rarely disagrees
  // with the request. Most deployments run both fees at 0.
  const gasFee = Math.round((amtPoints * gasFeePercent) / 100) + usdtToPoints(gasFeeFixedMicro / 1_000_000);
  const fee = flatFee + gasFee;
  const net = Math.max(0, amtPoints - fee);

  const addressOk = addressLooksValid(chain, address);
  const trimmed = address.trim();
  // Gas is the user's own responsibility (founder, 2026-08-08). null = can't
  // check (relay not wired for this chain) — nothing changes. false = the
  // server would refuse this anyway, so keep the button dead.
  const gasReady = bal.data?.personalGasReady ?? null;
  const gasBlocked = gasReady === false;
  const stepUpCodeOk = /^\d{6}$/.test(stepUpCode);
  const invalid = usdtAvailableMicro <= 0 || belowMin || overBalance || !addressOk || gasBlocked || (needsStepUp && !stepUpCodeOk);

  if (done) return <SentConfirmation amount={confirmPoints} chainLabel={chainMeta.label} address={trimmed} status={resultStatus} />;

  async function submit() {
    setBusy(true); setError(null); setNeedsKyc(false);
    const code = stepUpCode.trim() || undefined;
    try {
      const r = await createWalletWithdrawal(enteredMicro, chain, trimmed, code);
      setConfirmPoints(usdtToPoints(enteredUsdt));
      setResultStatus(r.status === "paid" ? "paid" : r.status === "sending" ? "sending" : "pending");
      setDone(true);
    } catch (e) {
      if (e instanceof ApiError && e.body.kycRequired) {
        setNeedsKyc(true);
        setKycStatus(String(e.body.kycStatus ?? "none"));
      } else if (e instanceof ApiError && e.body.stepUpRequired) {
        if (!needsStepUp) void requestWithdrawalStepUp().catch(() => {});
        else setError((e as Error).message);
        setNeedsStepUp(true);
      } else {
        setError((e as Error).message);
      }
    } finally { setBusy(false); }
  }

  async function resendStepUpCode() {
    setResendBusy(true); setJustResent(false);
    try {
      await requestWithdrawalStepUp();
      setJustResent(true);
    } catch (e) {
      setError((e as Error).message);
    } finally { setResendBusy(false); }
  }

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      {/* Absolutely the same shape as the BNB withdraw screen (founder,
          2026-08-29): header, one balance card, then ONE card holding the
          address, the amount and the button. The KYC / step-up / gas blocks
          only appear when they actually apply. */}
      <header className="flex items-center gap-2">
        <Link href="/wallet" aria-label="Back to wallet" className="text-brand">
          <ArrowRightIcon size={22} className="rotate-180" />
        </Link>
        <UsdtLogo size={30} />
        <div>
          <h1 className="text-xl font-bold text-brand-ink">{t("common.getMyMoney")}</h1>
          {CHAINS.length === 1 && <p className="text-xs text-muted">{chainMeta.label} · {chainMeta.note}</p>}
        </div>
      </header>

      {needsKyc ? (
        <Card className="border-pending/30 bg-pending-tint p-4">
          <p className="font-bold text-pending">{t("withdraw.kyc.title")}</p>
          <p className="mt-1 text-sm text-brand-ink">
            {kycStatus === "pending" ? t("withdraw.kyc.pending") : t("withdraw.kyc.body")}
          </p>
          {kycStatus !== "pending" && (
            <div className="mt-3">
              <Button href="/kyc" full>{t("withdraw.kyc.cta")}</Button>
            </div>
          )}
        </Card>
      ) : needsStepUp ? (
        <Card className="border-pending/30 bg-pending-tint p-4">
          <p className="font-bold text-pending">{t("withdraw.stepUp.title")}</p>
          <p className="mt-1 text-sm text-brand-ink">{t("withdraw.stepUp.body")}</p>
          <label htmlFor="stepup-code" className="mt-3 mb-1.5 block text-sm font-semibold text-brand-ink">
            {t("withdraw.stepUp.codeLabel")}
          </label>
          <input id="stepup-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            placeholder="123456" value={stepUpCode}
            onChange={(e) => setStepUpCode(e.target.value.replace(/\D/g, ""))}
            className="num w-full rounded-xl border border-line bg-card p-3 text-lg tracking-widest text-brand-ink outline-none focus:border-brand" />
          {error && <p className="mt-2 text-sm font-semibold text-danger">{error}</p>}
          <button type="button" onClick={resendStepUpCode} disabled={resendBusy}
            className="mt-2 text-sm font-semibold text-brand disabled:opacity-50">
            {justResent ? t("withdraw.stepUp.resent") : t("withdraw.stepUp.resend")}
          </button>
        </Card>
      ) : null}

      <Card className="p-4">
        <p className="text-sm text-muted">{t("withdraw.youHave")}</p>
        <p className="num mt-1 text-2xl font-bold text-brand-ink">{formatUsdtMicro(usdtAvailableMicro)}</p>
      </Card>

      <Card className="p-4 space-y-4">
        {!needsKyc && !needsStepUp && error && (
          <p className="rounded-xl bg-danger-tint p-3 text-sm text-danger">{error}</p>
        )}

        <div>
          <label htmlFor="withdraw-address" className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-brand-ink">
            <WalletIcon size={18} className="shrink-0 text-brand" />
            {t("withdraw.bep20WalletAddress")}
          </label>
          <p className="mb-2 text-xs text-muted">{t("withdraw.addrHint")}</p>
          <input id="withdraw-address" value={address} onChange={(e) => setAddress(e.target.value)}
            autoCapitalize="none" autoCorrect="off" spellCheck={false}
            placeholder={t("withdraw.addrPlaceholderEvm")}
            className="num w-full rounded-xl border border-line bg-card p-3 text-sm text-brand-ink outline-none focus:border-brand" />
          {savedAddresses[chain] && savedAddresses[chain]!.toLowerCase() !== trimmed.toLowerCase() && (
            <button
              type="button"
              onClick={() => setAddress(savedAddresses[chain]!)}
              className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-full border border-brand/30 bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand"
            >
              <CheckIcon size={13} className="shrink-0" />
              <span className="truncate">{t("withdraw.useSaved")} {shortAddress(savedAddresses[chain]!)}</span>
            </button>
          )}
          {trimmed && !addressOk && (
            <p className="mt-2 text-sm text-danger">{t("withdraw.addrInvalid", { label: chainMeta.label })}</p>
          )}
        </div>

        <div>
          <label htmlFor="amt" className="mb-1.5 block text-sm font-semibold text-brand-ink">{t("withdraw.howManyPoints")}</label>
          <div className="flex items-center gap-2 rounded-xl border border-line bg-card p-3">
            <input id="amt" type="number" inputMode="decimal" value={usdtInput}
              min={minUsdt} max={usdtAvailableMicro / 1_000_000} step={0.5}
              placeholder={String(minUsdt)}
              onChange={(e) => setUsdtInput(e.target.value)}
              className="num w-full bg-transparent text-2xl font-bold text-brand-ink outline-none" />
            <span className="shrink-0 font-semibold text-muted">USDT</span>
          </div>
          {usdtAvailableMicro > 0 && <QuickFillChips onPick={fillPct} />}
          <p className="mt-1.5 text-xs text-muted">
            {t("withdraw.lowestPayout", { points: formatUsdtMicro(minMicro) })}
          </p>
        </div>

        {fee > 0 && !belowMin && (
          <div className="rounded-lg border border-line bg-card p-2.5 text-sm">
            <div className="flex justify-between text-muted">
              <span>{t("withdraw.feeLabel")}</span>
              <span className="num">− {formatMoney(fee)}</span>
            </div>
            <div className="mt-1 flex justify-between font-semibold text-brand-ink">
              <span>{t("withdraw.youReceive")}</span>
              <span className="num">{formatMoney(net)}</span>
            </div>
          </div>
        )}

        {belowMin && (
          <p className="rounded-lg bg-pending-tint p-2.5 text-sm text-pending">
            {t("withdraw.needAtLeast", { points: formatUsdtMicro(minMicro) })}
          </p>
        )}
        {overBalance && <p className="rounded-lg bg-danger-tint p-2.5 text-sm text-danger">{t("withdraw.notEnough")}</p>}
        {gasBlocked && (
          <div className="rounded-lg border border-danger/30 bg-danger-tint p-2.5 text-sm text-danger">
            <p className="font-semibold">{t("refund.gasNotReady")}</p>
            <p className="num mt-1 text-xs opacity-80">
              {t("refund.gasBalance", { balance: formatBnbWei(bal.data?.personalGasWei ?? null) })}
            </p>
          </div>
        )}

        <Button variant="accent" disabled={invalid || busy} onClick={submit}>
          {busy ? t("withdraw.sending") : needsStepUp ? t("withdraw.stepUp.confirm") : t("withdraw.askForUsdt")}
        </Button>
      </Card>
    </div>
  );
}

// Compact confirmation card — same shape as the BNB withdraw screen's `done`
// state, not a full-screen celebration.
function SentConfirmation({ amount, chainLabel, address, status }: { amount: number; chainLabel: string; address: string; status: "paid" | "sending" | "pending" }) {
  const { t } = useI18n();
  const shortAddr = address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-center gap-2">
        <Link href="/wallet" aria-label="Back to wallet" className="text-brand">
          <ArrowRightIcon size={22} className="rotate-180" />
        </Link>
        <UsdtLogo size={30} />
        <h1 className="text-xl font-bold text-brand-ink">{t("common.getMyMoney")}</h1>
      </header>

      <Card className="p-5 text-center">
        <CheckIcon size={38} className="mx-auto text-success" />
        <p className="mt-2 font-bold text-brand-ink">
          {status === "paid" ? "Your USDT was sent" : status === "sending" ? "Your USDT is being sent" : t("withdraw.gotRequest")}
        </p>
        <p className="num mt-1 text-lg font-bold text-brand-ink">
          {t("withdraw.onTheWay", { points: formatMoney(amount) })}
        </p>
        <div className="mt-4 rounded-xl border border-line bg-brand-tint/40 p-3 text-left">
          <p className="text-xs text-muted">{t("withdraw.network")}</p>
          <p className="font-semibold text-brand-ink">{chainLabel}</p>
          <p className="mt-2 text-xs text-muted">{t("withdraw.toWallet")}</p>
          <p className="num break-all text-sm text-brand-ink">{shortAddr}</p>
        </div>
        {status === "pending" && (
          <p className="mt-3 flex items-center justify-center gap-2 text-sm text-pending">
            <ClockIcon size={16} className="shrink-0" /> {t("withdraw.slaNote")}
          </p>
        )}
        <div className="mt-4"><Button href="/wallet" variant="primary">{t("withdraw.seeWallet")}</Button></div>
      </Card>

      <NotificationsCard compact />
    </div>
  );
}
