"use client";

// Ask for your deposited USDT back (founder, 2026-08-01).
//
// THIS SCREEN IS ABOUT ONE BALANCE AND MUST NOT BLUR INTO THE OTHER. It sends
// back money the user themselves deposited to buy mining machines. It is NOT
// how task earnings are cashed out — those live on a different ledger and leave
// through /wallet/withdraw. A user who confuses the two ends up believing their
// earnings are stuck, or that their deposit is spendable as earnings; both are
// wrong, and both are our fault if this page is vague. Hence: the word
// "withdraw" appears nowhere here, and a line says outright which money this is.
//
// The flow is manual on purpose, exactly like the deposit side: a human sends
// the USDT from the treasury and records the transaction. No signer, no hot
// wallet, no key in this app.
import { useState } from "react";
import Link from "next/link";
import { Card, Button, SectionTitle } from "@/components/ui";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { ArrowRightIcon, CheckIcon, InfoIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchUsdt, fetchPayoutAddresses, requestUsdtRefund } from "@/lib/api";
import { formatUsdtMicro, formatUsdtAmount, timeAgo } from "@/lib/format";

export default function RefundPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const usdt = useApi(fetchUsdt, []);
  const saved = useApi(fetchPayoutAddresses, []);

  const [amount, setAmount] = useState("");
  // Undefined until the saved address has loaded, so the field can adopt it
  // once without fighting the user if they have already started typing.
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  // Set when the request settled instantly (auto-send is on and it was under
  // the ceiling) instead of dropping into the manual queue — see
  // requestUsdtRefund's response and autoRefund.ts. Undefined = the ordinary
  // "we got it, staff will send it" confirmation.
  const [instantTxHash, setInstantTxHash] = useState<string | null>(null);
  // The gas fee (founder, 2026-08-08) actually charged on the last request —
  // shown in the confirmation card. Preview-computed fee (below) can drift by
  // a rounding unit from this; this is the real, server-snapshotted number.
  const [resultFeeMicro, setResultFeeMicro] = useState(0);
  const [resultNetMicro, setResultNetMicro] = useState(0);

  if (!ready || usdt.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (usdt.error || !usdt.data) {
    return (
      <div className="p-4 pt-6">
        <ErrorState message={usdt.error ?? "…"} onRetry={usdt.reload} />
      </div>
    );
  }

  const s = usdt.data;
  const min = s.refundMinMicro / 1_000_000;
  const balance = s.balanceMicro / 1_000_000;
  // Pre-fill with the wallet they already saved for payouts. Same chain, same
  // person, and re-typing an address is where people make the mistake that
  // cannot be undone.
  const prefill = saved.data?.addresses?.[s.treasuryChain ?? "bep20"] ?? "";
  const addr = address ?? prefill;

  // Blank field means "the minimum" — same convention as the withdraw screen
  // (web/src/app/wallet/withdraw/page.tsx) — so a balance under the minimum
  // explains itself the moment the page loads, instead of leaving the button
  // silently dead with no message until someone happens to type a number
  // that also fails.
  const typedUsdt = Number(amount);
  const effectiveAmt = amount.trim() !== "" && Number.isFinite(typedUsdt) ? typedUsdt : min;
  const belowMin = effectiveAmt < min;
  const overBalance = effectiveAmt > balance;
  const canSubmit = addr.trim().length > 0 && !belowMin && !overBalance;

  // PREVIEW ONLY — mirrors the server's exact formula (gasFeeMicro in
  // api/src/fees.ts) so this never shows a number the request will then
  // disagree with, but the fee actually charged is re-computed and
  // snapshotted server-side at request time.
  const effectiveMicro = Math.round(effectiveAmt * 1_000_000);
  const previewFeeMicro = !belowMin && !overBalance
    ? Math.round((effectiveMicro * s.gasFeePercent) / 100) + s.gasFeeFixedMicro
    : 0;
  const previewNetMicro = Math.max(0, effectiveMicro - previewFeeMicro);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await requestUsdtRefund(effectiveAmt, addr.trim());
      setSent(true);
      setInstantTxHash(res.status === "paid" ? (res.txHash ?? null) : null);
      setResultFeeMicro(res.feeMicro);
      setResultNetMicro(res.netMicro);
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
      <header>
        <Link href="/mine/topup" className="inline-flex items-center gap-1 text-sm font-semibold text-brand">
          <ArrowRightIcon size={16} className="rotate-180" />
          {t("topup.title")}
        </Link>
        <h1 className="mt-2 text-xl font-bold text-brand-ink">{t("refund.title")}</h1>
        <p className="text-sm text-muted">{t("refund.subtitle")}</p>
      </header>

      <Card className="p-4">
        <p className="text-sm text-muted">{t("refund.available")}</p>
        <p className="num text-2xl font-bold text-brand-ink">
          {formatUsdtMicro(s.balanceMicro)}
        </p>
        <p className="mt-1 text-xs text-muted">{t("refund.notSpent")}</p>
      </Card>

      {sent && (
        <Card className="border-success/30 bg-success-tint/60 p-4">
          <p className="flex items-center gap-2 font-bold text-success">
            <CheckIcon size={18} />
            {t(instantTxHash ? "refund.done.instant.title" : "refund.done.title")}
          </p>
          <p className="mt-1 text-sm text-brand-ink">
            {t(instantTxHash ? "refund.done.instant.body" : "refund.done.body")}
          </p>
          {resultFeeMicro > 0 && (
            <p className="mt-1 text-xs text-brand-ink">
              {t("refund.sentNet", { net: formatUsdtMicro(resultNetMicro), fee: formatUsdtMicro(resultFeeMicro) })}
            </p>
          )}
          {instantTxHash && <p className="num mt-2 break-all text-xs text-muted">{instantTxHash}</p>}
        </Card>
      )}

      {s.balanceMicro <= 0 ? (
        <EmptyState title={t("refund.none")} body={t("topup.subtitle")} />
      ) : (
        <>
          {error && (
            <p className="rounded-xl border border-danger/30 bg-danger-tint p-3 text-sm font-semibold text-danger">
              {error}
            </p>
          )}

          <div>
            <label htmlFor="amt" className="mb-2 block px-1 font-semibold text-brand-ink">
              {t("refund.amountLabel")}
            </label>
            <input
              id="amt"
              type="number"
              inputMode="decimal"
              min={min}
              max={balance}
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setSent(false); setInstantTxHash(null); }}
              placeholder={String(min)}
              className="num w-full rounded-xl border border-line bg-card p-3 text-brand-ink outline-none focus:border-brand"
            />
            <p className="mt-1.5 px-1 text-xs text-muted">
              {t("refund.min", { min: String(min) })}
            </p>
            {/* Only shown when a gas fee is actually configured — most
                deployments today have it at 0/0, same as the withdraw
                screen's identical `{fee > 0 && ...}` guard. */}
            {previewFeeMicro > 0 && (
              <div className="mt-2 rounded-lg border border-line bg-card p-2.5 text-sm">
                <div className="flex justify-between text-muted">
                  <span>{t("refund.feeLabel")}</span>
                  <span className="num">− {formatUsdtMicro(previewFeeMicro)}</span>
                </div>
                <div className="mt-1 flex justify-between font-semibold text-brand-ink">
                  <span>{t("refund.youGet")}</span>
                  <span className="num">{formatUsdtMicro(previewNetMicro)}</span>
                </div>
              </div>
            )}
            {/* Explains the disabled button instead of leaving it silently
                dead — mirrors withdraw.needAtLeast / withdraw.notEnough. */}
            {belowMin && (
              <p className="mt-2 rounded-lg bg-pending-tint p-2.5 text-sm text-pending">
                {t("refund.needAtLeast", { min: formatUsdtAmount(min) })}
              </p>
            )}
            {!belowMin && overBalance && (
              <p className="mt-2 rounded-lg bg-danger-tint p-2.5 text-sm text-danger">
                {t("refund.notEnough")}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="addr" className="mb-2 block px-1 font-semibold text-brand-ink">
              {t("refund.addressLabel")}
            </label>
            <input
              id="addr"
              value={addr}
              onChange={(e) => { setAddress(e.target.value); setSent(false); setInstantTxHash(null); }}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="num w-full rounded-xl border border-line bg-card p-3 text-sm text-brand-ink outline-none focus:border-brand"
            />
            <p className="mt-1.5 px-1 text-xs text-muted">{t("refund.addressHint")}</p>
          </div>

          <Button onClick={submit} disabled={!canSubmit || busy} full>
            {busy ? t("refund.sending") : t("refund.submit")}
          </Button>
        </>
      )}

      <div>
        <SectionTitle>{t("refund.history")}</SectionTitle>
        {s.refunds.length === 0 ? (
          <EmptyState title={t("refund.empty")} body={t("refund.subtitle")} />
        ) : (
          <Card className="divide-y divide-line">
            {s.refunds.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="num font-semibold text-brand-ink">
                    {formatUsdtMicro(r.amountMicro)}
                  </p>
                  {/* Only on a PAID row — a rejected request never sent
                      anything, so there is no "net" to have gotten; a
                      pending one hasn't been sent yet either. */}
                  {r.feeMicro > 0 && r.status === "paid" && (
                    <p className="num text-xs text-muted">
                      {t("refund.rowNet", { net: formatUsdtMicro(r.amountMicro - r.feeMicro) })}
                    </p>
                  )}
                  <p className="truncate text-xs text-muted">{timeAgo(r.createdAt)}</p>
                  {r.rejectReason && (
                    <p className="mt-0.5 text-xs text-danger">{r.rejectReason}</p>
                  )}
                  {/* Proof, the same way a paid withdrawal shows its hash. */}
                  {r.txHash && (
                    <p className="num mt-0.5 truncate text-xs text-muted">{r.txHash}</p>
                  )}
                </div>
                <StatusBadge status={r.status} />
              </div>
            ))}
          </Card>
        )}
      </div>

      {/* Which money this is — moved below the form, 2026-08-08: this is a
          clarification for someone confused about the two balances, not a
          warning that changes what someone does with the form above it (see
          topup/page.tsx's spend-only card, which IS kept above its address
          for exactly that reason and is not the same kind of message). */}
      <p className="flex gap-2 rounded-xl border border-line bg-card p-3 text-sm text-muted">
        <InfoIcon size={16} className="mt-0.5 shrink-0" />
        {t("refund.notEarnings")}
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: "pending" | "paid" | "rejected" }) {
  const { t } = useI18n();
  const cls = {
    pending: "bg-pending-tint text-pending",
    paid: "bg-success-tint text-success",
    rejected: "bg-danger-tint text-danger",
  }[status];
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${cls}`}>
      {t(`refund.status.${status}`)}
    </span>
  );
}
