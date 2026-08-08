// The gas-cost fee (founder, 2026-08-08): sending USDT on BEP20 costs the
// platform real gas, and neither a withdrawal nor a refund recovered any of
// it before this — a refund of the full requested amount was a guaranteed
// per-request loss. Percent-of-amount + a fixed floor, because a pure
// percentage undercharges on small requests where the fixed gas cost is the
// bigger share of the total (the founder's own example: 5% + $0.01 on a $1
// request). Shared by both flows so the two never drift into two different
// answers to "what does gas cost."
import { getSetting } from "./db.ts";
import { config } from "./config.ts";

export type GasFeeRate = { percent: number; fixedMicro: number };

export async function getGasFeeRate(): Promise<GasFeeRate> {
  const percent = Math.max(0, Number(await getSetting("gas_fee_percent", "0")) || 0);
  const fixedMicro = Math.max(0, Math.round(Number(await getSetting("gas_fee_fixed_micro", "0")) || 0));
  return { percent, fixedMicro };
}

// Fee for a micro-USDT amount — used by refunds, which are USDT-denominated
// end to end.
export function gasFeeMicro(amountMicro: number, rate: GasFeeRate): number {
  return Math.round((amountMicro * rate.percent) / 100) + rate.fixedMicro;
}

// Fee for a points amount — used by withdrawals. The fixed micro-USDT leg is
// converted to points at the SAME rate a withdrawal is paid out at
// (config.pointsPerUsdt, the one conversion rule payout.ts also uses), so
// "$0.01" means the same number of points everywhere it is charged.
export function gasFeePoints(amountPoints: number, rate: GasFeeRate): number {
  const fixedPoints = Math.round((rate.fixedMicro / 1_000_000) * config.pointsPerUsdt);
  return Math.round((amountPoints * rate.percent) / 100) + fixedPoints;
}
