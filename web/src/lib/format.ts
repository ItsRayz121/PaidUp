// Formatting helpers — kept in one place so points/money always read the same.
// Launch market: Pakistan. Payout rail: USDT.

// Value model (founder decision 2026-07-11):
//   • 1000 points = 1 USDT  — the REAL payout rate. MUST match the backend
//     (api/src/config.ts `pointsPerUsdt`, default 1000). If you change
//     POINTS_PER_USDT on the server, change it here too, or the displayed value
//     and the actual payout will disagree.
//
// USDT is the ONLY money figure we show (founder, 2026-07-12). We deliberately
// do not print an approximate local-currency amount beside it: USDT is what the
// user actually receives, and a rupee figure derived from a hard-coded rate goes
// stale and reads as a promise we don't control.
export const POINTS_PER_USDT = 1000;

export function formatPoints(points: number): string {
  return new Intl.NumberFormat("en-PK").format(points);
}

export function pointsToUsdt(points: number): number {
  return points / POINTS_PER_USDT;
}

// Exact USDT value, e.g. "2.00 USDT".
export function formatUsdt(points: number): string {
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(pointsToUsdt(points))} USDT`;
}

// Primary money string used across the app. USDT only — see the note above.
export function formatMoney(points: number): string {
  return formatUsdt(points);
}

// For USDT the SERVER computed and sent as a decimal string (e.g. "3804.521000").
// Those are the authoritative figures — the server floors them to USDT's 6-dp
// smallest unit — so we display them rather than recomputing from points.
export function formatUsdtAmount(usdt: string | number): string {
  return `${Number(usdt).toFixed(2)} USDT`;
}

// ---- ROZI ------------------------------------------------------------------
//
// The API sends every ROZI amount as MICRO-ROZI: an integer count of millionths.
// Fields carrying one are named `...Micro` (roziMicro, estimatedRoziMicro,
// nextCostMicro). NEVER print one of those numbers directly — a balance of 3.33
// ROZI arrives as 3333333, and showing that to a user is the whole reason the
// fields are named the way they are.
//
// MUST stay in sync with ROZI_SCALE in api/src/mining/core.ts.
export const ROZI_SCALE = 1_000_000;

export function roziFromMicro(micro: number): number {
  return (micro ?? 0) / ROZI_SCALE;
}

// How ROZI reads to a user. The base rate is 10/day and an 8-hour session pays
// ~3.33, so the decimals ARE the number — rounding to whole ROZI would show a
// real day's mining as "3" and, after a few halvings, as "0".
//
// Trailing zeros are trimmed: "10" not "10.000000", but "0.104166" in full. A
// miner watching a small balance grow needs to see it move.
export function formatRozi(micro: number): string {
  const rozi = roziFromMicro(micro);
  if (rozi === 0) return "0";
  // Below a thousandth, show enough places that a real balance is never "0.00".
  const decimals = Math.abs(rozi) < 1 ? 6 : Math.abs(rozi) < 1000 ? 4 : 2;
  const s = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0, maximumFractionDigits: decimals,
  }).format(rozi);
  return s;
}

// "2 hours ago", "just now" — plain words, no timestamps in the user UI.
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
