// ROZI mining — everything that touches the database. The maths it calls lives
// in ./core.ts as pure functions; this file is the plumbing around it.
//
// Reading order: hashrateOf() (what a miner is worth right now) -> startSession
// / accrue() (how that becomes shares) -> settleEpoch() (how shares become ROZI).
import { sql, now, newId, postRozi, type TxApi } from "../db.ts";
import { flagOnce } from "../fraud.ts";
import {
  epochOf, epochEndMs, splitByEpoch, cappedEmissionMicro, computeHashrate,
  payoutMicroFor, rigPower, parseMilestones, piBaseRateFor, piPayoutMicroFor,
  capScaleFactor, toMicro,
} from "./core.ts";
import { loadMiningSettings, totalEmittedMicro, type MiningSettings } from "./settings.ts";

// ---- "pi" model helpers ----------------------------------------------------

// The population the halving milestones are measured against.
//
// Counted, deliberately, WITHOUT filtering: more users only ever means a LOWER
// rate, so there is no incentive for anyone to inflate this number — and a
// stricter filter (verified only, active only) would let a wave of unverified
// signups mine at the pre-halving rate while the throttle stared past them.
export async function minerPopulation(t: Pick<TxApi, "get"> = sql): Promise<number> {
  const r = await t.get<{ n: string }>("SELECT COUNT(*) AS n FROM users");
  return Number(r?.n ?? 0);
}

// The rate one baseline miner earns for a full day, right now, after however many
// milestone halvings the user base has already triggered.
export function effectivePiRate(s: MiningSettings, userCount: number): number {
  return piBaseRateFor(userCount, s.piBaseRate, parseMilestones(s.piHalvingUsers));
}

// Shares a baseline miner (no multipliers) books over one full reference day.
// Dividing a user's shares by this converts hashrate-seconds into "baseline days".
export function piFullDayShares(s: MiningSettings): number {
  return s.baseHashrate * s.piReferenceHours * 3600;
}

// ---- Hashrate -------------------------------------------------------------

async function rigPowerOf(userId: string): Promise<number> {
  const rows = await sql.all<{
    rig_id: string; level: number; base_cost: number; cost_growth: number;
    base_power: number; power_growth: number; max_level: number;
  }>(
    `SELECT ur.rig_id, ur.level, r.base_cost, r.cost_growth, r.base_power,
            r.power_growth, r.max_level
     FROM user_rigs ur JOIN rigs r ON r.id = ur.rig_id
     WHERE ur.user_id = ? AND r.status = 'active'`,
    userId,
  );
  return rows.reduce((sum, r) => sum + rigPower(
    { baseCost: r.base_cost, costGrowth: r.cost_growth, basePower: r.base_power,
      powerGrowth: r.power_growth, maxLevel: r.max_level },
    r.level,
  ), 0);
}

// Live boosts, newest first. Task boosts are capped at `taskBoostMaxStack` here
// rather than at grant time: capping at grant would silently throw away a boost
// the user genuinely earned, and if the Admin later raises the cap those boosts
// should come back. So we grant everything and only ever cap on read.
async function activeBoostPcts(userId: string, s: MiningSettings): Promise<number[]> {
  const rows = await sql.all<{ kind: string; multiplier_pct: number }>(
    "SELECT kind, multiplier_pct FROM user_boosts WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC",
    userId, now(),
  );
  const out: number[] = [];
  let taskCount = 0;
  for (const r of rows) {
    if (r.kind === "task") {
      if (taskCount >= s.taskBoostMaxStack) continue;
      taskCount++;
    }
    out.push(r.multiplier_pct);
  }
  return out;
}

// A user's OWN hashrate — everything except the referral component — computed for
// MANY users in a fixed number of queries.
//
// Excluding the referral component is not an optimisation, it breaks a recursion
// that would otherwise be fatal: if your hashrate included your referral bonus,
// and your referral bonus was a % of your invitees' hashrate, then a referral
// cycle (A invites B invites A — which the data model does not forbid) loops
// forever. Inheriting only the invitee's OWN hashrate makes the graph acyclic by
// construction.
//
// Batching is not an optimisation either. The obvious version — loop the downline
// calling a single-user helper — is three queries per invitee, on every
// /mining/state poll AND every accrual. A user with a 10,000-strong downline would
// fire ~30,000 queries per request and take the API down: success would have been
// the outage. So: three aggregate queries for the whole set, arithmetic in JS.
async function ownHashrateBatch(
  userIds: string[], s: MiningSettings,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (userIds.length === 0) return out;

  const ph = userIds.map(() => "?").join(",");
  const [rigRows, boostRows, streakRows] = await Promise.all([
    sql.all<{ user_id: string; rig_id: string; level: number; base_cost: number;
              cost_growth: number; base_power: number; power_growth: number; max_level: number }>(
      `SELECT ur.user_id, ur.rig_id, ur.level, r.base_cost, r.cost_growth, r.base_power,
              r.power_growth, r.max_level
       FROM user_rigs ur JOIN rigs r ON r.id = ur.rig_id
       WHERE ur.user_id IN (${ph}) AND r.status = 'active'`, ...userIds),
    sql.all<{ user_id: string; kind: string; multiplier_pct: number }>(
      `SELECT user_id, kind, multiplier_pct FROM user_boosts
       WHERE user_id IN (${ph}) AND expires_at > ? ORDER BY created_at DESC`,
      ...userIds, now()),
    sql.all<{ user_id: string; current_days: number }>(
      `SELECT user_id, current_days FROM mining_streaks WHERE user_id IN (${ph})`, ...userIds),
  ]);

  const rigPowerBy = new Map<string, number>();
  for (const r of rigRows) {
    const power = rigPower(
      { baseCost: Number(r.base_cost), costGrowth: r.cost_growth, basePower: r.base_power,
        powerGrowth: r.power_growth, maxLevel: r.max_level },
      r.level,
    );
    rigPowerBy.set(r.user_id, (rigPowerBy.get(r.user_id) ?? 0) + power);
  }

  // Same task-boost stack cap as activeBoostPcts(), applied per user.
  const boostsBy = new Map<string, number[]>();
  const taskCountBy = new Map<string, number>();
  for (const b of boostRows) {
    if (b.kind === "task") {
      const n = taskCountBy.get(b.user_id) ?? 0;
      if (n >= s.taskBoostMaxStack) continue;
      taskCountBy.set(b.user_id, n + 1);
    }
    const list = boostsBy.get(b.user_id) ?? [];
    list.push(b.multiplier_pct);
    boostsBy.set(b.user_id, list);
  }

  const streakBy = new Map(streakRows.map((r) => [r.user_id, r.current_days]));

  for (const id of userIds) {
    out.set(id, computeHashrate({
      base: s.baseHashrate,
      rigPower: rigPowerBy.get(id) ?? 0,
      streakDays: streakBy.get(id) ?? 0,
      streakStepPct: s.streakStepPct,
      streakCapDays: s.streakCapDays,
      boostPcts: boostsBy.get(id) ?? [],
      referralHashrate: 0, // the recursion break — see ownHashrate() above
      referralCapPct: s.referralCapPct,
      maxHashrate: s.maxHashrate,
    }));
  }
  return out;
}

// Hashrate inherited from the downline. An invitee who has not mined within
// `referralActiveHours` contributes ZERO — dead signups are worth nothing, which
// is the whole anti-farm point of doing it this way instead of paying per signup.
async function referralHashrateOf(userId: string, s: MiningSettings): Promise<number> {
  const cutoff = new Date(Date.now() - s.referralActiveHours * 3600_000).toISOString();

  const active = async (referrerIds: string[]): Promise<string[]> => {
    if (referrerIds.length === 0) return [];
    const placeholders = referrerIds.map(() => "?").join(",");
    const rows = await sql.all<{ id: string }>(
      `SELECT DISTINCT u.id FROM users u
       JOIN mining_sessions ms ON ms.user_id = u.id
       WHERE u.referred_by IN (${placeholders})
         AND u.status = 'active'
         AND ms.started_at > ?`,
      ...referrerIds, cutoff,
    );
    return rows.map((r) => r.id);
  };

  const l1 = await active([userId]);
  const l2 = (await active(l1)).filter((id) => id !== userId && !l1.includes(id));

  const power = await ownHashrateBatch([...l1, ...l2], s);
  let total = 0;
  for (const id of l1) total += (power.get(id) ?? 0) * (s.referralL1Pct / 100);
  for (const id of l2) total += (power.get(id) ?? 0) * (s.referralL2Pct / 100);
  return Math.floor(total);
}

export async function hashrateOf(
  userId: string,
  s?: MiningSettings,
): Promise<{ hashrate: number; breakdown: Record<string, number> }> {
  const cfg = s ?? (await loadMiningSettings());
  const [rigs, boosts, streak, referral] = await Promise.all([
    rigPowerOf(userId),
    activeBoostPcts(userId, cfg),
    sql.get<{ current_days: number }>(
      "SELECT current_days FROM mining_streaks WHERE user_id = ?", userId),
    referralHashrateOf(userId, cfg),
  ]);
  const streakDays = streak?.current_days ?? 0;
  const hashrate = computeHashrate({
    base: cfg.baseHashrate,
    rigPower: rigs,
    streakDays,
    streakStepPct: cfg.streakStepPct,
    streakCapDays: cfg.streakCapDays,
    boostPcts: boosts,
    referralHashrate: referral,
    referralCapPct: cfg.referralCapPct,
    maxHashrate: cfg.maxHashrate,
  });
  return {
    hashrate,
    breakdown: {
      base: cfg.baseHashrate,
      rigs,
      streakDays,
      streakMultiplierPct: Math.round(
        (1 + (cfg.streakStepPct / 100) * Math.min(streakDays, cfg.streakCapDays)) * 100),
      boostPct: boosts.reduce((a, b) => a + b, 0),
      referral,
    },
  };
}

// ---- Boosts ---------------------------------------------------------------

export async function grantBoost(
  userId: string,
  kind: "task" | "ad" | "points",
  pct: number,
  hours: number,
  sourceRefId?: string,
  t: Pick<TxApi, "run"> = sql,
): Promise<void> {
  await t.run(
    `INSERT INTO user_boosts (id, user_id, kind, multiplier_pct, expires_at, source_ref_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    newId(), userId, kind, pct,
    new Date(Date.now() + hours * 3600_000).toISOString(),
    sourceRefId ?? null, now(),
  );
}

// ---- Streak ---------------------------------------------------------------

// Called when a session starts. Consecutive epochs extend the streak; a gap
// resets it to 1 (not 0 — today still counts, you just lost the run).
async function touchStreak(userId: string, epoch: number): Promise<void> {
  const row = await sql.get<{ current_days: number; best_days: number; last_epoch: number | null }>(
    "SELECT current_days, best_days, last_epoch FROM mining_streaks WHERE user_id = ?", userId,
  );
  if (!row) {
    await sql.run(
      "INSERT INTO mining_streaks (user_id, current_days, best_days, last_epoch, updated_at) VALUES (?,1,1,?,?)",
      userId, epoch, now(),
    );
    return;
  }
  if (row.last_epoch === epoch) return;               // already counted today
  const next = row.last_epoch === epoch - 1 ? row.current_days + 1 : 1;
  await sql.run(
    "UPDATE mining_streaks SET current_days = ?, best_days = ?, last_epoch = ?, updated_at = ? WHERE user_id = ?",
    next, Math.max(next, row.best_days), epoch, now(), userId,
  );
}

// ---- Sessions -------------------------------------------------------------

export type SessionState = {
  active: boolean;
  expiresAt?: string;
  hashrate: number;
  sharesToday: number;
  estimatedRoziMicro: number;
  // False under the pi model, where estimatedRozi is what the user has actually
  // earned and cannot be moved by anyone else. True under the pool model, where
  // it is a live estimate that shrinks as more people mine.
  estimateIsLive: boolean;
  deviceBlocked: boolean;
};

// THE anti-farm rule (MINING_SPEC.md § 9): a device may accrue shares for exactly
// ONE user per epoch. The PK on (epoch, device_id) is what enforces it — two
// concurrent requests from a phone running two accounts cannot both win the row.
//
// The second account is NOT blocked from using the app, and its session still
// runs. It simply accrues nothing, and staff get a flag. Blocking outright would
// punish the family-shares-one-phone case, which is common in our markets.
async function claimDevice(epoch: number, deviceId: string, userId: string): Promise<boolean> {
  if (!deviceId) return true; // no fingerprint => cannot enforce; other rules apply
  await sql.run(
    `INSERT INTO mining_epoch_devices (epoch, device_id, user_id, created_at)
     VALUES (?,?,?,?) ON CONFLICT (epoch, device_id) DO NOTHING`,
    epoch, deviceId, userId, now(),
  );
  const owner = await sql.get<{ user_id: string }>(
    "SELECT user_id FROM mining_epoch_devices WHERE epoch = ? AND device_id = ?",
    epoch, deviceId,
  );
  if (owner?.user_id === userId) return true;

  await flagOnce(
    "mining_device_share", `${deviceId}:e${epoch}`, userId, "high",
    `Device ${deviceId} already mined for user ${owner?.user_id} in epoch ${epoch}; ` +
    `user ${userId} accrues zero shares.`,
  );
  return false;
}

export async function startSession(
  userId: string,
  deviceId: string,
): Promise<{ ok: true; expiresAt: string } | { ok: false; reason: string }> {
  const s = await loadMiningSettings();

  // Mining is free to mint, so it is the most bot-attractive surface we have.
  // An unverified email is the cheapest possible account; require the one thing
  // that costs an attacker something.
  const user = await sql.get<{ email_verified: number; status: string }>(
    "SELECT email_verified, status FROM users WHERE id = ?", userId,
  );
  if (!user || user.status !== "active") return { ok: false, reason: "Account is not active." };
  if (!user.email_verified) return { ok: false, reason: "Verify your email to start mining." };

  await accrue(userId); // close out any expired session before opening a new one

  const existing = await sql.get<{ expires_at: string }>(
    "SELECT expires_at FROM mining_sessions WHERE user_id = ? AND status = 'active'", userId,
  );
  if (existing) return { ok: true, expiresAt: existing.expires_at };

  const epoch = epochOf();
  await claimDevice(epoch, deviceId, userId);
  await touchStreak(userId, epoch);

  const startedAt = now();
  const expiresAt = new Date(Date.now() + s.sessionHours * 3600_000).toISOString();
  await sql.run(
    `INSERT INTO mining_sessions (id, user_id, device_id, started_at, expires_at, last_accrued_at, status)
     VALUES (?,?,?,?,?,?,'active')`,
    newId(), userId, deviceId || null, startedAt, expiresAt, startedAt,
  );
  return { ok: true, expiresAt };
}

// Credit the seconds elapsed since the last accrual at the CURRENT hashrate, and
// close the session if it has expired. Called on every status poll and before any
// action that changes hashrate, so a boost that lands mid-session applies from
// that moment forward and is never applied retroactively to seconds already paid.
export async function accrue(userId: string): Promise<void> {
  const session = await sql.get<{
    id: string; device_id: string | null; expires_at: string; last_accrued_at: string;
  }>(
    "SELECT id, device_id, expires_at, last_accrued_at FROM mining_sessions WHERE user_id = ? AND status = 'active'",
    userId,
  );
  if (session) await accrueSession(userId, session);
}

type SessionRow = {
  id: string; device_id: string | null; expires_at: string; last_accrued_at: string;
};

async function accrueSession(userId: string, session: SessionRow): Promise<void> {
  const nowMs = Date.now();
  const expiresMs = Date.parse(session.expires_at);
  const lastMs = Date.parse(session.last_accrued_at);
  const untilMs = Math.min(nowMs, expiresMs);

  if (untilMs > lastMs) {
    // Chop the elapsed time at UTC midnight and book each slice to the day it
    // actually happened in. Sessions are 8 hours, so one started in the evening
    // routinely spans two days; crediting all of it to the start day would give
    // the user tomorrow's mining on yesterday's ledger — and if yesterday is
    // already settled, that share is gone for good.
    const slices = splitByEpoch(lastMs, untilMs);
    const { hashrate } = await hashrateOf(userId);

    for (const { epoch, seconds } of slices) {
      // Never write into a day that has already paid out. If we did, the shares
      // would sit in mining_shares forever and never be settled — invisible, and
      // silently stolen from the user. It should be impossible (the sweep +
      // grace period below exist to make sure accrual always lands first), so if
      // it ever happens we want it loud in the logs rather than quiet in the DB.
      const settled = await sql.get<{ epoch: number }>(
        "SELECT epoch FROM mining_epochs WHERE epoch = ?", epoch);
      if (settled) {
        console.error(
          `MINING: dropping ${seconds}s of accrual for user ${userId} in epoch ${epoch} — ` +
          `that day is already settled. The accrual sweep should have caught this first.`,
        );
        continue;
      }

      // The device is claimed PER DAY, so a session crossing midnight has to
      // claim the new day too.
      const holdsDevice = session.device_id
        ? await claimDevice(epoch, session.device_id, userId)
        : true;
      if (!holdsDevice) continue;

      const shares = hashrate * seconds;
      if (shares <= 0) continue;

      await sql.run(
        `INSERT INTO mining_shares (epoch, user_id, shares, updated_at) VALUES (?,?,?,?)
         ON CONFLICT (epoch, user_id) DO UPDATE SET shares = mining_shares.shares + EXCLUDED.shares,
                                                    updated_at = EXCLUDED.updated_at`,
        epoch, userId, shares, now(),
      );
    }

    await sql.run(
      "UPDATE mining_sessions SET last_accrued_at = ? WHERE id = ?",
      new Date(untilMs).toISOString(), session.id,
    );
  }

  if (nowMs >= expiresMs) {
    await sql.run(
      "UPDATE mining_sessions SET status = 'ended', ended_at = ? WHERE id = ?",
      now(), session.id,
    );
  }
}

// Accrue EVERY session with time owing, not just the one belonging to whoever
// happened to make a request.
//
// Without this, shares are only written when the user polls — so someone who taps
// "Start mining" and closes the app has nothing in mining_shares when their day is
// settled, and earns zero for a session they legitimately ran. That is the single
// most user-visible bug the mining system could have had.
//
// Runs on the settlement timer, immediately BEFORE settlement, so every session's
// time is on the books before the day it belongs to is paid out.
export async function accrueAllSessions(): Promise<number> {
  const sessions = await sql.all<SessionRow & { user_id: string }>(
    `SELECT id, user_id, device_id, expires_at, last_accrued_at
     FROM mining_sessions WHERE status = 'active'`,
  );
  for (const s of sessions) {
    try {
      await accrueSession(s.user_id, s);
    } catch (err) {
      // One bad session must not stop the sweep — the rest still need to be paid.
      console.error(`MINING: accrual failed for session ${s.id}`, err);
    }
  }
  return sessions.length;
}

export async function sessionState(userId: string): Promise<SessionState> {
  await accrue(userId);
  const s = await loadMiningSettings();
  const epoch = epochOf();

  const [session, shares, { hashrate }] = await Promise.all([
    sql.get<{ expires_at: string; device_id: string | null }>(
      "SELECT expires_at, device_id FROM mining_sessions WHERE user_id = ? AND status = 'active'", userId),
    sql.get<{ shares: string }>(
      "SELECT shares FROM mining_shares WHERE epoch = ? AND user_id = ?", epoch, userId),
    hashrateOf(userId, s),
  ]);

  const mine = Number(shares?.shares ?? 0);

  // What the user has EARNED so far today.
  //
  // Under the pi model this is not a guess at all: the payout comes from the
  // user's own shares, so nobody else joining can move it. It only ever goes up
  // as they keep mining. That is what killed the old screen's worst behaviour —
  // it used to show a lone miner the ENTIRE daily pot ("~3,000,000 ROZI"), a
  // number that silently collapsed by orders of magnitude the moment real traffic
  // arrived. Honest arithmetic, but it read as a broken promise.
  //
  // Under the pool model it remains a genuine estimate that moves with the crowd,
  // and `estimateIsLive` tells the UI to keep saying so.
  let earnedTodayMicro: number;
  if (s.emissionModel === "pi") {
    const rate = effectivePiRate(s, await minerPopulation());
    earnedTodayMicro = piPayoutMicroFor(mine, rate, s.baseHashrate, s.piReferenceHours * 3600);
  } else {
    const totalRow = await sql.get<{ total: string }>(
      "SELECT COALESCE(SUM(shares), 0) AS total FROM mining_shares WHERE epoch = ?", epoch,
    );
    const total = Number(totalRow?.total ?? 0);
    earnedTodayMicro = payoutMicroFor(
      mine, total, cappedEmissionMicro(epoch, await totalEmittedMicro(), s));
  }

  const owner = session?.device_id
    ? await sql.get<{ user_id: string }>(
        "SELECT user_id FROM mining_epoch_devices WHERE epoch = ? AND device_id = ?",
        epoch, session.device_id)
    : undefined;

  return {
    active: Boolean(session),
    expiresAt: session?.expires_at,
    hashrate,
    sharesToday: mine,
    estimatedRoziMicro: earnedTodayMicro,
    // Only the pool model's number is a moving estimate. The pi model's is what
    // the user has actually earned, so the UI must NOT hedge it.
    estimateIsLive: s.emissionModel !== "pi",
    deviceBlocked: Boolean(owner && owner.user_id !== userId),
  };
}

// ---- Epoch settlement -----------------------------------------------------

// emissionMicro / emitted / withheld are all MICRO-ROZI.
export type SettlementResult = {
  epoch: number; emissionMicro: number; totalShares: number;
  miners: number; emitted: number; withheld: number; skipped?: string;
};

// Settle one closed epoch: split its emission pro-rata by hashrate-seconds.
//
// Idempotent on the mining_epochs PK, and the whole thing is one transaction, so
// a crash halfway through rolls back and the next tick retries cleanly. This is
// the only place ROZI is ever minted.
export async function settleEpoch(epoch: number): Promise<SettlementResult> {
  if (epoch >= epochOf()) {
    return { epoch, emissionMicro: 0, totalShares: 0, miners: 0, emitted: 0, withheld: 0,
             skipped: "epoch is still open" };
  }

  return sql.tx(async (t) => {
    // Serialize settlement globally (one fixed lock key, not per-user). Two API
    // instances settling DIFFERENT epochs at the same moment would both read the
    // same totalEmitted, both believe they have the same room under the supply
    // cap, and together mint past it. The per-epoch primary key stops a double
    // settlement of the SAME day; it does nothing for this. The cap is the one
    // promise about ROZI that has to be literally true, so it gets a real lock.
    await t.run("SELECT pg_advisory_xact_lock(hashtext('rozi-settlement'))");

    const already = await t.get<{ epoch: number }>(
      "SELECT epoch FROM mining_epochs WHERE epoch = ?", epoch);
    if (already) {
      return { epoch, emissionMicro: 0, totalShares: 0, miners: 0, emitted: 0, withheld: 0,
               skipped: "already settled" };
    }

    const s = await loadMiningSettings();
    const alreadyEmittedMicro = await totalEmittedMicro(t);

    const rows = await t.all<{ user_id: string; shares: string }>(
      "SELECT user_id, shares FROM mining_shares WHERE epoch = ? AND shares > 0", epoch);
    const totalShares = rows.reduce((a, r) => a + Number(r.shares), 0);

    // What each miner is owed, in MICRO, before the supply cap gets a say. The two
    // models differ ONLY here — everything around it (the lock, the cap, the
    // withhold rule, the ledger write) is identical, on purpose.
    let owed: { userId: string; micro: number }[] = [];
    let emissionMicro = 0;

    if (totalShares > 0) {
      if (s.emissionModel === "pi") {
        // PI MODEL: each miner's reward comes from their own shares alone. There
        // is no denominator, so nobody's payout moves when another miner joins.
        const rate = effectivePiRate(s, await minerPopulation(t));
        owed = rows.map((r) => ({
          userId: r.user_id,
          micro: piPayoutMicroFor(
            Number(r.shares), rate, s.baseHashrate, s.piReferenceHours * 3600),
        }));

        // The daily total floats with the crowd, so it can outrun what the cap has
        // left. Scale everyone by the same factor rather than paying in row order
        // until the pool dries up mid-list, which would hand the remainder to
        // whoever sorted first. This is the endgame: the pool running out.
        const wantedMicro = owed.reduce((a, o) => a + o.micro, 0);
        const roomMicro = Math.max(0, toMicro(s.supplyCap) - alreadyEmittedMicro);
        const scale = capScaleFactor(wantedMicro, roomMicro);
        if (scale < 1) {
          owed = owed.map((o) => ({ ...o, micro: Math.floor(o.micro * scale) }));
        }
        emissionMicro = owed.reduce((a, o) => a + o.micro, 0);
      } else {
        // POOL MODEL: a fixed pot, split pro-rata by hashrate-seconds.
        emissionMicro = cappedEmissionMicro(epoch, alreadyEmittedMicro, s);
        if (emissionMicro > 0) {
          owed = rows.map((r) => ({
            userId: r.user_id,
            micro: payoutMicroFor(Number(r.shares), totalShares, emissionMicro),
          }));
        }
      }
    }

    let emitted = 0;
    let withheld = 0;

    if (owed.length > 0) {
      // Accounts that are suspended, or carrying an unresolved HIGH-severity
      // flag, are WITHHELD rather than skipped: under the pool model their shares
      // stay in the denominator, because if they were removed instead, a farm
      // getting caught would hand its stolen share back to everyone else and
      // quietly inflate the epoch — the honest miners' payout must not depend on
      // how much fraud we happened to detect that day. Under the pi model there
      // is no denominator to poison, but withholding still keeps the cap
      // accounting honest, so the rule is simply kept the same in both.
      const blocked = new Set(
        (await t.all<{ user_id: string }>(
          `SELECT DISTINCT u.id AS user_id FROM users u
           LEFT JOIN fraud_flags f
             ON f.user_id = u.id AND f.severity = 'high' AND f.resolved_by IS NULL
           WHERE u.id IN (SELECT user_id FROM mining_shares WHERE epoch = ?)
             AND (u.status <> 'active' OR f.id IS NOT NULL)`,
          epoch,
        )).map((r) => r.user_id),
      );

      for (const o of owed) {
        if (o.micro <= 0) continue;
        if (blocked.has(o.userId)) {
          withheld += o.micro;
          continue;
        }
        await postRozi({
          userId: o.userId, micro: o.micro, direction: "credit",
          sourceType: "mining", sourceRefId: String(epoch),
          note: `Mining reward, day ${epoch}`,
        }, t);
        emitted += o.micro;
      }
    }

    await t.run(
      `INSERT INTO mining_epochs (epoch, emission, total_shares, miners, emitted, withheld, settled_at)
       VALUES (?,?,?,?,?,?,?)`,
      epoch, emissionMicro, totalShares, rows.length, emitted, withheld, now(),
    );

    return { epoch, emissionMicro, totalShares, miners: rows.length, emitted, withheld };
  });
}

// A day is only settled once it has been closed for this long. The grace period
// is what makes the sweep safe: every active session is accrued on the same timer
// (every 15 min), so by the time a day is eligible for settlement, all of its
// mining is on the books. Settling the instant a day closed would race the sweep
// and pay some users for a partial day.
const SETTLE_GRACE_MS = 60 * 60 * 1000; // 1 hour

// Accrue every open session, THEN settle every day that is closed and out of its
// grace period. Order matters — accrual must land before the day it belongs to is
// paid out. Safe to call on boot and on a timer: if the process was down for three
// days, this catches all three up in order.
export async function settleDueEpochs(): Promise<SettlementResult[]> {
  await accrueAllSessions();

  const current = epochOf();
  const last = await sql.get<{ epoch: number }>(
    "SELECT MAX(epoch) AS epoch FROM mining_epochs");
  // Never walk back further than 30 epochs on a cold start — a fresh database
  // with genesis in the past would otherwise try to settle every empty day since.
  const from = last?.epoch != null ? last.epoch + 1 : Math.max(0, current - 30);

  const out: SettlementResult[] = [];
  for (let e = from; e < current; e++) {
    if (Date.now() < epochEndMs(e) + SETTLE_GRACE_MS) break; // too fresh; wait
    out.push(await settleEpoch(e));
  }
  return out;
}
