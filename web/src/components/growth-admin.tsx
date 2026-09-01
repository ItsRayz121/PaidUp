"use client";

// Growth admin — referral rates (brief part 41) and the leaderboard (part 42).
//
// Internal tool: density over friendliness, jargon allowed (DESIGN_BRIEF). What
// is NOT allowed here is a number that disagrees with what a user was told —
// every figure on these two screens comes from the API that serves the earner
// app, never from a constant typed into this file.

import { useState } from "react";
import { useApi } from "@/lib/hooks";
import {
  fetchReferralAdmin, setReferralRatesForAll,
  fetchLeaderboardAdmin, excludeFromLeaderboard, unexcludeFromLeaderboard,
  type ReferralAdmin,
} from "@/lib/api";
import { formatPoints, timeAgo } from "@/lib/format";
import { useStaffNav } from "@/lib/staffNav";

const n = (v: number) => v.toLocaleString("en-US");

// ---- Referrals --------------------------------------------------------------

export function ReferralPanel() {
  const data = useApi(fetchReferralAdmin, []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const d = data.data;
  const dirty = Object.keys(draft).length > 0;

  async function saveAll() {
    setSaving(true);
    setMsg(null);
    try {
      const patch: Record<string, number> = {};
      for (const [k, v] of Object.entries(draft)) {
        if (v.trim() === "") continue;
        patch[k] = Number(v);
      }
      if (Object.keys(patch).length === 0) { setDraft({}); return; }
      const res = await setReferralRatesForAll(patch);
      setDraft({});
      data.reload();
      setMsg(`Saved on ${res.updated} network(s). Live immediately.`);
    } catch (e) {
      // The API refuses L1+L2 above the margin. That refusal is the most useful
      // thing this screen can say, so it is shown verbatim rather than summarised.
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (data.loading) return <p className="p-4 text-sm text-muted">Loading…</p>;
  if (data.error || !d) return <p className="p-4 text-sm text-danger">{data.error}</p>;

  return (
    <div className="space-y-5">
      {!d.enabled && (
        <p className="rounded-lg bg-danger-tint p-2.5 text-xs text-danger">
          <strong>Referrals are switched OFF</strong> (Features &amp; settings → Referrals). No new
          bonus is being paid, whatever the rates below say. Bonuses already credited are untouched.
        </p>
      )}

      {/* ⚠️ THE HEADLINE IS THE ADVERTISED RATE, NOT ANY ONE NETWORK'S.
          The invite screens promise the MINIMUM across active networks, so this
          is the only number a user has actually been told. Raising one network
          and leaving another below it changes nothing they can see — which is
          the mistake this whole screen exists to make visible. */}
      <div className="rounded-lg border border-line bg-card p-3">
        <h3 className="font-bold text-brand-ink">What users are promised right now</h3>
        <p className="mt-1 text-xs text-muted">
          The invite screens advertise the <strong>lowest</strong> rate across active networks — a
          floor we meet on every offer. A disabled network never drags it down.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Level 1" value={`${d.advertised.l1}%`} sub="of a friend's task points" />
          <Stat label="Level 2" value={`${d.advertised.l2}%`} sub="friends of friends" />
          <Stat label="First task" value={formatPoints(d.advertised.firstTaskBonus)}
            sub="one-off, when they finish task 1" />
          <Stat label="Window"
            value={d.advertised.windowDays === 0 ? "Lifetime" : `${d.advertised.windowDays} days`}
            sub="how long an invite keeps paying" />
        </div>
      </div>

      {/* One control, every row. Raising referral pay one network at a time does
          not raise what users see. */}
      <div className="rounded-lg border border-line bg-card p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-bold text-brand-ink">Set the rate on every network at once</h3>
          {dirty && (
            <button onClick={saveAll} disabled={saving}
              className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {saving ? "Saving…" : "Save to all networks"}
            </button>
          )}
        </div>
        <p className="text-xs text-muted">
          Referral pay comes out of <strong>our margin</strong>, never the invitee&apos;s balance. The API
          refuses L1 + L2 above the margin on any network — at a 60/40 split that is 40%, and past it
          every referred task loses money.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {([
            ["referralBonusPct", "Level 1 (%)", String(d.advertised.l1)],
            ["referralBonusPctL2", "Level 2 (%)", String(d.advertised.l2)],
            ["referralFirstTaskBonus", "First-task bonus (points)", String(d.advertised.firstTaskBonus)],
            ["referralBonusDays", "Window in days (0 = lifetime)", String(d.advertised.windowDays)],
          ] as const).map(([key, label, current]) => (
            <label key={key} className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 flex-1 text-muted">{label}</span>
              <input
                value={draft[key] ?? ""}
                placeholder={current}
                onChange={(e) => setDraft((s) => ({ ...s, [key]: e.target.value }))}
                className={`w-28 shrink-0 rounded-md border px-2 py-1 text-right font-mono ${
                  draft[key] ? "border-brand bg-brand-tint" : "border-line"
                }`}
              />
            </label>
          ))}
        </div>
        {msg && <p className="mt-2 rounded-md border border-line p-2 text-xs text-brand-ink">{msg}</p>}
      </div>

      <NetworkRates d={d} />

      {/* Is referral spend buying users, or signups? */}
      <div className="rounded-lg border border-line bg-card p-3">
        <h3 className="font-bold text-brand-ink">What it has cost, and what it bought</h3>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="Paid all time" value={formatPoints(d.totals.paidAll)} sub="points, from margin" />
          <Stat label="Paid last 30 days" value={formatPoints(d.totals.paid30d)} sub="points" />
          <Stat label="Inviters paid" value={n(d.totals.payingReferrers)} sub="accounts" />
          <Stat label="Invited users" value={n(d.totals.referredUsers)} sub="signed up via a link" />
          <Stat label="Did a task" value={n(d.totals.activatedUsers)} sub="at least one credit" />
          {/* The one number that says whether the spend is working. A referral
              programme paying for signups that never earn is paying for nothing. */}
          <Stat label="Activation" value={`${d.totals.activationPct}%`} sub="invites that did a task" />
        </div>
      </div>

      <TopReferrers rows={d.topReferrers} />
    </div>
  );
}

function NetworkRates({ d }: { d: ReferralAdmin }) {
  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <h3 className="font-bold text-brand-ink">Per network</h3>
      <p className="mt-1 text-xs text-muted">
        Rows marked <span className="rounded bg-pending-tint px-1 text-pending">floor</span> are the
        ones holding the advertised rate down. Raising anything else changes nothing users can see.
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[620px] text-xs">
          <thead className="text-left uppercase text-muted">
            <tr>
              <th className="py-1">Network</th><th>Status</th><th>Split</th><th>Margin</th>
              <th>L1</th><th>L2</th><th>First task</th><th>Window</th><th>Headroom</th>
            </tr>
          </thead>
          <tbody>
            {d.networks.map((x) => (
              <tr key={x.id} className="border-t border-line">
                <td className="py-1.5 font-semibold text-brand-ink">
                  {x.name}
                  {x.status === "active" && d.pinning.includes(x.id) && (
                    <span className="ms-1.5 rounded bg-pending-tint px-1 text-[10px] font-semibold text-pending">floor</span>
                  )}
                </td>
                <td className={x.status === "active" ? "text-success" : "text-muted"}>{x.status}</td>
                <td className="font-mono">{x.commissionSplitPct}%</td>
                <td className="font-mono">{x.marginPct}%</td>
                <td className="font-mono">{x.referralBonusPct}%</td>
                <td className="font-mono">{x.referralBonusPctL2}%</td>
                <td className="font-mono">{n(x.referralFirstTaskBonus)}</td>
                <td className="font-mono">{x.referralBonusDays === 0 ? "life" : `${x.referralBonusDays}d`}</td>
                {/* Negative headroom means this network loses money on every
                    referred task. The API refuses to CREATE that state, but a
                    split lowered afterwards can produce it. */}
                <td className={`font-mono ${x.headroomPct < 0 ? "font-bold text-danger" : "text-muted"}`}>
                  {x.headroomPct}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type SortKey = "points" | "invites" | "activeInvites" | "inactivePct";

function TopReferrers({ rows }: { rows: ReferralAdmin["topReferrers"] }) {
  const { openUser } = useStaffNav();
  const [sort, setSort] = useState<SortKey>("points");
  const sorted = [...rows].sort((a, b) => (b[sort] as number) - (a[sort] as number));
  // A render helper, not a component (react-hooks/static-components).
  const sortBtn = (k: SortKey, label: string) => (
    <button onClick={() => setSort(k)}
      className={`uppercase ${sort === k ? "font-bold text-brand-ink" : "hover:text-brand-ink"}`}>
      {label}{sort === k ? " ▼" : ""}
    </button>
  );
  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <h3 className="font-bold text-brand-ink">Top partners</h3>
      <p className="mt-1 text-xs text-muted">
        <strong>Invites</strong> is signups; <strong>Active</strong> is how many finished a task;{" "}
        <strong>Inactive</strong> is the rest. A big Inactive % next to a big invite count on one
        account is the shape of a fake-signup farm. Tap a column to sort.
      </p>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Nobody has earned a referral bonus yet.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[560px] text-xs">
            <thead className="text-left uppercase text-muted">
              <tr>
                <th className="py-1">User</th>
                <th>{sortBtn("points", "Paid")}</th>
                <th>{sortBtn("invites", "Invites")}</th>
                <th>{sortBtn("activeInvites", "Active")}</th>
                <th>{sortBtn("inactivePct", "Inactive")}</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const dead = r.invites >= 5 && r.activeInvites === 0;
                const farmish = r.invites >= 5 && r.inactivePct >= 80;
                return (
                  <tr key={r.id} className="border-t border-line">
                    <td className="py-1.5">
                      <button onClick={() => openUser(r.id)} className="text-brand-ink hover:underline">{r.email}</button>
                      {r.status !== "active" && <span className="ms-1 text-danger">({r.status})</span>}
                    </td>
                    <td className="font-mono">{formatPoints(r.points)}</td>
                    <td className="font-mono">{n(r.invites)}</td>
                    <td className={`font-mono ${dead ? "font-bold text-danger" : ""}`}>{n(r.activeInvites)}</td>
                    <td className={`font-mono ${farmish ? "font-bold text-danger" : "text-muted"}`}>
                      {n(r.inactiveInvites)} · {r.inactivePct}%
                    </td>
                    <td className={r.openFlags > 0 ? "font-bold text-danger" : "text-muted"}>
                      {r.openFlags || "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Leaderboard ------------------------------------------------------------

export function LeaderboardPanel() {
  const data = useApi(fetchLeaderboardAdmin, []);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function hide(userId: string, email: string) {
    const reason = window.prompt(
      `Hide ${email} from the public leaderboard?\n\n` +
      "This hides them from two read-only boards. It changes no balance and does not stop them " +
      "earning.\n\nWhy? (recorded, and shown on this screen)",
    );
    if (reason === null || reason.trim() === "") return;
    setBusy(userId);
    try {
      await excludeFromLeaderboard(userId, reason.trim());
      data.reload();
      setMsg(null);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); }
  }

  async function show(userId: string) {
    setBusy(userId);
    try {
      await unexcludeFromLeaderboard(userId);
      data.reload();
      setMsg(null);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); }
  }

  if (data.loading) return <p className="p-4 text-sm text-muted">Loading…</p>;
  if (data.error || !data.data) return <p className="p-4 text-sm text-danger">{data.error}</p>;
  const d = data.data;

  return (
    <div className="space-y-5">
      {/* The board is computed whether the flag is on or not — that is the
          confusing part, so the screen says which it is rather than leaving
          "there are rows here" to be read as "users can see this". */}
      {!d.enabled && (
        <p className="rounded-lg bg-pending-tint p-2.5 text-xs text-pending">
          <strong>The leaderboard page is switched OFF</strong> (Features &amp; settings →
          Leaderboard). Users see nothing. The boards below are still computed, so you can work on
          them before turning it back on.
        </p>
      )}

      <p className="rounded-lg border border-line bg-card p-2.5 text-xs text-muted">
        Users see these boards with names <strong>masked</strong> (&ldquo;fa•••&rdquo;). You see the real
        address because the only decision here is about a specific person. Hiding someone is a
        <strong> display change</strong>: no balance moves, nothing is clawed back, and they carry on
        earning exactly as before.
      </p>

      {msg && <p className="rounded-md bg-danger-tint p-2 text-xs text-danger">{msg}</p>}

      {d.exclusions.length > 0 && (
        <div className="rounded-lg border border-line bg-card p-3">
          <h3 className="font-bold text-brand-ink">Hidden from the boards</h3>
          <table className="mt-2 w-full text-xs">
            <tbody>
              {d.exclusions.map((x) => (
                <tr key={x.userId} className="border-t border-line first:border-t-0">
                  <td className="py-1.5 text-brand-ink">{x.email}</td>
                  <td className="text-muted">{x.reason}</td>
                  <td className="text-muted">{timeAgo(x.at)}</td>
                  <td className="text-right">
                    <button onClick={() => show(x.userId)} disabled={busy === x.userId}
                      className="rounded bg-brand-tint px-2 py-0.5 text-[10px] font-semibold text-brand disabled:opacity-50">
                      Show again
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Board title="Top earners" rows={d.topEarners} onHide={hide} busy={busy} />
      <Board title="Top inviters" rows={d.topReferrers} onHide={hide} busy={busy} showInvites />
    </div>
  );
}

function Board(
  { title, rows, onHide, busy, showInvites }: {
    title: string;
    rows: { rank: number; id: string; email: string; points: number; invites?: number }[];
    onHide: (id: string, email: string) => void;
    busy: string | null;
    showInvites?: boolean;
  },
) {
  const { openUser } = useStaffNav();
  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <h3 className="font-bold text-brand-ink">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Nobody qualifies yet.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[440px] text-xs">
            <thead className="text-left uppercase text-muted">
              <tr>
                <th className="py-1">#</th><th>User</th><th>Points</th>
                {showInvites && <th>Invites</th>}<th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="py-1.5 font-mono text-muted">{r.rank}</td>
                  <td><button onClick={() => openUser(r.id)} className="text-brand-ink hover:underline">{r.email}</button></td>
                  <td className="font-mono">{formatPoints(r.points)}</td>
                  {showInvites && <td className="font-mono">{r.invites ?? 0}</td>}
                  <td className="text-right">
                    <button onClick={() => onHide(r.id, r.email)} disabled={busy === r.id}
                      className="rounded bg-brand-tint px-2 py-0.5 text-[10px] font-semibold text-brand disabled:opacity-50">
                      Hide
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line p-2">
      <p className="text-[10px] uppercase text-muted">{label}</p>
      <p className="num font-semibold text-brand-ink">{value}</p>
      {sub && <p className="text-[10px] text-muted">{sub}</p>}
    </div>
  );
}
