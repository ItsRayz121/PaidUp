// Formatting helpers — kept in one place so points/money always read the same.
// Launch market: Pakistan. Payout rail: USDT.

// Value model (founder decision 2026-07-11):
//   • 1000 points = 1 USDT  — the REAL payout rate. MUST match the backend
//     (api/src/config.ts `pointsPerUsdt`, default 1000). If you change
//     POINTS_PER_USDT on the server, change it here too, or the displayed value
//     and the actual payout will disagree.
//
// ⚠️ POINTS ARE NOW AN INTERNAL UNIT ONLY (founder, 2026-07-29). The user-facing
// app shows ONE currency for money — USDT — and the word "points" no longer
// appears on any earner screen.
//
// The ledger is still in points and the API still speaks points, because that is
// where the integer arithmetic lives and a floating-point money ledger is how
// money systems lose cents. Points are converted to USDT at the very edge, here.
// So: the API boundary talks points, everything a user reads says USDT, and
// usdtToPoints() below is the one place the conversion runs the other way.
//
// The staff panel is deliberately EXEMPT and still shows points: it is where the
// ledger is reconciled, and hiding the underlying unit from the people doing
// that would make the numbers harder to check, not easier.
export const POINTS_PER_USDT = 1000;

// Only the staff panel should call this now. Earner screens use formatMoney.
export function formatPoints(points: number): string {
  return new Intl.NumberFormat("en-PK").format(points);
}

export function pointsToUsdt(points: number): number {
  return points / POINTS_PER_USDT;
}

// The other direction, for inputs where the user types USDT and the API wants
// points. Rounded, because a fractional point cannot exist in the ledger.
export function usdtToPoints(usdt: number): number {
  return Math.round(usdt * POINTS_PER_USDT);
}

// Exact USDT value, e.g. "2.00 USDT".
//
// PRECISION IS ADAPTIVE, and it has to be: a single task can pay 5 points, which
// is $0.005. At a fixed two decimals that renders as "0.01 USDT" (overstating
// it) or "0.00 USDT" (telling someone their work was worth nothing). Small
// amounts therefore get three decimals, which is what the numbers in this app
// actually need. Anything from a dollar up reads as money normally does.
export function formatUsdt(points: number): string {
  const usdt = pointsToUsdt(points);
  const decimals = Math.abs(usdt) > 0 && Math.abs(usdt) < 1 ? 3 : 2;
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: decimals,
  }).format(usdt)} USDT`;
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

// ---- USDT top-up credit ----------------------------------------------------
//
// A SEPARATE number from the money above. `formatMoney` converts POINTS earned
// from tasks into the USDT we will pay out; this formats a balance that is
// already USDT, topped up by the user to spend on mining machines.
//
// Do not add the two together anywhere. One is money we owe the user and can be
// withdrawn; the other is prepaid credit that can only be spent inside the app
// and can never be taken out (api/src/db.ts, usdt_ledger). A single combined
// "your USDT" figure would promise that all of it is withdrawable.
export const USDT_SCALE = 1_000_000;

export function usdtFromMicro(micro: number): number {
  return (micro ?? 0) / USDT_SCALE;
}

export function formatUsdtMicro(micro: number): string {
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(usdtFromMicro(micro))} USDT`;
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
