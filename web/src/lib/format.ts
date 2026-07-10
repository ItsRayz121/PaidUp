// Formatting helpers — kept in one place so points/money always read the same.
// Launch country assumption: Pakistan (see docs/PROJECT_SPEC.md → Open Questions).

// Points-to-currency is a business decision (commission split). This constant is
// a placeholder for the demo ONLY, so the UI can show "your points are worth X".
// Real value comes from the backend once the split is set. Do not treat as final.
export const POINTS_PER_UNIT = 100; // 100 points = 1 rupee (demo rate)
export const CURRENCY = "PKR";
export const CURRENCY_SYMBOL = "Rs";

export function formatPoints(points: number): string {
  return new Intl.NumberFormat("en-PK").format(points);
}

export function pointsToMoney(points: number): number {
  return points / POINTS_PER_UNIT;
}

export function formatMoney(points: number): string {
  const value = pointsToMoney(points);
  return `${CURRENCY_SYMBOL} ${new Intl.NumberFormat("en-PK", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value)}`;
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
