"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Button } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import { ArrowRightIcon, CheckIcon, ClockIcon, StarIcon, MineIcon, InfoIcon } from "@/components/icons";
import { useRequireAuth, useApi, useCountdown } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchMyConversion, burnRozi } from "@/lib/api";
import { formatMoney, formatRozi, roziFromMicro, ROZI_SCALE } from "@/lib/format";

// Turn ROZI into points — the ONLY path between the two ledgers (§ 6).
//
// TWO BOUNDS, and this screen has to make both legible without feeling like a
// wall of conditions:
//
//   1. THE POT. A fixed number of points, committed before the window opened.
//      Everyone who burns shares it pro-rata, so THE RATE FLOATS — your share
//      falls as others join. There is no fixed ROZI->points rate anywhere in
//      this app, and this screen must never imply one. A user who works out the
//      floating part for themselves, after converting, will believe they were
//      cheated; so it is stated twice, before the input.
//
//   2. THE PER-USER CEILING (founder, 2026-07-29). You may convert at most N% of
//      what you have mined over the life of the account. Shown as an unlock
//      ("you can turn X into points") rather than as a punishment, because that
//      is what it is: mine more, unlock more.
//
// The server re-checks every rule here under an advisory lock. Nothing on this
// page is a decision — it is all explanation.
export default function ConvertPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const conv = useApi(fetchMyConversion, []);

  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const closesIn = useCountdown(conv.data?.closesAt);

  if (!ready || conv.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (conv.error || !conv.data) {
    return <div className="p-4 pt-6"><ErrorState message={conv.error ?? "…"} onRetry={conv.reload} /></div>;
  }

  const c = conv.data;
  const balance = roziFromMicro(c.roziMicro);
  const allowance = roziFromMicro(c.allowanceMicro);
  // You can put in at most what you HOLD and at most what you have UNLOCKED —
  // two different limits that are easy to conflate, so the smaller one drives
  // the form and the copy names whichever one actually bit.
  const limit = Math.min(balance, allowance);

  const amt = Number(amount);
  const amtValid = Number.isFinite(amt) && amt > 0;
  const tooSmall = amtValid && Math.floor(amt * ROZI_SCALE) <= 0;
  const overBalance = amtValid && amt > balance;
  const overAllowance = amtValid && !overBalance && amt > allowance;
  const canSubmit = c.open && amtValid && !tooSmall && !overBalance && !overAllowance;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await burnRozi(amt);
      setDone(true);
      setAmount("");
      conv.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <header className="flex items-center gap-2">
      <Link href="/mine" aria-label="Back to mining" className="text-brand">
        <ArrowRightIcon size={22} className="rotate-180" />
      </Link>
      <h1 className="text-xl font-bold text-brand-ink">{t("convert.title")}</h1>
    </header>
  );

  // ---- The two ways this screen is closed ----------------------------------

  if (!c.enabled || !c.open) {
    const off = !c.enabled;
    return (
      <div className="px-4 pt-5 pb-8 space-y-5">
        {header}
        <Card className="p-5 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-brand-tint text-brand">
            <ClockIcon size={28} />
          </span>
          <p className="mt-3 font-bold text-brand-ink">
            {t(off ? "convert.off.title" : "convert.closed.title")}
          </p>
          <p className="mt-1 text-sm text-muted">
            {t(off ? "convert.off.body" : "convert.closed.body")}
          </p>
        </Card>
        {/* Even with nothing open, the unlock is worth showing: it is the answer
            to "how much of this will I ever be able to use?", and it is the
            reason to keep mining between windows. */}
        <AllowanceCard rozi={allowance} pct={c.maxPctOfMined} usedMicro={c.convertedMicro} />
        <Button href="/mine" full>{t("nav.mine")}</Button>
      </div>
    );
  }

  // ---- The open window ------------------------------------------------------

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      {header}
      <p className="px-1 text-sm text-muted">{t("convert.subtitle")}</p>

      {/* The pot, and immediately under it the sentence that stops this from
          reading as a rate. These two never get separated. */}
      <Card className="overflow-hidden">
        <div className="bg-brand p-5 text-center text-white">
          <p className="text-sm text-white/80">{t("convert.pot")}</p>
          <p className="num mt-1 flex items-center justify-center gap-2 text-4xl font-extrabold">
            <StarIcon size={28} className="text-accent" />
            {formatMoney(c.potPoints ?? 0)}
          </p>
          {closesIn && (
            <p className="mt-2 num text-sm text-white/85">
              {t("convert.closesIn", { time: closesIn })}
            </p>
          )}
        </div>
        <p className="flex gap-2 p-3.5 text-sm text-brand-ink">
          <InfoIcon size={16} className="mt-0.5 shrink-0 text-brand" />
          {t("convert.potNote")}
        </p>
      </Card>

      <AllowanceCard rozi={allowance} pct={c.maxPctOfMined} usedMicro={c.convertedMicro} />

      {done && (
        <Card className="flex items-center gap-3 border-success/30 bg-success-tint/50 p-4">
          <CheckIcon size={22} className="shrink-0 text-success" />
          <p className="font-semibold text-brand-ink">{t("convert.done")}</p>
        </Card>
      )}
      {error && <p className="rounded-xl bg-danger-tint p-3 text-sm text-danger">{error}</p>}

      {/* What they have already put in, and what it would pay if the pot closed
          this second — with the caveat attached, not in a tooltip. */}
      {(c.myBurnMicro ?? 0) > 0 && (
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted">{t("convert.youPutIn")}</span>
            <span className="num font-bold text-brand-ink">
              {formatRozi(c.myBurnMicro ?? 0)} ROZI
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-sm text-muted">{t("convert.ifClosedNow")}</span>
            <span className="num font-bold text-accent-ink">
              ~{formatMoney(c.myPointsIfClosedNow ?? 0)}
            </span>
          </div>
          <p className="mt-2 text-xs text-muted">{t("convert.ifClosedNote")}</p>
        </Card>
      )}

      <Card className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted">{t("convert.yourRozi")}</span>
          <span className="num font-bold text-brand-ink">{formatRozi(c.roziMicro)} ROZI</span>
        </div>
      </Card>

      <div>
        <label htmlFor="burn-amount" className="mb-2 block px-1 font-semibold text-brand-ink">
          {t("convert.amount.label")}
        </label>
        <input
          id="burn-amount"
          type="number"
          inputMode="decimal"
          min={0}
          max={limit}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
          className="num w-full rounded-xl border border-line bg-card p-3 text-brand-ink outline-none focus:border-brand"
        />
        {overBalance && <p className="mt-2 px-1 text-sm text-danger">{t("convert.notEnough")}</p>}
        {overAllowance && (
          <p className="mt-2 px-1 text-sm text-danger">
            {t("convert.tooMuch", { n: formatRozi(c.allowanceMicro) })}
          </p>
        )}
      </div>

      <Button onClick={submit} disabled={!canSubmit || busy} full>
        {busy ? t("convert.working") : t("convert.cta")}
      </Button>
    </div>
  );
}

// The per-user ceiling, framed as an unlock. Shown whether or not a window is
// open, because it answers a question that outlives any one window.
function AllowanceCard({ rozi, pct, usedMicro }: { rozi: number; pct: number; usedMicro: number }) {
  const { t } = useI18n();
  const none = rozi <= 0;
  return (
    <Card className={`p-4 ${none ? "" : "border-brand/30 bg-brand-tint/50"}`}>
      <p className="flex items-center gap-2 font-bold text-brand-ink">
        <MineIcon size={18} className="shrink-0 text-brand" />
        {none
          ? t("convert.limit.none")
          : t("convert.limit.title", { n: formatRozi(rozi * ROZI_SCALE) })}
      </p>
      {!none && (
        <p className="mt-1 text-sm text-muted">
          {t("convert.limit.body", { pct: String(pct) })}
        </p>
      )}
      {usedMicro > 0 && (
        <p className="num mt-1 text-xs text-muted">
          {t("convert.limit.used", { n: formatRozi(usedMicro) })}
        </p>
      )}
    </Card>
  );
}
