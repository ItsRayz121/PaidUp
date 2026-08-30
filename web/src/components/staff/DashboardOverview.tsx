"use client";

// Dashboard landing block (admin rebuild, Phase B). Two things a staff member
// wants the instant they open the console: what needs doing (every work queue's
// size, and anything that means money is stuck), and what just happened (the
// last few admin actions). The full analytics report + charts render below
// this, unchanged.
//
// ⚠️ TILES SHOW PROGRESS, NOT JUST A RED COUNT (founder, 2026-08-30). A signal
// you can work down to zero — fraud flags, failed payout jobs, a treasury
// shortfall — carries an `open` and a recently-`cleared` count. The tile is
// red only while something is still open; once everything is handled it turns
// green ("all clear"). "5 total · 3 cleared · 2 open" is the whole point: you
// can see what you already dealt with, not just what is left.
import { useApi } from "@/lib/hooks";
import { fetchStaffDashboard, type AttentionSignal } from "@/lib/api";
import { useStaffNav, type SectionId } from "@/lib/staffNav";
import { TimeCell, Spinner, ErrorRow } from "./primitives";

// A plain queue size (leaves the queue when done — no "cleared" history to show).
type CountTile = { kind: "count"; label: string; value: number; section: SectionId; anchor?: string; tone: "warn" | "bad" };
// A signal with open + cleared. Red while open, green once all clear.
type SignalTile = { kind: "signal"; label: string; signal: AttentionSignal; section: SectionId; anchor?: string };
type Tile = CountTile | SignalTile;

export function DashboardOverview() {
  const d = useApi(fetchStaffDashboard, [], true, 30_000);
  const { goToSection } = useStaffNav();

  if (d.loading && !d.data) return <Spinner label="Loading dashboard…" />;
  if (d.error) return <ErrorRow message={d.error} onRetry={d.reload} />;
  if (!d.data) return null;

  const a = d.data.attention;
  const tiles: Tile[] = [
    { kind: "count", label: "Withdrawals — new", value: a.withdrawalsPending, section: "money", anchor: "p-withdrawals", tone: "warn" },
    { kind: "count", label: "Withdrawals — ready to pay", value: a.withdrawalsReady, section: "money", anchor: "p-withdrawals", tone: "warn" },
    { kind: "count", label: "USDT deposits waiting", value: a.depositsPending, section: "money", anchor: "p-usdt-deposits", tone: "warn" },
    { kind: "count", label: "USDT refunds waiting", value: a.refundsPending, section: "money", anchor: "p-usdt-refunds", tone: "warn" },
    { kind: "signal", label: "BNB withdrawals failed", signal: a.bnbFailed, section: "money", anchor: "p-bnb-withdrawals" },
    { kind: "signal", label: "Payout relay jobs failed", signal: a.relayFailed, section: "money", anchor: "p-relay-jobs" },
    { kind: "signal", label: "Treasury shortfall (chains)", signal: a.reconciliationShortfall, section: "money", anchor: "p-reconciliation" },
    { kind: "signal", label: "Open fraud flags", signal: a.fraudOpen, section: "users", anchor: "p-fraud" },
    { kind: "count", label: "IDs waiting for review", value: a.kycWaiting, section: "users", anchor: "p-kyc", tone: "warn" },
    { kind: "count", label: "Open support tickets", value: a.ticketsOpen, section: "support", tone: "warn" },
  ];

  // Tone → classes. "ok" is the resolved/green state; "clear" is a tile that
  // never had anything (plain, not green — green means "you cleared it").
  const box = {
    bad: "border-danger/40 bg-danger-tint/40",
    warn: "border-pending/40 bg-pending-tint/40",
    ok: "border-success/40 bg-success-tint/40",
    clear: "border-line bg-card",
  };
  const num = { bad: "text-danger", warn: "text-pending", ok: "text-success", clear: "text-muted" };

  function toneOf(t: Tile): keyof typeof box {
    if (t.kind === "count") return t.value === 0 ? "clear" : t.tone;
    if (t.signal.open > 0) return "bad";
    return t.signal.cleared > 0 ? "ok" : "clear";
  }

  // Nothing red or amber anywhere.
  const allQuiet = tiles.every((t) => {
    const tn = toneOf(t);
    return tn === "clear" || tn === "ok";
  });

  return (
    <section className="mb-8">
      <h2 className="mb-2 font-bold text-brand-ink">Needs attention</h2>
      {allQuiet && (
        <p className="mb-3 rounded-lg border border-success/30 bg-success-tint/40 p-3 text-sm text-success">
          Nothing needs a decision right now. Anything cleared in the last few days is shown in green below.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => {
          const tn = toneOf(t);
          const headline = t.kind === "count" ? t.value : t.signal.open;
          const total = t.kind === "signal" ? t.signal.open + t.signal.cleared : 0;
          return (
            <button
              key={t.label}
              onClick={() => goToSection(t.section, t.anchor)}
              className={`rounded-lg border p-3 text-left transition-colors hover:brightness-95 ${box[tn]}`}
            >
              <p className={`num text-2xl font-bold ${num[tn]}`}>{headline}</p>
              <p className="mt-0.5 text-xs text-muted">{t.label}</p>
              {t.kind === "signal" && total > 0 && (
                <p className="mt-1 text-[11px] text-muted">
                  {tn === "ok"
                    ? `✓ all ${t.signal.cleared} cleared`
                    : `${total} total · ${t.signal.cleared} cleared · ${t.signal.open} open`}
                </p>
              )}
            </button>
          );
        })}
      </div>

      {d.data.reconciliation.some((r) => r.delta < 0) && (
        <div className="mt-3 rounded-lg border border-danger/40 bg-danger-tint/40 p-3 text-sm">
          <p className="font-semibold text-danger">Treasury reconciliation shortfall</p>
          <p className="mb-1 text-xs text-muted">
            The books say we hold more USDT than the chain actually does. It re-flags every hour until
            corrected — fix it with a USDT adjustment on the affected user (Users &amp; IDs → open the user → Adjust USDT).
          </p>
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
