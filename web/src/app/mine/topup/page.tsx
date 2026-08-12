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
// ⚠️ SIMPLIFIED 2026-08-12 (founder audit): this screen used to ALWAYS ask for
// a pasted transaction ID + amount before crediting anything — a leftover from
// before personal deposit addresses existed. They exist now (CUSTODY_SPEC.md
// § 5 step 1) and the scanner (deposits/scanner.ts + credit.ts) already
// auto-credits a deposit to one, exactly like the BNB deposit screen. Making a
// user paste a tx hash for money that was already credited was pure friction
// with nothing behind it. The manual form now shows ONLY on a deployment with
// no custody xpub configured (`s.personalAddress` is null), where a human
// really does still have to read the chain and confirm by hand.
import { useState } from "react";
import Link from "next/link";
import { Card, Button, SectionTitle } from "@/components/ui";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import {
  ArrowRightIcon, CopyIcon, CheckIcon, InfoIcon, ClockIcon, LockIcon,
} from "@/components/icons";
import { QrCode } from "@/components/QrCode";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchUsdt, claimUsdtTopup } from "@/lib/api";
import { formatUsdtMicro, timeAgo } from "@/lib/format";
import { chainLabel } from "@/lib/chains";

export default function TopUpPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const usdt = useApi(fetchUsdt, []);

  // Manual claim state — only used on the fallback path (no personal address).
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
  // A personal deposit address auto-credits the moment the chain confirms it
  // — no staff step, no tx hash to paste, same as the BNB deposit screen. Only
  // a deployment with no custody xpub configured has no personal address, and
  // falls back to the one shared treasury address, which still needs a human
  // to confirm the tx hash by hand.
  const auto = Boolean(s.personalAddress);
  const depositAddress = s.personalAddress ?? s.treasuryAddress;
  const chain = s.treasuryChain ?? "bep20";

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

      {!auto && sent && (
        <Card className="border-success/30 bg-success-tint/60 p-4">
          <p className="flex items-center gap-2 font-bold text-success">
            <CheckIcon size={18} />
            {t("topup.done.title")}
          </p>
          <p className="mt-1 text-sm text-brand-ink">{t("topup.done.body")}</p>
        </Card>
      )}

      {/* ---- Address — QR + two labelled rows, exactly the BNB deposit
          screen's layout (founder, 2026-08-12: "make it as simple as BNB"). ---- */}
      <div>
        <SectionTitle>{t("topup.address")}</SectionTitle>
        <Card className="p-4 space-y-3">
          <div className="flex justify-center"><QrCode value={depositAddress ?? ""} /></div>
          {/* Coin and network as two separate labelled rows. A wallet asks for
              both, and a user who has to infer either one from a run-on
              sentence is a user who eventually sends BNB on the wrong network. */}
          <div className="rounded-lg border border-line p-2.5 text-xs text-muted flex justify-between">
            <span>{t("topup.token")}</span>
            <span className="font-semibold text-brand-ink">{t("topup.tokenValue")}</span>
          </div>
          <div className="rounded-lg border border-line p-2.5 text-xs text-muted flex justify-between">
            <span>{t("topup.network")}</span>
            <span className="font-semibold text-brand-ink">{chainLabel(chain)}</span>
          </div>
          {/* When custody derivation is on, this is the user's OWN address, and
              a deposit to it credits on its own — see the auto note below. */}
          {s.personalAddress && (
            <p className="text-xs font-semibold text-brand">{t("topup.yourOwnAddress")}</p>
          )}
          <button
            onClick={copyAddress}
            className="w-full rounded-xl border border-line p-3 text-left flex items-center justify-between active:bg-brand-tint/40"
          >
            <span className="num text-sm break-all text-brand-ink">{depositAddress}</span>
            {copied ? <CheckIcon size={18} className="shrink-0 text-success ml-2" /> : <CopyIcon size={18} className="shrink-0 text-muted ml-2" />}
          </button>
        </Card>
        {/* Wrong-chain deposits are the number one way people lose money doing
            this, and they are unrecoverable. Said in danger colours, next to the
            address, not buried in the steps above. */}
        <p className="mt-2 flex gap-2 rounded-xl border border-danger/30 bg-danger-tint p-3 text-sm font-semibold text-danger">
          <InfoIcon size={16} className="mt-0.5 shrink-0" />
          {t("topup.addressWarn")}
        </p>
        {auto && (
          <p className="mt-2 flex gap-2 rounded-xl border border-success/30 bg-success-tint/50 p-3 text-sm text-brand-ink">
            <CheckIcon size={16} className="mt-0.5 shrink-0 text-success" />
            {t("topup.autoNote")}
          </p>
        )}
      </div>

      {/* ---- Manual claim — fallback path only, when there is no personal
          deposit address to auto-credit from. ---- */}
      {!auto && (
        <>
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
        </>
      )}

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

      {/* ---- How — only the manual fallback has steps to follow. The auto path
          has exactly one step, already said above the address: send it. ---- */}
      {!auto && (
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
      )}
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
