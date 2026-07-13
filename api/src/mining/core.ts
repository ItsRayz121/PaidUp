// ROZI mining — the pure maths. No database, no I/O, no clock beyond what is
// passed in. Every economic rule in docs/MINING_SPEC.md that can be expressed as
// a function lives here, so it can be tested directly (see tests/mining.test.ts).
//
// The one property that must never break: the sum of all emissions over all time
// is bounded, and a user's payout is always a SHARE of a fixed pot. That is what
// makes ROZI free to mint — it is not a claim on the treasury.
//
// THIS FILE MUST HAVE NO IMPORTS. Not a style rule — mining/settings.ts imports
// db.ts, which opens a database connection at module scope, and a unit test that
// pulls in a database connection never exits. Keep the numbers here, where they
// can be read without starting anything.

// ---- Tunable defaults ------------------------------------------------------
// Every number in the mining economy. Admin-tunable at runtime with no redeploy
// (mining/settings.ts overlays whatever is stored in app_settings on top of these).

// ---- Units -----------------------------------------------------------------
//
// ROZI IS STORED AS AN INTEGER COUNT OF MILLIONTHS ("micro-ROZI"). 1 ROZI =
// 1_000_000 micro. The ledger column is BIGINT and holds micro; nothing anywhere
// stores a fractional ROZI as a float, because a float ledger is how money
// systems lose cents.
//
// This exists because payouts are FLOORED, and the floor used to be a whole ROZI.
// With a base rate of 10/day and an 8-hour session, a miner earns 3.33 ROZI — and
// after two halvings, 0.83, which floored to ZERO. The app would have gone on
// taking people's time and paying them nothing. Flooring to a millionth instead
// means the dust we keep is 0.000001 ROZI, which is a rounding error rather than
// a user's whole day.
//
// The floor still runs in the treasury's favour (dust stays unemitted, so we
// remain strictly under the supply cap) — it is just six decimal places further
// down. See docs/MINING_SPEC.md § 3.2.
//
// Convention: any variable holding micro-ROZI is named `...Micro`. Settings and
// the rig catalogue are in WHOLE ROZI (they are human-facing admin numbers) and
// are converted with toMicro() at the moment they meet the ledger.
export const ROZI_SCALE = 1_000_000;

export function toMicro(rozi: number): number {
  return Math.round(rozi * ROZI_SCALE);
}

export function fromMicro(micro: number): number {
  return micro / ROZI_SCALE;
}

export const MINING_DEFAULTS = {
  // -- Emission model (founder decision, 2026-07-13). Two models exist:
  //
  //    "pi"   — each miner earns piBaseRate x their multipliers x the fraction of
  //             a full mining day they actually mined. Their reward does NOT
  //             depend on how many other people mine, so it is predictable, and a
  //             halving is a clean 50% cut to the person (not a 20x collapse from
  //             halving + dilution stacking). The daily total floats with the
  //             crowd, so the throttle is piHalvingUsers, below.
  //
  //    "pool" — the original Bitcoin-style model: a fixed daily pot split
  //             pro-rata by hashrate-seconds. Kept because it is the only model
  //             where over-issuance is arithmetically impossible, and it is the
  //             safe place to fall back to if "pi" ever runs hot.
  //
  //    The supplyCap is a hard ceiling under BOTH. It is the promise about ROZI
  //    that has to be literally true, so it is enforced at settlement either way.
  emissionModel: "pi",

  // -- "pi" model (§ 3.2). ROZI/day for a BASELINE miner: no multipliers, mining
  //    a full reference day. A miner with x2 multipliers earns twice this.
  //
  //    10/day (founder decision, 2026-07-13). Deliberately a SMALL number: a token
  //    people count in single digits feels scarce, and scarcity is the entire
  //    product here. It survives all five halvings down to 0.3125/day because the
  //    ledger holds millionths (see ROZI_SCALE above) — under the old whole-ROZI
  //    ledger a rate this low would have paid partial days literally nothing.
  piBaseRate: 10,

  // Base rate HALVES each time the user base crosses one of these counts. This is
  // the throttle: growth is what drains the pool, so growth is what slows the tap.
  // A calendar halving cannot do this — 10x the users on day one would empty the
  // pool regardless of what the calendar said.
  piHalvingUsers: "10000,50000,250000,1000000,5000000",

  // What counts as "a full day's mining" for the rate. 24h at 8h sessions means a
  // user has to come back ~3x a day to earn the full rate — which is the retention
  // loop, priced in. Mine a third of that, earn a third.
  piReferenceHours: 24,

  // -- "pool" model (§ 3.2). 3M/day, halving every 100 days, converging to 600M
  //    against a 650M cap — the headroom absorbs referral overhead.
  baseEmission: 3_000_000,
  halvingEpochs: 100,
  supplyCap: 650_000_000,

  // -- Sessions (§ 4.2). Mining STOPS when a session expires. That friction is
  //    the retention loop: ~3 app opens a day, each one an ad impression.
  sessionHours: 8,
  baseHashrate: 10,
  maxHashrate: 100_000,

  // -- Streak (§ 4.3): +5%/day up to 20 days => 2.0x
  streakStepPct: 5,
  streakCapDays: 20,

  // -- Task boost (§ 4.4). The most important number in the file: it is what
  //    makes the biggest miners also the people doing the surveys that pay us.
  taskBoostPct: 50,
  taskBoostHours: 48,
  taskBoostMaxStack: 3,

  // -- Ad boost (§ 8.1). The reward for watching an ad is a BOOST, never
  //    currency — which is why a faked ad view cannot mint anything.
  adBoostPct: 100,
  adBoostHours: 4,
  adWatchDailyCap: 10,
  adsEnabled: 0,            // off until the founder has a Monetag/Adsterra account
  adProvider: "",           // ads stay off until this is set too, even if the flag is 1

  // -- Referral hashrate (§ 4.6). Dead signups are worth exactly zero.
  referralL1Pct: 10,
  referralL2Pct: 3,
  referralCapPct: 100,
  referralActiveHours: 24,  // an invitee must have mined this recently to count

  // -- Transfers (§ 7). Wallet-to-wallet only. No order book, ever.
  transfersEnabled: 0,
  transferDailyCap: 50_000,
  transferMinAccountDays: 7,
  transferFeePct: 2,        // burned, not collected

  // -- Conversion (§ 6). OFF at launch: users mine for 2-3 months with nothing
  //    convertible and nothing tradeable. This is the founder's decision and it
  //    is what makes the whole design safe.
  conversionEnabled: 0,
  conversionSharePct: 10,   // suggested pot = this % of the period's real margin

  // -- Admin guardrail: ceiling on one hand-made ROZI adjustment.
  adminAdjustMaxRozi: 1_000_000,
};

export type MiningSettings = typeof MINING_DEFAULTS;

// Day 0 of mining. Epochs are whole UTC days since this instant.
//
// This is deliberately in the PAST. An epoch can only be settled once it has
// closed, so a genesis of "today" would mean no epoch is ever settleable until
// tomorrow — including in tests, where the whole settlement path would silently
// divide up an empty pot and pass. Epochs before anyone mined simply have no
// shares, so they emit nothing: back-dating genesis costs no supply.
export const MINING_GENESIS_MS = Date.UTC(2026, 6, 1); // 2026-07-01T00:00:00Z
const DAY_MS = 86_400_000;

export function epochOf(at: Date | string = new Date()): number {
  const t = typeof at === "string" ? Date.parse(at) : at.getTime();
  return Math.floor((t - MINING_GENESIS_MS) / DAY_MS);
}

export function epochStart(epoch: number): Date {
  return new Date(MINING_GENESIS_MS + epoch * DAY_MS);
}

export function epochEndMs(epoch: number): number {
  return MINING_GENESIS_MS + (epoch + 1) * DAY_MS;
}

// Split [fromMs, toMs) into per-epoch slices.
//
// This exists because mining sessions cross UTC midnight all the time — an 8-hour
// session started at 20:00 runs four hours into the next day. Attributing the
// WHOLE session to the epoch it started in would credit tomorrow's mining to
// today, and if today has already been settled those shares are silently lost
// forever (the mining_epochs row exists, so settlement never revisits it).
//
// So every accrual is chopped at the day boundary and each slice is booked to the
// day it actually happened in.
export function splitByEpoch(fromMs: number, toMs: number): { epoch: number; seconds: number }[] {
  const out: { epoch: number; seconds: number }[] = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const epoch = epochOf(new Date(cursor));
    const sliceEnd = Math.min(toMs, epochEndMs(epoch));
    const seconds = Math.floor((sliceEnd - cursor) / 1000);
    if (seconds > 0) out.push({ epoch, seconds });
    cursor = sliceEnd;
  }
  return out;
}

export type Emission = {
  baseEmission: number;   // E0, ROZI per epoch at epoch 0
  halvingEpochs: number;  // halve E0 every this many epochs
  supplyCap: number;      // hard ceiling on cumulative mining emission, ever
};

// E(e) = E0 / 2^floor(e / halving), in MICRO. Halving is what makes "mine early"
// true rather than a marketing line — it never gets easier, and we never have to
// lie about that.
export function emissionMicroAt(epoch: number, s: Emission): number {
  if (epoch < 0) return 0;
  const halvings = Math.floor(epoch / Math.max(1, s.halvingEpochs));
  // 2^halvings overflows to Infinity long before this matters; guard anyway so a
  // far-future epoch emits 0 rather than NaN.
  const divisor = Math.pow(2, halvings);
  if (!Number.isFinite(divisor) || divisor <= 0) return 0;
  return Math.floor(toMicro(s.baseEmission) / divisor);
}

// What we are allowed to emit this epoch, in MICRO, given everything already
// emitted. The cap is the last line of defence: even if an Admin fat-fingers the
// base emission to a billion, cumulative mining emission cannot pass supplyCap.
export function cappedEmissionMicro(
  epoch: number, alreadyEmittedMicro: number, s: Emission,
): number {
  const want = emissionMicroAt(epoch, s);
  const room = Math.max(0, toMicro(s.supplyCap) - alreadyEmittedMicro);
  return Math.min(want, room);
}

// ---- Rigs -----------------------------------------------------------------
// Growth factors are stored x100 (160 = 1.60) so the DB holds integers only.

export type RigDef = {
  baseCost: number; costGrowth: number;   // x100
  basePower: number; powerGrowth: number; // x100
  maxLevel: number;
};

// Cost to go from `level` to `level + 1`. Level 0 = not owned.
export function rigUpgradeCost(def: RigDef, level: number): number {
  return Math.floor(def.baseCost * Math.pow(def.costGrowth / 100, level));
}

// Flat hashrate a rig contributes AT a given level (not cumulative across levels
// — a level-3 rig replaces its level-2 self).
export function rigPower(def: RigDef, level: number): number {
  if (level <= 0) return 0;
  return Math.floor(def.basePower * Math.pow(def.powerGrowth / 100, level - 1));
}

// Cost growth (1.60) deliberately outruns power growth (1.50), so every level is
// worse value than the last. The upgrade tree is a treadmill that burns ROZI
// forever and can never be "solved" into runaway hashrate. Assert it here so a
// future Admin edit that inverts the curves is caught by the tests, not by an
// inflation crisis six months in.
export function rigIsDeflationary(def: RigDef): boolean {
  return def.costGrowth > def.powerGrowth;
}

// ---- Hashrate -------------------------------------------------------------

export type HashrateInputs = {
  base: number;            // flat, everyone gets this while a session is live
  rigPower: number;        // sum of rigPower() over owned rigs
  streakDays: number;
  streakStepPct: number;   // +5% per day
  streakCapDays: number;   // ...up to 20 days => 2.0x
  boostPcts: number[];     // active boosts: task (+50), ad (+100), points (+100)
  referralHashrate: number; // raw hashrate inherited from L1/L2 invitees
  referralCapPct: number;  // referral component <= this % of own pre-referral
  maxHashrate: number;
};

export function computeHashrate(i: HashrateInputs): number {
  const flat = i.base + i.rigPower;

  const streak = 1 + (i.streakStepPct / 100) * Math.min(i.streakDays, i.streakCapDays);

  // Boosts are additive with each other, then multiplicative against the flat
  // base. Two +50% task boosts and a +100% ad boost => x3.0, not x4.5. Additive
  // stacking is the difference between a lively economy and a runaway one.
  const boost = 1 + i.boostPcts.reduce((a, b) => a + b, 0) / 100;

  const own = flat * streak * boost;

  // A referral parasite — an account with no rigs, no streak, no tasks, living
  // entirely off a downline — is capped at doubling itself. You cannot farm your
  // way to the top of the network by signing up phones alone.
  const referralCeiling = own * (i.referralCapPct / 100);
  const referral = Math.min(i.referralHashrate, referralCeiling);

  return Math.floor(Math.min(own + referral, i.maxHashrate));
}

// ---- Pro-rata settlement ("pool" model) ------------------------------------

// Each miner gets emission * (their shares / total shares), in MICRO, floored.
// Flooring means the dust stays UNEMITTED, which keeps us strictly under the cap
// — the error, if any, is always in the treasury's favour, never the other way.
//
// The ratio is taken FIRST, deliberately. The natural `(emissionMicro * shares)`
// is emission up to 6.5e14 times shares up to ~8.6e9, which is 5.6e24 — far past
// 2^53, where JS integers stop being exact. Dividing first keeps both operands
// small and the result exact to well within the 1-micro floor.
export function payoutMicroFor(
  shares: number, totalShares: number, emissionMicro: number,
): number {
  if (totalShares <= 0 || shares <= 0 || emissionMicro <= 0) return 0;
  return Math.floor(emissionMicro * (shares / totalShares));
}

// ---- Per-miner settlement ("pi" model) -------------------------------------

// The halving milestones, stored as a comma-separated string so an Admin can
// retune them in the panel without a migration. Junk is dropped rather than
// throwing: a fat-fingered milestone list must not be able to take settlement
// down, and a shorter list only ever means a MORE generous rate, never a mint.
export function parseMilestones(raw: string): number[] {
  return String(raw ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}

// The base rate halves once per milestone the user base has passed.
//
// Halving on USER COUNT, not the calendar (founder decision, 2026-07-13). The
// pool is drained by people, so people are what must throttle it: a viral month
// would blow through a calendar-halved pool while the schedule sat there
// insisting it was still week one.
export function piBaseRateFor(userCount: number, baseRate: number, milestones: number[]): number {
  if (!(baseRate > 0)) return 0;
  let halvings = 0;
  for (const m of milestones) if (userCount >= m) halvings++;
  const divisor = Math.pow(2, halvings);
  if (!Number.isFinite(divisor) || divisor <= 0) return 0;
  return baseRate / divisor;
}

// What one miner earns, from THEIR OWN shares alone — no total, no denominator,
// no dilution. This is the whole point of the model: another miner joining cannot
// reduce what you get.
//
// `shares` is hashrate-seconds and already carries every multiplier, because
// hashrate = base x streak x boosts x rigs (+ referral). So dividing by the
// shares a baseline miner would book over a full reference day converts shares
// straight into "how many baseline-days did this person mine", and the rate is
// simply multiplied through.
//
//   baseline miner, full day  -> shares = baseHashrate * referenceSeconds -> 1.0x rate
//   x2 multipliers, full day  -> 2.0x rate
//   baseline miner, 8h of 24h -> 0.33x rate
//
// Returns MICRO-ROZI, floored to the millionth. Dust stays unemitted, so the
// error is always in the treasury's favour — but it is now a millionth of a ROZI
// rather than a whole one, which is what lets the rate be as low as 10/day (and
// survive five halvings down to 0.3125/day) while still paying an 8-hour session
// its honest 0.104 ROZI. Under the old whole-ROZI floor that session paid zero.
export function piPayoutMicroFor(
  shares: number, rate: number, baseHashrate: number, referenceSeconds: number,
): number {
  const fullDayShares = baseHashrate * referenceSeconds;
  if (fullDayShares <= 0 || shares <= 0 || rate <= 0) return 0;
  // Ratio first, for the same 2^53 reason as payoutMicroFor.
  return Math.floor(rate * ROZI_SCALE * (shares / fullDayShares));
}

// The "pi" model's daily total floats with the crowd, so unlike the pool model it
// can ASK for more than the supply cap has left. When it does, every payout is
// scaled by the same factor rather than paying users in row order until the pool
// runs dry mid-list — which would hand the whole remainder to whoever happened to
// sort first. Returns 1 when there is room for everyone.
export function capScaleFactor(wanted: number, room: number): number {
  if (wanted <= 0) return 1;
  if (room <= 0) return 0;
  return Math.min(1, room / wanted);
}

// ---- Conversion window ----------------------------------------------------

// The value bridge (MINING_SPEC.md § 6). A user who burns `burn` ROZI into a
// window that received `totalBurn` ROZI receives that fraction of a pot of
// POINTS that was fixed before the window opened.
//
// There is no rate here, and that is the entire point. A fixed ROZI->Points rate
// would be a promise to buy back an asset we mint for free — an unfunded
// liability that grows with our own success. This cannot pay out more than the
// pot, no matter what anybody mines.
export function conversionPayout(burn: number, totalBurn: number, potPoints: number): number {
  if (totalBurn <= 0 || burn <= 0) return 0;
  return Math.floor((potPoints * burn) / totalBurn);
}
