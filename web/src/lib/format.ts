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

// ---- ONE CURRENCY ON SCREEN (founder, 2026-07-30) --------------------------
//
// The earner app shows a single balance, in ROZI. Task and referral earnings —
// which the ledger holds as POINTS — are displayed as ROZI at the fixed ratio
// below, and added to what the user mined.
//
// WHAT THIS IS: a display decision. The two ledgers underneath are UNCHANGED and
// still separate (guardrail #7): points are still points, ROZI is still ROZI,
// nothing converts, no balance is rewritten, and a withdrawal still debits the
// points ledger in points. That separation is what makes the ratio safe to
// change later — retuning POINTS_PER_ROZI restates what is on screen and touches
// nobody's history. If the two ledgers were ever actually merged, this number
// would become impossible to change without confiscating from somebody.
//
// ⚠️ WHAT THIS COSTS, stated once so it is not rediscovered as a surprise: a
// fixed ratio between points and ROZI PUBLISHES AN IMPLIED ROZI PRICE. Points
// have a public rate (1000 = 1 USDT), so 100 points = 1 ROZI says, arithmetically
// and in public, that 1 ROZI = $0.01 — and against the 21M cap, that a $210,000
// valuation. That is exactly the claim MINING_SPEC.md § 7 and the road map's
// no-price rule exist to avoid making. It is the accepted, understood cost of
// showing one currency; it is not an oversight, and it is why the ROZI road map
// still must not print a price of its own on top of it.
export const POINTS_PER_ROZI = 100;

// Points -> micro-ROZI, so earnings can be added to a mined balance that is
// already in micro. Rounded, not floored: this is a display figure, and flooring
// it would shave a fraction off every balance on screen for no benefit.
export function pointsToRoziMicro(points: number): number {
  return Math.round(((points ?? 0) / POINTS_PER_ROZI) * ROZI_SCALE);
}

// The single number the earner app leads with: what they mined, plus what they
// earned, in one currency.
export function totalRoziMicro(roziMicro: number, points: number): number {
  return (roziMicro ?? 0) + pointsToRoziMicro(points);
}

// A POINTS figure, printed as ROZI. This is the one to reach for on every earner
// screen that shows an amount earned: a task reward, a referral total, a
// leaderboard row.
//
// ⚠️ USE THIS, NOT formatMoney, ON ANYTHING AN EARNER READS (founder,
// 2026-07-30: "hide the USDT amount everywhere"). Two currencies on screen was
// the confusion this whole pass exists to remove, and a single stray "0.005
// USDT" on a task card puts it straight back — it is the smallest number in the
// app and it made a real task look worthless.
//
// THE THREE PLACES USDT LEGITIMATELY SURVIVES, because the number there IS
// USDT and calling it anything else would be the lie:
//   • /wallet/withdraw — what we will actually send, on a real chain.
//   • /mine/topup and /mine/rigs — top-up credit the user paid real USDT for.
//   • /mine/convert — the conversion window's whole job is stating a cash rate.
// The staff panel is exempt too, and still shows raw points: it is where the
// ledger gets reconciled.
export function formatPointsAsRozi(points: number): string {
  return `${formatRozi(pointsToRoziMicro(points))} ROZI`;
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
