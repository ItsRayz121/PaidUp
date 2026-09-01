"use client";

// Money & payouts — the Overview sub-tab (founder, 2026-09-01: "make it
// comprehensive: how much the platform holds right now, and how much flows in
// vs out over 1h / 24h / 7d / 30d / 1y / all time").
//
// One request (`GET /staff/money/overview`), everything derived server-side.
// This screen answers "are we solvent and which way is the money moving" at a
// glance; the individual queues (its sibling sub-tabs) are where you act.
import { useState, type ReactNode } from "react";
import { useApi } from "@/lib/hooks";
import { fetchMoneyOverview, type MoneyOverview as TOverview } from "@/lib/api";
import { QUEUE_POLL_MS, RefreshBar } from "@/components/staff";
import { useStaffNav } from "@/lib/staffNav";
import { StatusBadge, TimeCell, Spinner, ErrorRow } from "./primitives";
import { formatUsdtMicro, formatPoints, formatBnbWei } from "@/lib/format";

const WINDOWS: { key: string; label: string }[] = [
  { key: "h1", label: "1 hour" },
  { key: "h24", label: "24 hours" },
  { key: "d7", label: "7 days" },
  { key: "d30", label: "30 days" },
  { key: "d365", label: "1 year" },
  { key: "all", label: "All time" },
];

function Card({ tone, label, value, children }: {
  tone: "in" | "out" | "net"; label: string; value: string; children?: ReactNode;
}) {
  const ring = {
    in: "border-success/40 bg-success-tint/30",
    out: "border-danger/40 bg-danger-tint/30",
    net: "border-brand/40 bg-brand-tint/40",
  }[tone];
  const num = { in: "text-success", out: "text-danger", net: "text-brand-ink" }[tone];
  return (
    <div className={`rounded-lg border p-4 ${ring}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className={`num text-2xl font-bold ${num}`}>{value}</p>
      {children && <div className="mt-1 space-y-0.5 text-xs text-muted">{children}</div>}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="num text-lg font-bold text-brand-ink">{value}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  );
}

function LatestList({ title, rows, onOpen }: {
  title: string; onOpen: () => void;
  rows: { id: string; email: string; status: string; at: string; amount: string }[];
}) {
  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h4>
        <button onClick={onOpen} className="text-xs font-semibold text-brand hover:underline">Open queue →</button>
      </div>
      {rows.length === 0 ? (
        <p className="py-2 text-xs text-muted">Nothing yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate text-brand-ink">{r.email}</span>
              <span className="num shrink-0 text-xs">{r.amount}</span>
              <StatusBadge status={r.status} />
              <span className="shrink-0"><TimeCell iso={r.at} /></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MoneyOverview() {
  const [auto, setAuto] = useState(true);
  const d = useApi(fetchMoneyOverview, [], true, auto ? QUEUE_POLL_MS : undefined);
  const { goToSection } = useStaffNav();
  const [win, setWin] = useState("h24");

  if (d.loading && !d.data) return <Spinner label="Loading money overview…" />;
  if (d.error) return <ErrorRow message={d.error} onRetry={d.reload} />;
  if (!d.data) return null;
  const o: TOverview = d.data;
  const f = o.flows[win] ?? o.flows.all;
  const chains = Object.keys(o.heldNow.treasuryMicro);
  const bnbOut = formatBnbWei(f.bnbOutWei);

  return (
    <section className="mb-8 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-brand-ink">Money &amp; payouts — overview</h2>
        <RefreshBar updatedAt={d.updatedAt} loading={d.loading} onRefresh={d.reload} auto={auto} setAuto={setAuto} />
      </div>

      {/* ---- what the platform holds right now ---- */}
      <div className="rounded-lg border border-brand/30 bg-brand-tint/30 p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Platform holds right now</p>
        <p className="num text-3xl font-bold text-brand-ink">{formatUsdtMicro(o.heldNow.treasuryTotalMicro)}</p>
        <p className="mt-0.5 text-xs text-muted">
          on-chain treasury + unswept deposit addresses
          {o.heldNow.checkedAt ? <> · checked <TimeCell iso={o.heldNow.checkedAt} /></> : " · no reconciliation snapshot yet"}
        </p>
        {chains.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {chains.map((c) => (
              <span key={c} className="text-muted">
                <span className="font-semibold uppercase text-brand-ink">{c}</span>{" "}
                <span className="num">{formatUsdtMicro(o.heldNow.treasuryMicro[c])}</span>
              </span>
            ))}
          </div>
        )}
        {/* ⚠️ Liabilities shown as separate lines, never summed with each other
            or with ROZI (guardrail #7). */}
        <p className="mt-2 text-xs text-muted">
          We owe users: <span className="num font-semibold text-brand-ink">{formatPoints(o.heldNow.outstandingPoints)}</span> pts
          (~<span className="num">{formatUsdtMicro(o.heldNow.pointsLiabilityMicro)}</span>) ·
          held USDT deposits: <span className="num font-semibold text-brand-ink">{formatUsdtMicro(o.heldNow.usdtDepositLiabilityMicro)}</span>
        </p>
      </div>

      {/* ---- inflow / outflow for the chosen window ---- */}
      <div>
        <div className="mb-2 flex flex-wrap gap-1">
          {WINDOWS.map((w) => (
            <button key={w.key} onClick={() => setWin(w.key)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                win === w.key ? "bg-brand text-white" : "bg-brand-tint text-brand"
              }`}>
              {w.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Card tone="in" label="Money in" value={formatUsdtMicro(f.depositsInMicro)}>
            <p>USDT deposits confirmed</p>
          </Card>
          <Card tone="out" label="Money out" value={formatUsdtMicro(f.outMicro)}>
            <p>Withdrawals sent: {formatUsdtMicro(f.withdrawalsOutMicro)}</p>
            <p>Deposit refunds: {formatUsdtMicro(f.refundsOutMicro)}</p>
            {bnbOut !== "0" && <p>BNB gas out: {bnbOut}</p>}
          </Card>
          <Card tone="net" label="Net flow" value={`${f.netMicro >= 0 ? "+" : "−"}${formatUsdtMicro(Math.abs(f.netMicro))}`}>
            <p>{f.netMicro >= 0 ? "more came in than went out" : "more went out than came in"}</p>
          </Card>
        </div>
      </div>

      {/* ---- owed vs paid (folded in from the old Money panel) ---- */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Owed to users (live)" value={formatPoints(o.owed.outstandingPoints)} sub={formatUsdtMicro(o.owed.outstandingMicro)} />
        <Tile label="Paid out (all time)" value={formatPoints(o.owed.paidPoints)} sub={formatUsdtMicro(o.owed.paidMicro)} />
        <Tile label="Awaiting payout" value={formatPoints(o.owed.pendingPoints)} sub={formatUsdtMicro(o.owed.pendingMicro)} />
        <Tile label="Fees kept" value={formatPoints(o.owed.feePoints)} sub="from withdrawals" />
      </div>

      {/* ---- latest activity per stream ---- */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <LatestList title="Latest withdrawals" onOpen={() => goToSection("money", "p-withdrawals")}
          rows={o.latest.withdrawals.map((r) => ({ ...r, amount: `${formatPoints(r.points)} pts` }))} />
        <LatestList title="Latest deposits" onOpen={() => goToSection("money", "p-usdt-deposits")}
          rows={o.latest.deposits.map((r) => ({ ...r, amount: formatUsdtMicro(r.usdtMicro) }))} />
        <LatestList title="Latest refunds" onOpen={() => goToSection("money", "p-usdt-refunds")}
          rows={o.latest.refunds.map((r) => ({ ...r, amount: formatUsdtMicro(r.usdtMicro) }))} />
        <LatestList title="Latest BNB withdrawals" onOpen={() => goToSection("money", "p-bnb-withdrawals")}
          rows={o.latest.bnb.map((r) => ({ ...r, amount: `${formatBnbWei(r.wei)} BNB` }))} />
        <LatestList title="Failed payout relay jobs" onOpen={() => goToSection("money", "p-relay-jobs")}
          rows={o.latest.relayFailed.map((r) => ({ ...r, amount: formatUsdtMicro(r.usdtMicro) }))} />
      </div>
    </section>
  );
}
