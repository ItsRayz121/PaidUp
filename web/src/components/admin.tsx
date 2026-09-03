"use client";

// Super-admin panels. `admin` was always the top role, but it had no tools:
// no way to find a user, pay one, suspend one, or appoint staff. These add them.
// Internal tool — density over friendliness, jargon allowed (DESIGN_BRIEF).
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import {
  searchUsers, setUserStatus, bulkSetUserStatus, setUserReview, adjustUserPoints,
  fetchStaffMembers, setStaffRole, downloadExport,
  fetchTelegramNamePending, refreshTelegramNames,
  type AdminUserRow, type StaffRole,
} from "@/lib/api";
import { formatUsdtMicro, timeAgo } from "@/lib/format";
import { useStaffNav } from "@/lib/staffNav";
import { useTableQuery } from "@/lib/staffTable";
import { COUNTRY_OPTIONS } from "@/lib/countries";
import { DataTable, type Column } from "@/components/staff/DataTable";
import { StatusBadge, TimeCell, Points } from "@/components/staff/primitives";
import { useToast } from "@/components/staff/toast";

// ---- Users list — on the shared DataTable (admin rebuild, Phase A) --------
// Search / pagination / row count / CSV / bulk-suspend all come from the one
// component now. Server-side sort and column filters land in Phase B when
// GET /staff/users grows the params; the columns are marked non-sortable
// until then rather than faking a client-side sort of one page.
export function UsersPanel() {
  // Default to a short page (founder, 2026-09-01: "show five or six, then let
  // me click for more" — the pager IS the "see more"). Staff can raise it.
  const q = useTableQuery("users", { pageSize: 10, sort: "created_at", dir: "desc" });
  const users = useApi(
    () => searchUsers({
      q: q.search, limit: q.pageSize, offset: q.offset,
      sort: q.sort ?? undefined, dir: q.dir,
      status: q.filters.status, kyc: q.filters.kyc, country: q.filters.country || undefined,
      flagged: q.filters.flagged === "1", held: q.filters.held === "1", review: q.filters.review === "1",
    }),
    [q.search, q.pageSize, q.offset, q.sort, q.dir, JSON.stringify(q.filters)],
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
      key: "email", header: "Email", sortable: true, csv: (u) => u.email,
      render: (u) => (
        <div className="min-w-0">
          <span className="block truncate font-semibold text-brand-ink">{u.email}</span>
          <span className="block truncate text-xs text-muted">{u.id}</span>
        </div>
      ),
    },
    { key: "balance", header: "Balance", align: "right", sortable: true, csv: (u) => u.balance, render: (u) => <Points value={u.balance} /> },
    {
      // Real deposited USDT (usdt_ledger), not points/ROZI converted to a
      // USDT-equivalent — that read as money sitting somewhere when none was.
      key: "usdt", header: "USDT deposited", align: "right", sortable: true,
      csv: (u) => formatUsdtMicro(u.usdtMicro), render: (u) => <span className="text-muted">{formatUsdtMicro(u.usdtMicro)}</span>,
    },
    {
      key: "status", header: "Status", sortable: true, csv: (u) => u.status,
      render: (u) => (
        <div className="flex flex-wrap items-center gap-1">
          <StatusBadge status={u.status === "active" ? "active" : "suspended"} />
          {u.openFlags > 0 && <span className="rounded bg-pending-tint px-1.5 py-0.5 text-[11px] font-semibold text-pending">suspect ({u.openFlags})</span>}
          {u.held && <span className="rounded bg-pending-tint px-1.5 py-0.5 text-[11px] font-semibold text-pending">payouts held</span>}
          {u.underReview && <span className="rounded bg-brand-tint px-1.5 py-0.5 text-[11px] font-semibold text-brand">under review</span>}
        </div>
      ),
    },
    { key: "created_at", header: "Joined", sortable: true, csv: (u) => u.created_at, render: (u) => <TimeCell iso={u.created_at} /> },
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
        filters={[
          { key: "status", label: "Status", type: "select", options: [
            { value: "active", label: "active" }, { value: "suspended", label: "suspended" },
          ] },
          { key: "kyc", label: "ID", type: "select", options: [
            { value: "none", label: "none" }, { value: "pending", label: "pending" },
            { value: "approved", label: "approved" }, { value: "rejected", label: "rejected" },
          ] },
          { key: "flagged", label: "Fraud flags", type: "select", options: [{ value: "1", label: "has open" }] },
          { key: "held", label: "Payouts held", type: "select", options: [{ value: "1", label: "yes" }] },
          { key: "review", label: "Under review", type: "select", options: [{ value: "1", label: "yes" }] },
          { key: "country", label: "Country", type: "select",
            options: COUNTRY_OPTIONS.map((c) => ({ value: c, label: c })) },
        ]}
        toolbarRight={
          <div className="flex items-center gap-1.5">
            <TelegramNamesButton onDone={users.reload} />
            <button onClick={exportAll} className="rounded-md bg-brand-tint px-2.5 py-1.5 text-xs font-semibold text-brand">
              Export {q.search ? "matching" : "all"} (CSV)
            </button>
          </div>
        }
        bulkActions={[
          { label: "Suspend selected", tone: "danger", run: (ids) => bulkStatus(ids, "suspended") },
          { label: "Restore selected", run: (ids) => bulkStatus(ids, "active") },
        ]}
      />
    </section>
  );
}

// Fill in missing Telegram usernames (founder, 2026-09-03: "instead of
// Telegram user, show his username"). Two populations never had one written —
// accounts that connected Telegram from the website, and accounts older than
// the columns — and no login will fix an account that is not logging in now.
// This asks the Bot API, in capped batches, only when a human presses it.
//
// It disappears when there is nothing left to do: a button that always reads
// "0 to fix" is furniture.
function TelegramNamesButton({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const p = useApi(fetchTelegramNamePending, []);
  const [busy, setBusy] = useState(false);
  const pending = p.data?.pending ?? 0;
  if (pending === 0) return null;

  async function run() {
    setBusy(true);
    try {
      const r = await refreshTelegramNames();
      toast.ok(
        r.updated > 0
          ? `Filled in ${r.updated} name(s).${r.pending > 0 ? ` ${r.pending} still to go — press again.` : ""}`
          : "Telegram had no name on file for those accounts.",
      );
      p.reload(); onDone();
    } catch (e) { toast.err((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <button onClick={run} disabled={busy}
      title="Ask Telegram for the usernames of accounts that show as 'Telegram #…'"
      className="rounded-md bg-brand-tint px-2.5 py-1.5 text-xs font-semibold text-brand disabled:opacity-50">
      {busy ? "Checking…" : `Refresh Telegram names (${pending})`}
    </button>
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
        <details className="mb-3 rounded-lg border-2 border-line-strong bg-card p-3">
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
          <div className="overflow-x-auto rounded-lg border-2 border-line-strong">
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

// The old MoneyPanel ("Owed vs paid" tiles + a "Recent staff actions" table)
// was retired 2026-09-01: its tiles moved into the new Money → Overview
// (components/staff/MoneyOverview.tsx), and the founder asked for the staff-
// actions table to live ONLY in the Audit log, not be repeated here.
