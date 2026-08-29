"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import { NotificationsCard } from "@/components/NotificationsCard";
import { ConnectWallet } from "@/components/ConnectWallet";
import { WalletIcon, CheckIcon, ClockIcon, ShieldIcon, InfoIcon, ArrowRightIcon } from "@/components/icons";
import { UsdtLogo } from "@/components/tokenIcons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchBalance, fetchPayoutAddresses, createWithdrawal, createEarnedUsdtWithdrawal, requestWithdrawalStepUp, ApiError } from "@/lib/api";
import { formatMoney, pointsToUsdt, usdtToPoints, formatBnbWei, formatUsdtMicro } from "@/lib/format";
import { CHAINS, addressLooksValid, type ChainId } from "@/lib/chains";
import { shortAddress } from "@/lib/wallet";

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
  const [resultStatus, setResultStatus] = useState<"paid" | "sending" | "pending">("pending");
  const [source, setSource] = useState<"points" | "earned_usdt">("points");
  // Set when the server refuses the withdrawal because the user has not verified
  // their ID yet. Drives the "Verify your ID" card below instead of a dead error.
  const [needsKyc, setNeedsKyc] = useState(false);
  const [kycStatus, setKycStatus] = useState("none");
  // Set when the server refuses because this withdrawal (or today's total) is
  // over stepUpMinPoints (api/src/routes/withdrawals.ts) and no code has been
  // supplied yet. submit() sends the code itself the first time this happens —
  // see below — then shows the code box.
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const [stepUpCode, setStepUpCode] = useState("");
  const [resendBusy, setResendBusy] = useState(false);
  const [justResent, setJustResent] = useState(false);
  // Connect (signed) is the default and the safe path — see ConnectWallet.tsx.
  // Typing is the documented fallback for a smart-contract wallet, an exchange
  // deposit address, or a phone with no wallet app at all.
  const [addrTyping, setAddrTyping] = useState(false);

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
  const stepUpCodeOk = /^\d{6}$/.test(stepUpCode);
  const invalid = belowMin || overBalance || !addressOk || gasBlocked || (needsStepUp && !stepUpCodeOk);
  const trimmed = address.trim();

  if (done) return <SentConfirmation amount={net} chainLabel={chainMeta.label} address={trimmed} status={resultStatus} />;

  async function submit() {
    setBusy(true); setError(null); setNeedsKyc(false);
    const code = stepUpCode.trim() || undefined;
    try {
      const response = source === "earned_usdt"
        ? await createEarnedUsdtWithdrawal(amountUsdtMicro, chain, address.trim(), code)
        : await createWithdrawal(amt, chain, address.trim(), code);
      const status = response.request.status;
      setResultStatus(status === "paid" ? "paid" : status === "sending" ? "sending" : "pending");
      setDone(true);
    } catch (e) {
      // The server sends a `kycRequired` flag, not just a sentence. Show them the
      // way to fix it rather than an error they can do nothing about.
      if (e instanceof ApiError && e.body.kycRequired) {
        setNeedsKyc(true);
        setKycStatus(String(e.body.kycStatus ?? "none"));
      } else if (e instanceof ApiError && e.body.stepUpRequired) {
        // First time we see this: no code has reached their inbox yet, so send
        // one now and let the card's own copy explain why — no need to also
        // surface the raw "confirm with the code" server message. A wrong or
        // expired code on a later attempt hits this same branch with nothing
        // left to auto-send; that message (e.g. "that code is wrong") DOES
        // need to reach the user, so it's shown in the card below instead.
        if (!needsStepUp) void requestWithdrawalStepUp().catch(() => {});
        else setError((e as Error).message);
        setNeedsStepUp(true);
      } else {
        setError((e as Error).message);
      }
    }
    finally { setBusy(false); }
  }

  async function resendStepUpCode() {
    setResendBusy(true); setJustResent(false);
    try {
      await requestWithdrawalStepUp();
      setJustResent(true);
    } catch (e) {
      setError((e as Error).message);
    }
    finally { setResendBusy(false); }
  }

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      {/* Same clean shape as the BNB withdraw screen (founder, 2026-08-29):
          logo + title + the single payout chain as a subtitle, not a picker
          card. The chain picker only comes back if CHAINS ever has >1 entry. */}
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

      {/* "Pay from" only appears when the user actually has task USDT to choose
          between — otherwise there is nothing to pick and it is just noise. */}
      {earnedUsdtMicro > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setSource("points")}
            className={`rounded-xl border p-3 text-left ${source === "points" ? "border-brand bg-brand-tint" : "border-line bg-card"}`}>
            <span className="block text-sm font-semibold">Main balance</span>
            <span className="text-xs text-muted">{formatMoney(balance)}</span>
          </button>
          <button type="button" onClick={() => setSource("earned_usdt")}
            className={`rounded-xl border p-3 text-left ${source === "earned_usdt" ? "border-brand bg-brand-tint" : "border-line bg-card"}`}>
            <span className="block text-sm font-semibold">Task USDT</span>
            <span className="text-xs text-muted">{formatUsdtMicro(earnedUsdtMicro)}</span>
          </button>
        </div>
      )}

      {/* The chain picker only renders when CHAINS has more than one entry — a
          single-option radio group reads as "there are others, find them". The
          one chain we pay out on is stated in the header subtitle instead. */}
      {CHAINS.length > 1 && (
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
          </div>
        </div>
      )}

      {/* ---- Where the money goes ----
          Connect (signed) is the default, same reasoning as ConnectWallet.tsx:
          a pasted address proves nothing, and the most common way money is
          stolen from users in our markets is a fake "support agent" swapping
          in their own address. This used to live on /profile/settings as the
          app's only address-entry screen; when that screen was simplified
          down to a plain typed box (2026-08-12), the signed path had nowhere
          left to run from — restored here, since this is now the one place
          a payout address is ever set. */}
      {!addrTyping ? (
        <ConnectWallet
          chain={chain}
          savedAddress={savedAddresses[chain]}
          verified={saved.data?.verified?.[chain]}
          onConnected={(addr) => { setAddress(addr); saved.reload(); }}
          onUseTyping={() => {
            setAddrTyping(true);
            if (!address && savedAddresses[chain]) setAddress(savedAddresses[chain]);
          }}
        />
      ) : (
        <Card className="p-4">
          <label htmlFor="withdraw-address" className="flex items-center gap-2 font-bold text-brand-ink">
            <WalletIcon size={20} className="shrink-0 text-brand" />
            {t("withdraw.bep20WalletAddress")}
          </label>
          {/* One saved address, tap to paste it instantly (founder, 2026-08-12:
              "as simple as the BNB screen"). Only shown once there is a saved
              address that differs from what's in the box right now — otherwise
              it would just be a second copy of what the field already says. */}
          {savedAddresses[chain] && savedAddresses[chain]!.toLowerCase() !== trimmed.toLowerCase() && (
            <button
              type="button"
              onClick={() => setAddress(savedAddresses[chain]!)}
              className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-full border border-brand/30 bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand"
            >
              <CheckIcon size={13} className="shrink-0" />
              <span className="truncate">
                {t("withdraw.useSaved")} {shortAddress(savedAddresses[chain]!)}
              </span>
            </button>
          )}
          <input id="withdraw-address" value={address} onChange={(e) => setAddress(e.target.value)}
            autoCapitalize="none" autoCorrect="off" spellCheck={false}
            placeholder={t("withdraw.addrPlaceholderEvm")}
            className="num mt-3 w-full rounded-xl border border-line bg-card p-3 text-sm text-brand-ink outline-none focus:border-brand" />
          {trimmed && addressOk && (
            <p className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-success">
              <CheckIcon size={16} />
              {savedAddresses[chain]?.toLowerCase() === trimmed.toLowerCase()
                ? t("withdraw.savedAddressReady") : t("withdraw.newAddressReady")}
            </p>
          )}
          {trimmed && !addressOk && (
            <p className="mt-2 text-sm text-danger">{t("withdraw.addrInvalid", { label: chainMeta.label })}</p>
          )}
          <p className="mt-2 flex items-start gap-1.5 text-xs text-muted">
            <InfoIcon size={15} className="mt-0.5 shrink-0" /> {t("withdraw.addressAutoSave")}
          </p>
          <button
            type="button"
            onClick={() => setAddrTyping(false)}
            className="mt-3 text-sm font-semibold text-brand underline-offset-2 hover:underline"
          >
            {t("connect.connectInstead")}
          </button>
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
        {/* Only shown when gas is actually missing — a reassuring "gas ready"
            box on every visit is exactly the kind of clutter this pass removes. */}
        {gasBlocked && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger-tint p-2.5 text-sm text-danger">
            <p className="font-semibold">{t("refund.gasNotReady")}</p>
            <p className="num mt-1 text-xs opacity-80">
              {t("refund.gasBalance", { balance: formatBnbWei(bal.data?.personalGasWei ?? null) })}
            </p>
          </div>
        )}
      </div>

      <Button variant="accent" disabled={invalid || busy} onClick={submit}>
        <WalletIcon size={20} />
        {busy ? t("withdraw.sending") : needsStepUp ? t("withdraw.stepUp.confirm") : t("withdraw.askForUsdt")}
      </Button>
      <p className="flex items-center justify-center gap-1.5 text-xs text-muted">
        <ShieldIcon size={14} /> {t("withdraw.safetyNote")}
      </p>
    </div>
  );
}

// Compact confirmation card — same shape as the BNB withdraw screen's `done`
// state (founder, 2026-08-29), not a full-screen celebration.
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
        <div className="animate-pop mx-auto grid h-16 w-16 place-items-center rounded-full bg-success text-white">
          <CheckIcon size={34} />
        </div>
        <p className="mt-3 font-bold text-brand-ink">
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

      {/* The moment they most want to hear "your money is sent" — offer to tell
          them. Renders nothing if push is off or unsupported. */}
      <NotificationsCard compact />
    </div>
  );
}
