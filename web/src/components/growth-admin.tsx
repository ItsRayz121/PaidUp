"use client";

// Growth admin — referral rates (brief part 41) and the leaderboard (part 42).
//
// Internal tool: density over friendliness, jargon allowed (DESIGN_BRIEF). What
// is NOT allowed here is a number that disagrees with what a user was told —
// every figure on these two screens comes from the API that serves the earner
// app, never from a constant typed into this file.

import { Fragment, useState } from "react";
import { useApi } from "@/lib/hooks";
import {
  fetchReferralAdmin, setReferralRatesForAll, fetchReferralInvitees,
  fetchLeaderboardAdmin, excludeFromLeaderboard, unexcludeFromLeaderboard,
  fetchLeaderboardRewardSettings, saveLeaderboardRewardSettings, fetchLeaderboardRewardCycles,
  fetchLeaderboardMiningReserve,
  type ReferralAdmin, type ReferralInvitee,
  type LeaderboardRewardSettings, type LeaderboardRewardCycleConfig,
} from "@/lib/api";
import { formatPoints, formatRozi, formatPointsAsRozi, formatMoney, timeAgo, displayIdentity } from "@/lib/format";
import { useStaffNav } from "@/lib/staffNav";
import { computeDistribution, distributionToTiersString, type DistributionMethod } from "@/lib/rewardDistribution";
import { usePrompt } from "@/components/staff/prompt";

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
      <div className="rounded-lg border-2 border-line-strong bg-card p-3">
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
      <div className="rounded-lg border-2 border-line-strong bg-card p-3">
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

      {/* Is referral spend buying users, or signups? */}
      <div className="rounded-lg border-2 border-line-strong bg-card p-3">
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
      <TopInviters rows={d.topReferrers} />
    </div>
  );
}

// PerNetworkPanel / NetworkRates — DELETED (founder, Part 4, 2026-09-06). This
// was a read-only mirror of exactly the per-network economics
// (margin/headroom/the "floor" pinning badge) that web/src/components/staff.tsx's
// NetworkPanel — Tasks & Networks → Ad networks — already showed, editable,
// one tab over. That table now also shows margin/headroom/the floor badge
// (it already fetched networks; it now also fetches GET /staff/referrals),
// so this stopped being a second home for the same data rather than a
// different job. See NetworkPanel in staff.tsx for where this data lives now.

type SortKey = "points" | "invites" | "activeInvites" | "inactivePct";

function InviteeList({ id }: { id: string }) {
  const data = useApi(() => fetchReferralInvitees(id), [id]);
  if (data.loading) return <p className="p-2 text-xs text-muted">Loading invitees…</p>;
  if (data.error || !data.data) return <p className="p-2 text-xs text-danger">{data.error}</p>;
  const rows: ReferralInvitee[] = data.data.invitees;
  if (rows.length === 0) return <p className="p-2 text-xs text-muted">No invitees.</p>;
  const active = rows.filter((r) => r.active).length;
  return (
    <div className="rounded-md border-2 border-line-strong bg-bg/40 p-2">
      <p className="mb-1 text-[11px] text-muted">
        {rows.length} invited · <span className="font-semibold text-success">{active} active</span> ·{" "}
        <span className="font-semibold text-danger">{rows.length - active} inactive</span>
      </p>
      <table className="w-full text-[11px]">
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-line">
              <td className="py-1">{displayIdentity(r)}</td>
              <td className="text-muted">{timeAgo(r.joinedAt)}</td>
              <td className="font-mono">{r.creditedTasks} task{r.creditedTasks === 1 ? "" : "s"}</td>
              <td className={r.active ? "font-semibold text-success" : "text-muted"}>
                {r.active ? "active" : "inactive"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopReferrers({ rows }: { rows: ReferralAdmin["topReferrers"] }) {
  const { openUser } = useStaffNav();
  const [sort, setSort] = useState<SortKey>("invites");
  const [open, setOpen] = useState<string | null>(null);
  const sorted = [...rows].sort((a, b) => (b[sort] as number) - (a[sort] as number));
  // A render helper, not a component (react-hooks/static-components).
  const sortBtn = (k: SortKey, label: string) => (
    <button onClick={() => setSort(k)}
      className={`uppercase ${sort === k ? "font-bold text-brand-ink" : "hover:text-brand-ink"}`}>
      {label}{sort === k ? " ▼" : ""}
    </button>
  );
  return (
    <div className="rounded-lg border-2 border-line-strong bg-card p-3">
      <h3 className="font-bold text-brand-ink">Top partners</h3>
      <p className="mt-1 text-xs text-muted">
        <strong>Invites</strong> is signups; <strong>Active</strong> is how many finished a task;{" "}
        <strong>Inactive</strong> is the rest. A big Inactive % next to a big invite count on one
        account is the shape of a fake-signup farm. Tap a column to sort, tap a row to see the
        invitees.
      </p>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Nobody has invited anyone yet.</p>
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
                const activePct = r.invites === 0 ? 0 : Math.round((r.activeInvites / r.invites) * 100);
                return (
                  <Fragment key={r.id}>
                    <tr className="cursor-pointer border-t border-line hover:bg-brand-tint/30"
                      onClick={() => setOpen(open === r.id ? null : r.id)}>
                      <td className="py-1.5">
                        <button onClick={(e) => { e.stopPropagation(); openUser(r.id); }} className="text-brand-ink hover:underline">
                          {displayIdentity(r)}
                        </button>
                        {r.status !== "active" && <span className="ms-1 text-danger">({r.status})</span>}
                        <span className="ms-1 text-muted">{open === r.id ? "▾" : "▸"}</span>
                      </td>
                      <td className="font-mono">{formatPoints(r.points)}</td>
                      <td className="font-mono">{n(r.invites)}</td>
                      <td className={`font-mono ${dead ? "font-bold text-danger" : ""}`}>{n(r.activeInvites)} · {activePct}%</td>
                      <td className={`font-mono ${farmish ? "font-bold text-danger" : "text-muted"}`}>
                        {n(r.inactiveInvites)} · {r.inactivePct}%
                      </td>
                      <td className={r.openFlags > 0 ? "font-bold text-danger" : "text-muted"}>
                        {r.openFlags || "—"}
                      </td>
                    </tr>
                    {open === r.id && (
                      <tr>
                        <td colSpan={6} className="pb-2"><InviteeList id={r.id} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// A compact ranking below "Top partners" (founder, 2026-09-02: "you can add it
// below top partners"). Same rows, same data — the Leaderboard tab's own "Top
// inviters" board reads from a much stricter query (a PAID referral bonus,
// api/src/leaderboard.ts) and stays empty until someone's invite has actually
// earned money; this one reuses the already-working `topReferrers` fetch
// (any invite counts) so there is a real "who invited the most people" answer
// here even before anyone's referral bonus has paid out.
function TopInviters({ rows }: { rows: ReferralAdmin["topReferrers"] }) {
  const { openUser } = useStaffNav();
  const top = [...rows].sort((a, b) => b.invites - a.invites).slice(0, 10);
  return (
    <div className="rounded-lg border-2 border-line-strong bg-card p-3">
      <h3 className="font-bold text-brand-ink">Top inviters</h3>
      <p className="mt-1 text-xs text-muted">Ranked by invites sent, top 10.</p>
      {top.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Nobody qualifies yet.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[360px] text-xs">
            <thead className="text-left uppercase text-muted">
              <tr><th className="py-1">#</th><th>User</th><th>Invites</th></tr>
            </thead>
            <tbody>
              {top.map((r, i) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="py-1.5 font-mono text-muted">{i + 1}</td>
                  <td><button onClick={() => openUser(r.id)} className="text-brand-ink hover:underline">{displayIdentity(r)}</button></td>
                  <td className="font-mono">{n(r.invites)}</td>
                </tr>
              ))}
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
  const prompt = usePrompt();

  async function hide(userId: string, email: string) {
    const reason = await prompt(
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
        <div className="rounded-lg border-2 border-line-strong bg-card p-3">
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
    rows: {
      rank: number; id: string; email: string; points: number; invites?: number;
      username?: string | null; telegramUsername?: string | null;
    }[];
    onHide: (id: string, email: string) => void;
    busy: string | null;
    showInvites?: boolean;
  },
) {
  const { openUser } = useStaffNav();
  return (
    <div className="rounded-lg border-2 border-line-strong bg-card p-3">
      <h3 className="font-bold text-brand-ink">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Nobody qualifies yet.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[440px] text-xs">
            <thead className="text-left uppercase text-muted">
              <tr>
                {/* Part 9 — no bare "Points" column: task/referral earnings are
                    shown the same way an earner sees their own (ROZI, option
                    B), with the real USDT value underneath since that figure
                    is genuinely real here too (a documented, currently-used
                    payout rate), not invented. */}
                <th className="py-1">#</th><th>User</th><th>Earned</th>
                {showInvites && <th>Invites</th>}<th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="py-1.5 font-mono text-muted">{r.rank}</td>
                  <td><button onClick={() => openUser(r.id)} className="text-brand-ink hover:underline">{displayIdentity(r)}</button></td>
                  <td className="font-mono">
                    {formatPointsAsRozi(r.points)}
                    <div className="text-[10px] text-muted">{formatMoney(r.points)}</div>
                  </td>
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
    <div className="rounded-lg border-2 border-line-strong p-2">
      <p className="text-[10px] uppercase text-muted">{label}</p>
      <p className="num font-semibold text-brand-ink">{value}</p>
      {sub && <p className="text-[10px] text-muted">{sub}</p>}
    </div>
  );
}

// ---- Leaderboard reward pools (founder, 2026-09-05) ------------------------
//
// Weekly/monthly ROZI prizes for the top of each track. Config is ONE JSON
// blob server-side — Save always sends the WHOLE object back (never a
// partial patch), so the draft state below mirrors that shape exactly.
// Tiers are edited as a comma-separated list ("150, 100, 70, 25") — position
// = rank, so reordering the numbers reorders which rank gets what. Simpler
// and harder to corrupt than a dynamic add/remove row list, and just as
// admin-editable.

type CycleDraft = { enabled: boolean; tiersEarnersRozi: string; tiersReferrersRozi: string };
type SettingsDraft = { enabled: boolean; weekly: CycleDraft; monthly: CycleDraft };

function toDraft(s: LeaderboardRewardSettings): SettingsDraft {
  const cycle = (c: LeaderboardRewardCycleConfig): CycleDraft => ({
    enabled: c.enabled,
    tiersEarnersRozi: c.tiersEarnersRozi.join(", "),
    tiersReferrersRozi: c.tiersReferrersRozi.join(", "),
  });
  return { enabled: s.enabled, weekly: cycle(s.weekly), monthly: cycle(s.monthly) };
}

function parseTiers(raw: string): number[] {
  // Filter blank tokens BEFORE parsing, same as mining-admin.tsx's
  // MilestoneEditor — a trailing/doubled comma ("150, 100,") would otherwise
  // parse the empty token as Number("") = 0, a phantom extra rank worth 0
  // ROZI that silently inflates the rank count shown and settled against.
  return raw.split(",").map((s) => s.trim()).filter((s) => s !== "")
    .map((s) => Number(s)).filter((n) => Number.isFinite(n) && n >= 0);
}

function fromDraft(d: SettingsDraft): LeaderboardRewardSettings {
  const cycle = (c: CycleDraft): LeaderboardRewardCycleConfig => ({
    enabled: c.enabled,
    tiersEarnersRozi: parseTiers(c.tiersEarnersRozi),
    tiersReferrersRozi: parseTiers(c.tiersReferrersRozi),
  });
  return { enabled: d.enabled, weekly: cycle(d.weekly), monthly: cycle(d.monthly) };
}

// Part 7 — a fair-distribution calculator on top of the tiers input above.
// It computes a preview table (rank / % / ROZI) for a total pool + winner
// count under a chosen method, then "Apply" writes the SAME comma-separated
// string a staff member would otherwise have typed by hand into the exact
// tiers field that already drives settlement (api/src/leaderboardRewards.ts)
// — this never talks to the API itself and never invents a second
// distribution engine, it only fills in the existing one's input faster and
// more fairly than typing 100 numbers by hand.
const POOL_PRESETS = [10, 20, 50, 100, 1000];
// A staff-facing display cap, not a design limit — the whole tier list still
// gets computed and applied at any winner count up to WINNERS_MAX below.
// React rendering tens of thousands of table rows with no virtualization
// would visibly stall the tab; nobody actually reads 10,000 rows to check
// them by eye anyway. The applied string (below) is never truncated.
const PREVIEW_ROW_CAP = 300;

function DistributionCalculator({ onApply }: { onApply: (tiers: string) => void }) {
  const [pool, setPool] = useState("100");
  const [winners, setWinners] = useState("10");
  const [method, setMethod] = useState<DistributionMethod>("balanced");
  const poolN = Math.max(0, Number(pool) || 0);
  // Founder, 2026-09-07: "if I select 1000 that goes distributed among 1000,
  // ... even 10,000 that goes distributed among 10,000." loadLeaderboard's
  // own query already aggregates every qualifying user regardless of the
  // LIMIT it is asked for (leaderboard.ts), so raising this cap adds no real
  // query cost — the underlying scan was already happening for the top-20
  // view.
  const WINNERS_MAX = 10_000;
  const winnersN = Math.max(0, Math.min(WINNERS_MAX, Math.floor(Number(winners) || 0)));
  const result = computeDistribution(poolN, winnersN, method);

  return (
    <div className="rounded-lg border border-line bg-brand-tint/20 p-2.5">
      <p className="text-xs font-semibold text-brand-ink">Distribution calculator</p>
      <p className="mt-0.5 text-[11px] text-muted">
        Pick a pool and a winner count (1–{WINNERS_MAX.toLocaleString()}) and this fills the field above
        for you — fairly, not typed rank by rank. <strong>Balanced competitive</strong> (the default) gives
        higher ranks a real edge without first place swallowing the pool; <strong>Equal</strong> splits it
        evenly across every winner, whether that&apos;s 10 people or 10,000.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-[10px] text-muted">Total pool (ROZI)<br />
          <input type="number" min={0} value={pool} onChange={(e) => setPool(e.target.value)}
            className="mt-0.5 w-24 rounded border border-line bg-card px-1.5 py-1 text-xs num" />
        </label>
        <label className="text-[10px] text-muted">Winners (1–{WINNERS_MAX.toLocaleString()})<br />
          <input type="number" min={1} max={WINNERS_MAX} value={winners} onChange={(e) => setWinners(e.target.value)}
            className="mt-0.5 w-24 rounded border border-line bg-card px-1.5 py-1 text-xs num" />
        </label>
        <label className="text-[10px] text-muted">Method<br />
          <select value={method} onChange={(e) => setMethod(e.target.value as DistributionMethod)}
            className="mt-0.5 rounded border border-line bg-card px-1.5 py-1 text-xs">
            <option value="balanced">Balanced competitive</option>
            <option value="equal">Equal</option>
          </select>
        </label>
        <div className="flex flex-wrap gap-1">
          {POOL_PRESETS.map((p) => (
            <button key={p} type="button" onClick={() => setPool(String(p))}
              className="rounded bg-card px-1.5 py-1 text-[10px] font-semibold text-brand border border-line">
              {p} ROZI
            </button>
          ))}
        </div>
      </div>

      {result.tooSmallForWinnerCount && (
        <p className="mt-2 rounded bg-danger-tint p-1.5 text-[11px] text-danger">
          This pool is too small for {winnersN} winners — some ranks would get 0 ROZI. Raise the pool
          or lower the winner count.
        </p>
      )}
      {result.firstToLastRatio != null && (
        <p className="mt-1.5 text-[11px] text-muted">
          Rank 1 gets <strong>{result.firstToLastRatio}×</strong> what rank {winnersN} gets.
        </p>
      )}

      {result.rows.length > 0 && (
        <div className="mt-2 max-h-48 overflow-y-auto rounded border border-line">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-card text-left uppercase text-muted">
              <tr><th className="px-1.5 py-1">Rank</th><th className="px-1.5 py-1">%</th><th className="px-1.5 py-1">ROZI</th></tr>
            </thead>
            <tbody>
              {result.rows.slice(0, PREVIEW_ROW_CAP).map((r) => (
                <tr key={r.rank} className={`border-t border-line ${r.rozi === 0 ? "text-danger" : ""}`}>
                  <td className="px-1.5 py-0.5 font-mono">{r.rank}</td>
                  <td className="px-1.5 py-0.5 font-mono">{r.percent}%</td>
                  <td className="px-1.5 py-0.5 font-mono">{n(r.rozi)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.rows.length > PREVIEW_ROW_CAP && (
            <p className="border-t border-line bg-brand-tint/30 px-1.5 py-1 text-[10px] text-muted">
              Showing the first {PREVIEW_ROW_CAP} of {result.rows.length} ranks — Apply still fills in
              every one of them.
            </p>
          )}
        </div>
      )}

      <button type="button" disabled={result.rows.length === 0}
        onClick={() => onApply(distributionToTiersString(result))}
        className="mt-2 rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
        Apply to the field above
      </button>
    </div>
  );
}

// Part 5/6 — the mining-allocation summary at the top of the builder.
function MiningReserveSummary() {
  const reserve = useApi(fetchLeaderboardMiningReserve, []);
  if (reserve.loading || !reserve.data) return null;
  const r = reserve.data;
  return (
    <div className="rounded-lg border-2 border-line-strong bg-card p-3">
      <h3 className="font-bold text-brand-ink">Mining allocation — what a new pool draws from</h3>
      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        <div><p className="text-[10px] uppercase text-muted">Official cap</p><p className="num font-semibold text-brand-ink">{n(r.capRozi)}</p></div>
        <div><p className="text-[10px] uppercase text-muted">Already emitted</p><p className="num font-semibold text-brand-ink">{n(Math.round(r.emittedRozi))}</p></div>
        <div><p className="text-[10px] uppercase text-muted">Available reserve</p><p className="num font-semibold text-success">{n(Math.round(r.remainingRozi))}</p></div>
      </div>
      <p className="mt-2 text-[11px] text-muted">
        A reward pool never mints past the cap: if what every cadence&apos;s tiers ask for exceeds
        what&apos;s left, every payout that week/month is scaled down proportionally at settlement —
        the same protection mining&apos;s own daily payouts already use. There is no separate
        up-front reservation; this figure is the live source of truth, not a snapshot that can go stale.
      </p>
    </div>
  );
}

export function LeaderboardRewardsPanel() {
  const data = useApi(fetchLeaderboardRewardSettings, []);
  const cycles = useApi(() => fetchLeaderboardRewardCycles(20), []);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (data.loading) return <p className="p-4 text-sm text-muted">Loading…</p>;
  if (data.error || !data.data) return <p className="p-4 text-sm text-danger">{data.error}</p>;
  const live = draft ?? toDraft(data.data.settings);

  function set(patch: Partial<SettingsDraft>) { setDraft({ ...live, ...patch }); }
  function setCycle(cadence: "weekly" | "monthly", patch: Partial<CycleDraft>) {
    set({ [cadence]: { ...live[cadence], ...patch } } as Partial<SettingsDraft>);
  }

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const next = fromDraft(live);
      await saveLeaderboardRewardSettings(next);
      setDraft(null);
      setMsg("Saved.");
      data.reload();
    } catch (e) { setMsg((e as Error).message); } finally { setSaving(false); }
  }

  return (
    <div className="space-y-5">
      <MiningReserveSummary />

      <p className="rounded-lg border border-line bg-card p-2.5 text-xs text-muted">
        Real ROZI, paid automatically once a week/month closes — top earners AND top
        inviters, each on their own tiers. Ships <strong>off</strong> until you turn it on here.
        A user hidden from the leaderboard (the panel above) is hidden from these prizes too.
      </p>

      {msg && (
        <p className={`rounded-md p-2 text-xs ${msg === "Saved." ? "bg-success-tint text-success" : "bg-danger-tint text-danger"}`}>
          {msg}
        </p>
      )}

      <label className="flex items-center gap-2 rounded-lg border-2 border-line-strong bg-card p-3">
        <input type="checkbox" checked={live.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span className="text-sm font-semibold text-brand-ink">Reward pools are ON (master switch)</span>
      </label>

      {(["weekly", "monthly"] as const).map((cadence) => {
        const c = live[cadence];
        const earnersSum = parseTiers(c.tiersEarnersRozi).reduce((a, n) => a + n, 0);
        const referrersSum = parseTiers(c.tiersReferrersRozi).reduce((a, n) => a + n, 0);
        return (
          <div key={cadence} className="rounded-lg border-2 border-line-strong bg-card p-3 space-y-3">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={c.enabled}
                onChange={(e) => setCycle(cadence, { enabled: e.target.checked })} />
              <span className="font-bold capitalize text-brand-ink">{cadence}</span>
            </label>
            <div>
              <p className="text-[10px] uppercase text-muted">Top earners — ROZI per rank (rank 1 first)</p>
              <input value={c.tiersEarnersRozi} onChange={(e) => setCycle(cadence, { tiersEarnersRozi: e.target.value })}
                placeholder="150, 100, 70, 25, 25, 25, 25, 25, 25, 25"
                className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-xs num" />
              <p className="mt-0.5 text-[10px] text-muted">Pool: {n(earnersSum)} ROZI across {parseTiers(c.tiersEarnersRozi).length} ranks</p>
              <div className="mt-1.5">
                <DistributionCalculator onApply={(tiers) => setCycle(cadence, { tiersEarnersRozi: tiers })} />
              </div>
            </div>
            <div>
              <p className="text-[10px] uppercase text-muted">Top inviters — ROZI per rank (rank 1 first)</p>
              <input value={c.tiersReferrersRozi} onChange={(e) => setCycle(cadence, { tiersReferrersRozi: e.target.value })}
                placeholder="150, 100, 70, 25, 25, 25, 25, 25, 25, 25"
                className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-xs num" />
              <p className="mt-0.5 text-[10px] text-muted">Pool: {n(referrersSum)} ROZI across {parseTiers(c.tiersReferrersRozi).length} ranks</p>
              <div className="mt-1.5">
                <DistributionCalculator onApply={(tiers) => setCycle(cadence, { tiersReferrersRozi: tiers })} />
              </div>
            </div>
          </div>
        );
      })}

      <button onClick={save} disabled={saving}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
        {saving ? "Saving…" : "Save"}
      </button>

      <div className="rounded-lg border-2 border-line-strong bg-card p-3">
        <h3 className="font-bold text-brand-ink">Recent cycles</h3>
        <p className="text-xs text-muted">Every settled week/month, what it paid, and who won — this is the receipt.</p>
        {cycles.loading ? (
          <p className="mt-2 text-sm text-muted">Loading…</p>
        ) : !cycles.data || cycles.data.cycles.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Nothing has settled yet.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {cycles.data.cycles.map((c) => (
              <details key={c.id} className="rounded-md border border-line p-2">
                <summary className="cursor-pointer text-xs">
                  <span className="font-semibold capitalize text-brand-ink">{c.cycleType} · {c.track}</span>{" "}
                  <span className="text-muted">
                    {new Date(c.periodStart).toLocaleDateString()} – {new Date(c.periodEnd).toLocaleDateString()}
                  </span>{" "}
                  · paid <span className="num">{formatRozi(c.paidMicro)}</span> ROZI
                  {c.scaleFactor < 1 && (
                    <span className="ml-1 rounded bg-pending-tint px-1 text-pending">
                      scaled {(c.scaleFactor * 100).toFixed(0)}% — cap was tight
                    </span>
                  )}
                  <span className="ml-1 text-muted">· {timeAgo(c.settledAt)}</span>
                </summary>
                <table className="mt-2 w-full text-xs">
                  <tbody>
                    {c.winners.map((w) => (
                      <tr key={w.userId} className="border-t border-line first:border-t-0">
                        <td className="py-1 font-mono text-muted">#{w.rank}</td>
                        <td className="text-brand-ink">{w.email}</td>
                        <td className="num text-right">{formatRozi(w.micro)} ROZI</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
