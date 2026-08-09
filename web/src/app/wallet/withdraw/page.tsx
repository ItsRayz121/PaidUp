"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import { NotificationsCard } from "@/components/NotificationsCard";
import { WalletIcon, CheckIcon, ClockIcon, ShieldIcon, InfoIcon, ArrowRightIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchBalance, fetchPayoutAddresses, createWithdrawal, createEarnedUsdtWithdrawal, ApiError } from "@/lib/api";
import { formatMoney, pointsToUsdt, usdtToPoints, formatBnbWei, formatUsdtMicro } from "@/lib/format";
import { shortAddress } from "@/lib/wallet";
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
  // THE USER TYPES USDT; THE API TAKES POINTS. The input holds the raw string
  // they typed (not a number) so that "2." and "0.05" are typeable — coercing on
  // every keystroke makes a decimal point impossible to enter. It becomes points
  // once, at `amt` below, which is the only value the API ever sees.
  const [usdtInput, setUsdtInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [source, setSource] = useState<"points" | "earned_usdt">("points");
  // Set when the server refuses the withdrawal because the user has not verified
  // their ID yet. Drives the "Verify your ID" card below instead of a dead error.
  const [needsKyc, setNeedsKyc] = useState(false);
  const [kycStatus, setKycStatus] = useState("none");

  const savedAddresses = saved.data?.addresses ?? {};
  // Pre-fill the saved address for the current chain once it loads (only when the
  // field is still empty, so we never clobber something the user is typing).
  // Syncing FROM the API response (an external system) into the input's state.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!address && savedAddresses[chain]) setAddress(savedAddresses[chain]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.data]);

  function selectChain(c: ChainId) {
    setChain(c);
    // Switching chain swaps in that chain's saved address (or clears the field).
    setAddress(savedAddresses[c] ?? "");
  }

  if (!ready || bal.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (bal.error) return <div className="p-4 pt-6"><ErrorState message={bal.error} onRetry={bal.reload} /></div>;

  const balance = bal.data?.points ?? 0;
  const earnedUsdtMicro = bal.data?.earnedUsdtMicro ?? 0;
  const min = bal.data?.minWithdrawPoints ?? 1000;
  const flatFee = bal.data?.withdrawalFeePoints ?? 0;
  const gasFeePercent = bal.data?.gasFeePercent ?? 0;
  const gasFeeFixedMicro = bal.data?.gasFeeFixedMicro ?? 0;
  const chainMeta = CHAINS.find((c) => c.id === chain)!;
  // Blank field means "the minimum", which is what the placeholder shows.
  const typedUsdt = Number(usdtInput);
  const amt = usdtInput.trim() !== "" && Number.isFinite(typedUsdt)
    ? usdtToPoints(typedUsdt)
    : min;
  // PREVIEW ONLY — mirrors the server's exact formula (gasFeePoints in
  // api/src/fees.ts) so this never shows a number the request will then
  // disagree with, but the fee actually charged is re-computed and
  // snapshotted server-side at request time (see POST /withdrawals).
  const gasFee = Math.round((amt * gasFeePercent) / 100) + usdtToPoints(gasFeeFixedMicro / 1_000_000);
  const fee = flatFee + gasFee;
  const net = Math.max(0, amt - fee); // points actually converted to USDT
  const belowMin = amt < min;
  const amountUsdtMicro = Math.round((usdtInput.trim() === "" ? pointsToUsdt(min) : typedUsdt) * 1_000_000);
  const overBalance = source === "earned_usdt" ? amountUsdtMicro > earnedUsdtMicro : amt > balance;
  const addressOk = addressLooksValid(chain, address);
  // Gas is the user's own responsibility (founder, 2026-08-08, second pass).
  // null means "can't check yet" (relay not wired up for this chain) — the
  // pre-existing direct-treasury fallback pays its own gas, nothing changes.
  // false means the button must stay dead: the server would refuse this
  // before holding any points anyway.
  const gasReady = bal.data?.personalGasReady ?? null;
  const gasBlocked = gasReady === false;
  const invalid = belowMin || overBalance || !addressOk || gasBlocked;
  const trimmed = address.trim();
  const addressVerified = saved.data?.verified?.[chain];

  if (done) return <SentConfirmation amount={net} chainLabel={chainMeta.label} address={trimmed} />;

  async function submit() {
    setBusy(true); setError(null); setNeedsKyc(false);
    try {
      if (source === "earned_usdt") await createEarnedUsdtWithdrawal(amountUsdtMicro, chain, address.trim());
      else await createWithdrawal(amt, chain, address.trim());
      setDone(true);
    } catch (e) {
      // The server sends a `kycRequired` flag, not just a sentence. Show them the
      // way to fix it rather than an error they can do nothing about.
      if (e instanceof ApiError && e.body.kycRequired) {
        setNeedsKyc(true);
        setKycStatus(String(e.body.kycStatus ?? "none"));
      }
      setError((e as Error).message);
    }
    finally { setBusy(false); }
  }

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-center gap-2">
        <Link href="/wallet" aria-label="Back to wallet" className="text-brand">
          <ArrowRightIcon size={22} className="rotate-180" />
        </Link>
        <h1 className="text-xl font-bold text-brand-ink">{t("common.getMyMoney")}</h1>
      </header>

      {/* An unverified user gets a way FORWARD, not just a refusal. This is the
          most common reason a first withdrawal fails, so it must not be a wall. */}
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
      ) : (
        error && <p className="rounded-xl bg-danger-tint p-3 text-sm text-danger">{error}</p>
      )}

      {/* The "only what you earned" bridge sentence that used to open this
          card is gone (founder, 2026-08-05, asked and reconfirmed after being
          told what it was for — it explained why this number can be smaller
          than the ROZI balance on /wallet). If that confusion resurfaces in
          support tickets, this is the line to bring back. */}
      <Card className="p-4">
        <p className="text-sm text-muted">{t("withdraw.youHave")}</p>
        <p className="num text-2xl font-bold text-brand-ink">{formatMoney(balance)}</p>
        <p className="text-sm text-muted">{t("withdraw.aboutEquals")}</p>
      </Card>

      {earnedUsdtMicro > 0 && (
        <div>
          <p className="mb-2 px-1 font-semibold text-brand-ink">Pay from</p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setSource("points")}
              className={`rounded-xl border p-3 text-left ${source === "points" ? "border-brand bg-brand-tint" : "border-line bg-card"}`}>
              <span className="block font-semibold">Points balance</span>
              <span className="text-xs text-muted">{formatMoney(balance)}</span>
            </button>
            <button type="button" onClick={() => setSource("earned_usdt")}
              className={`rounded-xl border p-3 text-left ${source === "earned_usdt" ? "border-brand bg-brand-tint" : "border-line bg-card"}`}>
              <span className="block font-semibold">Task USDT</span>
              <span className="text-xs text-muted">{formatUsdtMicro(earnedUsdtMicro)}</span>
            </button>
          </div>
        </div>
      )}

      {/* Network picker — or, while we pay out on exactly one chain, a statement.
          A row of radio buttons containing a single option is not a choice; it
          reads as "there are others, find them", and every user who taps it
          learns nothing. So one chain renders as a plain labelled fact, and the
          picker comes back by itself the moment CHAINS has more than one entry
          (see web/src/lib/chains.ts). */}
      <div>
        <p className="mb-2 px-1 font-semibold text-brand-ink">{t("withdraw.getPaidUsdt")}</p>
        <div className="grid grid-cols-2 gap-2.5">
          {CHAINS.length === 1 ? (
            <div className="col-span-2 flex items-center justify-between rounded-xl border border-brand bg-brand-tint p-3">
              <span>
                <span className="block font-semibold text-brand-ink">{CHAINS[0].label}</span>
                <span className="text-xs text-muted">{CHAINS[0].note}</span>
              </span>
              <CheckIcon size={18} className="shrink-0 text-brand" />
            </div>
          ) : (
            CHAINS.map((c) => {
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
            })
          )}
        </div>
      </div>

      {/* ---- Where the money goes ----
          Read-only summary now (founder, 2026-08-05) — the actual connect/type
          flow moved to /profile/settings, so it exists in exactly one place.
          This card shows what's already saved and links there to change it;
          it never collects an address itself, which is what made the old
          version of this screen feel like a second, competing setup flow. */}
      {trimmed ? (
        <Card className="p-4">
          <p className="flex items-center gap-2 font-bold text-brand-ink">
            <WalletIcon size={20} className="shrink-0 text-brand" />
            {t("withdraw.sendingTo")}
          </p>
          <p className="num mt-1 break-all font-semibold text-brand-ink">{shortAddress(trimmed)}</p>
          {addressVerified ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-sm font-semibold text-success">
              <CheckIcon size={16} /> {t("connect.isYours")}
            </p>
          ) : (
            <p className="mt-1.5 flex items-start gap-1.5 text-sm text-muted">
              <InfoIcon size={16} className="mt-0.5 shrink-0" /> {t("connect.typedIn")}
            </p>
          )}
          <Link href="/profile/settings" className="mt-3 inline-block text-sm font-semibold text-brand underline-offset-2 hover:underline">
            {t("withdraw.changeWallet")}
          </Link>
        </Card>
      ) : (
        <Card className="border-pending/30 bg-pending-tint p-4">
          <p className="flex items-center gap-2 font-bold text-pending">
            <WalletIcon size={20} className="shrink-0" />
            {t("withdraw.noWallet.title")}
          </p>
          <p className="mt-1 text-sm text-brand-ink">{t("withdraw.noWallet.body")}</p>
          <div className="mt-3">
            <Button href="/profile/settings" full>{t("withdraw.noWallet.cta")}</Button>
          </div>
        </Card>
      )}

      {/* Amount */}
      <div>
        <label htmlFor="amt" className="mb-2 block px-1 font-semibold text-brand-ink">{t("withdraw.howManyPoints")}</label>
        <div className="flex items-center gap-2 rounded-xl border border-line bg-card p-3">
          {/* Not StarIcon: that one means "earnings" everywhere else in the app
              (wallet history, the invite rows), and on a field where the user
              types dollars it meant nothing at all. */}
          <WalletIcon size={20} className="text-brand" />
          <input id="amt" type="number" inputMode="decimal" value={usdtInput}
            min={pointsToUsdt(min)} max={pointsToUsdt(balance)} step={0.5}
            placeholder={String(pointsToUsdt(min))}
            onChange={(e) => setUsdtInput(e.target.value)}
            className="num w-full bg-transparent text-2xl font-bold text-brand-ink outline-none" />
          <span className="shrink-0 font-semibold text-muted">USDT</span>
        </div>
        {fee > 0 && !belowMin && (
          <div className="mt-2 rounded-lg border border-line bg-card p-2.5 text-sm">
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
        <p className="mt-1.5 px-1 text-sm font-semibold text-brand-ink">
          {t("withdraw.weSendWorth", { points: formatMoney(net) })}
        </p>
        <p className="px-1 text-xs text-muted">{t("withdraw.lowestPayout", { points: formatMoney(min) })}</p>
        {belowMin && <p className="mt-2 rounded-lg bg-pending-tint p-2.5 text-sm text-pending">{t("withdraw.needAtLeast", { points: formatMoney(min) })}</p>}
        {overBalance && <p className="mt-2 rounded-lg bg-danger-tint p-2.5 text-sm text-danger">{t("withdraw.notEnough")}</p>}
        {/* The amount can be perfectly valid while the button stays dead,
            because the address is what "invalid" is ALSO checking — and
            unlike belowMin/overBalance, that reason had no message of its
            own before this. The noWallet card above already explains a
            MISSING address; this covers the identical case at the point
            where someone is actually staring at the disabled button. */}
        {!belowMin && !overBalance && !addressOk && (
          <p className="mt-2 rounded-lg bg-pending-tint p-2.5 text-sm text-pending">{t("withdraw.needWalletFirst")}</p>
        )}
        {gasReady !== null && (
          <div
            className={`mt-2 rounded-lg border p-2.5 text-sm ${
              gasReady ? "border-line bg-card text-muted" : "border-danger/30 bg-danger-tint text-danger"
            }`}
          >
            <p className="font-semibold">
              {gasReady ? t("refund.gasReady") : t("refund.gasNotReady")}
            </p>
            <p className="num mt-1 text-xs opacity-80">
              {t("refund.gasBalance", { balance: formatBnbWei(bal.data?.personalGasWei ?? null) })}
            </p>
          </div>
        )}
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
        {t("withdraw.onTheWay", { points: formatMoney(amount) })}
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
        {/* The moment they most want to hear "your money is sent" — offer to
            tell them. Renders nothing if push is off or unsupported. */}
        <NotificationsCard compact />
      </div>
      <div className="mt-8 w-full max-w-sm space-y-2.5">
        <Button href="/wallet" variant="primary">{t("withdraw.seeWallet")}</Button>
        <Button href="/" variant="ghost">{t("withdraw.backHome")}</Button>
      </div>
    </div>
  );
}
