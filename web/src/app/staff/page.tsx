"use client";

import { useEffect, useState } from "react";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { LogoutButton } from "@/components/state";
import {
  fetchStaffQueue, decideWithdrawal, fetchFraud, fetchStaffUser,
  type StaffWithdrawal,
} from "@/lib/api";
import { formatPoints, formatMoney, timeAgo } from "@/lib/format";

// Internal tool: information density + speed over friendliness (DESIGN_BRIEF).
// Jargon (postback, fraud, ledger) is allowed here — never in the earner app.
const STATUSES = ["pending", "agent_approved", "manager_approved", "paid", "rejected"];

export default function StaffPage() {
  const { user, ready } = useRequireAuth();
  const [status, setStatus] = useState("pending");
  const [lookupTarget, setLookupTarget] = useState<string | null>(null);
  const queue = useApi(() => fetchStaffQueue(status), [status]);
  const isManager = user?.role === "manager" || user?.role === "admin";

  if (!ready) return <div className="p-6 text-muted">Loading…</div>;
  if (user && !user.role) {
    return (
      <div className="mx-auto max-w-md p-8 text-center">
        <h1 className="text-xl font-bold text-brand-ink">Staff only</h1>
        <p className="mt-2 text-muted">This area is for support staff. You do not have access.</p>
        <a href="/" className="mt-4 inline-block font-semibold text-brand">Back to the app</a>
      </div>
    );
  }

  async function act(id: string, action: "approve" | "reject" | "pay") {
    let note: string | undefined;
    if (action === "reject") {
      const reason = window.prompt("Reason for rejecting (the user will see this):");
      if (reason === null) return; // cancelled
      note = reason;
    }
    try {
      await decideWithdrawal(id, action, note);
      queue.reload();
    } catch (e) {
      window.alert((e as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-5">
      <header className="mb-5 flex items-center justify-between border-b border-line pb-3">
        <div>
          <h1 className="text-lg font-bold text-brand-ink">PaidUp — Staff</h1>
          <p className="text-xs text-muted">
            Signed in as {user?.email} · role: <span className="font-semibold uppercase">{user?.role}</span>
          </p>
        </div>
        <LogoutButton />
      </header>

      {/* Withdrawal queue */}
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
                      <button onClick={() => setLookupTarget(r.userId)} className="text-xs text-brand">view ledger</button>
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

      {/* Dispute lookup */}
      <UserLookup target={lookupTarget} />

      {/* Fraud flags — managers/admins only */}
      {isManager && <FraudPanel />}
    </div>
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

  // When a "view ledger" link elsewhere sets a target, search for it.
  useEffect(() => {
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
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-brand-tint text-left text-xs uppercase text-brand">
                <tr><th className="p-2.5">User</th><th className="p-2.5">Type</th><th className="p-2.5">Severity</th><th className="p-2.5">Detail</th><th className="p-2.5">When</th></tr>
              </thead>
              <tbody>
                {fraud.data!.flags.map((f, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="p-2.5">{String(f.user_email ?? f.user_id ?? "—")}</td>
                    <td className="p-2.5">{String(f.flag_type)}</td>
                    <td className="p-2.5">{String(f.severity)}</td>
                    <td className="p-2.5 text-muted">{String(f.detail ?? "")}</td>
                    <td className="p-2.5 text-muted">{timeAgo(String(f.created_at))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
