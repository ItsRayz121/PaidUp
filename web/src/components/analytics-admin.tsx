"use client";

// The admin dashboard (brief part 33), rendering the report from part 48.
// Internal tool: density over friendliness, jargon allowed (DESIGN_BRIEF).
//
// The charts are small multiples — one measure per panel, one axis each. See
// charts.tsx for why that is a correctness decision and not a layout preference.

import { useState } from "react";
import { useApi } from "@/lib/hooks";
import { fetchAnalytics, type Analytics } from "@/lib/api";
import { formatUsdtMicro, formatPoints } from "@/lib/format";
import { TimeChart, FunnelBars, StatTile, compact } from "@/components/charts";
import { useStaffNav } from "@/lib/staffNav";

const RANGES = [7, 30, 90];

export function AnalyticsDashboard() {
  const [days, setDays] = useState(7);
  const [asTable, setAsTable] = useState(false);
  const report = useApi(() => fetchAnalytics(days), [days]);
  const { goToSection } = useStaffNav();

  if (report.loading) return <p className="mb-8 text-sm text-muted">Loading the numbers…</p>;
  if (report.error) return <p className="mb-8 text-sm text-danger">{report.error}</p>;
  const a = report.data!;

  const pts = (n: number) => `${formatPoints(n)} pts`;
  const usdt = (micro: string) => formatUsdtMicro(Number(micro));

  return (
    <section className="mb-8">
      {/* Filters in one row above the charts, never per-panel. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-brand-ink">Dashboard</h2>
        <div className="flex flex-wrap items-center gap-1">
          {RANGES.map((d) => (
            <button key={d} onClick={() => setDays(d)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                days === d ? "bg-brand text-white" : "bg-brand-tint text-brand"
              }`}>
              {d} days
            </button>
          ))}
          {/* The table view is the accessibility path: every number on this
              screen must be reachable without reading a shape. */}
          <button onClick={() => setAsTable((v) => !v)}
            className="ms-2 rounded-md border border-line px-2.5 py-1 text-xs font-semibold text-brand">
            {asTable ? "Show charts" : "Show table"}
          </button>
        </div>
      </div>

      {/* The one hero figure. Active-today is the number that says whether the
          product is alive; everything else on this screen explains it. */}
      <div className="mb-4 rounded-lg border border-line bg-card p-4">
        <p className="text-xs text-muted">Active today</p>
        <p className="num text-5xl font-bold text-brand-ink">{compact(a.users.dau)}</p>
        <p className="mt-1 text-sm text-muted">
          {compact(a.users.wau)} this week · {compact(a.users.mau)} this month ·{" "}
          <span className="font-semibold text-brand-ink">{a.users.stickiness}%</span> of
          monthly users opened the app today
        </p>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatTile label="All accounts" value={compact(a.users.total)}
          sub={`${compact(a.users.verified)} verified`} onClick={() => goToSection("users")} />
        <StatTile label="New today" value={compact(a.users.newToday)}
          sub={`${compact(a.users.new7d)} in 7 days`} onClick={() => goToSection("users")} />
        <StatTile label="Tasks paid today" value={compact(a.tasks.completionsToday)}
          sub={`${a.tasks.completionRate}% of attempts pay out`} onClick={() => goToSection("tasks")} />
        <StatTile label="Miners right now" value={compact(a.mining.activeMiners)}
          sub={`${compact(a.mining.sessions)} sessions in ${days} days`} onClick={() => goToSection("mining")} />

        <StatTile label={`Revenue (${days}d, estimated)`} value={pts(a.money.revenuePoints)}
          sub={`${a.money.revenuePerActiveUser} pts per active user`} onClick={() => goToSection("money")} />
        <StatTile label={`Paid to users (${days}d)`} value={pts(a.money.rewardCostPoints)}
          sub={`${formatPoints(a.money.referralCostPoints)} of it referrals`} onClick={() => goToSection("money")} />
        <StatTile label="Waiting to be paid" value={pts(a.money.withdrawPendingPoints)}
          sub={`${formatPoints(a.money.withdrawnPointsAll)} paid all time`}
          tone={a.money.withdrawPendingPoints > 0 ? "warn" : "normal"} onClick={() => goToSection("money")} />
        <StatTile label={`Deposits (${days}d)`} value={usdt(a.money.depositMicro30d)}
          sub={`${usdt(a.money.depositMicroAll)} all time`} onClick={() => goToSection("money")} />

        <StatTile label="Proofs waiting" value={compact(a.tasks.proofsPending)}
          sub={`${a.tasks.approvalRate}% approved`}
          tone={a.tasks.proofsPending > 20 ? "warn" : "normal"} onClick={() => goToSection("tasks")} />
        <StatTile label="Open fraud flags" value={compact(a.risk.openFraud)}
          tone={a.risk.openFraud > 0 ? "bad" : "normal"} onClick={() => goToSection("users")} />
        <StatTile label="Open tickets" value={compact(a.risk.openTickets)}
          tone={a.risk.openTickets > 0 ? "warn" : "normal"} onClick={() => goToSection("support")} />
        <StatTile label="Invites that became earners"
          value={`${a.referrals.conversion}%`}
          sub={`${compact(a.referrals.activated)} of ${compact(a.referrals.signups)}`} onClick={() => goToSection("growth")} />
      </div>

      {/* The revenue estimate is labelled everywhere it appears. We store what
          we PAID a user, not what a network paid US — there is no invoice in
          this database, so the figure is the configured split applied backwards.
          Stating that is the difference between a useful estimate and a number
          somebody quotes to an investor. */}
      <p className="mb-4 rounded-lg border border-line bg-brand-tint/40 p-2 text-xs text-muted">
        <span className="font-semibold text-brand-ink">Revenue is an estimate.</span>{" "}
        We store what we paid users, not what the networks paid us. The figure applies
        each network&apos;s configured split backwards from the rewards we paid out. A real
        revenue number has to come from the network&apos;s own reporting.
      </p>

      {asTable ? (
        <DailyTable rows={a.series} mining={a.miningSeries} />
      ) : (
        <div className="mb-4 grid gap-3 lg:grid-cols-2">
          <TimeChart title="New accounts" points={a.series.map((r) => ({ label: r.day, value: r.signups }))} />
          <TimeChart title="Active users" points={a.series.map((r) => ({ label: r.day, value: r.active }))} />
          <TimeChart title="Tasks paid" points={a.series.map((r) => ({ label: r.day, value: r.completions }))} />
          <TimeChart title="Points paid for tasks"
            points={a.series.map((r) => ({ label: r.day, value: r.points }))} />
          <TimeChart title="ROZI mined"
            points={a.miningSeries.map((r) => ({ label: r.day, value: Number(r.rozi) / 1_000_000 }))} />
          <TimeChart title="People mining"
            points={a.miningSeries.map((r) => ({ label: r.day, value: r.miners }))} />
        </div>
      )}

      <div className="mb-4 grid gap-3 lg:grid-cols-2">
        <FunnelBars title={`Task funnel (${days} days)`} stages={[
          { label: "Started", value: a.tasks.starts },
          { label: "Verified by the network", value: a.tasks.verified },
          { label: "Paid to the user", value: a.tasks.credited },
        ]} />
        <FunnelBars title="Do they come back?" stages={[
          { label: `Next day (${a.retention.d1.cohort} people)`, value: a.retention.d1.pct },
          { label: `After a week (${a.retention.d7.cohort})`, value: a.retention.d7.pct },
          { label: `After a month (${a.retention.d30.cohort})`, value: a.retention.d30.pct },
        ]} />
      </div>

      <NetworkTable rows={a.byNetwork} days={days} />
    </section>
  );
}

// ---- Per-network revenue (brief part 15's reporting half) ------------------
function NetworkTable({ rows, days }: { rows: Analytics["byNetwork"]; days: number }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-line bg-card p-4 text-sm text-muted">
        No paid tasks in the last {days} days, so there is nothing to attribute yet.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[560px] text-sm">
        <caption className="p-2 text-left text-sm font-semibold text-brand-ink">
          Where the money came from ({days} days)
        </caption>
        <thead className="bg-brand-tint text-left text-xs uppercase text-brand">
          <tr>
            <th className="p-2.5">Network</th>
            <th className="p-2.5">Paid tasks</th>
            <th className="p-2.5">Split</th>
            <th className="p-2.5">To users</th>
            <th className="p-2.5">Our margin (est.)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => (
            <tr key={n.network} className="border-t border-line">
              <td className="p-2.5 font-semibold text-brand-ink">
                {n.label}
                {n.status === "disabled" && (
                  <span className="ms-1 text-xs font-normal text-danger">(disabled)</span>
                )}
              </td>
              <td className="num p-2.5">{n.completions}</td>
              <td className="p-2.5 text-muted">{n.split}% to users</td>
              <td className="num p-2.5">{formatPoints(n.userPoints)}</td>
              <td className="num p-2.5 font-semibold text-brand-ink">{formatPoints(n.marginPoints)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- The table view -------------------------------------------------------
// Every number the charts draw, as text. Not a fallback: it is how the data is
// read by anyone using a screen reader, and how anyone copies a figure out.
function DailyTable(
  { rows, mining }: { rows: Analytics["series"]; mining: Analytics["miningSeries"] },
) {
  const miningByDay = new Map(mining.map((m) => [m.day, m]));
  return (
    <div className="mb-4 max-h-[480px] overflow-auto rounded-lg border border-line">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="sticky top-0 bg-brand-tint text-left text-xs uppercase text-brand">
          <tr>
            <th className="p-2">Day</th>
            <th className="p-2">New</th>
            <th className="p-2">Active</th>
            <th className="p-2">Tasks paid</th>
            <th className="p-2">Points</th>
            <th className="p-2">ROZI</th>
            <th className="p-2">Miners</th>
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((r) => {
            const m = miningByDay.get(r.day);
            return (
              <tr key={r.day} className="border-t border-line">
                <td className="p-2 text-muted">{r.day}</td>
                <td className="num p-2">{r.signups}</td>
                <td className="num p-2">{r.active}</td>
                <td className="num p-2">{r.completions}</td>
                <td className="num p-2">{formatPoints(r.points)}</td>
                <td className="num p-2">{m ? compact(Number(m.rozi) / 1_000_000) : "0"}</td>
                <td className="num p-2">{m?.miners ?? 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
