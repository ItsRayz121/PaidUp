"use client";

// Super-admin panels. `admin` was always the top role, but it had no tools:
// no way to find a user, pay one, suspend one, or appoint staff. These add them.
// Internal tool — density over friendliness, jargon allowed (DESIGN_BRIEF).
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import {
  searchUsers, setUserStatus, bulkSetUserStatus, setUserReview, adjustUserPoints,
  fetchStaffMembers, setStaffRole,
  fetchMoney, downloadExport,
  type AdminUserRow, type StaffRole,
} from "@/lib/api";
import { formatPoints, formatMoney, formatUsdtAmount, timeAgo } from "@/lib/format";
import { useStaffNav } from "@/lib/staffNav";
import { useTableQuery } from "@/lib/staffTable";
import { DataTable, type Column } from "@/components/staff/DataTable";
import { StatusBadge, TimeCell, Points } from "@/components/staff/primitives";
import { useToast } from "@/components/staff/toast";

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="num text-lg font-bold text-brand-ink">{value}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  );
}

// ---- Users list — on the shared DataTable (admin rebuild, Phase A) --------
// Search / pagination / row count / CSV / bulk-suspend all come from the one
// component now. Server-side sort and column filters land in Phase B when
// GET /staff/users grows the params; the columns are marked non-sortable
// until then rather than faking a client-side sort of one page.
export function UsersPanel() {
  const q = useTableQuery("users", { pageSize: 25 });
  const users = useApi(
    () => searchUsers(q.search, q.pageSize, q.offset),
    [q.search, q.pageSize, q.offset],
  );
  const toast = useToast();
  const { openUser } = useStaffNav();
  const rows = users.data?.users ?? [];

  // N separate decisions, not one (see bulkSetUserStatus's comment in api.ts) —
  // a partial failure (a row already in that state, the actor's own id in the
  // selection) is reported, never swallowed into one ok/fail.
  async function bulkStatus(ids: string[], status: "active" | "suspended") {
    const reason = window.prompt(
      status === "suspended"
        ? `Why are you suspending ${ids.length} account(s)? They are locked out immediately.`
        : `Why are you restoring ${ids.length} account(s)?`,
    );
    if (!reason?.trim()) return;
    try {
      const r = await bulkSetUserStatus(ids, status, reason.trim());
      if (r.failed === 0) toast.ok(`${r.done} account(s) updated.`);
      else toast.err(`${r.done} updated, ${r.failed} failed — ${r.results.filter((x) => !x.ok).map((x) => x.error).join("; ")}`);
      users.reload();
    } catch (e) { toast.err((e as Error).message); }
  }

  async function exportAll() {
    try { await downloadExport("users", q.search); toast.ok("Export started."); }
    catch (e) { toast.err((e as Error).message); }
  }

  const columns: Column<AdminUserRow>[] = [
    {
      key: "email", header: "Email", csv: (u) => u.email,
      render: (u) => (
        <div className="min-w-0">
          <span className="block truncate font-semibold text-brand-ink">{u.email}</span>
          <span className="block truncate text-xs text-muted">{u.id}</span>
        </div>
      ),
    },
    { key: "balance", header: "Balance", align: "right", csv: (u) => u.balance, render: (u) => <Points value={u.balance} /> },
    { key: "value", header: "Value", align: "right", csv: (u) => formatMoney(u.balance), render: (u) => <span className="text-muted">{formatMoney(u.balance)}</span> },
    {
      key: "status", header: "Status", csv: (u) => u.status,
      render: (u) => (
        <div className="flex flex-wrap items-center gap-1">
          <StatusBadge status={u.status === "active" ? "active" : "suspended"} />
          {u.openFlags > 0 && <span className="rounded bg-pending-tint px-1.5 py-0.5 text-[11px] font-semibold text-pending">suspect ({u.openFlags})</span>}
          {u.held && <span className="rounded bg-pending-tint px-1.5 py-0.5 text-[11px] font-semibold text-pending">payouts held</span>}
          {u.underReview && <span className="rounded bg-brand-tint px-1.5 py-0.5 text-[11px] font-semibold text-brand">under review</span>}
        </div>
      ),
    },
    { key: "created_at", header: "Joined", csv: (u) => u.created_at, render: (u) => <TimeCell iso={u.created_at} /> },
    {
      key: "actions", header: "", render: (u) => (
        <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => openUser(u.id)} className="rounded-md bg-brand-tint px-2.5 py-1 text-xs font-semibold text-brand">Open</button>
          <UserQuickActions u={u} reload={users.reload} />
        </div>
      ),
    },
  ];

  return (
    <section className="mb-8">
      <h2 className="mb-2 font-bold text-brand-ink">Users</h2>
      <DataTable<AdminUserRow>
        q={q}
        columns={columns}
        rows={rows}
        total={users.data?.total ?? 0}
        loading={users.loading}
        error={users.error}
        onRetry={users.reload}
        getRowId={(u) => u.id}
        onRowClick={(u) => openUser(u.id)}
        searchPlaceholder="Search email or user id — blank shows the newest"
        emptyTitle="No users found"
        toolbarRight={
          <button onClick={exportAll} className="rounded-md bg-brand-tint px-2.5 py-1.5 text-xs font-semibold text-brand">
            Export {q.search ? "matching" : "all"} (CSV)
          </button>
        }
        bulkActions={[
          { label: "Suspend selected", tone: "danger", run: (ids) => bulkStatus(ids, "suspended") },
          { label: "Restore selected", run: (ids) => bulkStatus(ids, "active") },
        ]}
      />
    </section>
  );
}

// Per-row quick actions — adjust points, suspend/restore, mark for review.
// The full set (with a proper typed confirmation) moves to the User detail
// Danger zone in Phase B; kept here so nothing regresses in the meantime.
function UserQuickActions({ u, reload }: { u: AdminUserRow; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const suspended = u.status !== "active";

  async function run(fn: () => Promise<unknown>, okMsg: string) {
    setBusy(true);
    try { await fn(); toast.ok(okMsg); reload(); }
    catch (e) { toast.err((e as Error).message); }
    finally { setBusy(false); }
  }

  function toggleStatus() {
    const next = suspended ? "active" : "suspended";
    const reason = window.prompt(next === "suspended"
      ? "Why are you suspending this account? They are locked out immediately."
      : "Why are you restoring this account?");
    if (!reason?.trim()) return;
    run(() => setUserStatus(u.id, next, reason.trim()), `Account ${next === "suspended" ? "suspended" : "restored"}.`);
  }

  function adjust() {
    const raw = window.prompt("Adjust points. Positive adds, negative removes (e.g. 500 or -500).\nA credit is real money the user can withdraw. Logged against you.");
    if (raw === null) return;
    const points = Number(raw.trim());
    if (!Number.isInteger(points) || points === 0) { toast.err("Enter a whole number that is not zero."); return; }
    const reason = window.prompt("Reason (the user sees this in their wallet):");
    if (!reason?.trim()) return;
    run(async () => { const r = await adjustUserPoints(u.id, points, reason.trim()); toast.ok(`Balance ${r.before} → ${r.after} points.`); }, "");
  }

  function toggleReview() {
    if (u.underReview) {
      if (!window.confirm("Clear the review mark on this account?")) return;
      run(() => setUserReview(u.id, null), "Review mark cleared.");
      return;
    }
    const reason = window.prompt("Why are you marking this account for review?");
    if (!reason?.trim()) return;
    run(() => setUserReview(u.id, reason.trim()), "Marked for review.");
  }

  return (
    <>
      <button disabled={busy} onClick={adjust} className="rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">Adjust</button>
      <button disabled={busy} onClick={toggleStatus}
        className={`rounded-md px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50 ${suspended ? "bg-success" : "bg-danger"}`}>
        {suspended ? "Restore" : "Suspend"}
      </button>
      <button disabled={busy} onClick={toggleReview} className="rounded-md bg-brand-tint px-2.5 py-1 text-xs font-semibold text-brand disabled:opacity-50">
        {u.underReview ? "Clear review" : "Review"}
      </button>
    </>
  );
}

// ---- Staff roles ---------------------------------------------------------
// The role list is NOT a constant here — it comes from GET /staff/staff, which
// builds it from the API's permissions.ts. A hardcoded list drifts the moment a
// role is added, and drifts in the worst direction: the picker offers a role the
// API then refuses, or hides one that exists. "none" is the only entry the
// server does not send, because it is not a role — it is removal.
type RoleOpt = StaffRole | "none";

export function StaffRolesPanel() {
  const staff = useApi(fetchStaffMembers, []);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffRole>("support");
  const [busy, setBusy] = useState(false);
  const roles = staff.data?.roles ?? [];

  // The API keys on user id, so appointing by email means resolving it first.
  async function appoint(e: React.FormEvent) {
    e.preventDefault();
    const q = email.trim();
    if (!q) return;
    setBusy(true);
    try {
      const found = await searchUsers(q);
      const match = found.users.find((u) => u.email.toLowerCase() === q.toLowerCase());
      if (!match) { window.alert("No user with that email. They must sign up first."); return; }
      await setStaffRole(match.id, role);
      setEmail("");
      staff.reload();
    } catch (err) { window.alert((err as Error).message); }
    finally { setBusy(false); }
  }

  async function change(userId: string, next: RoleOpt) {
    if (next === "none" && !window.confirm("Remove this person's staff access?")) return;
    try { await setStaffRole(userId, next); staff.reload(); }
    catch (e) { window.alert((e as Error).message); }
  }

  return (
    <section className="mb-8">
      <h2 className="mb-2 font-bold text-brand-ink">Staff &amp; roles</h2>
      <p className="mb-2 text-xs text-muted">
        Give people the narrowest role that lets them do their job. The last account
        that can appoint staff cannot be demoted or removed.
      </p>

      <form onSubmit={appoint} className="mb-2 flex flex-wrap gap-2">
        <input value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="email of an existing user"
          className="flex-1 rounded-md border border-line bg-card p-2 text-sm outline-none" />
        <select value={role} onChange={(e) => setRole(e.target.value as StaffRole)}
          className="rounded-md border border-line bg-card p-2 text-sm">
          {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <button disabled={busy}
          className="rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          Appoint
        </button>
      </form>

      {/* What each role can actually do, from the server's own permission map.
          Without this the picker is nine words with no meaning, and whoever is
          appointing has to guess — which is how everyone ends up an admin. */}
      {roles.length > 0 && (
        <details className="mb-3 rounded-lg border border-line bg-card p-3">
          <summary className="cursor-pointer text-sm font-semibold text-brand">
            What can each role do?
          </summary>
          <div className="mt-2 space-y-2">
            {roles.map((r) => (
              <div key={r.id}>
                <p className="text-sm font-semibold text-brand-ink">{r.label}</p>
                <p className="text-xs text-muted">
                  {r.permissions.length === 0 ? "nothing" : r.permissions.join(" · ")}
                </p>
              </div>
            ))}
          </div>
        </details>
      )}

      {staff.loading ? <p className="text-sm text-muted">Loading…</p>
        : staff.error ? <p className="text-sm text-danger">{staff.error}</p> : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-brand-tint text-left text-xs uppercase text-brand">
                <tr><th className="p-2.5">Email</th><th className="p-2.5">Role</th><th className="p-2.5">Since</th><th className="p-2.5">Change</th></tr>
              </thead>
              <tbody>
                {(staff.data?.staff ?? []).map((s) => (
                  <tr key={s.userId} className="border-t border-line">
                    <td className="p-2.5 font-semibold text-brand-ink">{s.email}</td>
                    <td className="p-2.5">{s.roleLabel ?? s.role}</td>
                    <td className="p-2.5 text-muted">{timeAgo(s.at)}</td>
                    <td className="p-2.5">
                      <select value={s.role} onChange={(e) => change(s.userId, e.target.value as RoleOpt)}
                        className="rounded-md border border-line bg-card p-1 text-xs">
                        {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                        <option value="none">remove access</option>
                      </select>
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

// ---- Money view + export -------------------------------------------------
export function MoneyPanel() {
  const money = useApi(() => fetchMoney(10), []);
  const { goToSection } = useStaffNav();

  async function exportCsv(what: "ledger" | "withdrawals" | "audit") {
    try { await downloadExport(what); }
    catch (e) { window.alert((e as Error).message); }
  }

  if (money.loading) return <p className="mb-8 text-sm text-muted">Loading money…</p>;
  if (money.error) return <p className="mb-8 text-sm text-danger">{money.error}</p>;
  const m = money.data!;

  return (
    <section className="mb-8">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-brand-ink">Money</h2>
        <div className="flex gap-1.5">
          {(["ledger", "withdrawals", "audit"] as const).map((w) => (
            <button key={w} onClick={() => exportCsv(w)}
              className="rounded-md bg-brand-tint px-2.5 py-1 text-xs font-semibold text-brand">
              Export {w}.csv
            </button>
          ))}
        </div>
      </div>

      {/* "Owed to users" is the number that matters: points people still hold and
          can cash out. If it ever exceeds the treasury, you cannot pay everyone. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Owed to users (live)" value={formatPoints(m.points.outstanding)} sub={formatUsdtAmount(m.usdt.outstanding)} />
        <Tile label="Paid out (all time)" value={formatPoints(m.points.paidPoints)} sub={formatUsdtAmount(m.usdt.paid)} />
        <Tile label="Awaiting payout" value={formatPoints(m.points.pendingPoints)} sub={formatUsdtAmount(m.usdt.pending)} />
        <Tile label="Fees kept" value={formatPoints(m.points.feePoints)} sub="from withdrawals" />
      </div>
      <p className="mt-2 text-xs text-muted">
        Points created by hand (admin adjustments):{" "}
        <span className="num font-semibold">{formatPoints(m.points.adjustments)}</span>. These were
        not earned from a network — they come straight off your margin.
      </p>

      <div className="mb-1.5 mt-4 flex items-center justify-between">
        <h3 className="font-semibold text-brand-ink">Recent staff actions</h3>
        {/* The full, paginated log lives in the Audit section — this is a
            glance, not the log (founder, 2026-08-27). */}
        {m.auditTotal > m.recentAudit.length && (
          <button onClick={() => goToSection("audit")} className="text-xs font-semibold text-brand hover:underline">
            See more ({m.auditTotal} total)
          </button>
        )}
      </div>
      {m.recentAudit.length === 0 ? (
        <p className="rounded-lg border border-line bg-card p-3 text-sm text-muted">Nothing yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[620px] text-xs">
            <thead className="bg-brand-tint text-left uppercase text-brand">
              <tr><th className="p-2">When</th><th className="p-2">Who</th><th className="p-2">Action</th><th className="p-2">Target</th><th className="p-2">Detail</th></tr>
            </thead>
            <tbody>
              {m.recentAudit.map((a, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="p-2 text-muted">{timeAgo(String(a.created_at))}</td>
                  <td className="p-2">{String(a.actor_email)}</td>
                  <td className="p-2 font-semibold text-brand-ink">{String(a.action)}</td>
                  <td className="p-2">{String(a.target_email ?? "—")}</td>
                  <td className="p-2 text-muted">{String(a.detail ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
