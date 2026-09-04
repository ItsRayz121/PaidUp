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
// KYC-APPROVED USERS ONLY (founder decision, 2026-07-13). A "valid user" is one
// who has held a real ID card up to a camera and had a human confirm it.
//
// This cuts both ways and both ways are intended:
//   • It cannot be gamed UPWARD to trigger an early halving — nobody wants that,
//     since more users only ever means a lower rate.
//   • It CAN be gamed downward only by not doing KYC, which costs the user their
//     ability to withdraw and their inviter's referral income. Nobody sane pays
//     that price to slow a halving that hurts everyone equally.
//
// The real effect is that a botnet of ten thousand fake signups no longer drags
// the whole user base through a halving and cuts every honest miner's rate in
// half. Fake accounts can still mine — we don't hard-block them — but they no
// longer get a vote on how fast the tap closes.
export async function minerPopulation(t: Pick<TxApi, "get"> = sql): Promise<number> {
  const r = await t.get<{ n: string }>(
    "SELECT COUNT(*) AS n FROM users WHERE kyc_status = 'approved'");
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

// Live boosts, newest first. "task" and "ad" boosts are each capped at their own
// max-stack setting here rather than at grant time: capping at grant would
// silently throw away a boost the user genuinely earned, and if the Admin later
// raises the cap those boosts should come back. So we grant everything and only
// ever cap on read — the (n+1)th watch/completion simply queues and kicks in
// once an earlier one expires. "points" (booster) boosts have no entry here and
// stay uncapped, same as before this cap existed for any kind.
function boostStackCaps(s: MiningSettings): Record<string, number> {
  return { task: s.taskBoostMaxStack, ad: s.adBoostMaxStack };
}

// Split a set of already-stack-capped boost rows into the two things
// computeHashrate() wants: the PERCENTAGE multipliers, and the FLAT hashrate the
// ad boosts add (founder, 2026-08-30 — each active ad row is worth
// `adBoostFlat`, applied after the multipliers).
//
// An ad row contributes the flat amount FROM SETTINGS (so retuning adBoostFlat
// affects boosts already running, like the stack cap does), plus its own stored
// multiplier_pct if that is non-zero — which is 0 in the shipped config, so ads
// are flat-only by default, but an Admin who sets adBoostPct > 0 gets a genuine
// percentage on top rather than a knob that silently does nothing.
function splitBoosts(
  cappedRows: { kind: string; multiplier_pct: number }[], s: MiningSettings,
): { pcts: number[]; flatBonus: number } {
  const pcts: number[] = [];
  let adCount = 0;
  for (const r of cappedRows) {
    if (r.kind === "ad") adCount++;
    if (r.multiplier_pct > 0) pcts.push(r.multiplier_pct);
  }
  return { pcts, flatBonus: adCount * s.adBoostFlat };
}

// Shared by the single-user and batch hashrate paths so the cap rule is written
// once. `rows` must already be newest-first; `groupKey` scopes the per-kind count
// (a per-user id for the batch path, a constant for a single user).
function applyStackCaps<T extends { kind: string; multiplier_pct: number }>(
  rows: T[], caps: Record<string, number>, groupKey: (r: T) => string,
): T[] {
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const r of rows) {
    const cap = caps[r.kind];
    if (cap !== undefined) {
      const key = `${groupKey(r)}:${r.kind}`;
      const n = counts.get(key) ?? 0;
      if (n >= cap) continue;
      counts.set(key, n + 1);
    }
    out.push(r);
  }
  return out;
}

async function activeBoosts(
  userId: string, s: MiningSettings,
): Promise<{ pcts: number[]; flatBonus: number }> {
  const rows = await sql.all<{ kind: string; multiplier_pct: number }>(
    "SELECT kind, multiplier_pct FROM user_boosts WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC",
    userId, now(),
  );
  return splitBoosts(applyStackCaps(rows, boostStackCaps(s), () => ""), s);
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
// Postgres refuses a statement with more than 65,535 bound parameters, and these
// helpers bind one per user id. A sweep over 100,000 miners therefore CANNOT be
// one query no matter how well written — it has to be chunked, and the chunk size
// has to leave room for the handful of other parameters each query also binds.
const PARAM_CHUNK = 2_000;
function chunked<T>(xs: T[], size = PARAM_CHUNK): T[][] {
  if (xs.length <= size) return xs.length === 0 ? [] : [xs];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

// The raw ingredients of a hashrate, for many users in a fixed number of queries.
// Split out of ownHashrateBatch so the full-hashrate batch (hashrateOfBatch) can
// reuse the SAME gathering code rather than keep a second copy of it that drifts.
type HashrateParts = { rigPower: number; streakDays: number; pcts: number[]; flatBonus: number };

async function hashratePartsBatch(
  userIds: string[], s: MiningSettings,
): Promise<Map<string, HashrateParts>> {
  const out = new Map<string, HashrateParts>();
  if (userIds.length === 0) return out;
  for (const chunk of chunked(userIds)) {
    for (const [id, parts] of await hashratePartsChunk(chunk, s)) out.set(id, parts);
  }
  return out;
}

async function hashratePartsChunk(
  userIds: string[], s: MiningSettings,
): Promise<Map<string, HashrateParts>> {
  const out = new Map<string, HashrateParts>();
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

  // Same per-kind stack cap as activeBoosts(), scoped per user here, then split
  // into percentage boosts + the flat ad bonus (see splitBoosts()).
  const cappedBy = new Map<string, { kind: string; multiplier_pct: number }[]>();
  for (const b of applyStackCaps(boostRows, boostStackCaps(s), (r) => r.user_id)) {
    const list = cappedBy.get(b.user_id) ?? [];
    list.push({ kind: b.kind, multiplier_pct: b.multiplier_pct });
    cappedBy.set(b.user_id, list);
  }

  const streakBy = new Map(streakRows.map((r) => [r.user_id, r.current_days]));

  for (const id of userIds) {
    const { pcts, flatBonus } = splitBoosts(cappedBy.get(id) ?? [], s);
    out.set(id, {
      rigPower: rigPowerBy.get(id) ?? 0,
      streakDays: streakBy.get(id) ?? 0,
      pcts,
      flatBonus,
    });
  }
  return out;
}

// Turn the parts into a hashrate AND its breakdown. The ONE place that assembles
// either, so the single-user path, the own-hashrate batch and the full batch
// cannot disagree — about the arithmetic or about what the /mine screen is shown.
function hashrateFromParts(
  parts: HashrateParts | undefined, referral: number, s: MiningSettings,
): HashrateResult {
  const rigs = parts?.rigPower ?? 0;
  const streakDays = parts?.streakDays ?? 0;
  const pcts = parts?.pcts ?? [];
  const flatBonus = parts?.flatBonus ?? 0;
  const hashrate = computeHashrate({
    base: s.baseHashrate,
    rigPower: rigs,
    streakDays,
    streakStepPct: s.streakStepPct,
    streakCapDays: s.streakCapDays,
    boostPcts: pcts,
    flatBonus,
    referralHashrate: referral,
    referralCapPct: s.referralCapPct,
    maxHashrate: s.maxHashrate,
  });
  return {
    hashrate,
    breakdown: {
      base: s.baseHashrate,
      rigs,
      streakDays,
      streakMultiplierPct: Math.round(
        (1 + (s.streakStepPct / 100) * Math.min(streakDays, s.streakCapDays)) * 100),
      boostPct: pcts.reduce((a, b) => a + b, 0),
      // The flat ad bonus (founder, 2026-08-30) — shown as "+N" on the /mine
      // breakdown, separate from the "+X%" percentage boosts above.
      adFlatBonus: flatBonus,
      referral,
    },
  };
}

async function ownHashrateBatch(
  userIds: string[], s: MiningSettings,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (userIds.length === 0) return out;
  const parts = await hashratePartsBatch(userIds, s);
  for (const id of userIds) {
    // referralHashrate: 0 is the recursion break — see ownHashrate() above.
    out.set(id, hashrateFromParts(parts.get(id), 0, s).hashrate);
  }
  return out;
}

// Hashrate inherited from the downline. An invitee contributes ZERO unless they
// are BOTH:
//   • KYC-approved — a real person, confirmed by a human looking at their ID, and
//   • active (mined within `referralActiveHours`).
//
// The KYC condition is the anti-farm line the founder asked for, and it is the
// one that actually bites. Activity alone was never enough: a farm can script a
// thousand accounts that each open a session once a day, and under the old rule
// every one of them fed hashrate to the same referrer. Now each of those thousand
// accounts would have to hold a distinct real ID card up to a camera and get past
// a human. That is not a script; that is a thousand people.
//
// Dead signups were already worth nothing. Fake signups are now worth nothing too.
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
         AND u.kyc_status = 'approved'
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

// The FULL hashrate — referral component included — for many users in a fixed
// number of queries per chunk instead of ~8 queries per user.
//
// WHY THIS EXISTS: the accrual sweep calls this once per open mining session, and
// the audit of 2026-09-04 measured the per-user version at 998,601 sequential
// statements for 100,000 sessions (finding B4). On loopback that was 6 minutes
// against a 15-minute interval; over a real network, where every statement costs
// a round trip, the same statement count is roughly 11.6 minutes of pure waiting
// — inside the window, with settlement queued behind it, and getting worse with
// every new miner. The clock was never the problem. The statement count was.
//
// ⚠️ THIS MUST RETURN EXACTLY WHAT hashrateOf() RETURNS, PER USER. It is a
// different route to the same number, not a cheaper approximation, and a
// difference here would silently change what people are paid. Both paths now
// share hashratePartsBatch() and hashrateFromParts(), so the arithmetic cannot
// drift; the referral walk is the part that is genuinely re-expressed set-wise,
// and there is a differential test (mining-batch.e2e.ts) that seeds rigs, boosts,
// streaks and a two-level downline and asserts the two agree for every user.
export async function hashrateOfBatch(
  userIds: string[], s: MiningSettings,
): Promise<Map<string, HashrateResult>> {
  const out = new Map<string, HashrateResult>();
  if (userIds.length === 0) return out;
  // ⚠️ DEDUPE THE INPUT FIRST. The SQL below says DISTINCT, but DISTINCT is per
  // STATEMENT and this runs one statement per chunk — so an id appearing in two
  // chunks contributed its invitees twice, and a referral component was summed
  // twice. The differential test caught exactly this (a repeated id list crossing
  // the chunk boundary) and it is the reason that test exists: the arithmetic was
  // right, the set handling was not, and the only visible symptom would have been
  // some users quietly mining faster than they should.
  const ids = [...new Set(userIds)];
  const cutoff = new Date(Date.now() - s.referralActiveHours * 3600_000).toISOString();

  // Active invitees grouped BY REFERRER, for a whole set of referrers at once.
  // Same predicate as referralHashrateOf's `active()`: mined recently, still
  // active, KYC-approved. Chunked, because one bound parameter per referrer —
  // and accumulated into a Set per referrer so a chunk overlap cannot duplicate.
  const activeBy = async (refs: string[]): Promise<Map<string, string[]>> => {
    const m = new Map<string, Set<string>>();
    for (const chunk of chunked([...new Set(refs)])) {
      const ph = chunk.map(() => "?").join(",");
      const rows = await sql.all<{ ref: string; id: string }>(
        `SELECT DISTINCT u.referred_by AS ref, u.id FROM users u
         JOIN mining_sessions ms ON ms.user_id = u.id
         WHERE u.referred_by IN (${ph})
           AND u.status = 'active'
           AND u.kyc_status = 'approved'
           AND ms.started_at > ?`,
        ...chunk, cutoff,
      );
      for (const r of rows) {
        const set = m.get(r.ref) ?? new Set<string>();
        set.add(r.id);
        m.set(r.ref, set);
      }
    }
    return new Map([...m].map(([ref, set]) => [ref, [...set]]));
  };

  const l1By = await activeBy(ids);
  const everyL1 = [...new Set([...l1By.values()].flat())];
  // One query set for the SECOND level too: the active invitees of every level-1
  // invitee of anyone in this batch, looked up once and shared across the batch
  // rather than re-queried per miner.
  const l2ByL1 = await activeBy(everyL1);

  // Own hashrate for the miners themselves and for their whole two-level
  // downline. The downline contributes only its OWN hashrate (the recursion
  // break), which is exactly what ownHashrateBatch returns.
  const downline = new Set<string>();
  for (const id of everyL1) downline.add(id);
  for (const list of l2ByL1.values()) for (const id of list) downline.add(id);
  const [parts, downlinePower] = await Promise.all([
    hashratePartsBatch(ids, s),
    ownHashrateBatch([...downline], s),
  ]);

  for (const userId of ids) {
    const l1 = l1By.get(userId) ?? [];
    const l1Set = new Set(l1);
    // Mirrors referralHashrateOf exactly: level 2 is the DISTINCT union of the
    // level-1s' own active invitees, minus the user themselves and minus anyone
    // already counted at level 1 (a referral cycle is not forbidden by the data
    // model, so both exclusions are load-bearing, not tidiness).
    const l2: string[] = [];
    const seen = new Set<string>();
    for (const mid of l1) {
      for (const id of l2ByL1.get(mid) ?? []) {
        if (id === userId || l1Set.has(id) || seen.has(id)) continue;
        seen.add(id);
        l2.push(id);
      }
    }
    let referral = 0;
    for (const id of l1) referral += (downlinePower.get(id) ?? 0) * (s.referralL1Pct / 100);
    for (const id of l2) referral += (downlinePower.get(id) ?? 0) * (s.referralL2Pct / 100);
    out.set(userId, hashrateFromParts(parts.get(userId), Math.floor(referral), s));
  }
  return out;
}

export async function hashrateOf(
  userId: string,
  s?: MiningSettings,
): Promise<HashrateResult> {
  const cfg = s ?? (await loadMiningSettings());
  const [rigs, boosts, streak, referral] = await Promise.all([
    rigPowerOf(userId),
    activeBoosts(userId, cfg),
    sql.get<{ current_days: number }>(
      "SELECT current_days FROM mining_streaks WHERE user_id = ?", userId),
    referralHashrateOf(userId, cfg),
  ]);
  // Assembled by hashrateFromParts, the same function the batch path uses — see
  // the note on hashrateOfBatch for why the two must be identical rather than
  // merely similar.
  return hashrateFromParts(
    { rigPower: rigs, streakDays: streak?.current_days ?? 0,
      pcts: boosts.pcts, flatBonus: boosts.flatBonus },
    referral, cfg,
  );
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

export type HashrateResult = { hashrate: number; breakdown: Record<string, number> };

export type SessionState = {
  active: boolean;
  expiresAt?: string;
  hashrate: number;
  // The same breakdown hashrateOf() returns, carried here so /mining/state does
  // not recompute it - see the note in sessionState().
  breakdown: Record<string, number>;
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
export async function accrue(
  userId: string, s?: MiningSettings,
): Promise<HashrateResult | null> {
  const session = await sql.get<{
    id: string; device_id: string | null; expires_at: string; last_accrued_at: string;
  }>(
    "SELECT id, device_id, expires_at, last_accrued_at FROM mining_sessions WHERE user_id = ? AND status = 'active'",
    userId,
  );
  if (!session) return null;
  return accrueSession(userId, session, s);
}

type SessionRow = {
  id: string; device_id: string | null; expires_at: string; last_accrued_at: string;
};

// Returns the hashrate it computed, so a caller that needs the same number for
// display does not pay for it a second time (see sessionState). Returns null when
// there was no time owing - nothing was computed, so there is nothing to reuse and
// the caller must ask for it itself.
async function accrueSession(
  userId: string, session: SessionRow, s?: MiningSettings,
  // Precomputed hashrate, when the caller has already worked it out for a whole
  // batch of sessions (accrueAllSessions). Passing it in is what removes the ~8
  // queries per session that dominated the sweep.
  known?: HashrateResult,
): Promise<HashrateResult | null> {
  let computed: HashrateResult | null = null;
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
    // Settings are threaded in by callers that already loaded them. Without it,
    // every accrual re-read the whole settings table - once per session in the
    // sweep, which is 100,000 redundant reads at 100k miners.
    computed = known ?? (await hashrateOf(userId, s));
    const { hashrate } = computed;

    for (const { epoch, seconds } of slices) {
      // Never write into a day that has already paid out. If we did, the shares
      // would sit in mining_shares forever and never be settled — invisible, and
      // silently stolen from the user. It should be impossible (the sweep +
      // grace period below exist to make sure accrual always lands first), so if
      // it ever happens we want it loud in the logs rather than quiet in the DB.
      //
      // ⚠️ THE CHECK IS SKIPPED FOR THE CURRENT EPOCH, AND ONLY BECAUSE IT IS
      // PROVABLY UNNECESSARY THERE: settleEpoch() refuses outright while
      // `epoch >= epochOf()` (its first line), so today cannot already be
      // settled, by construction, in this process or any other. Past epochs —
      // the midnight-crossing case, which is the whole reason splitByEpoch
      // exists — are still checked against the database every time. This is one
      // query per session removed from a sweep that runs over every open session
      // (audit 2026-09-04, finding B4); it is NOT a relaxation of the guard.
      const settled = epoch >= epochOf()
        ? undefined
        : await sql.get<{ epoch: number }>(
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
  return computed;
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
  // ONE settings read for the whole sweep, not one per session. The values cannot
  // change mid-sweep in a way that matters - the sweep is a catch-up over time that
  // has already elapsed - and re-reading them per session was 100,000 redundant
  // reads at 100k miners (audit 2026-09-04, finding B4).
  const cfg = await loadMiningSettings();

  // Hashrates for a whole chunk of sessions in a fixed number of queries, rather
  // than ~8 queries per session. The chunk exists for two separate reasons and
  // both matter: Postgres caps bound parameters per statement, and holding one
  // batch's intermediate maps for 100,000 users at once is a lot of memory for a
  // background tick to take from the request path it shares a process with.
  //
  // ⚠️ THE PER-SESSION WRITES ARE DELIBERATELY STILL PER-SESSION. Each one claims
  // the device for the day (a PK conflict is how the one-device-one-account rule
  // is enforced) and can legitimately skip a slice, and each session is wrapped in
  // its own try/catch so one bad row cannot stop the sweep — the property that
  // makes this loop safe to run unattended. Batching the reads is a pure win;
  // batching the writes would trade that isolation away for less than it costs.
  for (const group of chunked(sessions, 500)) {
    let rates = new Map<string, HashrateResult>();
    try {
      rates = await hashrateOfBatch(group.map((g) => g.user_id), cfg);
    } catch (err) {
      // Fall back to per-session computation rather than skipping real earnings.
      console.error("MINING: batched hashrate failed, falling back per session", err);
    }
    for (const s of group) {
      try {
        await accrueSession(s.user_id, s, cfg, rates.get(s.user_id));
      } catch (err) {
        // One bad session must not stop the sweep — the rest still need to be paid.
        console.error(`MINING: accrual failed for session ${s.id}`, err);
      }
    }
  }
  return sessions.length;
}

export async function sessionState(userId: string): Promise<SessionState> {
  // THE SETTINGS ARE READ ONCE AND THREADED THROUGH, AND THE ACCRUAL'S OWN
  // HASHRATE IS REUSED FOR DISPLAY. This function used to load settings twice and
  // compute the hashrate twice (once inside accrue, once here), and the
  // /mining/state route then computed it a THIRD time for the breakdown - on the
  // single most-requested endpoint in the app, each computation being 8 queries
  // including two walks of the referral tree. Audit 2026-09-04, finding B2.
  //
  // Reusing accrual's number is correct, not a shortcut: nothing between the two
  // points changes a multiplier. Accrual claims the device and writes shares; it
  // touches no rig, boost, streak or referral row. When accrual had no time owing
  // it computed nothing, and only then is it computed here.
  const s = await loadMiningSettings();
  const accrued = await accrue(userId, s);
  const epoch = epochOf();

  const [session, shares, hr] = await Promise.all([
    sql.get<{ expires_at: string; device_id: string | null }>(
      "SELECT expires_at, device_id FROM mining_sessions WHERE user_id = ? AND status = 'active'", userId),
    sql.get<{ shares: string }>(
      "SELECT shares FROM mining_shares WHERE epoch = ? AND user_id = ?", epoch, userId),
    accrued ?? hashrateOf(userId, s),
  ]);
  const { hashrate, breakdown } = hr;

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
    breakdown,
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
    //
    // ⚠️ TRY, NOT WAIT, AND THE DIFFERENCE MATTERS UNDER LOAD. A blocking
    // `pg_advisory_xact_lock` made a waiting tick hold one pooled connection for
    // as long as the holder ran — measured at 17 s for 100,000 miners — and the
    // timers fire on a fixed interval with no idea a previous one is still going,
    // so overlapping ticks used to consume a connection each until the pool died
    // (audit 2026-09-04, finding B8). Settlement is idempotent on the
    // `mining_epochs` primary key and the caller retries on the next tick, so
    // declining to wait costs nothing and cannot skip a day.
    const lock = await t.get<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('rozi-settlement')) AS locked");
    if (!lock?.locked) {
      return { epoch, emissionMicro: 0, totalShares: 0, miners: 0, emitted: 0, withheld: 0,
               skipped: "another settlement is already running" };
    }

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
        // Parked here, NOT credited yet (founder decision 2026-08-12: mining is a
        // real "claim your gems" action, not a silent daily auto-credit). The cap
        // accounting above still treats this as emitted the moment it is owed —
        // an unclaimed reward is still ROZI that exists and counts against the
        // supply cap, exactly like an unswept USDT deposit still counts as ours.
        // claimRozi() below is the only place this ever becomes a real
        // rozi_ledger credit.
        await t.run(
          `INSERT INTO mining_unclaimed (epoch, user_id, micro, created_at) VALUES (?,?,?,?)`,
          epoch, o.userId, o.micro, now(),
        );
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

// ---- Claiming ---------------------------------------------------------------
//
// Settled ROZI sits in mining_unclaimed until the user taps Claim. This is the
// ONLY place a mining_unclaimed row ever becomes a real rozi_ledger credit.

// Sum of every settled-but-not-yet-claimed day, for the "ready to claim" card.
export async function claimableRoziMicro(userId: string): Promise<number> {
  const row = await sql.get<{ total: string }>(
    "SELECT COALESCE(SUM(micro), 0) AS total FROM mining_unclaimed WHERE user_id = ?", userId);
  return Number(row?.total ?? 0);
}

export type ClaimResult = { claimedMicro: number };

// Locked exactly like every other balance-changing route (guardrail #8) — not
// because a claim can be double-SPENT, but because two concurrent taps must not
// both sum the same unclaimed rows and each credit them, doubling the payout.
export async function claimRozi(userId: string): Promise<ClaimResult> {
  return sql.tx(async (t) => {
    await t.run("SELECT pg_advisory_xact_lock(hashtext(?))", userId);

    const rows = await t.all<{ epoch: number; micro: string }>(
      "SELECT epoch, micro FROM mining_unclaimed WHERE user_id = ?", userId);
    const claimedMicro = rows.reduce((a, r) => a + Number(r.micro), 0);
    if (claimedMicro <= 0) return { claimedMicro: 0 };

    await postRozi({
      userId, micro: claimedMicro, direction: "credit",
      sourceType: "mining",
      sourceRefId: rows.map((r) => r.epoch).sort((a, b) => a - b).join(","),
      note: rows.length === 1
        ? `Mining reward, day ${rows[0].epoch}, claimed`
        : `Mining reward, ${rows.length} days, claimed`,
    }, t);

    // ⚠️ MUST delete exactly the epochs just summed and credited, NEVER a blanket
    // `WHERE user_id = ?`. settleEpoch() locks on a GLOBAL key
    // (hashtext('rozi-settlement')), not this per-user one, so it can commit a
    // brand-new mining_unclaimed row for THIS user in the gap between the SELECT
    // above and this DELETE. Under READ COMMITTED each statement re-reads the
    // table fresh — a blanket delete would then sweep up that new, never-summed,
    // never-credited row: the reward silently vanishes, counted as emitted
    // against the supply cap but never landing in anyone's balance. Found in
    // security review (2026-08-12) before this ever shipped.
    const placeholders = rows.map(() => "?").join(",");
    await t.run(
      `DELETE FROM mining_unclaimed WHERE user_id = ? AND epoch IN (${placeholders})`,
      userId, ...rows.map((r) => r.epoch),
    );
    return { claimedMicro };
  });
}
