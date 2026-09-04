// A hard ceiling on how many PAID external calls this process can make.
//
// WHY THIS EXISTS, AND WHY IT IS A CEILING RATHER THAN A TUNING KNOB.
// This project has already shipped two real billing incidents, both the same
// shape: something polled a paid provider forever, at a rate set by code rather
// than by user demand, and nobody found out until a spend cap was nearly hit
// (CLAUDE.md, 2026-08-13 and 2026-08-27 — the BNB native scanner walking every
// block, then the USDT scanner's own steady-state poll). Each was fixed at its
// own call site, which is the right fix and is also the fix that only ever
// arrives AFTER the bill.
//
// So this is the other kind of control: one ceiling that holds even when a
// specific safeguard turns out to have a gap — the same reasoning already
// written down for `autoWithdrawMaxPoints` and `autoRefundMaxMicro`. It cannot
// know which loop went wrong. It only guarantees that whatever goes wrong stops
// costing money at a known, configured number.
//
// TWO TIERS, AND THE SPLIT IS LOAD-BEARING. A budget that refuses everything at
// once would turn a cost problem into a money-paths-down problem: the relay
// could not confirm a broadcast it had already made, and a withdrawal gate that
// cannot read a gas balance fails closed on a user who has done nothing wrong.
// So the soft limit stops the things that can simply run again later — scanners,
// display reads, the hourly reconciliation — and leaves headroom to the hard
// limit for the calls that are part of moving someone's money right now.
//
// IN-PROCESS, ON PURPOSE. Same honesty as the rate limiter in server.ts: with
// several replicas each gets its own budget, so the real ceiling is
// (replicas x limit). That is still a ceiling, and it needs no Redis to hold.
// The number to set is therefore per-replica.
import { config } from "./config.ts";

type Priority = "low" | "high";

// A rolling window kept as fixed-size buckets: 60 minute-buckets for the hour
// window, 24 hour-buckets for the day window. Bounded memory by construction —
// this file must never itself become the thing that grows without limit.
class RollingCounter {
  private buckets: number[];
  private stamps: number[];
  constructor(private readonly slots: number, private readonly slotMs: number) {
    this.buckets = new Array(slots).fill(0);
    this.stamps = new Array(slots).fill(-1);
  }
  private slotOf(now: number) { return Math.floor(now / this.slotMs); }
  add(n: number, now = Date.now()): void {
    const slot = this.slotOf(now);
    const i = slot % this.slots;
    if (this.stamps[i] !== slot) { this.buckets[i] = 0; this.stamps[i] = slot; }
    this.buckets[i] += n;
  }
  total(now = Date.now()): number {
    const oldest = this.slotOf(now) - (this.slots - 1);
    let sum = 0;
    for (let i = 0; i < this.slots; i++) {
      if (this.stamps[i] >= oldest) sum += this.buckets[i];
    }
    return sum;
  }
}

type Meter = {
  window: RollingCounter;
  limit: () => number;
  // Calls refused since the process started, split by tier — the number a human
  // actually needs when asking "did the ceiling bite, and what did it cost me".
  refusedLow: number;
  refusedHigh: number;
  // Logged once per window slot rather than per refusal: a runaway loop refused
  // ten thousand times would otherwise write ten thousand log lines, which is
  // its own bill.
  lastWarnSlot: number;
};

const meters: Record<string, Meter> = {
  // Blockchain JSON-RPC (rpc.ts and the viem transports in payout/relay/sweep/
  // reconcile). Steady state at launch is roughly 80-100 calls an hour: the
  // deposit scanner's two per tick, plus whatever the relay and the withdraw
  // screens ask for. The default is deliberately ~50x that — it is not meant to
  // shape normal traffic, only to stop an unattended loop.
  rpc: {
    window: new RollingCounter(60, 60_000),
    limit: () => config.rpcMaxCallsPerHour,
    refusedLow: 0, refusedHigh: 0, lastWarnSlot: -1,
  },
  // Block-explorer reads (bscscan.ts). Etherscan's free tier is a daily
  // allowance, so this one's window is a day to match what actually runs out.
  explorer: {
    window: new RollingCounter(24, 3_600_000),
    limit: () => config.explorerMaxCallsPerDay,
    refusedLow: 0, refusedHigh: 0, lastWarnSlot: -1,
  },
};

// Low priority may spend up to this share of the limit; the rest is reserved
// for calls that are part of moving money right now.
const SOFT_SHARE = 0.8;

export type MeterName = keyof typeof meters;

/**
 * Ask to make `n` paid calls. Returns false if that would cross this tier's
 * ceiling, in which case the caller must NOT make the call.
 *
 * A limit of 0 means "no ceiling" — the escape hatch for an operator who would
 * rather have an unbounded bill than a refused call, set deliberately.
 */
export function charge(name: MeterName, n: number, priority: Priority = "low"): boolean {
  const meter = meters[name];
  const limit = meter.limit();
  // Only an explicit 0 turns the ceiling off. A NaN limit cannot reach here —
  // config.ts's `num()` falls back to the default rather than to NaN — but the
  // guard stays, because "the ceiling silently stopped existing because someone
  // typo'd an env var" is precisely the failure this whole file is against.
  if (!Number.isFinite(limit) || limit <= 0) { meter.window.add(n); return true; }
  const ceiling = priority === "high" ? limit : Math.floor(limit * SOFT_SHARE);
  const used = meter.window.total();
  if (used + n > ceiling) {
    if (priority === "high") meter.refusedHigh++; else meter.refusedLow++;
    const slot = Math.floor(Date.now() / 60_000);
    if (meter.lastWarnSlot !== slot) {
      meter.lastWarnSlot = slot;
      console.warn(
        `[costGuard] ${name}: refusing a ${priority}-priority call — ${used} used against a ceiling of ${ceiling} ` +
        `(limit ${limit}). Something is calling far more than normal, or the limit is set too low.`,
      );
    }
    return false;
  }
  meter.window.add(n);
  return true;
}

/** What the ceilings are doing right now — for the staff diagnostics endpoint. */
export function usage(): Record<string, {
  used: number; limit: number; softCeiling: number; refusedLow: number; refusedHigh: number;
}> {
  const out: Record<string, { used: number; limit: number; softCeiling: number; refusedLow: number; refusedHigh: number }> = {};
  for (const [name, meter] of Object.entries(meters)) {
    const limit = meter.limit();
    out[name] = {
      used: meter.window.total(),
      limit,
      softCeiling: limit > 0 ? Math.floor(limit * SOFT_SHARE) : 0,
      refusedLow: meter.refusedLow,
      refusedHigh: meter.refusedHigh,
    };
  }
  return out;
}

/** Test seam only — resets every window and counter. */
export function __resetForTests(): void {
  for (const [name, meter] of Object.entries(meters)) {
    meters[name] = {
      ...meter,
      window: name === "explorer" ? new RollingCounter(24, 3_600_000) : new RollingCounter(60, 60_000),
      refusedLow: 0, refusedHigh: 0, lastWarnSlot: -1,
    };
  }
}
