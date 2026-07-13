"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { LogoutButton } from "@/components/state";
import {
  fetchStaffQueue, decideWithdrawal, fetchFraud, fetchStaffUser,
  type StaffWithdrawal,
} from "@/lib/api";
import { formatPoints, formatMoney, timeAgo } from "@/lib/format";
import {
  KpiDashboard, TicketQueue, NetworkPanel, ResolveFlagButton,
  TreasuryPanel, WithdrawalFeePanel,
} from "@/components/staff";
import { UsersPanel, StaffRolesPanel, MoneyPanel } from "@/components/admin";
import { MiningPanel } from "@/components/mining-admin";
import { Panel } from "@/components/boundary";
import { LogoMark } from "@/components/Logo";
import { TasksPanel, ProofQueue } from "@/components/tasks-admin";
import { KycPanel } from "@/components/kyc-admin";

// Internal tool: information density + speed over friendliness (DESIGN_BRIEF).
// Jargon (postback, fraud, ledger) is allowed here — never in the earner app.
const STATUSES = ["pending", "agent_approved", "manager_approved", "paid", "rejected"];

// ---- Sidebar sections -------------------------------------------------------
// Grouped deliberately COARSE (founder request: "proper side panels, not too
// many"): one entry per job a staff member sits down to do, not one per widget.
// Sections a role can't use are hidden, and only the ACTIVE section mounts, so
// opening the panel no longer fires every panel's API calls at once.
type SectionId = "dashboard" | "money" | "users" | "tasks" | "mining" | "support" | "team";
const SECTIONS: { id: SectionId; label: string; min: "agent" | "manager" | "admin" }[] = [
  { id: "dashboard", label: "Dashboard", min: "manager" },
  { id: "money", label: "Money & payouts", min: "agent" },
  { id: "users", label: "Users & IDs", min: "agent" },
  { id: "tasks", label: "Tasks & networks", min: "agent" },
  { id: "mining", label: "Mining (ROZI)", min: "admin" },
  { id: "support", label: "Support tickets", min: "agent" },
  { id: "team", label: "Staff & roles", min: "admin" },
];

export default function StaffPage() {
  const { user, ready } = useRequireAuth();
  const [lookupTarget, setLookupTarget] = useState<string | null>(null);
  const isManager = user?.role === "manager" || user?.role === "admin";
  const isAdmin = user?.role === "admin";

  // Which sections this role can see, in order.
  const visible = SECTIONS.filter((s) =>
    s.min === "agent" ? true : s.min === "manager" ? isManager : isAdmin,
  );
  const [section, setSection] = useState<SectionId | null>(null);
  // Restore the section from the URL hash so a reload (or a shared link) lands
  // on the same screen. Falls back to the first section the role can see.
  useEffect(() => {
    if (!ready || section !== null || visible.length === 0) return;
    const fromHash = window.location.hash.replace("#", "") as SectionId;
    // Syncing FROM the URL hash (an external system) once auth resolves — the
    // hash isn't readable during the static prerender, so it can't be state's
    // initial value.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSection(visible.some((s) => s.id === fromHash) ? fromHash : visible[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, visible.length]);
  function go(id: SectionId) {
    setSection(id);
    window.history.replaceState(null, "", `#${id}`);
  }
  // "view ledger" on a withdrawal jumps to the Users section with the search
  // pre-filled — the lookup lives there now.
  function openLedger(userId: string) {
    setLookupTarget(userId);
    go("users");
  }

  if (!ready) return <div className="p-6 text-muted">Loading…</div>;
  if (user && !user.role) {
    return (
      <div className="mx-auto max-w-md p-8 text-center">
        <h1 className="text-xl font-bold text-brand-ink">Staff only</h1>
        <p className="mt-2 text-muted">This area is for support staff. You do not have access.</p>
        <Link href="/" className="mt-4 inline-block font-semibold text-brand">Back to the app</Link>
      </div>
    );
  }

  const nav = (
    <>
      {visible.map((s) => (
        <button key={s.id} onClick={() => go(s.id)}
          className={`block w-full whitespace-nowrap rounded-md px-3 py-2 text-left text-sm font-semibold transition-colors ${
            section === s.id ? "bg-brand text-white" : "text-brand hover:bg-brand-tint"
          }`}>
          {s.label}
        </button>
      ))}
    </>
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-5">
      <header className="sticky top-0 z-20 -mx-4 mb-5 flex items-center justify-between gap-3 border-b border-line bg-bg/95 px-4 py-3 backdrop-blur">
        {/* min-w-0 + break-all: a long staff email must wrap on a phone, not
            shove the Sign out button off the edge. */}
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-bold text-brand-ink">
            <LogoMark size={24} /> RoziPay — Staff
          </h1>
          <p className="break-all text-xs text-muted">
            Signed in as {user?.email} · role: <span className="font-semibold uppercase">{user?.role}</span>
          </p>
        </div>
        <div className="shrink-0"><LogoutButton /></div>
      </header>

      {/* Mobile: sections as a horizontal chip bar */}
      <nav className="mb-4 flex gap-1 overflow-x-auto pb-1 md:hidden">{nav}</nav>

      <div className="flex items-start gap-6">
        {/* Desktop: sticky sidebar */}
        <nav className="sticky top-20 hidden w-44 shrink-0 space-y-1 md:block">{nav}</nav>

        <main className="min-w-0 flex-1">
          {section === "dashboard" && isManager && (
            <Panel title="Dashboard">
              <section className="mb-8">
                <h2 className="mb-2 font-bold text-brand-ink">Dashboard</h2>
                <KpiDashboard />
              </section>
            </Panel>
          )}

          {section === "money" && (
            <>
              <Panel title="Withdrawals"><WithdrawalQueue onViewLedger={openLedger} /></Panel>
              {/* The treasury (hot) wallet: where payouts are sent from — admin only */}
              {isAdmin && <Panel title="Treasury wallet"><TreasuryPanel /></Panel>}
              {isAdmin && <Panel title="Withdrawal fee"><WithdrawalFeePanel /></Panel>}
              {/* What you owe users vs what you've paid — admin only */}
              {isAdmin && <Panel title="Money"><MoneyPanel /></Panel>}
            </>
          )}

          {section === "users" && (
            <>
              {/* Find, pay, suspend a user — admin only */}
              {isAdmin && <Panel title="Users"><UsersPanel /></Panel>}
              {/* ID review. Admin only, deliberately narrower than the rest of the
                  panel: nobody else needs to see a stranger's national ID card. */}
              {isAdmin && <Panel title="Verify IDs"><KycPanel /></Panel>}
              {/* Dispute lookup — all staff */}
              <Panel title="Look up a user"><UserLookup target={lookupTarget} /></Panel>
              {/* Fraud flags — managers/admins only */}
              {isManager && <Panel title="Fraud flags"><FraudPanel /></Panel>}
            </>
          )}

          {section === "tasks" && (
            <>
              {/* Our own custom tasks — admin only */}
              {isAdmin && <Panel title="Our own tasks"><TasksPanel /></Panel>}
              {/* Task proof review — all staff */}
              <Panel title="Task proofs"><ProofQueue /></Panel>
              {/* Ad-network config — admin only */}
              {isAdmin && <Panel title="Ad networks"><NetworkPanel /></Panel>}
            </>
          )}

          {section === "mining" && isAdmin && (
            <Panel title="Mining (ROZI)">
              <section className="mb-8">
                <h2 className="mb-2 font-bold text-brand-ink">Mining (ROZI)</h2>
                <MiningPanel />
              </section>
            </Panel>
          )}

          {section === "support" && <Panel title="Support tickets"><TicketQueue /></Panel>}

          {section === "team" && isAdmin && (
            <Panel title="Staff & roles"><StaffRolesPanel /></Panel>
          )}
        </main>
      </div>
    </div>
  );
}

// ---- Withdrawal queue -------------------------------------------------------
function WithdrawalQueue({ onViewLedger }: { onViewLedger: (userId: string) => void }) {
  const [status, setStatus] = useState("pending");
  const queue = useApi(() => fetchStaffQueue(status), [status]);
  // Treasury wallet for the chains in the queue — so whoever pays sends from
  // the right wallet. Set by an admin under Money & payouts → Treasury wallet.
  const treasury = queue.data?.treasury;

  async function act(id: string, action: "approve" | "reject" | "pay") {
    let note: string | undefined;
    let txHash: string | undefined;
    if (action === "reject") {
      const reason = window.prompt("Reason for rejecting (the user will see this):");
      if (reason === null) return; // cancelled
      note = reason;
    }
    if (action === "pay") {
      // v1 is manual: send the USDT from the treasury wallet, then paste the
      // on-chain transaction hash here so the user gets proof of payment.
      const hash = window.prompt("Paste the USDT transaction hash you sent (0x…). Send the payment first.");
      if (hash === null) return; // cancelled
      txHash = hash.trim();
    }
    try {
      await decideWithdrawal(id, action, note, txHash);
      queue.reload();
    } catch (e) {
      window.alert((e as Error).message);
    }
  }

  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-bold text-brand-ink">Withdrawals</h2>
        <div className="flex flex-wrap gap-1">
          {STATUSES.map((s) => (
            <button key={s} onClick={() => setStatus(s)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                status === s ? "bg-brand text-white" : "bg-brand-tint text-brand"
              }`}>
              {s.replace("_", " ")}
            </button>
          ))}
        </div>
      </div>

      {treasury && (treasury.bep20 || treasury.base || treasury.aptos) && (
        <p className="mb-2 rounded-lg border border-line bg-brand-tint/40 p-2 text-xs text-muted">
          Pay from the treasury wallet:{" "}
          {(["bep20", "base", "aptos"] as const).filter((c) => treasury[c]).map((c) => (
            <span key={c} className="me-2">
              <span className="font-semibold uppercase">{c}</span>{" "}
              <span className="num">{treasury[c].slice(0, 10)}…{treasury[c].slice(-6)}</span>
            </span>
          ))}
        </p>
      )}

      {queue.loading ? (
        <p className="p-4 text-sm text-muted">Loading…</p>
      ) : queue.error ? (
        <p className="p-4 text-sm text-danger">{queue.error}</p>
      ) : (queue.data?.requests.length ?? 0) === 0 ? (
        <p className="rounded-lg border border-line bg-card p-4 text-sm text-muted">
          No {status.replace("_", " ")} withdrawals.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-brand-tint text-left text-xs uppercase text-brand">
              <tr>
                <th className="p-2.5">User</th>
                <th className="p-2.5">Amount</th>
                <th className="p-2.5">Network</th>
                <th className="p-2.5">Send to (USDT address)</th>
                <th className="p-2.5">Requested</th>
                <th className="p-2.5">Action</th>
              </tr>
            </thead>
            <tbody>
              {queue.data!.requests.map((r: StaffWithdrawal) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="p-2.5">
                    <div className="font-medium text-brand-ink">{r.userEmail}</div>
                    <button onClick={() => onViewLedger(r.userId)} className="text-xs text-brand">view ledger</button>
                  </td>
                  <td className="p-2.5">
                    <div className="num font-semibold text-brand-ink">{formatPoints(r.amount)}</div>
                    <div className="text-xs text-muted">{formatMoney(r.amount)}</div>
                  </td>
                  <td className="p-2.5 uppercase">{r.chain}</td>
                  <td className="p-2.5">
                    {r.address ? (
                      <button onClick={() => navigator.clipboard?.writeText(r.address!)}
                        title="Click to copy" className="num break-all text-left text-xs text-brand hover:underline">
                        {r.address}
                      </button>
                    ) : <span className="text-xs text-muted">—</span>}
                  </td>
                  <td className="p-2.5 text-muted">{timeAgo(r.at)}</td>
                  <td className="p-2.5">
                    <Actions status={r.status} onAct={(a) => act(r.id, a)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Actions({ status, onAct }: { status: string; onAct: (a: "approve" | "reject" | "pay") => void }) {
  const ready = status === "agent_approved" || status === "manager_approved";
  if (status === "paid" || status === "rejected") return <span className="text-xs text-muted">—</span>;
  return (
    <div className="flex gap-1.5">
      {status === "pending" && (
        <button onClick={() => onAct("approve")} className="rounded-md bg-success px-2.5 py-1 text-xs font-semibold text-white">Approve</button>
      )}
      {ready && (
        <button onClick={() => onAct("pay")} className="rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white">Mark paid</button>
      )}
      <button onClick={() => onAct("reject")} className="rounded-md bg-danger px-2.5 py-1 text-xs font-semibold text-white">Reject</button>
    </div>
  );
}

function UserLookup({ target }: { target: string | null }) {
  const [id, setId] = useState("");
  const [query, setQuery] = useState("");
  const res = useApi(() => (query ? fetchStaffUser(query) : Promise.resolve(null)), [query]);

  // When a "view ledger" link elsewhere sets a target, search for it. This is
  // the "adjust state when a prop changes" case — the prop is the event.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (target) { setId(target); setQuery(target); }
  }, [target]);

  return (
    <section className="mb-8">
      <h2 className="mb-2 font-bold text-brand-ink">Look up a user (disputes)</h2>
      <div className="flex gap-2">
        <input value={id} onChange={(e) => setId(e.target.value)}
          placeholder="user id" className="flex-1 rounded-md border border-line bg-card p-2 text-sm outline-none" />
        <button onClick={() => setQuery(id)} className="rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white">Search</button>
      </div>

      {query && res.loading && <p className="mt-2 text-sm text-muted">Loading…</p>}
      {res.error && <p className="mt-2 text-sm text-danger">{res.error}</p>}
      {res.data && (
        <div className="mt-3 rounded-lg border border-line bg-card p-3 text-sm">
          <p className="font-semibold text-brand-ink">
            {String((res.data.user as Record<string, unknown>).email)} ·
            balance <span className="num">{formatPoints(Number((res.data.user as Record<string, unknown>).balancePoints))}</span> pts
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[420px] text-xs">
              <thead className="text-left text-muted"><tr><th className="p-1.5">Amount</th><th className="p-1.5">Source</th><th className="p-1.5">Note</th><th className="p-1.5">When</th></tr></thead>
              <tbody>
                {(res.data.ledger as Record<string, unknown>[]).map((l, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="num p-1.5">{Number(l.amount) >= 0 ? "+" : ""}{String(l.amount)}</td>
                    <td className="p-1.5">{String(l.source_type)}</td>
                    <td className="p-1.5 text-muted">{String(l.note ?? "")}</td>
                    <td className="p-1.5 text-muted">{timeAgo(String(l.created_at))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(res.data.fraudFlags as unknown[]).length > 0 && (
            <p className="mt-2 rounded bg-danger-tint p-2 text-xs text-danger">
              {(res.data.fraudFlags as unknown[]).length} fraud flag(s) on this user.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function FraudPanel() {
  const fraud = useApi(fetchFraud, []);
  return (
    <section>
      <h2 className="mb-2 font-bold text-brand-ink">Open fraud flags</h2>
      {fraud.loading ? <p className="text-sm text-muted">Loading…</p>
        : fraud.error ? <p className="text-sm text-danger">{fraud.error}</p>
        : (fraud.data?.flags.length ?? 0) === 0 ? (
          <p className="rounded-lg border border-line bg-card p-4 text-sm text-muted">No open flags. Good.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-brand-tint text-left text-xs uppercase text-brand">
                <tr><th className="p-2.5">User</th><th className="p-2.5">Type</th><th className="p-2.5">Severity</th><th className="p-2.5">Detail</th><th className="p-2.5">When</th><th className="p-2.5">Action</th></tr>
              </thead>
              <tbody>
                {fraud.data!.flags.map((f, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="p-2.5">{String(f.user_email ?? f.user_id ?? "—")}</td>
                    <td className="p-2.5">{String(f.flag_type)}</td>
                    <td className="p-2.5">{String(f.severity)}</td>
                    <td className="p-2.5 text-muted">{String(f.detail ?? "")}</td>
                    <td className="p-2.5 text-muted">{timeAgo(String(f.created_at))}</td>
                    <td className="p-2.5"><ResolveFlagButton id={String(f.id)} onResolved={fraud.reload} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
