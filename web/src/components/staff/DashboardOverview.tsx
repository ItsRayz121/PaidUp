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
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import { fetchStaffDashboard, recheckReconciliation, type AttentionSignal } from "@/lib/api";
import { useStaffNav, type SectionId } from "@/lib/staffNav";
import { TimeCell, Spinner, ErrorRow } from "./primitives";
import { useToast } from "./toast";

// A plain queue size (leaves the queue when done — no "cleared" history to show).
type CountTile = { kind: "count"; label: string; value: number; section: SectionId; anchor?: string; tone: "warn" | "bad" };
// A signal with open + cleared. Red while open, green once all clear.
type SignalTile = { kind: "signal"; label: string; signal: AttentionSignal; section: SectionId; anchor?: string };
type Tile = CountTile | SignalTile;

export function DashboardOverview() {
  const d = useApi(fetchStaffDashboard, [], true, 30_000);
  const { goToSection } = useStaffNav();
  const toast = useToast();
  const [rechecking, setRechecking] = useState<string | null>(null);

  async function recheck(chain: string) {
    setRechecking(chain);
    try {
      const r = await recheckReconciliation(chain);
      const delta = r.snapshot?.delta ?? 0;
      toast.ok(delta < 0 ? `${chain}: still short by ${Math.abs(delta)} USDT.` : `${chain}: no shortfall now.`);
      d.reload();
    } catch (e) { toast.err((e as Error).message); }
    finally { setRechecking(null); }
  }

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
            <p key={r.chain} className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="num">{r.chain}: {(r.delta / 1e6).toFixed(2)} USDT short · checked <TimeCell iso={r.checkedAt} /></span>
              <button onClick={() => recheck(r.chain)} disabled={rechecking === r.chain}
                className="rounded-md bg-brand px-2 py-0.5 text-[11px] font-semibold text-white disabled:opacity-50">
                {rechecking === r.chain ? "Checking…" : "Re-check now"}
              </button>
            </p>
          ))}
        </div>
      )}

      {/* "Recent admin activity" used to live here. Removed 2026-09-01
          (founder): it duplicated the Audit log, which is one click away and is
          the single place the full record belongs. */}
    </section>
  );
}
