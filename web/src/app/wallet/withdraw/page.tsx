"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Button } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import { WalletIcon, CheckIcon, ClockIcon, ShieldIcon, ArrowRightIcon, StarIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { fetchBalance, createWithdrawal } from "@/lib/api";
import { formatPoints, formatMoney, pointsToMoney, CURRENCY_SYMBOL, POINTS_PER_UNIT } from "@/lib/format";

const WALLETS = [
  { id: "jazzcash", label: "JazzCash", hint: "Mobile wallet" },
  { id: "easypaisa", label: "EasyPaisa", hint: "Mobile wallet" },
];

// Withdrawal request + the "money on the way" moment. v1 payout is MANUAL —
// the confirmation is honest: a request we pay within the SLA, not instant.
export default function WithdrawPage() {
  const { ready } = useRequireAuth();
  const bal = useApi(fetchBalance, []);

  const [walletId, setWalletId] = useState("jazzcash");
  const [amount, setAmount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!ready || bal.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (bal.error) return <div className="p-4 pt-6"><ErrorState message={bal.error} onRetry={bal.reload} /></div>;

  const balance = bal.data?.points ?? 0;
  const min = bal.data?.minWithdrawPoints ?? 2000;
  const wallet = WALLETS.find((w) => w.id === walletId)!;
  const amt = amount || min;
  const belowMin = amt < min;
  const overBalance = amt > balance;
  const invalid = belowMin || overBalance;

  if (done) return <SentConfirmation amount={amt} wallet={wallet.label} />;

  async function submit() {
    setBusy(true); setError(null);
    try {
      await createWithdrawal(amt, walletId);
      setDone(true);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-center gap-2">
        <Link href="/wallet" aria-label="Back to wallet" className="text-brand">
          <ArrowRightIcon size={22} className="rotate-180" />
        </Link>
        <h1 className="text-xl font-bold text-brand-ink">Get my money</h1>
      </header>

      {error && <p className="rounded-xl bg-danger-tint p-3 text-sm text-danger">{error}</p>}

      <Card className="p-4">
        <p className="text-sm text-muted">You have</p>
        <p className="num text-2xl font-bold text-brand-ink">{formatPoints(balance)} points</p>
        <p className="text-sm text-muted">= about {formatMoney(balance)}</p>
      </Card>

      <div>
        <p className="mb-2 px-1 font-semibold text-brand-ink">Send my money to</p>
        <div className="grid grid-cols-2 gap-2.5">
          {WALLETS.map((w) => {
            const active = w.id === walletId;
            return (
              <button key={w.id} onClick={() => setWalletId(w.id)} aria-pressed={active}
                className={`rounded-xl border p-3 text-left ${active ? "border-brand bg-brand-tint" : "border-line bg-card"}`}>
                <span className="flex items-center justify-between">
                  <span className="font-semibold text-brand-ink">{w.label}</span>
                  {active && <CheckIcon size={18} className="text-brand" />}
                </span>
                <span className="text-xs text-muted">{w.hint}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label htmlFor="amt" className="mb-2 block px-1 font-semibold text-brand-ink">How many points?</label>
        <div className="flex items-center gap-2 rounded-xl border border-line bg-card p-3">
          <StarIcon size={20} className="text-accent" />
          <input id="amt" type="number" inputMode="numeric" value={amount || ""}
            min={min} max={balance} step={100} placeholder={String(min)}
            onChange={(e) => setAmount(Number(e.target.value))}
            className="num w-full bg-transparent text-2xl font-bold text-brand-ink outline-none" />
        </div>
        <p className="mt-1.5 px-1 text-sm text-muted">
          You will get <span className="font-semibold text-brand-ink">{CURRENCY_SYMBOL} {pointsToMoney(Math.max(0, amt)).toLocaleString("en-PK")}</span> in your {wallet.label}.
        </p>
        <p className="px-1 text-xs text-muted">Lowest payout is {formatPoints(min)} points ({POINTS_PER_UNIT} points = {CURRENCY_SYMBOL} 1).</p>
        {belowMin && <p className="mt-2 rounded-lg bg-pending-tint p-2.5 text-sm text-pending">You need at least {formatPoints(min)} points to get money.</p>}
        {overBalance && <p className="mt-2 rounded-lg bg-danger-tint p-2.5 text-sm text-danger">You do not have that many points yet.</p>}
      </div>

      <Button variant="accent" disabled={invalid || busy} onClick={submit}>
        <WalletIcon size={20} /> {busy ? "Sending…" : `Send me ${CURRENCY_SYMBOL} ${pointsToMoney(Math.max(0, amt)).toLocaleString("en-PK")}`}
      </Button>
      <p className="flex items-center justify-center gap-1.5 text-xs text-muted">
        <ShieldIcon size={14} /> We check every payment to keep your account safe.
      </p>
    </div>
  );
}

function SentConfirmation({ amount, wallet }: { amount: number; wallet: string }) {
  return (
    <div className="flex min-h-[80dvh] flex-col items-center justify-center px-6 text-center">
      <div className="animate-pop grid h-24 w-24 place-items-center rounded-full bg-success text-white"><CheckIcon size={52} /></div>
      <h1 className="animate-rise mt-6 text-2xl font-bold text-brand-ink">We got your request</h1>
      <p className="animate-rise mt-2 text-lg text-muted">
        <span className="font-semibold text-brand-ink num">{formatMoney(amount)}</span> is on the way to your {wallet}.
      </p>
      <div className="animate-rise mt-6 w-full max-w-sm space-y-2.5 text-left">
        <div className="flex items-center gap-3 rounded-xl bg-success-tint p-3 text-success">
          <CheckIcon size={20} className="shrink-0" /><span className="text-sm font-medium">Request received</span>
        </div>
        <div className="flex items-center gap-3 rounded-xl bg-pending-tint p-3 text-pending">
          <ClockIcon size={20} className="shrink-0" />
          <span className="text-sm font-medium">We send your money within 72 hours. We will tell you when it is sent.</span>
        </div>
      </div>
      <div className="mt-8 w-full max-w-sm space-y-2.5">
        <Button href="/wallet" variant="primary">See my wallet</Button>
        <Button href="/" variant="ghost">Back to home</Button>
      </div>
    </div>
  );
}
