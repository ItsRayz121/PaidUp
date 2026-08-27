"use client";

// Super-admin panels. `admin` was always the top role, but it had no tools:
// no way to find a user, pay one, suspend one, or appoint staff. These add them.
// Internal tool — density over friendliness, jargon allowed (DESIGN_BRIEF).
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import {
  searchUsers, setUserStatus, bulkSetUserStatus, setUserReview, adjustUserPoints,
  fetchStaffMembers, setStaffRole,
  fetchMoney, downloadExport, fetchStaffUser,
  type AdminUserRow, type StaffRole,
} from "@/lib/api";
import { formatPoints, formatMoney, formatUsdtAmount, timeAgo } from "@/lib/format";
import { useStaffNav } from "@/lib/staffNav";

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="num text-lg font-bold text-brand-ink">{value}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  );
}

// ---- Users: search, suspend, adjust points -------------------------------
// ⚠️ SHOWS 10 AT A TIME, "SEE MORE" GROWS THE PAGE (founder, 2026-08-27):
// this used to hand back up to 200 rows on load. `limit` grows by 10 on each
// click rather than a real offset-paged view, which keeps rows already on
// screen in place (no "page 2 replaced page 1" disorientation) at the cost of
// re-fetching the whole visible set each time — fine at this row count.
// ---- Bulk selection + actions (founder, 2026-08-27) ------------------------
// Suspend/export used to be one row at a time — fine for a dispute lookup, not
// for a farm sweep of twenty accounts found by the same fraud rule. Selection
// is scoped to whatever page is currently loaded (the same rows the "See
// more" button grows), so a bulk action never reaches past what the staff
// member can actually see and review before clicking it.
export function UsersPanel() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(10);
  const users = useApi(() => searchUsers(query, limit, 0), [query, limit]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const rows = users.data?.users ?? [];

  function search(next: string) {
    setQuery(next);
    setLimit(10); // a new search starts from a short first page again
    setSelected(new Set());
  }

  const allSelected = rows.length > 0 && rows.every((u) => selected.has(u.id));
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((u) => u.id)));
  }
  function toggleOne(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // N separate decisions, not one (see bulkSetUserStatus's comment in api.ts) —
  // a partial failure (a row already in that state, the actor's own id caught
  // in the selection) is reported, never silently swallowed into one ok/fail.
  async function bulkChangeStatus(status: "active" | "suspended") {
    const ids = [...selected];
    if (ids.length === 0) return;
    const reason = window.prompt(
      status === "suspended"
        ? `Why are you suspending ${ids.length} account(s)? They are locked out immediately.`
        : `Why are you restoring ${ids.length} account(s)?`,
    );
    if (!reason?.trim()) return;
    setBulkBusy(true);
    try {
      const r = await bulkSetUserStatus(ids, status, reason.trim());
      const failedRows = r.results.filter((x) => !x.ok);
      window.alert(
        r.failed === 0
          ? `${r.done} account(s) updated.`
          : `${r.done} updated, ${r.failed} failed:\n\n${failedRows.map((x) => `${x.id}: ${x.error}`).join("\n")}`,
      );
      setSelected(new Set());
      users.reload();
    } catch (e) { window.alert((e as Error).message); }
    finally { setBulkBusy(false); }
  }

  async function exportCsv() {
    try { await downloadExport("users", query); }
    catch (e) { window.alert((e as Error).message); }
  }

  return (
    <section className="mb-8">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-brand-ink">Users</h2>
        <button onClick={exportCsv}
          className="rounded-md bg-brand-tint px-2.5 py-1 text-xs font-semibold text-brand">
          Export {query ? "matching" : "all"} to CSV
        </button>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); search(q.trim()); }} className="mb-2 flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search email or user id — blank shows the newest"
          className="flex-1 rounded-md border border-line bg-card p-2 text-sm outline-none"
        />
        <button className="rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white">Search</button>
      </form>

      {selected.size > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-brand/30 bg-brand-tint/40 p-2">
          <span className="text-xs font-semibold text-brand-ink">{selected.size} selected</span>
          <button disabled={bulkBusy} onClick={() => bulkChangeStatus("suspended")}
            className="rounded-md bg-danger px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
            Suspend selected
          </button>
          <button disabled={bulkBusy} onClick={() => bulkChangeStatus("active")}
            className="rounded-md bg-success px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
            Restore selected
          </button>
          <button disabled={bulkBusy} onClick={() => setSelected(new Set())}
            className="rounded-md bg-card px-2.5 py-1 text-xs font-semibold text-muted disabled:opacity-50">
            Clear
          </button>
        </div>
      )}

      {users.loading ? <p className="text-sm text-muted">Loading…</p>
        : users.error ? <p className="text-sm text-danger">{users.error}</p>
        : rows.length === 0 ? (
          <p className="rounded-lg border border-line bg-card p-4 text-sm text-muted">No users found.</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full min-w-[800px] text-sm">
                <thead className="bg-brand-tint text-left text-xs uppercase text-brand">
                  <tr>
                    <th className="w-8 p-2.5"><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                    <th className="p-2.5">Email</th><th className="p-2.5">Balance</th>
                    <th className="p-2.5">Value</th><th className="p-2.5">Status</th>
                    <th className="p-2.5">Joined</th><th className="p-2.5">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <UserRow key={u.id} u={u} onChanged={users.reload}
                      selected={selected.has(u.id)} onToggleSelect={() => toggleOne(u.id)} />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-muted">
              Showing {rows.length} of {users.data!.total}
              {rows.length < users.data!.total && (
                <button onClick={() => setLimit((l) => l + 10)}
                  className="ms-2 font-semibold text-brand hover:underline">See more</button>
              )}
            </p>
          </>
        )}
    </section>
  );
}

function UserRow(
  { u, onChanged, selected, onToggleSelect }:
  { u: AdminUserRow; onChanged: () => void; selected: boolean; onToggleSelect: () => void },
) {
  const [busy, setBusy] = useState(false);
  const { openUser } = useStaffNav();
  const suspended = u.status !== "active";

  async function toggleStatus() {
    const next = suspended ? "active" : "suspended";
    const reason = window.prompt(
      next === "suspended"
        ? "Why are you suspending this account? They are locked out immediately."
        : "Why are you restoring this account?",
    );
    if (!reason?.trim()) return;
    setBusy(true);
    try { await setUserStatus(u.id, next, reason.trim()); onChanged(); }
    catch (e) { window.alert((e as Error).message); }
    finally { setBusy(false); }
  }

  async function adjust() {
    const raw = window.prompt(
      "Adjust points. Positive adds, negative removes (e.g. 500 or -500).\n" +
      "A credit is real money the user can withdraw. This is logged against you.",
    );
    if (raw === null) return;
    const points = Number(raw.trim());
    if (!Number.isInteger(points) || points === 0) {
      window.alert("Enter a whole number that is not zero.");
      return;
    }
    const reason = window.prompt("Reason (the user sees this in their wallet):");
    if (!reason?.trim()) return;
    setBusy(true);
    try {
      const r = await adjustUserPoints(u.id, points, reason.trim());
      window.alert(`Done. Balance ${r.before} → ${r.after} points.`);
      onChanged();
    } catch (e) { window.alert((e as Error).message); }
    finally { setBusy(false); }
  }

  // "Flagged" / "payouts held" / "under review" don't carry their reason on
  // this row — the list endpoint deliberately doesn't fetch per-row detail
  // (that's an N+1 query for a list of 10-200). Clicking any of them jumps to
  // the full user detail screen, which has the real text for all three.
  async function showReason(kind: "flag" | "hold" | "review") {
    setBusy(true);
    try {
      const d = await fetchStaffUser(u.id);
      if (kind === "hold") {
        window.alert(
          d.user.withdrawal_hold_reason
            ? `Payouts held: ${String(d.user.withdrawal_hold_reason)}`
            : "No hold reason on file.",
        );
      } else if (kind === "review") {
        window.alert(
          d.user.under_review_reason
            ? `Under review: ${String(d.user.under_review_reason)}`
            : "No review reason on file.",
        );
      } else {
        const open = d.fraudFlags.filter((f) => !f.resolution_note);
        window.alert(
          open.length
            ? open.map((f) => `${String(f.flag_type)} (${String(f.severity)}): ${String(f.detail ?? "no detail")}`).join("\n\n")
            : "No open flags.",
        );
      }
    } catch (e) { window.alert((e as Error).message); }
    finally { setBusy(false); openUser(u.id); }
  }

  // The "suspect (N)" badge above is a live COUNT of open fraud flags and
  // clears itself the moment those flags resolve — it cannot say "we are
  // looking into this" across a multi-day investigation. This is the real,
  // staff-SET version of that: a person turns it on and off deliberately.
  async function toggleReview() {
    if (u.underReview) {
      if (!window.confirm("Clear the review mark on this account?")) return;
      setBusy(true);
      try { await setUserReview(u.id, null); onChanged(); }
      catch (e) { window.alert((e as Error).message); }
      finally { setBusy(false); }
      return;
    }
    const reason = window.prompt("Why are you marking this account for review?");
    if (!reason?.trim()) return;
    setBusy(true);
    try { await setUserReview(u.id, reason.trim()); onChanged(); }
    catch (e) { window.alert((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <tr className={`border-t border-line ${suspended ? "bg-danger-tint/40" : ""}`}>
      <td className="p-2.5"><input type="checkbox" checked={selected} onChange={onToggleSelect} /></td>
      <td className="p-2.5">
        <span className="font-semibold text-brand-ink">{u.email}</span>
        <span className="block text-xs text-muted">{u.id}</span>
      </td>
      <td className="num p-2.5">{formatPoints(u.balance)}</td>
      <td className="p-2.5 text-muted">{formatMoney(u.balance)}</td>
      <td className="p-2.5">
        <div className="flex flex-wrap items-center gap-1">
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
            suspended ? "bg-danger text-white" : "bg-success-tint text-success"
          }`}>{suspended ? "banned" : "active"}</span>
          {/* Open fraud flags on an otherwise active account — the "suspect"
              state the founder asked for. Not a real status column: nothing
              stops them earning, it's a signal, same as everywhere else fraud
              flags appear in this panel (guardrail: flag-only, never a block
              unless a real block is applied). */}
          {u.openFlags > 0 && (
            <button disabled={busy} onClick={() => showReason("flag")}
              className="rounded-full bg-pending-tint px-2 py-0.5 text-xs font-semibold text-pending hover:underline">
              suspect ({u.openFlags})
            </button>
          )}
          {u.held && (
            <button disabled={busy} onClick={() => showReason("hold")}
              className="rounded-full bg-pending-tint px-2 py-0.5 text-xs font-semibold text-pending hover:underline">
              payouts held
            </button>
          )}
          {/* The real, staff-SET triage mark — separate from "suspect (N)"
              above, which is only a live count and forgets the moment flags
              resolve. A different colour on purpose, so the two are never
              mistaken for the same signal at a glance. */}
          {u.underReview && (
            <button disabled={busy} onClick={() => showReason("review")}
              className="rounded-full bg-brand-tint px-2 py-0.5 text-xs font-semibold text-brand hover:underline">
              under review
            </button>
          )}
        </div>
      </td>
      <td className="p-2.5 text-muted">{timeAgo(u.created_at)}</td>
      <td className="p-2.5">
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => openUser(u.id)}
            className="rounded-md bg-brand-tint px-2.5 py-1 text-xs font-semibold text-brand">
            View
          </button>
          <button disabled={busy} onClick={adjust}
            className="rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
            Adjust
          </button>
          <button disabled={busy} onClick={toggleStatus}
            className={`rounded-md px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50 ${
              suspended ? "bg-success" : "bg-danger"
            }`}>
            {suspended ? "Restore" : "Suspend"}
          </button>
          <button disabled={busy} onClick={toggleReview}
            className="rounded-md bg-brand-tint px-2.5 py-1 text-xs font-semibold text-brand disabled:opacity-50">
            {u.underReview ? "Clear review" : "Mark for review"}
          </button>
        </div>
      </td>
    </tr>
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
