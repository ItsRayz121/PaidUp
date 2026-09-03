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
import { ArrowDownIcon, ArrowUpIcon, ChartIcon } from "@/components/icons";

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
    in: "border-success bg-success-tint/30",
    out: "border-danger bg-danger-tint/30",
    net: "border-brand bg-brand-tint/40",
  }[tone];
  const num = { in: "text-success", out: "text-danger", net: "text-brand-ink" }[tone];
  const Icon = { in: ArrowDownIcon, out: ArrowUpIcon, net: ChartIcon }[tone];
  return (
    <div className={`rounded-lg border-2 p-4 ${ring}`}>
      <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <Icon size={13} /> {label}
      </p>
      <p className={`num text-2xl font-bold ${num}`}>{value}</p>
      {children && <div className="mt-1 space-y-0.5 text-xs text-muted">{children}</div>}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border-2 border-line-strong bg-card p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="num text-lg font-bold text-brand-ink">{value}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  );
}

type LatestRow = { id: string; email: string; status: string; at: string; amount: string; tag?: string };
function LatestList({ title, rows, onOpen }: {
  title: string; onOpen: () => void; rows: LatestRow[];
}) {
  return (
    <div className="rounded-lg border-2 border-line-strong bg-card p-3">
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
              <span className="min-w-0 flex-1 truncate text-brand-ink">
                {r.tag && <span className="mr-1 rounded bg-brand-tint px-1 text-[10px] font-semibold uppercase text-brand">{r.tag}</span>}
                {r.email}
              </span>
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
  const [win, setWin] = useState("h1");

  if (d.loading && !d.data) return <Spinner label="Loading money overview…" />;
  if (d.error) return <ErrorRow message={d.error} onRetry={d.reload} />;
  if (!d.data) return null;
  const o: TOverview = d.data;
  const f = o.flows[win] ?? o.flows.all;
  const chains = Object.keys(o.heldNow.treasuryMicro);
  // formatBnbWei returns "…BNB" already — don't append the unit again.
  const hasBnbOut = f.bnbOutWei !== "0" && f.bnbOutWei !== "";

  return (
    <section className="mb-8 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-brand-ink">Money &amp; payouts — overview</h2>
        <RefreshBar updatedAt={d.updatedAt} loading={d.loading} onRefresh={d.reload} auto={auto} setAuto={setAuto} />
      </div>

      {/* ---- what the platform holds right now ---- */}
      <div className="rounded-lg border-2 border-brand bg-brand-tint/30 p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Platform holds right now</p>
        <p className="num text-3xl font-bold text-brand-ink">{formatUsdtMicro(o.heldNow.treasuryTotalMicro)}</p>
        <p className="mt-0.5 text-xs text-muted">
          on-chain treasury + unswept deposit addresses
          {o.heldNow.checkedAt ? <> · checked <TimeCell iso={o.heldNow.checkedAt} /></> : " · no reconciliation snapshot yet"}
        </p>
        {/* One row per chain, each broken into its own lines instead of one
            run-on sentence — the founder found "BEP20 6.09 · of which held in
            unswept deposit addresses: 4.09" unreadable at a glance
            (2026-09-03). The "in the treasury wallet" split is only safe to
            compute per chain while there is exactly one chain live — the
            unswept liability figure is a GLOBAL sum (see staff.ts), not
            per-chain, so on a future multi-chain deploy this quietly falls
            back to just the per-chain total + the one global unswept line. */}
        {chains.length > 0 && (
          <div className="mt-3 space-y-2.5 border-t border-line pt-2.5">
            {chains.map((c) => {
              const totalMicro = o.heldNow.treasuryMicro[c];
              const sweptMicro = chains.length === 1
                ? Math.max(0, totalMicro - o.heldNow.usdtDepositLiabilityMicro)
                : null;
              return (
                <div key={c} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold uppercase text-brand-ink">{c}</span>
                    <span className="num font-semibold text-brand-ink">{formatUsdtMicro(totalMicro)}</span>
                  </div>
                  {sweptMicro !== null && (
                    <>
                      <div className="flex items-center justify-between pl-3 text-xs text-muted">
                        <span>In the treasury wallet</span>
                        <span className="num">{formatUsdtMicro(sweptMicro)}</span>
                      </div>
                      <div className="flex items-center justify-between pl-3 text-xs text-muted">
                        <span>In users&rsquo; wallets, not yet swept</span>
                        <span className="num">{formatUsdtMicro(o.heldNow.usdtDepositLiabilityMicro)}</span>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {chains.length !== 1 && (
          <p className="mt-2 text-xs text-muted">
            of which held in unswept deposit addresses:{" "}
            <span className="num font-semibold text-brand-ink">{formatUsdtMicro(o.heldNow.usdtDepositLiabilityMicro)}</span>
          </p>
        )}
      </div>

      {/* ---- inflow / outflow for the chosen window ---- */}
      <div>
        <div className="mb-2 flex flex-wrap gap-1">
          {WINDOWS.map((w) => (
            <button key={w.key} onClick={() => setWin(w.key)}
              className={`rounded-md border-2 px-2.5 py-1 text-xs font-semibold ${
                win === w.key ? "border-brand bg-brand text-white" : "border-line-strong bg-brand-tint text-brand"
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
            {hasBnbOut && <p>BNB gas out: {formatBnbWei(f.bnbOutWei)}</p>}
          </Card>
          <Card tone="net" label="Net flow" value={`${f.netMicro >= 0 ? "+" : "−"}${formatUsdtMicro(Math.abs(f.netMicro))}`}>
            <p>{f.netMicro >= 0 ? "more came in than went out" : "more went out than came in"}</p>
          </Card>
        </div>
      </div>

      {/* ---- owed vs paid (folded in from the old Money panel) ---- */}
      {/* "Owed to users" is a computed liability (points × the payout rate),
          never money the platform is holding — kept in its own tile, apart
          from the "Platform holds right now" card above, on purpose. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Owed to users (computed)" value={formatPoints(o.owed.outstandingPoints)} sub={`≈ ${formatUsdtMicro(o.owed.outstandingMicro)}`} />
        <Tile label="Paid out (all time)" value={formatPoints(o.owed.paidPoints)} sub={formatUsdtMicro(o.owed.paidMicro)} />
        <Tile label="Awaiting payout" value={formatPoints(o.owed.pendingPoints)} sub={formatUsdtMicro(o.owed.pendingMicro)} />
        <Tile label="Fees kept" value={formatPoints(o.owed.feePoints)} sub="from withdrawals" />
      </div>

      {/* ---- latest activity ---- */}
      {/* Every way money leaves the platform in ONE list — a founder who made
          BNB withdrawals and deposit refunds was seeing "Nothing yet" under a
          points-only "Latest withdrawals" heading (founder, 2026-09-02). */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <LatestList title="Recent money out" onOpen={() => goToSection("money", "p-withdrawals-group")}
          rows={recentMoneyOut(o)} />
        <LatestList title="Latest deposits" onOpen={() => goToSection("money", "p-deposits-group")}
          rows={o.latest.deposits.map((r) => ({ ...r, amount: formatUsdtMicro(r.usdtMicro) }))} />
        <LatestList title="Failed payout relay jobs" onOpen={() => goToSection("money", "p-withdrawals-group")}
          rows={o.latest.relayFailed.map((r) => ({ ...r, amount: formatUsdtMicro(r.usdtMicro) }))} />
      </div>
    </section>
  );
}

// Merge the three outbound streams (points withdrawals, deposit refunds, BNB
// gas-outs) into one time-sorted list so the overview reflects real activity
// no matter which rail the money left on.
function recentMoneyOut(o: TOverview): LatestRow[] {
  const rows: LatestRow[] = [
    ...o.latest.withdrawals.map((r) => ({ ...r, tag: "Withdraw", amount: formatUsdtMicro(r.usdtMicro) })),
    ...o.latest.refunds.map((r) => ({ ...r, tag: "Refund", amount: formatUsdtMicro(r.usdtMicro) })),
    ...o.latest.bnb.map((r) => ({ ...r, tag: "BNB", amount: formatBnbWei(r.wei) })),
  ];
  return rows.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 8);
}
