"use client";

// Add USDT — top-up credit for buying mining machines.
//
// THE ONE THING THIS SCREEN MUST NOT GET WRONG: what the money can do
// afterwards. Top-up credit buys rigs and nothing else. It cannot be withdrawn,
// it cannot be sent to anyone, and it is NOT the same balance as the task
// earnings the wallet pays out (api/src/db.ts, usdt_ledger — the absence of a
// withdrawal path is the whole safety argument).
//
// So the "buys machines only" card is placed ABOVE the address, before anything
// a user could act on. A person who sends USDT and only then learns it cannot
// come back out has been misled by us, no matter how true each individual
// sentence on the page was.
//
// The flow is deliberately manual: send to our address, paste the transaction
// ID, a human checks the chain and confirms. No wallet connect, no automatic
// crediting, nothing this app holds a key for.
import { useState } from "react";
import Link from "next/link";
import { Card, Button, SectionTitle } from "@/components/ui";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import {
  ArrowRightIcon, CopyIcon, CheckIcon, InfoIcon, ClockIcon, LockIcon,
} from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchUsdt, claimUsdtTopup } from "@/lib/api";
import { formatUsdtMicro, timeAgo } from "@/lib/format";

export default function TopUpPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const usdt = useApi(fetchUsdt, []);

  const [tx, setTx] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!ready || usdt.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (usdt.error || !usdt.data) {
    return (
      <div className="p-4 pt-6">
        <ErrorState message={usdt.error ?? "…"} onRetry={usdt.reload} />
      </div>
    );
  }

  const s = usdt.data;
  // Prefer the user's own address once custody derivation is on (deployments
  // without an xpub configured always get null here — see CUSTODY_SPEC.md §5
  // step 1). Falls back to the one shared treasury address, exactly the
  // behaviour this screen had before the per-user feature existed.
  const depositAddress = s.personalAddress ?? s.treasuryAddress;

  const header = (
    <header>
      <Link href="/mine/rigs" className="inline-flex items-center gap-1 text-sm font-semibold text-brand">
        <ArrowRightIcon size={16} className="rotate-180" />
        {t("rigs.title")}
      </Link>
      <h1 className="mt-2 text-xl font-bold text-brand-ink">{t("topup.title")}</h1>
      <p className="text-sm text-muted">{t("topup.subtitle")}</p>
    </header>
  );

  // Switched off, or no treasury address set. Say so with a way forward rather
  // than showing a form that cannot work.
  if (!s.enabled || !s.treasuryAddress) {
    return (
      <div className="px-4 pt-5 pb-8 space-y-5">
        {header}
        <Card className="p-5 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-brand-tint text-brand">
            <ClockIcon size={28} />
          </span>
          <p className="mt-3 font-bold text-brand-ink">{t("topup.off.title")}</p>
          <p className="mt-1 text-sm text-muted">{t("topup.off.body")}</p>
        </Card>
        <Button href="/mine/rigs" full>{t("rigs.title")}</Button>
      </div>
    );
  }

  const amt = Number(amount);
  const amtValid = Number.isFinite(amt) && amt >= s.minTopup && amt <= s.maxTopup;
  const canSubmit = tx.trim().length >= 6 && amtValid;

  function copyAddress() {
    void navigator.clipboard?.writeText(depositAddress ?? "");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await claimUsdtTopup(tx.trim(), amt);
      setSent(true);
      setTx("");
      setAmount("");
      usdt.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      {header}

      <Card className="p-4">
        <p className="text-sm text-muted">{t("topup.balance")}</p>
        <p className="num text-2xl font-bold text-brand-ink">
          {formatUsdtMicro(s.balanceMicro)}
        </p>
        {/* Only offered once there is something to send back. A "get your money
            back" link above a zero balance is noise on the screen whose job is
            to explain how to put money in. */}
        {s.balanceMicro > 0 && (
          <Link
            href="/mine/refund"
            className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-brand"
          >
            {t("refund.link")}
            <ArrowRightIcon size={16} />
          </Link>
        )}
      </Card>

      {/* Above the address, on purpose. See the note at the top of this file. */}
      <Card className="border-pending/30 bg-pending-tint p-4">
        <p className="flex items-center gap-2 font-bold text-pending">
          <LockIcon size={18} />
          {t("topup.spendOnly.title")}
        </p>
        <p className="mt-1 text-sm text-brand-ink">{t("topup.spendOnly.body")}</p>
      </Card>

      {sent && (
        <Card className="border-success/30 bg-success-tint/60 p-4">
          <p className="flex items-center gap-2 font-bold text-success">
            <CheckIcon size={18} />
            {t("topup.done.title")}
          </p>
          <p className="mt-1 text-sm text-brand-ink">{t("topup.done.body")}</p>
        </Card>
      )}

      {/* ---- Address ---- */}
      <div>
        <SectionTitle>{t("topup.address")}</SectionTitle>
        <Card className="p-4">
          {/* Coin and network as two separate labelled rows, ABOVE the address.
              A wallet asks for both, and a user who has to infer either one from
              a run-on sentence is a user who eventually sends BNB on the wrong
              network. Two rows, two answers, nothing to infer. */}
          <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted">{t("topup.token")}</dt>
            <dd className="font-bold text-brand-ink">{t("topup.tokenValue")}</dd>
            <dt className="text-muted">{t("topup.network")}</dt>
            <dd className="font-bold text-brand-ink">{t("topup.networkValue")}</dd>
          </dl>
          {/* When custody derivation is on, this is the user's OWN address —
              still confirmed by staff reading the tx hash exactly as before
              (CUSTODY_SPEC.md § 5 step 1 is read-only), but it means a deposit
              is no longer landing in a pool shared with every other user. */}
          {s.personalAddress && (
            <p className="mb-2 text-xs font-semibold text-brand">{t("topup.yourOwnAddress")}</p>
          )}
          {/* One line: the full address, horizontally scrollable rather than
              truncated (nothing about it is hidden — see the copy button
              beside it for an exact-value alternative), with Copy pinned
              next to it instead of stacked below. */}
          <div className="flex items-center gap-2 border-t border-line pt-3">
            <p className="num flex-1 overflow-x-auto whitespace-nowrap text-sm font-semibold text-brand-ink">
              {depositAddress}
            </p>
            <button
              onClick={copyAddress}
              aria-label={copied ? t("topup.copied") : t("topup.copy")}
              className="flex shrink-0 items-center justify-center rounded-xl border border-brand bg-brand-tint p-2 text-brand"
            >
              {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
            </button>
          </div>
        </Card>
        {/* Wrong-chain deposits are the number one way people lose money doing
            this, and they are unrecoverable. Said in danger colours, next to the
            address, not buried in the steps above. */}
        <p className="mt-2 flex gap-2 rounded-xl border border-danger/30 bg-danger-tint p-3 text-sm font-semibold text-danger">
          <InfoIcon size={16} className="mt-0.5 shrink-0" />
          {t("topup.addressWarn")}
        </p>
      </div>

      {/* ---- Claim ---- */}
      {error && (
        <p className="rounded-xl border border-danger/30 bg-danger-tint p-3 text-sm font-semibold text-danger">
          {error}
        </p>
      )}

      <div>
        <label htmlFor="tx" className="mb-2 block px-1 font-semibold text-brand-ink">
          {t("topup.txLabel")}
        </label>
        <input
          id="tx"
          value={tx}
          onChange={(e) => { setTx(e.target.value); setSent(false); }}
          placeholder={t("topup.txPlaceholder")}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="w-full rounded-xl border border-line bg-card p-3 text-sm text-brand-ink outline-none focus:border-brand"
        />
      </div>

      <div>
        <label htmlFor="amt" className="mb-2 block px-1 font-semibold text-brand-ink">
          {t("topup.amountLabel")}
        </label>
        <input
          id="amt"
          type="number"
          inputMode="decimal"
          min={s.minTopup}
          max={s.maxTopup}
          value={amount}
          onChange={(e) => { setAmount(e.target.value); setSent(false); }}
          placeholder="0"
          className="num w-full rounded-xl border border-line bg-card p-3 text-brand-ink outline-none focus:border-brand"
        />
        <p className="mt-1.5 px-1 text-xs text-muted">
          {t("topup.limits", { min: String(s.minTopup), max: String(s.maxTopup) })}
        </p>
      </div>

      <Button onClick={submit} disabled={!canSubmit || busy} full>
        {busy ? t("topup.sending") : t("topup.submit")}
      </Button>

      {/* ---- History ---- */}
      <div>
        <SectionTitle>{t("topup.history")}</SectionTitle>
        {s.topups.length === 0 ? (
          <EmptyState title={t("topup.empty")} body={t("topup.subtitle")} />
        ) : (
          <Card className="divide-y divide-line">
            {s.topups.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="num font-semibold text-brand-ink">
                    {formatUsdtMicro(r.amountMicro)}
                  </p>
                  <p className="truncate text-xs text-muted">{timeAgo(r.createdAt)}</p>
                  {r.rejectReason && (
                    <p className="mt-0.5 text-xs text-danger">{r.rejectReason}</p>
                  )}
                </div>
                <StatusBadge status={r.status} />
              </div>
            ))}
          </Card>
        )}
      </div>

      {/* ---- How (moved to the bottom, 2026-08-08: redundant with the address
          card + form above it for most people, but still worth having for
          anyone who wants the steps spelled out) ---- */}
      <div>
        <SectionTitle>{t("topup.how")}</SectionTitle>
        <Card className="divide-y divide-line">
          {[
            t("topup.step1"),
            t("topup.step2"),
            t("topup.step3"),
          ].map((line, i) => (
            <p key={line} className="flex gap-3 px-4 py-3 text-sm text-brand-ink">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand text-xs font-bold text-white">
                {i + 1}
              </span>
              {line}
            </p>
          ))}
        </Card>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: "pending" | "confirmed" | "rejected" }) {
  const { t } = useI18n();
  const cls = {
    pending: "bg-pending-tint text-pending",
    confirmed: "bg-success-tint text-success",
    rejected: "bg-danger-tint text-danger",
  }[status];
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${cls}`}>
      {t(`topup.status.${status}`)}
    </span>
  );
}
