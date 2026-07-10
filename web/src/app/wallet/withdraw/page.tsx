"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Button } from "@/components/ui";
import {
  WalletIcon, CheckIcon, ClockIcon, ShieldIcon, ArrowRightIcon, StarIcon,
} from "@/components/icons";
import { user } from "@/lib/mock";
import { formatPoints, formatMoney, pointsToMoney, CURRENCY_SYMBOL, POINTS_PER_UNIT } from "@/lib/format";

// Withdrawal request flow + signature moment #2 ("money sent").
// v1 is MANUAL approval (no automated payout — docs/PROJECT_SPEC.md non-goals),
// so the confirmation is honest: it's a REQUEST that we pay within the SLA,
// not an instant transfer. Still a calm, reassuring designed moment.

export default function WithdrawPage() {
  const [walletId, setWalletId] = useState(user.wallets[0].id);
  const [amount, setAmount] = useState(user.minWithdrawPoints);
  const [done, setDone] = useState(false);

  const wallet = user.wallets.find((w) => w.id === walletId)!;
  const belowMin = amount < user.minWithdrawPoints;
  const overBalance = amount > user.balancePoints;
  const invalid = belowMin || overBalance;

  if (done) return <SentConfirmation amount={amount} wallet={wallet.label} />;

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-center gap-2">
        <Link href="/wallet" aria-label="Back to wallet" className="text-brand">
          <ArrowRightIcon size={22} className="rotate-180" />
        </Link>
        <h1 className="text-xl font-bold text-brand-ink">Get my money</h1>
      </header>

      <Card className="p-4">
        <p className="text-sm text-muted">You have</p>
        <p className="num text-2xl font-bold text-brand-ink">
          {formatPoints(user.balancePoints)} points
        </p>
        <p className="text-sm text-muted">= about {formatMoney(user.balancePoints)}</p>
      </Card>

      {/* Choose wallet */}
      <div>
        <p className="mb-2 px-1 font-semibold text-brand-ink">Send my money to</p>
        <div className="grid grid-cols-2 gap-2.5">
          {user.wallets.map((w) => {
            const active = w.id === walletId;
            return (
              <button
                key={w.id}
                onClick={() => setWalletId(w.id)}
                aria-pressed={active}
                className={`rounded-xl border p-3 text-left ${
                  active ? "border-brand bg-brand-tint" : "border-line bg-card"
                }`}
              >
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

      {/* Amount */}
      <div>
        <label htmlFor="amt" className="mb-2 block px-1 font-semibold text-brand-ink">
          How many points?
        </label>
        <div className="flex items-center gap-2 rounded-xl border border-line bg-card p-3">
          <StarIcon size={20} className="text-accent" />
          <input
            id="amt"
            type="number"
            inputMode="numeric"
            value={amount}
            min={user.minWithdrawPoints}
            max={user.balancePoints}
            step={100}
            onChange={(e) => setAmount(Number(e.target.value))}
            className="num w-full bg-transparent text-2xl font-bold text-brand-ink outline-none"
          />
        </div>
        <p className="mt-1.5 px-1 text-sm text-muted">
          You will get{" "}
          <span className="font-semibold text-brand-ink">
            {CURRENCY_SYMBOL} {pointsToMoney(Math.max(0, amount)).toLocaleString("en-PK")}
          </span>{" "}
          in your {wallet.label}.
        </p>
        <p className="px-1 text-xs text-muted">
          Lowest payout is {formatPoints(user.minWithdrawPoints)} points
          ({POINTS_PER_UNIT} points = {CURRENCY_SYMBOL} 1).
        </p>

        {belowMin && (
          <p className="mt-2 rounded-lg bg-pending-tint p-2.5 text-sm text-pending">
            You need at least {formatPoints(user.minWithdrawPoints)} points to get money.
          </p>
        )}
        {overBalance && (
          <p className="mt-2 rounded-lg bg-danger-tint p-2.5 text-sm text-danger">
            You do not have that many points yet.
          </p>
        )}
      </div>

      <Button variant="accent" disabled={invalid} onClick={() => setDone(true)}>
        <WalletIcon size={20} /> Send me {CURRENCY_SYMBOL} {pointsToMoney(Math.max(0, amount)).toLocaleString("en-PK")}
      </Button>

      <p className="flex items-center justify-center gap-1.5 text-xs text-muted">
        <ShieldIcon size={14} /> We check every payment to keep your account safe.
      </p>
    </div>
  );
}

// ---- Signature moment #2: money on the way -------------------------------
function SentConfirmation({ amount, wallet }: { amount: number; wallet: string }) {
  return (
    <div className="flex min-h-[80dvh] flex-col items-center justify-center px-6 text-center">
      <div className="animate-pop grid h-24 w-24 place-items-center rounded-full bg-success text-white">
        <CheckIcon size={52} />
      </div>

      <h1 className="animate-rise mt-6 text-2xl font-bold text-brand-ink">
        We got your request
      </h1>
      <p className="animate-rise mt-2 text-lg text-muted">
        <span className="font-semibold text-brand-ink num">{formatMoney(amount)}</span>{" "}
        is on the way to your {wallet}.
      </p>

      <div className="animate-rise mt-6 w-full max-w-sm space-y-2.5 text-left">
        <div className="flex items-center gap-3 rounded-xl bg-success-tint p-3 text-success">
          <CheckIcon size={20} className="shrink-0" />
          <span className="text-sm font-medium">Request received</span>
        </div>
        <div className="flex items-center gap-3 rounded-xl bg-pending-tint p-3 text-pending">
          <ClockIcon size={20} className="shrink-0" />
          <span className="text-sm font-medium">
            We send your money within 72 hours. We will tell you when it is sent.
          </span>
        </div>
      </div>

      <div className="mt-8 w-full max-w-sm space-y-2.5">
        <Button href="/wallet" variant="primary">See my wallet</Button>
        <Button href="/" variant="ghost">Back to home</Button>
      </div>
    </div>
  );
}
