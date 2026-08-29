"use client";

// Dashboard landing block (admin rebuild, Phase B). Two things a staff member
// wants the instant they open the console: what needs doing (every work queue's
// size, and anything that means money is stuck), and what just happened (the
// last few admin actions). The full analytics report + charts render below
// this, unchanged.
import { useApi } from "@/lib/hooks";
import { fetchStaffDashboard } from "@/lib/api";
import { useStaffNav, type SectionId } from "@/lib/staffNav";
import { TimeCell, Spinner, ErrorRow } from "./primitives";

type Tile = { label: string; value: number; section: SectionId; tone: "warn" | "bad" | "ok" };

export function DashboardOverview() {
  const d = useApi(fetchStaffDashboard, [], true, 30_000);
  const { goToSection } = useStaffNav();

  if (d.loading && !d.data) return <Spinner label="Loading dashboard…" />;
  if (d.error) return <ErrorRow message={d.error} onRetry={d.reload} />;
  if (!d.data) return null;

  const a = d.data.attention;
  const tiles: Tile[] = [
    { label: "Withdrawals — new", value: a.withdrawalsPending, section: "money", tone: "warn" },
    { label: "Withdrawals — ready to pay", value: a.withdrawalsReady, section: "money", tone: "warn" },
    { label: "USDT deposits waiting", value: a.depositsPending, section: "money", tone: "warn" },
    { label: "USDT refunds waiting", value: a.refundsPending, section: "money", tone: "warn" },
    { label: "BNB withdrawals failed", value: a.bnbFailed, section: "money", tone: "bad" },
    { label: "Payout relay jobs failed", value: a.relayFailed, section: "money", tone: "bad" },
    { label: "Treasury shortfall (chains)", value: a.reconciliationShortfall, section: "money", tone: "bad" },
    { label: "Open fraud flags", value: a.fraudOpen, section: "users", tone: "bad" },
    { label: "IDs waiting for review", value: a.kycWaiting, section: "users", tone: "warn" },
    { label: "Open support tickets", value: a.ticketsOpen, section: "support", tone: "warn" },
  ];

  const toneClass = {
    warn: "border-pending/40 bg-pending-tint/40",
    bad: "border-danger/40 bg-danger-tint/40",
    ok: "border-line bg-card",
  };
  const numClass = { warn: "text-pending", bad: "text-danger", ok: "text-brand-ink" };

  const nothing = tiles.every((t) => t.value === 0);

  return (
    <section className="mb-8">
      <h2 className="mb-2 font-bold text-brand-ink">Needs attention</h2>
      {nothing ? (
        <p className="rounded-lg border border-success/30 bg-success-tint/40 p-4 text-sm text-success">
          Every queue is clear. Nothing needs a decision right now.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {tiles.map((t) => (
            <button
              key={t.label}
              onClick={() => goToSection(t.section)}
              className={`rounded-lg border p-3 text-left transition-colors hover:brightness-95 ${
                t.value === 0 ? toneClass.ok : toneClass[t.tone]
              }`}
            >
              <p className={`num text-2xl font-bold ${t.value === 0 ? "text-muted" : numClass[t.tone]}`}>{t.value}</p>
              <p className="mt-0.5 text-xs text-muted">{t.label}</p>
            </button>
          ))}
        </div>
      )}

      {d.data.reconciliation.some((r) => r.delta < 0) && (
        <div className="mt-3 rounded-lg border border-danger/40 bg-danger-tint/40 p-3 text-sm">
          <p className="font-semibold text-danger">Treasury reconciliation shortfall</p>
          {d.data.reconciliation.filter((r) => r.delta < 0).map((r) => (
            <p key={r.chain} className="num text-xs text-muted">
              {r.chain}: {(r.delta / 1e6).toFixed(2)} USDT short · checked <TimeCell iso={r.checkedAt} />
            </p>
          ))}
        </div>
      )}

      <h3 className="mb-2 mt-6 font-bold text-brand-ink">Recent admin activity</h3>
      {d.data.recentActivity.length === 0 ? (
        <p className="rounded-lg border border-line bg-card p-3 text-sm text-muted">Nothing yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[560px] text-xs">
            <thead className="bg-brand-tint/60 text-left uppercase text-brand">
              <tr><th className="p-2">When</th><th className="p-2">Action</th><th className="p-2">Who</th><th className="p-2">On</th><th className="p-2">Detail</th></tr>
            </thead>
            <tbody>
              {d.data.recentActivity.map((r, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="p-2"><TimeCell iso={r.created_at} /></td>
                  <td className="p-2 font-semibold text-brand-ink">{r.action}</td>
                  <td className="p-2 text-muted">{r.actor_email ?? "—"}</td>
                  <td className="p-2 text-muted">{r.target_email ?? "—"}</td>
                  <td className="p-2 text-muted">{r.detail ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
