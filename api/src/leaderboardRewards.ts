// Weekly + monthly ROZI prizes for the top of each leaderboard track
// (founder, 2026-09-05). Ships OFF by default — see
// leaderboardRewardSettings.ts's own header — until an admin sets real tiers
// and turns a cadence on in /staff.
//
// SAME SHAPE AS mining/engine.ts's settleEpoch(), on purpose: idempotent on a
// unique row (cycle_type, track, period_start), a global TRY (not blocking)
// advisory lock so two ticking replicas can't both mint the same cycle, and
// every payout scaled by the SAME capScaleFactor() mining already uses so a
// reward pool can never push cumulative ROZI past the 21M cap — it is
// counted in totalEmittedMicro() (mining/settings.ts) for exactly this reason.
import { sql, now, newId, postRozi } from "./db.ts";
import { loadLeaderboard, type LeaderboardRange } from "./leaderboard.ts";
import { loadLeaderboardRewardSettings, type LeaderboardRewardSettings } from "./leaderboardRewardSettings.ts";
import { loadMiningSettings, totalEmittedMicro } from "./mining/settings.ts";
import { toMicro, capScaleFactor } from "./mining/core.ts";

export type CycleType = "weekly" | "monthly";
export type Track = "earners" | "referrers";

// ---- Period boundaries ------------------------------------------------------
// UTC-normalized so "This Week"/"This Month" on the public leaderboard and
// "what period did the prize settle over" in the admin panel are always
// describing the exact same window — see leaderboard.ts's LeaderboardRange
// header for why that consistency matters.

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The period containing `at` — Monday 00:00 UTC..next Monday for weekly, the 1st..next 1st (UTC) for monthly. Still in progress if `at` is now. */
export function currentPeriodBounds(cycleType: CycleType, at: Date = new Date()): { startISO: string; endISO: string } {
  if (cycleType === "weekly") {
    const day = startOfUtcDay(at);
    const dow = day.getUTCDay(); // 0=Sun..6=Sat
    const sinceMonday = (dow + 6) % 7; // Mon=0 .. Sun=6
    const start = new Date(day); start.setUTCDate(day.getUTCDate() - sinceMonday);
    const end = new Date(start); end.setUTCDate(start.getUTCDate() + 7);
    return { startISO: start.toISOString(), endISO: end.toISOString() };
  }
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

/** The period immediately BEFORE the one containing `at` — the one that has fully closed and is due for settlement. */
export function previousPeriodBounds(cycleType: CycleType, at: Date = new Date()): { startISO: string; endISO: string } {
  const cur = currentPeriodBounds(cycleType, at);
  const curStart = new Date(cur.startISO);
  if (cycleType === "weekly") {
    const start = new Date(curStart); start.setUTCDate(curStart.getUTCDate() - 7);
    return { startISO: start.toISOString(), endISO: cur.startISO };
  }
  const start = new Date(Date.UTC(curStart.getUTCFullYear(), curStart.getUTCMonth() - 1, 1));
  return { startISO: start.toISOString(), endISO: cur.startISO };
}

function tiersFor(settings: LeaderboardRewardSettings, cycleType: CycleType, track: Track): number[] {
  const cfg = settings[cycleType];
  return track === "earners" ? cfg.tiersEarnersRozi : cfg.tiersReferrersRozi;
}

export type SettleResult =
  | { skipped: string; cycleId?: undefined; paidMicro: 0; winners: 0 }
  | { skipped?: undefined; cycleId: string; paidMicro: number; winners: number };

/**
 * Settle ONE (cycle_type, track) for the given closed period. Idempotent: a
 * second call for the same period is a fast no-op (returns `skipped`), never
 * a second mint. Call this once per tick per (cycleType, track) — the tick
 * itself decides which period is currently due (previousPeriodBounds).
 */
export async function settleLeaderboardCycle(
  cycleType: CycleType, track: Track, periodStartISO: string, periodEndISO: string,
): Promise<SettleResult> {
  return sql.tx(async (t) => {
    // ⚠️ SAME GLOBAL KEY mining/engine.ts's settleEpoch() USES
    // ('rozi-settlement'), NOT a per-cycle key. This is deliberate and not
    // just borrowed style: both this job and mining settlement read
    // totalEmittedMicro() and mint against the SAME 21M cap, on their own
    // independent timers. A per-cycle lock key only stops two leaderboard
    // settlements from colliding with EACH OTHER — it does nothing to stop
    // this settlement and a mining settlement tick from interleaving, each
    // reading the same stale "already emitted" total and both minting past
    // the cap. Caught in review before this ever shipped. TRY, not wait — a
    // decline just means "the other one has the cap right now", and this is
    // idempotent + cheap to retry next tick.
    const lock = await t.get<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('rozi-settlement')) AS locked");
    if (!lock?.locked) return { skipped: "another settlement is already running", paidMicro: 0, winners: 0 };

    const already = await t.get<{ id: string }>(
      "SELECT id FROM leaderboard_reward_cycles WHERE cycle_type = ? AND track = ? AND period_start = ?",
      cycleType, track, periodStartISO,
    );
    if (already) return { skipped: "already settled", paidMicro: 0, winners: 0 };

    const settings = await loadLeaderboardRewardSettings();
    if (!settings.enabled || !settings[cycleType].enabled) {
      return { skipped: "disabled", paidMicro: 0, winners: 0 };
    }
    const tiersRozi = tiersFor(settings, cycleType, track);
    if (tiersRozi.length === 0) return { skipped: "no tiers configured", paidMicro: 0, winners: 0 };

    // Read OUTSIDE this transaction, deliberately — the period this ranks
    // over is already CLOSED (periodEndISO has already elapsed by the time a
    // settlement is due), so its ledger rows are settled fact, not something
    // that could still change under us mid-transaction. Only the MINT
    // (postRozi, below) needs to be inside `t`.
    const range: LeaderboardRange = { sinceISO: periodStartISO, untilISO: periodEndISO };
    const board = await loadLeaderboard(range, tiersRozi.length);
    const rows = track === "earners" ? board.earners : board.referrers;
    if (rows.length === 0) return { skipped: "no eligible winners this period", paidMicro: 0, winners: 0 };

    const wantedMicro = rows.reduce((a, _r, i) => a + toMicro(tiersRozi[i] ?? 0), 0);
    const capMicro = toMicro((await loadMiningSettings()).supplyCap);
    const alreadyEmittedMicro = await totalEmittedMicro(t);
    const roomMicro = Math.max(0, capMicro - alreadyEmittedMicro);
    const scale = capScaleFactor(wantedMicro, roomMicro);

    const cycleId = newId();
    let paidMicro = 0;
    const payouts: { userId: string; rank: number; score: number; micro: number; ledgerId: string }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const rawMicro = toMicro(tiersRozi[i] ?? 0);
      const micro = Math.floor(rawMicro * scale);
      if (micro <= 0) continue;
      const r = rows[i] as { id: string; earned?: number; ref_points?: number };
      const score = track === "earners" ? (r.earned ?? 0) : (r.ref_points ?? 0);
      const ledgerId = await postRozi({
        userId: r.id, micro, direction: "credit", sourceType: "leaderboard_reward",
        sourceRefId: cycleId, note: `${cycleType} ${track} leaderboard, rank ${i + 1}`,
      }, t);
      paidMicro += micro;
      payouts.push({ userId: r.id, rank: i + 1, score, micro, ledgerId });
    }

    await t.run(
      `INSERT INTO leaderboard_reward_cycles
         (id, cycle_type, track, period_start, period_end, wanted_micro, paid_micro, scale_factor, settled_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      cycleId, cycleType, track, periodStartISO, periodEndISO, wantedMicro, paidMicro, scale, now(),
    );
    for (const p of payouts) {
      await t.run(
        `INSERT INTO leaderboard_reward_payouts
           (id, cycle_id, user_id, rank, score, micro, rozi_ledger_id, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        newId(), cycleId, p.userId, p.rank, p.score, p.micro, p.ledgerId, now(),
      );
    }
    return { cycleId, paidMicro, winners: payouts.length };
  });
}

// A safety cap on how many past periods one tick will backfill per
// (cycleType, track) — not a design limit, a "cannot hammer the ledger
// unboundedly in one tick" guard for the edge case that actually matters
// (a feature switched on long after launch, or a long outage). 8 weeks / 8
// months is generous headroom over any real gap; further periods still
// backfill on the NEXT tick, one at a time, until caught up.
const MAX_BACKFILL_PERIODS = 8;

async function isPeriodSettled(cycleType: CycleType, track: Track, periodStartISO: string): Promise<boolean> {
  const row = await sql.get<{ id: string }>(
    "SELECT id FROM leaderboard_reward_cycles WHERE cycle_type = ? AND track = ? AND period_start = ?",
    cycleType, track, periodStartISO,
  );
  return !!row;
}

/**
 * Settle every (cycleType, track) whose previous period has closed AND is not
 * yet settled — walking backward from "the period immediately before now"
 * until an ALREADY-settled period is found (periods are always settled
 * oldest-first, so that is proof every older one was already handled), so a
 * process that was down across more than one boundary — or a cadence just
 * turned on — still pays every missed period, not only the newest one. Safe
 * to call on any cadence: the common case is one cheap existence check that
 * immediately confirms "nothing more to backfill", and a settlement that
 * finds nothing due does no writes. Called from server.ts's everyNoOverlap,
 * same pattern as mining settlement (settleDueEpochs walks every unsettled
 * epoch for the identical reason).
 */
export async function tickLeaderboardRewards(
  onSettled?: (cycleId: string, cycleType: CycleType, track: Track) => void | Promise<void>,
): Promise<void> {
  const settings = await loadLeaderboardRewardSettings();
  if (!settings.enabled) return;
  const atNow = new Date();
  for (const cycleType of ["weekly", "monthly"] as const) {
    if (!settings[cycleType].enabled) continue;
    for (const track of ["earners", "referrers"] as const) {
      // Walk backward collecting DUE (unsettled, closed) periods, oldest last
      // in the walk — reverse before settling so they are paid oldest-first,
      // matching the "always settled in order" assumption the stop condition
      // above relies on.
      const due: { startISO: string; endISO: string }[] = [];
      let bounds = previousPeriodBounds(cycleType, atNow);
      for (let i = 0; i < MAX_BACKFILL_PERIODS; i++) {
        if (await isPeriodSettled(cycleType, track, bounds.startISO)) break;
        due.push(bounds);
        bounds = previousPeriodBounds(cycleType, new Date(bounds.startISO));
      }
      due.reverse();
      for (const b of due) {
        try {
          const result = await settleLeaderboardCycle(cycleType, track, b.startISO, b.endISO);
          if (result.cycleId && onSettled) await onSettled(result.cycleId, cycleType, track);
        } catch (e) {
          console.error(`[leaderboardRewards] settlement failed for ${cycleType}/${track}`, e);
        }
      }
    }
  }
}
