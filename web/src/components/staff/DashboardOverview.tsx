"use client";

// Dashboard landing block (admin rebuild, Phase B). Two things a staff member
// wants the instant they open the console: what needs doing (every work queue's
// size, and anything that means money is stuck), and what just happened (the
// last few admin actions). The full analytics report + charts render below
// this, unchanged.
//
// ⚠️ RESOLVED THINGS DISAPPEAR — THEY DON'T LINGER GREEN (founder, 2026-09-02).
// A signal you can work down to zero — fraud flags, failed payout jobs, a
// treasury shortfall — shows ONLY while something is still open (red). Once
// everything is handled the tile is gone from the grid entirely; there is no
// "all clear" green state to scan past. Plain queue counts (withdrawals, KYC,
// tickets) still show a muted 0 because that is the normal resting state of a
// queue, not a problem that was fixed.
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import {
  fetchStaffDashboard, recheckReconciliation, fetchReconciliationSuspects,
  adjustUserUsdt, type ReconSuspect,
} from "@/lib/api";
import { useStaffNav, type SectionId } from "@/lib/staffNav";
import { TimeCell, Spinner, ErrorRow } from "./primitives";
import { useToast } from "./toast";

// A plain queue size (leaves the queue when done — a muted 0 is fine).
type CountTile = { kind: "count"; label: string; value: number; section: SectionId; anchor?: string };
// A problem signal. Rendered only while `open > 0`.
type SignalTile = { kind: "signal"; label: string; open: number; section: SectionId; anchor?: string };
type Tile = CountTile | SignalTile;

export function DashboardOverview() {
  const d = useApi(fetchStaffDashboard, [], true, 30_000);
  const { goToSection, openUser } = useStaffNav();
  const toast = useToast();
  const [rechecking, setRechecking] = useState<string | null>(null);
  const [suspects, setSuspects] = useState<ReconSuspect[] | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);

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

  async function findSuspects(chain: string) {
    setRechecking(chain);
    try {
      const r = await fetchReconciliationSuspects(chain);
      setSuspects(r.suspects);
      if (!r.suspects.length) toast.ok("No double-credited deposits found — check the ledger by hand.");
    } catch (e) { toast.err((e as Error).message); }
    finally { setRechecking(null); }
  }

  async function fixSuspect(s: ReconSuspect, chain: string) {
    if (!window.confirm(`Post a −${s.overcreditUsdt} USDT adjustment on ${s.email}?\nThis corrects a deposit that was credited twice (tx ${s.txHash.slice(0, 14)}…).`)) return;
    setBusyUser(s.userId);
    try {
      await adjustUserUsdt(s.userId, -s.overcreditUsdt, `Reconciliation fix — deposit ${s.txHash} credited twice`);
      await recheckReconciliation(chain);
      toast.ok(`Adjusted ${s.email}. Re-checking…`);
      setSuspects((cur) => (cur ?? []).filter((x) => x.userId !== s.userId || x.txHash !== s.txHash));
      d.reload();
    } catch (e) { toast.err((e as Error).message); }
    finally { setBusyUser(null); }
  }

  if (d.loading && !d.data) return <Spinner label="Loading dashboard…" />;
  if (d.error) return <ErrorRow message={d.error} onRetry={d.reload} />;
  if (!d.data) return null;

  const a = d.data.attention;
  const allTiles: Tile[] = [
    { kind: "count", label: "Withdrawals — new", value: a.withdrawalsPending, section: "money", anchor: "p-withdrawals-group" },
    { kind: "count", label: "Withdrawals — ready to pay", value: a.withdrawalsReady, section: "money", anchor: "p-withdrawals-group" },
    { kind: "count", label: "USDT deposits waiting", value: a.depositsPending, section: "money", anchor: "p-deposits-group" },
    { kind: "count", label: "USDT refunds waiting", value: a.refundsPending, section: "money", anchor: "p-deposits-group" },
    { kind: "signal", label: "BNB withdrawals failed", open: a.bnbFailed.open, section: "money", anchor: "p-withdrawals-group" },
    { kind: "signal", label: "Payout relay jobs failed", open: a.relayFailed.open, section: "money", anchor: "p-withdrawals-group" },
    { kind: "signal", label: "Treasury shortfall (chains)", open: a.reconciliationShortfall.open, section: "money", anchor: "p-treasury-group" },
    { kind: "signal", label: "Open fraud flags", open: a.fraudOpen.open, section: "users", anchor: "p-fraud" },
    { kind: "count", label: "IDs waiting for review", value: a.kycWaiting, section: "users", anchor: "p-kyc" },
    { kind: "count", label: "Open support tickets", value: a.ticketsOpen, section: "support" },
  ];
  // Signal tiles vanish once resolved; count tiles always show.
  const tiles = allTiles.filter((t) => t.kind === "count" || t.open > 0);

  const anyProblem = tiles.some((t) => t.kind === "signal" || (t.kind === "count" && t.value > 0));
  const shortfalls = d.data.reconciliation.filter((r) => r.delta < 0);

  return (
    <section className="mb-8">
      <h2 className="mb-2 font-bold text-brand-ink">Needs attention</h2>
      {!anyProblem && (
        <p className="mb-3 rounded-lg border-2 border-success/50 bg-success-tint/40 p-3 text-sm text-success">
          Every queue is clear — nothing needs a decision right now.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => {
          const isSignal = t.kind === "signal";
          const headline = isSignal ? t.open : t.value;
          const tone = isSignal
            ? "border-danger bg-danger-tint/50"
            : headline > 0
              ? "border-pending bg-pending-tint/40"
              : "border-line-strong bg-card";
          const numTone = isSignal ? "text-danger" : headline > 0 ? "text-pending" : "text-muted";
          return (
            <button
              key={t.label}
              onClick={() => goToSection(t.section, t.anchor)}
              className={`rounded-lg border-2 p-3 text-left transition-colors hover:brightness-95 ${tone}`}
            >
              <p className={`num text-2xl font-bold ${numTone}`}>{headline}</p>
              <p className="mt-0.5 text-xs text-muted">{t.label}</p>
            </button>
          );
        })}
      </div>

      {shortfalls.length > 0 && (
        <div className="mt-3 rounded-lg border-2 border-danger bg-danger-tint/40 p-3 text-sm">
          <p className="font-semibold text-danger">Treasury reconciliation shortfall</p>
          <p className="mb-1 text-xs text-muted">
            The books say we hold more USDT than the chain actually does. Find the account whose deposit was
            counted twice, post the correcting adjustment, then re-check — it clears and stops re-flagging.
          </p>
          {shortfalls.map((r) => (
            <p key={r.chain} className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="num">{r.chain}: {(r.delta / 1e6).toFixed(2)} USDT short · checked <TimeCell iso={r.checkedAt} /></span>
              <button onClick={() => findSuspects(r.chain)} disabled={rechecking === r.chain}
                className="rounded-md bg-brand px-2 py-0.5 text-[11px] font-semibold text-white disabled:opacity-50">
                Find the over-credited user
              </button>
              <button onClick={() => recheck(r.chain)} disabled={rechecking === r.chain}
                className="rounded-md border-2 border-brand px-2 py-0.5 text-[11px] font-semibold text-brand disabled:opacity-50">
                {rechecking === r.chain ? "Checking…" : "Re-check now"}
              </button>
            </p>
          ))}
          {suspects && suspects.length > 0 && (
            <div className="mt-2 space-y-1 rounded-md border-2 border-line-strong bg-card p-2">
              {suspects.map((s) => (
                <div key={s.userId + s.txHash} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <button className="text-brand underline" onClick={() => openUser(s.userId)}>{s.email}</button>
                  <span className="num text-muted">
                    topup ${s.topupUsdt} + scan ${s.depositUsdt} → over by ${s.overcreditUsdt}
                  </span>
                  <button onClick={() => fixSuspect(s, shortfalls[0]?.chain ?? "bep20")} disabled={busyUser === s.userId}
                    className="rounded-md bg-danger px-2 py-0.5 text-[11px] font-semibold text-white disabled:opacity-50">
                    {busyUser === s.userId ? "Adjusting…" : `Adjust −$${s.overcreditUsdt}`}
                  </button>
                </div>
              ))}
            </div>
          )}
          {suspects && suspects.length === 0 && (
            <p className="mt-2 text-[11px] text-muted">
              No double-credited deposit found automatically — identify the user in the USDT ledger and use
              Users &amp; IDs → open the user → Adjust USDT.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
