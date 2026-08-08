// Admin-tunable ceilings for fully-automatic settlement (founder, 2026-08-08:
// "it is user money... no need of any human involvement [below some amount],
// only above a big amount like $100"). Both ceilings already existed
// (autoWithdraw.ts / autoRefund.ts, founder 2026-08-05/06) but were env-var
// only — an Admin could not change them without a redeploy. Live in
// app_settings now, same pattern as the gas fee (fees.ts), falling back to
// the env var default so nothing changes for a deployment that never touches
// this in /staff.
//
// ⚠️ Neither of these does anything by itself. Both auto-settle paths stay a
// no-op until PAYOUT_MODE=onchain AND a real treasury signer key are also
// set — see CUSTODY_SPEC.md § 5c and payout.ts's header comment. Raising a
// ceiling here only changes what happens ONCE that is true.
import { getSetting } from "./db.ts";
import { config } from "./config.ts";

export async function getAutoWithdrawMaxPoints(): Promise<number> {
  const v = await getSetting("auto_withdraw_max_points", String(config.autoWithdrawMaxPoints));
  return Math.max(0, Number(v) || 0);
}

export async function getAutoRefundMaxMicro(): Promise<number> {
  const v = await getSetting("auto_refund_max_micro", String(config.autoRefundMaxMicro));
  return Math.max(0, Number(v) || 0);
}
