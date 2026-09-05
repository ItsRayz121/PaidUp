// Admin-tunable config for the leaderboard reward pools (founder, 2026-09-05).
//
// Stored as ONE JSON blob under a single app_settings key, unlike mining's
// flat scalar keys (mining/settings.ts) — deliberately. A tier list is an
// ARRAY (rank 1..N in whole ROZI), not a scalar, and the two tracks/two
// cadences together are a small tree, not a flat bag of numbers. Storing it
// as one blob means a PATCH validates and writes the WHOLE shape atomically
// (an admin can never save "tiers" without "enabled" landing, or vice versa),
// where N separate scalar keys would need N separate reads to reconstruct one
// coherent config and could disagree mid-edit. Same underlying app_settings
// table every other tunable in this app uses — just one key instead of many.
import { getSetting, setSetting } from "./db.ts";

export type LeaderboardRewardCycleConfig = {
  enabled: boolean;
  // Whole ROZI per rank, index 0 = rank 1. Length = how many ranks get paid.
  // Every number here is the actual amount minted (before supply-cap
  // scaling) — there is no separate "pool size" field, because a pool size
  // that could disagree with the sum of its own tiers is exactly the kind
  // of two-numbers-for-one-fact bug this codebase keeps finding in review.
  tiersEarnersRozi: number[];
  tiersReferrersRozi: number[];
};

export type LeaderboardRewardSettings = {
  // Master switch — both cadences stay off even if individually enabled.
  enabled: boolean;
  weekly: LeaderboardRewardCycleConfig;
  monthly: LeaderboardRewardCycleConfig;
};

// Recommended shape (founder asked for a recommendation, 2026-09-05): top-10,
// steeply tiered, not a flat top-100 split. ROZI's whole culture is small and
// scarce (2.5 ROZI/day baseline, halving on schedule) — spreading a pool
// across 100 people makes rank 100 a rounding error that reads as fake
// generosity, where a steep top-10 taper makes rank 1 feel like a real prize
// while keeping total weekly/monthly spend small and auditable as one named
// number. Every figure below is a DEFAULT — an admin can retype any of it,
// and the whole feature ships OFF until they do.
const DEFAULT_WEEKLY_TIERS = [150, 100, 70, 25, 25, 25, 25, 25, 25, 25]; // sums to 495
const DEFAULT_MONTHLY_TIERS = [600, 400, 280, 100, 100, 100, 100, 100, 100, 100]; // sums to 1980

export const LEADERBOARD_REWARD_DEFAULTS: LeaderboardRewardSettings = {
  enabled: false,
  weekly: { enabled: false, tiersEarnersRozi: DEFAULT_WEEKLY_TIERS, tiersReferrersRozi: DEFAULT_WEEKLY_TIERS },
  monthly: { enabled: false, tiersEarnersRozi: DEFAULT_MONTHLY_TIERS, tiersReferrersRozi: DEFAULT_MONTHLY_TIERS },
};

const KEY = "leaderboardRewards.config";
const MAX_TIERS = 20; // matches loadLeaderboard's own row cap — see leaderboard.ts

export function clampTiers(tiers: unknown): number[] {
  if (!Array.isArray(tiers)) return [];
  return tiers
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v >= 0)
    .slice(0, MAX_TIERS);
}

function mergeCycle(stored: unknown, fallback: LeaderboardRewardCycleConfig): LeaderboardRewardCycleConfig {
  const s = (stored ?? {}) as Partial<LeaderboardRewardCycleConfig>;
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : fallback.enabled,
    tiersEarnersRozi: s.tiersEarnersRozi ? clampTiers(s.tiersEarnersRozi) : fallback.tiersEarnersRozi,
    tiersReferrersRozi: s.tiersReferrersRozi ? clampTiers(s.tiersReferrersRozi) : fallback.tiersReferrersRozi,
  };
}

export async function loadLeaderboardRewardSettings(): Promise<LeaderboardRewardSettings> {
  const raw = await getSetting(KEY, "");
  if (!raw) return LEADERBOARD_REWARD_DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as Partial<LeaderboardRewardSettings>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : LEADERBOARD_REWARD_DEFAULTS.enabled,
      weekly: mergeCycle(parsed.weekly, LEADERBOARD_REWARD_DEFAULTS.weekly),
      monthly: mergeCycle(parsed.monthly, LEADERBOARD_REWARD_DEFAULTS.monthly),
    };
  } catch {
    // A corrupt/hand-edited blob must not crash every screen that reads this —
    // same "never let a display/config read throw" posture as bnbPrice.ts,
    // bscscan.ts, hasEnoughGasForDisplay.
    return LEADERBOARD_REWARD_DEFAULTS;
  }
}

export async function saveLeaderboardRewardSettings(next: LeaderboardRewardSettings): Promise<void> {
  await setSetting(KEY, JSON.stringify(next));
}
