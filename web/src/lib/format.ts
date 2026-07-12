// Formatting helpers — kept in one place so points/money always read the same.
// Launch market: Pakistan. Payout rail: USDT.

// Value model (founder decision 2026-07-11):
//   • 1000 points = 1 USDT  — the REAL payout rate. MUST match the backend
//     (api/src/config.ts `pointsPerUsdt`, default 1000). If you change
//     POINTS_PER_USDT on the server, change it here too, or the displayed value
//     and the actual payout will disagree.
//   • 1 USDT ≈ 280 PKR — a display-only approximation so users see a familiar
//     local figure next to the (exact) USDT amount.
export const POINTS_PER_USDT = 1000;
export const PKR_PER_USDT = 280;

export function formatPoints(points: number): string {
  return new Intl.NumberFormat("en-PK").format(points);
}

export function pointsToUsdt(points: number): number {
  return points / POINTS_PER_USDT;
}
export function pointsToPkr(points: number): number {
  return pointsToUsdt(points) * PKR_PER_USDT;
}

// Exact USDT value, e.g. "2.00 USDT".
export function formatUsdt(points: number): string {
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(pointsToUsdt(points))} USDT`;
}
// Approximate local value, e.g. "Rs 560".
export function formatPkr(points: number): string {
  return `Rs ${new Intl.NumberFormat("en-PK", { maximumFractionDigits: 0 }).format(pointsToPkr(points))}`;
}

// Primary money string used across the app: exact USDT + an approximate PKR,
// e.g. "2.00 USDT (≈ Rs 560)". USDT is what the user actually receives; the
// rupee figure is only an at-a-glance local approximation.
export function formatMoney(points: number): string {
  return `${formatUsdt(points)} (≈ ${formatPkr(points)})`;
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
