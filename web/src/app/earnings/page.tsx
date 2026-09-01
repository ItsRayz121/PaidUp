"use client";

// "What you've earned from the platform" — a lifetime summary.
//
// Built ahead of real USDT payouts and gated behind the `earnings_view` flag,
// which ships OFF (api/src/flagsCore.ts). While it is off, GET /me/earnings
// 403s and this page shows a "coming soon" state instead of a number nobody can
// act on yet.
import { Card } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { fetchEarnings } from "@/lib/api";
import { formatUsdtMicro, formatRozi, formatPointsAsRozi } from "@/lib/format";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <span className="text-muted">{label}</span>
      <span className="font-semibold text-brand-ink">{value}</span>
    </div>
  );
}

export default function EarningsPage() {
  const { ready } = useRequireAuth();
  const e = useApi(fetchEarnings, []);

  if (!ready || e.loading) return <div className="p-4 pt-6"><Loading /></div>;

  // Flag off -> 403. Not an error the user did anything about.
  const off = e.error && (e.error.toLowerCase().includes("turned off"));
  if (off) {
    return (
      <div className="px-4 pt-5 pb-8 space-y-4">
        <h1 className="text-xl font-bold text-brand-ink">Your earnings</h1>
        <Card className="p-5 text-center">
          <p className="text-sm text-muted">
            This is coming soon. Once cash-out opens you&apos;ll see everything you have
            earned from tasks, invites and mining here.
          </p>
        </Card>
      </div>
    );
  }
  if (e.error) return <div className="p-4 pt-6"><ErrorState message={e.error} onRetry={e.reload} /></div>;
  if (!e.data) return null;

  const d = e.data;

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header>
        <h1 className="text-xl font-bold text-brand-ink">Your earnings</h1>
        <p className="text-sm text-muted">Everything you have earned from the platform, for life.</p>
      </header>

      <Card className="p-5">
        <p className="text-xs font-semibold uppercase text-muted">Total earned</p>
        <p className="mt-1 text-3xl font-bold text-brand-ink">{formatUsdtMicro(d.usdtMicro.total)}</p>
        <p className="mt-1 text-xs text-muted">
          {formatUsdtMicro(d.usdtMicro.withdrawn)} already withdrawn
        </p>
      </Card>

      <Card className="p-4 divide-y divide-line">
        <div className="pb-1"><p className="text-xs font-semibold uppercase text-muted">From tasks &amp; invites</p></div>
        <Row label="Tasks" value={formatPointsAsRozi(d.points.tasks)} />
        <Row label="Invites" value={formatPointsAsRozi(d.points.referrals)} />
        {d.points.bonuses > 0 && <Row label="Bonuses" value={formatPointsAsRozi(d.points.bonuses)} />}
        <Row label="Task USDT" value={formatUsdtMicro(d.usdtMicro.earnedUsdt)} />
      </Card>

      <Card className="p-4 divide-y divide-line">
        <div className="pb-1"><p className="text-xs font-semibold uppercase text-muted">Mined</p></div>
        <Row label="Mined ROZI" value={formatRozi(d.roziMicro.mined)} />
        {d.roziMicro.fromTasks > 0 && <Row label="ROZI from tasks" value={formatRozi(d.roziMicro.fromTasks)} />}
        <Row label="Total ROZI" value={formatRozi(d.roziMicro.total)} />
      </Card>
    </div>
  );
}
