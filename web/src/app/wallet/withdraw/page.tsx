"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Button } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import { NotificationsCard } from "@/components/NotificationsCard";
import { WalletIcon, CheckIcon, ClockIcon, InfoIcon, ArrowRightIcon } from "@/components/icons";
import { UsdtLogo } from "@/components/tokenIcons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import {
  fetchBalance, fetchPayoutAddresses, fetchUsdt, createWithdrawal,
  createEarnedUsdtWithdrawal, requestUsdtRefund, requestWithdrawalStepUp, ApiError,
} from "@/lib/api";
import { formatMoney, pointsToUsdt, usdtToPoints, formatBnbWei, formatUsdtMicro } from "@/lib/format";
import { CHAINS, addressLooksValid, type ChainId } from "@/lib/chains";
import { shortAddress } from "@/lib/wallet";

// ONE SCREEN FOR ALL USDT OUT (founder, 2026-08-29).
//
// The user reads one "Ready to take out" figure (the same number /wallet shows)
// and one address box — no wallet-connect step, same shape as the BNB withdraw
// screen. Under the hood the money can come from three places, and the "Take
// from" chips only appear when more than one of them has a balance:
//   • points   — task/referral earnings   -> POST /withdrawals
//   • earned USDT — task rewards paid in USDT -> POST /withdrawals (usdt amount)
//   • deposit  — USDT the user topped up   -> POST /usdt/refunds (staff-approved,
//     stays on the deposit ledger — this is the existing "Get your USDT back"
//     flow, just reachable from here now).
//
// v1 payout is MANUAL for the first two (staff approve, then send); the deposit
// path can auto-settle from the user's own derived address below a ceiling.
export default function WithdrawPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const bal = useApi(fetchBalance, []);
  const saved = useApi(fetchPayoutAddresses, []);
  // Deposit credit + its minimum live on /usdt, not /wallet/balance. Fetched
  // unconditionally: the refund route is not gated on usdtTopupEnabled, so a
  // user who topped up before it was switched off can still take it back.
  const usdt = useApi(fetchUsdt, []);

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
  const [source, setSource] = useState<"points" | "earned_usdt" | "deposit">("points");
  const [needsKyc, setNeedsKyc] = useState(false);
  const [kycStatus, setKycStatus] = useState("none");
  // Large withdrawals need a fresh emailed code (stepUpMinPoints). Does not
  // apply to the deposit refund path.
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const [stepUpCode, setStepUpCode] = useState("");
  const [resendBusy, setResendBusy] = useState(false);
  const [justResent, setJustResent] = useState(false);

  const savedAddresses = saved.data?.addresses ?? {};

  if (!ready || bal.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (bal.error) return <div className="p-4 pt-6"><ErrorState message={bal.error} onRetry={bal.reload} /></div>;

  const balance = bal.data?.points ?? 0;
  const earnedUsdtMicro = bal.data?.earnedUsdtMicro ?? 0;
  const depositMicro = usdt.data?.balanceMicro ?? 0;
  const refundMinMicro = usdt.data?.refundMinMicro ?? 1_000_000;
  const usdtAvailableMicro = bal.data?.usdtAvailableMicro ?? 0;
  const min = bal.data?.minWithdrawPoints ?? 1000;
  const flatFee = bal.data?.withdrawalFeePoints ?? 0;
  const gasFeePercent = bal.data?.gasFeePercent ?? 0;
  const gasFeeFixedMicro = bal.data?.gasFeeFixedMicro ?? 0;
  const chainMeta = CHAINS.find((c) => c.id === chain)!;

  // The places money can come from, in the order they're offered. A place with
  // nothing in it is left out; if only one is left, it's picked silently and no
  // chips show — the screen is then exactly the BNB one.
  const sources = [
    balance > 0 && { key: "points" as const, label: t("withdraw.source.earnings"), amountMicro: Math.round(pointsToUsdt(balance) * 1_000_000) },
    earnedUsdtMicro > 0 && { key: "earned_usdt" as const, label: t("withdraw.source.taskUsdt"), amountMicro: earnedUsdtMicro },
    depositMicro > 0 && { key: "deposit" as const, label: t("withdraw.source.deposit"), amountMicro: depositMicro },
  ].filter(Boolean) as { key: "points" | "earned_usdt" | "deposit"; label: string; amountMicro: number }[];

  const effectiveSource = sources.some((s) => s.key === source) ? source : (sources[0]?.key ?? "points");
  const isDeposit = effectiveSource === "deposit";
  const isPoints = effectiveSource === "points";
  const availMicro = sources.find((s) => s.key === effectiveSource)?.amountMicro ?? 0;

  const minMicro = isDeposit ? refundMinMicro : Math.round(pointsToUsdt(min) * 1_000_000);
  const minUsdt = minMicro / 1_000_000;

  const typedUsdt = Number(usdtInput);
  const hasTyped = usdtInput.trim() !== "" && Number.isFinite(typedUsdt);
  const enteredUsdt = hasTyped ? typedUsdt : minUsdt;
  const enteredMicro = Math.round(enteredUsdt * 1_000_000);
  const amtPoints = hasTyped ? usdtToPoints(typedUsdt) : min; // points path only

  const belowMin = enteredMicro < minMicro;
  const overBalance = enteredMicro > availMicro;

  // Fee preview — points path only. The server re-computes and snapshots it
  // (api/src/fees.ts); this just mirrors the formula so the number shown never
  // disagrees with the request. Most deployments run it at 0.
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
  const invalid = sources.length === 0 || belowMin || overBalance || !addressOk || gasBlocked || (needsStepUp && !stepUpCodeOk);

  if (done) return <SentConfirmation amount={confirmPoints} chainLabel={chainMeta.label} address={trimmed} status={resultStatus} />;

  async function submit() {
    setBusy(true); setError(null); setNeedsKyc(false);
    const code = stepUpCode.trim() || undefined;
    try {
      let status: string;
      if (isDeposit) {
        const r = await requestUsdtRefund(enteredUsdt, trimmed);
        status = r.status;
        setConfirmPoints(usdtToPoints(r.netMicro / 1_000_000));
      } else if (effectiveSource === "earned_usdt") {
        const r = await createEarnedUsdtWithdrawal(enteredMicro, chain, trimmed, code);
        status = r.request.status;
        setConfirmPoints(usdtToPoints(enteredUsdt));
      } else {
        const r = await createWithdrawal(amtPoints, chain, trimmed, code);
        status = r.request.status;
        setConfirmPoints(net);
      }
      setResultStatus(status === "paid" ? "paid" : status === "sending" ? "sending" : "pending");
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
          address, the amount and the button. The KYC / step-up / "take from"
          / gas blocks only appear when they actually apply. */}
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

      {/* "Take from" only appears when more than one place has a balance. */}
      {sources.length > 1 && (
        <div>
          <p className="mb-2 px-1 font-semibold text-brand-ink">{t("withdraw.payFrom")}</p>
          <div className="flex flex-wrap gap-2">
            {sources.map((s) => {
              const active = s.key === effectiveSource;
              return (
                <button key={s.key} type="button" aria-pressed={active}
                  onClick={() => { setSource(s.key); setUsdtInput(""); }}
                  className={`min-w-[46%] flex-1 rounded-xl border p-3 text-left ${active ? "border-brand bg-brand-tint" : "border-line bg-card"}`}>
                  <span className="block text-sm font-semibold text-brand-ink">{s.label}</span>
                  <span className="num text-xs text-muted">{formatUsdtMicro(s.amountMicro)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {isDeposit && (
        <p className="flex items-start gap-1.5 rounded-lg bg-brand-tint/40 p-2.5 text-xs text-muted">
          <InfoIcon size={14} className="mt-0.5 shrink-0" /> {t("withdraw.depositNote")}
        </p>
      )}

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
              min={minUsdt} max={availMicro / 1_000_000} step={0.5}
              placeholder={String(minUsdt)}
              onChange={(e) => setUsdtInput(e.target.value)}
              className="num w-full bg-transparent text-2xl font-bold text-brand-ink outline-none" />
            <span className="shrink-0 font-semibold text-muted">USDT</span>
          </div>
          <p className="mt-1.5 text-xs text-muted">
            {t("withdraw.lowestPayout", { points: isDeposit ? formatUsdtMicro(minMicro) : formatMoney(min) })}
          </p>
        </div>

        {isPoints && fee > 0 && !belowMin && (
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
            {t("withdraw.needAtLeast", { points: isDeposit ? formatUsdtMicro(minMicro) : formatMoney(min) })}
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
