"use client";

// Super-admin panels. `admin` was always the top role, but it had no tools:
// no way to find a user, pay one, suspend one, or appoint staff. These add them.
// Internal tool — density over friendliness, jargon allowed (DESIGN_BRIEF).
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import {
  searchUsers, setUserStatus, adjustUserPoints,
  fetchStaffMembers, setStaffRole,
  fetchMoney, downloadExport,
  type AdminUserRow,
} from "@/lib/api";
import { formatPoints, formatMoney, timeAgo } from "@/lib/format";

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
export function UsersPanel() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const users = useApi(() => searchUsers(query), [query]);

  return (
    <section className="mb-8">
      <h2 className="mb-2 font-bold text-brand-ink">Users</h2>
      <form onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }} className="mb-2 flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search email or user id — blank shows the newest"
          className="flex-1 rounded-md border border-line bg-card p-2 text-sm outline-none"
        />
        <button className="rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white">Search</button>
      </form>

      {users.loading ? <p className="text-sm text-muted">Loading…</p>
        : users.error ? <p className="text-sm text-danger">{users.error}</p>
        : (users.data?.users.length ?? 0) === 0 ? (
          <p className="rounded-lg border border-line bg-card p-4 text-sm text-muted">No users found.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-brand-tint text-left text-xs uppercase text-brand">
                <tr>
                  <th className="p-2.5">Email</th><th className="p-2.5">Balance</th>
                  <th className="p-2.5">Value</th><th className="p-2.5">Status</th>
                  <th className="p-2.5">Joined</th><th className="p-2.5">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.data!.users.map((u) => <UserRow key={u.id} u={u} onChanged={users.reload} />)}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

function UserRow({ u, onChanged }: { u: AdminUserRow; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
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

  return (
    <tr className={`border-t border-line ${suspended ? "bg-danger-tint/40" : ""}`}>
      <td className="p-2.5">
        <span className="font-semibold text-brand-ink">{u.email}</span>
        <span className="block text-xs text-muted">{u.id}</span>
      </td>
      <td className="num p-2.5">{formatPoints(u.balance)}</td>
      <td className="p-2.5 text-muted">{formatMoney(u.balance)}</td>
      <td className="p-2.5">
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
          suspended ? "bg-danger text-white" : "bg-success-tint text-success"
        }`}>{u.status}</span>
      </td>
      <td className="p-2.5 text-muted">{timeAgo(u.created_at)}</td>
      <td className="p-2.5">
        <div className="flex gap-1.5">
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
        </div>
      </td>
    </tr>
  );
}

// ---- Staff roles ---------------------------------------------------------
const ROLES = ["agent", "manager", "admin", "none"] as const;
type RoleOpt = (typeof ROLES)[number];

export function StaffRolesPanel() {
  const staff = useApi(fetchStaffMembers, []);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"agent" | "manager" | "admin">("agent");
  const [busy, setBusy] = useState(false);

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
        Agent = withdrawals under the limit, plus tickets. Manager = any withdrawal, fraud, KPIs.
        Admin = everything, including creating points by hand. The last admin cannot be demoted.
      </p>

      <form onSubmit={appoint} className="mb-2 flex flex-wrap gap-2">
        <input value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="email of an existing user"
          className="flex-1 rounded-md border border-line bg-card p-2 text-sm outline-none" />
        <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}
          className="rounded-md border border-line bg-card p-2 text-sm">
          <option value="agent">agent</option>
          <option value="manager">manager</option>
          <option value="admin">admin</option>
        </select>
        <button disabled={busy}
          className="rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          Appoint
        </button>
      </form>

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
                    <td className="p-2.5 uppercase">{s.role}</td>
                    <td className="p-2.5 text-muted">{timeAgo(s.at)}</td>
                    <td className="p-2.5">
                      <select value={s.role} onChange={(e) => change(s.userId, e.target.value as RoleOpt)}
                        className="rounded-md border border-line bg-card p-1 text-xs">
                        {ROLES.map((r) => <option key={r} value={r}>{r === "none" ? "remove access" : r}</option>)}
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
  const money = useApi(fetchMoney, []);

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
        <Tile label="Owed to users (live)" value={formatPoints(m.points.outstanding)} sub={`${m.usdt.outstanding.toFixed(2)} USDT`} />
        <Tile label="Paid out (all time)" value={formatPoints(m.points.paidPoints)} sub={`${m.usdt.paid.toFixed(2)} USDT`} />
        <Tile label="Awaiting payout" value={formatPoints(m.points.pendingPoints)} sub={`${m.usdt.pending.toFixed(2)} USDT`} />
        <Tile label="Fees kept" value={formatPoints(m.points.feePoints)} sub="from withdrawals" />
      </div>
      <p className="mt-2 text-xs text-muted">
        Points created by hand (admin adjustments):{" "}
        <span className="num font-semibold">{formatPoints(m.points.adjustments)}</span>. These were
        not earned from a network — they come straight off your margin.
      </p>

      <h3 className="mb-1.5 mt-4 font-semibold text-brand-ink">Recent staff actions</h3>
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
