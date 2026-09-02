"use client";

// The User 360 page (admin rebuild, Phase B). One record, one tabbed layout:
// Overview · Activity · Balances · Money · Referrals · Tickets · Audit, plus a
// Danger zone. Every number is derived server-side from a table that already
// exists (GET /staff/users/:id) — no per-user counter to drift.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { DetailLayout, type DetailTab } from "./DetailLayout";
import { StatusBadge, TimeCell, Points, UsdtMicro } from "./primitives";
import { useToast } from "./toast";
import {
  fetchStaffUser, setUserStatus, setUserReview, setWithdrawalHold,
  adjustUserPoints, adjustUserRozi, adjustUserUsdt, type StaffUserDetail,
  fetchEligibleRewards, quickSendReward, type EligibleReward,
} from "@/lib/api";
import { formatMoney, formatPoints, formatUsdtMicro } from "@/lib/format";

type Row = Record<string, unknown>;
const S = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const N = (v: unknown) => Number(v ?? 0);

function MiniTable({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <p className="rounded-lg border border-line bg-card p-3 text-sm text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[520px] text-xs">
        <thead className="bg-brand-tint/60 text-left uppercase text-brand">
          <tr>{head.map((h) => <th key={h} className="p-2">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i} className="border-t border-line">
              {cells.map((c, j) => <td key={j} className="p-2 align-top">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className="text-sm text-brand-ink">{children}</p>
    </div>
  );
}

// Approved rewards for this user that have not been released yet — with a
// one-click "Send now" (balance mode) that runs the same path a disbursement
// batch does. Only rendered for a staff member who can manage disbursements.
function WaitingRewards({ userId }: { userId: string }) {
  const toast = useToast();
  const [items, setItems] = useState<EligibleReward[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    () => fetchEligibleRewards({ userId, limit: 50 }).then((r) => setItems(r.items)).catch(() => setItems([])),
    [userId],
  );
  useEffect(() => { void load(); }, [load]);

  if (!items || items.length === 0) return null;
  async function send(proofId: string) {
    setBusy(proofId);
    try {
      const r = await quickSendReward(proofId);
      if (r.released) toast.ok("Reward sent to their balance.");
      else toast.err(r.result?.error ?? "Could not send that reward.");
      await load();
    } catch (e) { toast.err((e as Error).message); }
    finally { setBusy(null); }
  }
  return (
    <div className="rounded-lg border border-brand/30 bg-brand-tint/20 p-4">
      <p className="mb-2 text-xs font-semibold uppercase text-brand">Rewards waiting to be paid</p>
      <div className="space-y-1.5">
        {items.map((it) => (
          <div key={it.proofId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate">
              {it.taskTitle}
              <span className="ml-2 num text-xs text-muted">
                {it.usdtMicro > 0 ? formatUsdtMicro(it.usdtMicro) : ""}
                {it.roziMicro > 0 ? ` ${(it.roziMicro / 1e6).toFixed(2)} ROZI` : ""}
              </span>
            </span>
            <button disabled={busy === it.proofId} onClick={() => send(it.proofId)}
              className="rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
              {busy === it.proofId ? "Sending…" : "Send now"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function UserDetail({ d, onReload, onBack, canDisburse = false }: {
  d: StaffUserDetail;
  onReload: () => void;
  onBack: () => void;
  canDisburse?: boolean;
}) {
  const u = d.user;
  const toast = useToast();
  const [tab, setTab] = useState("overview");
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try { await fn(); if (ok) toast.ok(ok); onReload(); }
    catch (e) { toast.err((e as Error).message); }
    finally { setBusy(false); }
  }

  const suspended = S(u.status) !== "active";

  // ---- Danger zone actions ----
  function doStatus() {
    const next = suspended ? "active" : "suspended";
    const reason = window.prompt(next === "suspended"
      ? "Why are you suspending this account? They are locked out immediately."
      : "Why are you restoring this account?");
    if (!reason?.trim()) return;
    act(() => setUserStatus(u.id, next, reason.trim()), `Account ${next === "suspended" ? "suspended" : "restored"}.`);
  }
  function doHold() {
    if (u.withdrawalHeld) {
      if (!window.confirm("Lift the payout hold on this account?")) return;
      act(() => setWithdrawalHold(u.id, null), "Payout hold lifted.");
      return;
    }
    const reason = window.prompt("Why are you holding this account's automatic payouts? (They still mine and earn.)");
    if (!reason?.trim()) return;
    act(() => setWithdrawalHold(u.id, reason.trim()), "Automatic payouts held.");
  }
  function doReview() {
    if (u.underReview) {
      if (!window.confirm("Clear the review mark?")) return;
      act(() => setUserReview(u.id, null), "Review mark cleared.");
      return;
    }
    const reason = window.prompt("Why are you marking this account for review?");
    if (!reason?.trim()) return;
    act(() => setUserReview(u.id, reason.trim()), "Marked for review.");
  }
  function doAdjustPoints() {
    const raw = window.prompt("Adjust POINTS. Positive adds, negative removes (e.g. 500 or -500).\nA credit is real money the user can withdraw. Logged against you.");
    if (raw === null) return;
    const points = Number(raw.trim());
    if (!Number.isInteger(points) || points === 0) { toast.err("Enter a whole number that is not zero."); return; }
    const reason = window.prompt("Reason (the user sees this in their wallet):");
    if (!reason?.trim()) return;
    act(async () => { const r = await adjustUserPoints(u.id, points, reason.trim()); toast.ok(`Points ${r.before} → ${r.after}.`); }, "");
  }
  function doAdjustUsdt() {
    const raw = window.prompt(
      "Adjust USDT deposit-credit balance (dollars, decimals allowed). Positive adds, negative removes.\n" +
      "Use this to fix a treasury shortfall: a debit here brings the books back to what the chain holds.\n" +
      "A debit MAY take the balance negative — that is expected when the recorded balance was wrong.",
    );
    if (raw === null) return;
    const usdt = Number(raw.trim());
    if (!Number.isFinite(usdt) || usdt === 0) { toast.err("Enter a non-zero number."); return; }
    const reason = window.prompt("Reason (min 3 characters — lands in the audit log):");
    if (!reason || reason.trim().length < 3) return;
    act(async () => {
      const r = await adjustUserUsdt(u.id, usdt, reason.trim());
      toast.ok(`USDT ${(r.beforeMicro / 1e6).toFixed(6)} → ${(r.afterMicro / 1e6).toFixed(6)}.`);
    }, "");
  }
  function doAdjustRozi() {
    const raw = window.prompt("Adjust ROZI (whole ROZI, decimals allowed). Positive adds, negative removes.");
    if (raw === null) return;
    const rozi = Number(raw.trim());
    if (!Number.isFinite(rozi) || rozi === 0) { toast.err("Enter a non-zero amount."); return; }
    const note = window.prompt("Reason (min 3 characters):");
    if (!note || note.trim().length < 3) return;
    act(() => adjustUserRozi(u.id, rozi, note.trim()), "ROZI adjusted.");
  }

  // ---- Tabs ----
  const tabs: DetailTab[] = [
    {
      id: "overview", label: "Overview",
      content: (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-line bg-card p-4 sm:grid-cols-3">
            <Field label="Email">{S(u.email)}</Field>
            <Field label="Handle">{u.username ? `@${S(u.username)}` : "—"}</Field>
            <Field label="Display name">{S(u.display_name) || "—"}</Field>
            <Field label="Country">{S(u.country) || "—"}</Field>
            <Field label="ID check"><StatusBadge status={S(u.kyc_status) || "none"} /></Field>
            <Field label="Telegram">{u.telegram_id ? "linked" : "—"}</Field>
            <Field label="Invite code">{S(u.referral_code) || "—"}</Field>
            <Field label="Joined"><TimeCell iso={S(u.created_at)} /></Field>
            <Field label="Status"><StatusBadge status={suspended ? "suspended" : "active"} /></Field>
          </div>

          {u.withdrawalHeld && (
            <p className="rounded-lg bg-pending-tint p-3 text-xs text-pending">
              Automatic payouts held: {S(u.withdrawal_hold_reason)}
              {u.withdrawal_hold_until ? ` (until ${S(u.withdrawal_hold_until).slice(0, 10)})` : " (no end date)"}. They can still mine and earn.
            </p>
          )}
          {u.underReview && (
            <p className="rounded-lg bg-pending-tint p-3 text-xs text-pending">
              Marked for review: {S(u.under_review_reason)}
              {u.under_review_by_email ? ` — by ${S(u.under_review_by_email)}` : ""}. Triage note only — it stops nothing.
            </p>
          )}

          {canDisburse && <WaitingRewards userId={u.id} />}

          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-muted">Devices &amp; IPs</p>
            <MiniTable
              head={["Device", "IP", "First seen", "Last seen"]}
              empty="No sign-in devices on record."
              rows={d.devices.map((x) => [
                <span key="d" className="num">{x.device_id.slice(0, 16)}…</span>,
                <span key="i" className="num">{x.ip ?? "—"}</span>,
                <TimeCell key="f" iso={x.first_seen} />,
                <TimeCell key="l" iso={x.last_seen} />,
              ])}
            />
          </div>

          {d.fraudFlags.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase text-danger">Fraud flags</p>
              <MiniTable
                head={["Type", "Severity", "Detail", "When", "Resolved"]}
                empty=""
                rows={d.fraudFlags.map((f: Row) => [
                  S(f.flag_type), S(f.severity), <span key="x" className="text-muted">{S(f.detail)}</span>,
                  <TimeCell key="w" iso={S(f.created_at)} />, S(f.resolution_note) || "open",
                ])}
              />
            </div>
          )}
        </div>
      ),
    },
    {
      id: "activity", label: "Activity",
      content: (
        <MiniTable
          head={["When", "Kind", "What"]}
          empty="No activity recorded."
          rows={d.activity.map((a) => [
            <TimeCell key="w" iso={a.at} />,
            <span key="k" className="rounded bg-brand-tint/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-brand">{a.kind}</span>,
            <span key="d" className="text-muted">{a.detail}</span>,
          ])}
        />
      ),
    },
    {
      id: "balances", label: "Balances",
      content: (
        <div className="space-y-4">
          {/* ⚠️ THREE LEDGERS, THREE BOXES, NEVER A TOTAL (guardrail #7). */}
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border border-line p-3">
              <p className="text-[10px] uppercase text-muted">Points</p>
              <p className="num font-bold text-brand-ink"><Points value={N(u.balancePoints)} /></p>
              <p className="text-[10px] text-muted">withdrawable · {formatMoney(N(u.balancePoints))}</p>
            </div>
            <div className="rounded-lg border border-line p-3">
              <p className="text-[10px] uppercase text-muted">ROZI</p>
              <p className="num font-bold text-brand-ink">{(N(u.roziMicro) / 1e6).toFixed(3)}</p>
              <p className="text-[10px] text-muted">mined + received</p>
            </div>
            <div className="rounded-lg border border-line p-3">
              <p className="text-[10px] uppercase text-muted">USDT credit</p>
              <p className="num font-bold text-brand-ink"><UsdtMicro value={N(u.usdtMicro)} /></p>
              <p className="text-[10px] text-muted">deposits, spend-only</p>
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-muted">Points ledger</p>
            <MiniTable head={["Amount", "Source", "Note", "When"]} empty="No points ledger rows."
              rows={d.ledger.map((l: Row) => [
                <span key="a" className="num">{N(l.amount) >= 0 ? "+" : ""}{S(l.amount)}</span>,
                S(l.source_type), <span key="n" className="text-muted">{S(l.note)}</span>,
                <TimeCell key="w" iso={S(l.created_at)} />,
              ])} />
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-muted">ROZI ledger</p>
            <MiniTable head={["Dir", "Amount", "Source", "When"]} empty="No ROZI ledger rows."
              rows={d.roziLedger.map((l: Row) => [
                S(l.direction), <span key="a" className="num">{(N(l.amount) / 1e6).toFixed(3)}</span>,
                S(l.source_type), <TimeCell key="w" iso={S(l.created_at)} />,
              ])} />
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-muted">USDT deposit ledger</p>
            <MiniTable head={["Dir", "Amount", "Source", "When"]} empty="No USDT ledger rows."
              rows={d.usdtLedger.map((l: Row) => [
                S(l.direction), <span key="a" className="num">{(N(l.amount) / 1e6).toFixed(2)}</span>,
                S(l.source_type), <TimeCell key="w" iso={S(l.created_at)} />,
              ])} />
          </div>
        </div>
      ),
    },
    {
      id: "money", label: "Money",
      content: (
        <div className="space-y-4">
          <p className="text-xs text-muted">
            Paid out: <span className="num font-semibold text-brand-ink">{formatPoints(d.paidSummary.totalPoints)}</span> pts
            across {d.paidSummary.count} withdrawal{d.paidSummary.count === 1 ? "" : "s"} (net of fees).
          </p>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-muted">Withdrawals (task / referral cash-out)</p>
            <MiniTable head={["Amount", "Fee", "Chain / to", "Status", "When"]} empty="No withdrawals."
              rows={d.withdrawals.map((r: Row) => [
                <span key="a" className="num">{formatPoints(N(r.amount))}</span>,
                <span key="f" className="num text-muted">{N(r.fee_points) > 0 ? `− ${formatPoints(N(r.fee_points))}` : "—"}</span>,
                <span key="c" className="text-muted">{S(r.chain)} · {S(r.address)} {r.address_verified ? "✓ signed" : "· typed"}</span>,
                <StatusBadge key="s" status={S(r.status)} />, <TimeCell key="w" iso={S(r.created_at)} />,
              ])} />
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-muted">USDT refunds (their deposit, returned)</p>
            <MiniTable head={["Amount", "Fee", "Chain / to", "Status", "When"]} empty="No refunds."
              rows={d.usdtRefunds.map((r: Row) => [
                <span key="a" className="num">{(N(r.amount) / 1e6).toFixed(2)} USDT</span>,
                <span key="f" className="num text-muted">{N(r.fee_micro) > 0 ? `− ${(N(r.fee_micro) / 1e6).toFixed(2)}` : "—"}</span>,
                <span key="c" className="text-muted">{S(r.chain)} · {S(r.address)}</span>,
                <StatusBadge key="s" status={S(r.status)} />, <TimeCell key="w" iso={S(r.created_at)} />,
              ])} />
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-muted">USDT top-ups (deposit credit)</p>
            <MiniTable head={["Amount", "Chain", "Status", "When"]} empty="No top-ups."
              rows={d.usdtTopups.map((r: Row) => [
                <span key="a" className="num">{(N(r.amount) / 1e6).toFixed(2)} USDT</span>,
                S(r.chain), <StatusBadge key="s" status={S(r.status)} />, <TimeCell key="w" iso={S(r.created_at)} />,
              ])} />
          </div>
        </div>
      ),
    },
    {
      id: "referrals", label: "Referrals",
      content: (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-4 text-sm">
            <Field label="Invited by">{d.invitedBy ? `${d.invitedBy.email} (${d.invitedBy.referral_code})` : "—"}</Field>
            <Field label="Directly invited">{d.inviteeCount}</Field>
            <Field label="Friends of friends">{d.referral.joined2Count}</Field>
            <Field label="Referral points earned"><Points value={d.referral.earnedPoints} /></Field>
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-muted">
              Invited {d.inviteeCount} {d.inviteeCount > d.invitees.length ? `— newest ${d.invitees.length}` : ""}
            </p>
            <MiniTable head={["Email", "Status", "Joined"]} empty="Nobody yet."
              rows={d.invitees.map((r: Row) => [
                S(r.email), <StatusBadge key="s" status={S(r.status)} />, <TimeCell key="w" iso={S(r.created_at)} />,
              ])} />
          </div>
        </div>
      ),
    },
    {
      id: "tickets", label: `Tickets${d.tickets.length ? ` (${d.tickets.length})` : ""}`,
      content: (
        <MiniTable head={["Subject", "Status", "Opened"]} empty="No support tickets."
          rows={d.tickets.map((t: Row) => [
            S(t.subject), <StatusBadge key="s" status={S(t.status)} />, <TimeCell key="w" iso={S(t.created_at)} />,
          ])} />
      ),
    },
    {
      id: "audit", label: "Audit",
      content: (
        <MiniTable head={["When", "Action", "Change", "By"]} empty="No admin actions on this account."
          rows={d.audit.map((a) => [
            <TimeCell key="w" iso={a.created_at} />,
            <span key="a" className="font-semibold text-brand-ink">{a.action}</span>,
            <span key="c" className="text-muted">
              {a.previous_value || a.new_value
                ? `${a.previous_value ?? "∅"} → ${a.new_value ?? "∅"}`
                : (a.detail ?? "")}
            </span>,
            a.actor_email ?? "—",
          ])} />
      ),
    },
  ];

  return (
    <DetailLayout
      breadcrumb={[{ label: "Users", onClick: onBack }, { label: S(u.email) }]}
      title={S(u.email)}
      ids={[
        { label: "id", value: u.id },
        ...(u.username ? [{ label: "handle", value: `@${S(u.username)}` }] : []),
        { label: "code", value: S(u.referral_code) },
      ]}
      badges={
        <>
          <StatusBadge status={suspended ? "suspended" : "active"} />
          {u.withdrawalHeld && <StatusBadge status="held" tone="warn" />}
          {u.underReview && <StatusBadge status="under_review" tone="warn" />}
          <StatusBadge status={`id: ${S(u.kyc_status) || "none"}`} tone={S(u.kyc_status) === "approved" ? "good" : "neutral"} />
          {u.telegram_id ? <StatusBadge status="telegram" tone="info" /> : null}
        </>
      }
      tabs={tabs}
      activeTab={tab}
      onTab={setTab}
      dangerZone={
        <div className="flex flex-wrap gap-2">
          <button disabled={busy} onClick={doStatus}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 ${suspended ? "bg-success" : "bg-danger"}`}>
            {suspended ? "Restore account" : "Suspend account"}
          </button>
          <button disabled={busy} onClick={doHold}
            className="rounded-md bg-pending px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {u.withdrawalHeld ? "Lift payout hold" : "Hold payouts"}
          </button>
          <button disabled={busy} onClick={doReview}
            className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {u.underReview ? "Clear review mark" : "Mark for review"}
          </button>
          <button disabled={busy} onClick={doAdjustPoints}
            className="rounded-md border border-danger/40 bg-card px-3 py-1.5 text-xs font-semibold text-danger disabled:opacity-50">
            Adjust points
          </button>
          <button disabled={busy} onClick={doAdjustRozi}
            className="rounded-md border border-danger/40 bg-card px-3 py-1.5 text-xs font-semibold text-danger disabled:opacity-50">
            Adjust ROZI
          </button>
          <button disabled={busy} onClick={doAdjustUsdt}
            className="rounded-md border border-danger/40 bg-card px-3 py-1.5 text-xs font-semibold text-danger disabled:opacity-50">
            Adjust USDT
          </button>
        </div>
      }
    />
  );
}

// Standalone "find + open a user" screen (the Users & IDs → "Look up a user"
// panel). Keeps its own small search box; the target prop lets a "view ledger"
// link elsewhere in the console jump straight in.
export function UserLookupScreen({ target, onCleared, canDisburse = false }: { target: string | null; onCleared?: () => void; canDisburse?: boolean }) {
  const [id, setId] = useState(target ?? "");
  const [query, setQuery] = useState(target ?? "");
  const [data, setData] = useState<StaffUserDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(q: string) {
    if (!q.trim()) return;
    setLoading(true); setError(null);
    try { setData(await fetchStaffUser(q.trim())); }
    catch (e) { setError((e as Error).message); setData(null); }
    finally { setLoading(false); }
  }

  // React to an incoming `target` (set when another screen links here).
  const [seenTarget, setSeenTarget] = useState(target);
  if (target && target !== seenTarget) {
    setSeenTarget(target);
    setId(target); setQuery(target); load(target);
  }

  return (
    <section className="mb-8">
      {!data && (
        <>
          <h2 className="mb-2 font-bold text-brand-ink">Look up a user</h2>
          <form onSubmit={(e) => { e.preventDefault(); setQuery(id); load(id); }} className="flex gap-2">
            <input value={id} onChange={(e) => setId(e.target.value)}
              placeholder="user id, email, @handle or invite code"
              className="flex-1 rounded-md border border-line bg-card p-2 text-sm outline-none focus:border-brand" />
            <button className="rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white">Search</button>
          </form>
          {query && loading && <p className="mt-2 text-sm text-muted">Loading…</p>}
          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        </>
      )}

      {data && (
        <UserDetail
          d={data}
          canDisburse={canDisburse}
          onReload={() => load(query)}
          onBack={() => { setData(null); setId(""); setQuery(""); onCleared?.(); }}
        />
      )}
    </section>
  );
}
