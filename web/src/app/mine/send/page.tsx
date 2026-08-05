"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Button } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import { ArrowRightIcon, CheckIcon, ShieldIcon, ClockIcon, MineIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchMiningState, sendRozi } from "@/lib/api";
import { formatRozi, roziFromMicro, ROZI_SCALE } from "@/lib/format";

// Send ROZI to another RoziPay user.
//
// This is a TRANSFER, not a trade. There is no price field, no counterparty
// search, no matching, and no money leg — running any of those would make us an
// unlicensed exchange under PVARA (MINING_SPEC.md § 7). If a future ticket asks
// for "let users sell ROZI here", that is the ticket to push back on.
//
// Every refusal the server can issue is mirrored as a CARD WITH A WAY FORWARD
// rather than an error under a form the user already filled in. Finding out you
// are not allowed to send only after typing an amount is the worst version of
// this screen, and it is the version you get for free if you skip this.
export default function SendRoziPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const mining = useApi(fetchMiningState, []);

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ received: number } | null>(null);

  if (!ready || mining.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (mining.error || !mining.data) {
    return (
      <div className="p-4 pt-6">
        <ErrorState message={mining.error ?? "…"} onRetry={mining.reload} />
      </div>
    );
  }

  const s = mining.data;
  const tr = s.transfer;
  const balance = roziFromMicro(s.roziMicro);
  // The cap is a rolling 24h window on the server, so "left today" has to be
  // computed from what has already gone out, not from the cap alone.
  const leftToday = Math.max(0, tr.dailyCap - roziFromMicro(tr.sentTodayMicro));

  const amt = Number(amount);
  const amtValid = Number.isFinite(amt) && amt > 0;
  // Mirror of the server's floor: below one millionth there is nothing to send.
  const tooSmall = amtValid && Math.floor(amt * ROZI_SCALE) <= 0;
  const overBalance = amtValid && amt > balance;
  const overCap = amtValid && amt > leftToday;
  const fee = amtValid ? Math.floor(amt * ROZI_SCALE * tr.feePct / 100) / ROZI_SCALE : 0;
  const receives = amtValid ? amt - fee : 0;
  const canSubmit =
    tr.canSend && to.trim() !== "" && amtValid && !tooSmall && !overBalance && !overCap;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await sendRozi(to.trim(), amt);
      setSent({ received: roziFromMicro(res.receivedMicro) });
      mining.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Reached ONLY from /wallet's Send button today (nothing on /mine links
  // here) — so every way back off this screen goes to Wallet, not Mine. See
  // the comment on the /wallet BottomNav entry for why this matters.
  const header = (
    <header className="flex items-center gap-2">
      <Link href="/wallet" aria-label="Back to wallet" className="text-brand">
        <ArrowRightIcon size={22} className="rotate-180" />
      </Link>
      <h1 className="text-xl font-bold text-brand-ink">{t("send.title")}</h1>
    </header>
  );

  if (sent) {
    return (
      <div className="px-4 pt-5 pb-8 space-y-5">
        {header}
        <Card className="border-success/30 bg-success-tint/50 p-5 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-success text-white">
            <CheckIcon size={28} />
          </span>
          <p className="mt-3 font-bold text-brand-ink">
            {t("send.done", { n: formatRozi(sent.received * ROZI_SCALE) })}
          </p>
        </Card>
        <Button href="/wallet" full>{t("nav.wallet")}</Button>
      </div>
    );
  }

  // ---- The three ways this screen is closed, each with a way out -------------

  if (!tr.enabled) {
    return (
      <div className="px-4 pt-5 pb-8 space-y-5">
        {header}
        <Card className="p-5 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-brand-tint text-brand">
            <ClockIcon size={28} />
          </span>
          <p className="mt-3 font-bold text-brand-ink">{t("send.off.title")}</p>
          <p className="mt-1 text-sm text-muted">{t("send.off.body")}</p>
        </Card>
        <Button href="/wallet" full>{t("nav.wallet")}</Button>
      </div>
    );
  }

  if (tr.requireKyc && tr.kycStatus !== "approved") {
    const pending = tr.kycStatus === "pending";
    return (
      <div className="px-4 pt-5 pb-8 space-y-5">
        {header}
        <Card className="border-pending/30 bg-pending-tint p-4">
          <p className="flex items-center gap-2 font-bold text-pending">
            <ShieldIcon size={20} />
            {t("send.kyc.title")}
          </p>
          <p className="mt-1 text-sm text-brand-ink">
            {pending ? t("send.kyc.pending") : t("send.kyc.body")}
          </p>
          {!pending && (
            <div className="mt-3">
              <Button href="/kyc" full>{t("send.kyc.cta")}</Button>
            </div>
          )}
        </Card>
      </div>
    );
  }

  if (tr.accountDays < tr.minAccountDays) {
    return (
      <div className="px-4 pt-5 pb-8 space-y-5">
        {header}
        <Card className="p-5 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-brand-tint text-brand">
            <MineIcon size={28} />
          </span>
          <p className="mt-3 font-bold text-brand-ink">{t("send.age.title")}</p>
          <p className="mt-1 text-sm text-muted">
            {t("send.age.body", { days: String(tr.minAccountDays) })}
          </p>
        </Card>
        <Button href="/wallet" full>{t("nav.wallet")}</Button>
      </div>
    );
  }

  // ---- The form -------------------------------------------------------------

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      {header}
      <p className="px-1 text-sm text-muted">{t("send.subtitle")}</p>

      {error && <p className="rounded-xl bg-danger-tint p-3 text-sm text-danger">{error}</p>}

      <Card className="p-4">
        <p className="text-sm text-muted">{t("send.balance")}</p>
        <p className="num text-2xl font-bold text-brand-ink">
          {formatRozi(s.roziMicro)} <span className="text-base text-brand">ROZI</span>
        </p>
        <p className="mt-1 text-sm text-muted">
          {t("send.left", { n: formatRozi(leftToday * ROZI_SCALE) })}
        </p>
      </Card>

      <div>
        <label htmlFor="send-to" className="mb-2 block px-1 font-semibold text-brand-ink">
          {t("send.to.label")}
        </label>
        <input
          id="send-to"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder={t("send.to.placeholder")}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="w-full rounded-xl border border-line bg-card p-3 text-brand-ink outline-none focus:border-brand"
        />
      </div>

      <div>
        <label htmlFor="send-amount" className="mb-2 block px-1 font-semibold text-brand-ink">
          {t("send.amount.label")}
        </label>
        <input
          id="send-amount"
          type="number"
          inputMode="decimal"
          min={0}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
          className="num w-full rounded-xl border border-line bg-card p-3 text-brand-ink outline-none focus:border-brand"
        />
        {/* The fee is a BURN, not a charge we collect, but that distinction is
            ours and not the user's — they only need to know what arrives. */}
        {amtValid && !tooSmall && (
          <div className="mt-2 space-y-0.5 px-1 text-sm">
            <p className="text-muted">
              {t("send.fee", { fee: formatRozi(fee * ROZI_SCALE), pct: String(tr.feePct) })}
            </p>
            <p className="font-semibold text-brand-ink">
              {t("send.receives", { n: formatRozi(receives * ROZI_SCALE) })}
            </p>
          </div>
        )}
        {overBalance && (
          <p className="mt-2 px-1 text-sm text-danger">{t("send.notEnough")}</p>
        )}
        {overCap && !overBalance && (
          <p className="mt-2 px-1 text-sm text-danger">
            {t("send.left", { n: formatRozi(leftToday * ROZI_SCALE) })}
          </p>
        )}
      </div>

      <Button onClick={submit} disabled={!canSubmit || busy} full>
        {busy ? t("send.sending") : t("send.cta")}
      </Button>
    </div>
  );
}
