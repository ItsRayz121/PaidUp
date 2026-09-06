// Reward-pool distribution calculator (Part 7) — a pure, UI-side helper that
// answers "if I put N ROZI into M winners with method X, what does each rank
// get?" It only ever PRODUCES the same comma-separated, rank-1-first ROZI
// list the existing Reward Pools screen already takes
// (LeaderboardRewardsPanel's tiersEarnersRozi/tiersReferrersRozi) — nothing
// here talks to the API or changes how a cycle settles. That keeps this
// calculator a strictly additive assist tool over the already-built,
// already-tested settlement path (api/src/leaderboardRewards.ts), rather
// than a second, competing distribution engine.
//
// Every method here must, by construction:
//   - sum to EXACTLY the requested total pool (integer ROZI), never off by a
//     rounding error in either direction — largestRemainderRound below is
//     what guarantees that, the same "round every share, then hand out
//     whatever the plain rounding missed to the ranks it shorted most" idea
//     the payout industry calls the largest-remainder method.
//   - never invent a payout for a rank that doesn't exist (winnerCount is a
//     hard length bound on the result).

export type DistributionMethod = "balanced" | "equal";

export type DistributionRow = {
  rank: number;
  /** Share of the pool this rank gets, 0-100. */
  percent: number;
  /** Whole ROZI this rank gets — these sum to exactly `totalPool`. */
  rozi: number;
};

export type DistributionResult = {
  rows: DistributionRow[];
  /** rows[0].rozi / rows[last].rozi, or null if there's only one winner or the last rank is 0. */
  firstToLastRatio: number | null;
  /** True if the pool is small enough relative to winnerCount that at least one rank would round to 0. */
  tooSmallForWinnerCount: boolean;
};

/**
 * Raw (unrounded) weight for each rank under a method, rank 1 first.
 * "balanced" = 1/sqrt(rank), normalized by the caller below — higher ranks
 * get a real edge without first place swallowing the whole pool.
 * "equal" = every rank weighted identically.
 */
function rawWeights(method: DistributionMethod, winnerCount: number): number[] {
  const ranks = Array.from({ length: winnerCount }, (_, i) => i + 1);
  if (method === "equal") return ranks.map(() => 1);
  return ranks.map((rank) => 1 / Math.sqrt(rank));
}

/**
 * Split `total` whole units across `weights` (any non-negative numbers,
 * needn't sum to 1) so the result sums to EXACTLY `total` — the largest-
 * remainder method: floor every share, then hand the leftover units one at a
 * time to whichever shares were rounded down the most, largest remainder
 * first, ties broken by rank order (stable, deterministic — never arbitrary
 * JS sort instability for equal remainders).
 */
export function largestRemainderRound(total: number, weights: number[]): number[] {
  const weightSum = weights.reduce((a, w) => a + w, 0);
  if (total <= 0 || weightSum <= 0 || weights.length === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w / weightSum) * total);
  const floors = exact.map((x) => Math.floor(x));
  let remaining = total - floors.reduce((a, x) => a + x, 0);
  const order = floors
    .map((_, i) => i)
    .sort((a, b) => (exact[b] - floors[b]) - (exact[a] - floors[a]) || a - b);
  const result = [...floors];
  for (let i = 0; i < order.length && remaining > 0; i++, remaining--) {
    result[order[i]] += 1;
  }
  return result;
}

/**
 * The full preview table for the reward-pool builder: pick a method, a
 * total pool (whole ROZI), and a winner count (1-100 per the spec), get back
 * exactly `winnerCount` rows whose `rozi` sums to `totalPool`.
 */
export function computeDistribution(
  totalPool: number, winnerCount: number, method: DistributionMethod,
): DistributionResult {
  const count = Math.max(0, Math.min(100, Math.floor(winnerCount)));
  const pool = Math.max(0, Math.floor(totalPool));
  const weights = rawWeights(method, count);
  const rozi = largestRemainderRound(pool, weights);
  const rows: DistributionRow[] = rozi.map((amount, i) => ({
    rank: i + 1,
    percent: pool > 0 ? Math.round((amount / pool) * 10000) / 100 : 0,
    rozi: amount,
  }));
  const last = rows[rows.length - 1];
  const firstToLastRatio =
    rows.length > 1 && last && last.rozi > 0 ? Math.round((rows[0].rozi / last.rozi) * 100) / 100 : null;
  return {
    rows,
    firstToLastRatio,
    tooSmallForWinnerCount: rows.some((r) => r.rozi === 0) && pool > 0,
  };
}

/** Render a DistributionResult back into the exact comma-separated, rank-1-first
 * string the existing tiers input (and the settlement job behind it) already
 * takes — this is the "Apply" step: hand the computed rows to the same field
 * an admin would otherwise type into by hand. */
export function distributionToTiersString(result: DistributionResult): string {
  return result.rows.map((r) => r.rozi).join(", ");
}
