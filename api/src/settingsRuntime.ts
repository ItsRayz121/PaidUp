// Settings that an Admin can change at runtime AND that are also enforced
// somewhere on the earner side.
//
// This file exists to stop one specific class of bug: a stored setting honoured
// in one place and not another. `minWithdrawPoints` is read by the wallet screen
// ("you can cash out now") and, separately, by the route that creates the
// request. If those two disagree, the app tells a user they can withdraw and
// then refuses them — which reads as the product being broken, not as a setting.
// One reader, imported by both.
//
// Kept out of config.ts deliberately: that module is synchronous, loaded from
// the environment at boot, and has no database. These are async reads.
import { getSetting } from "./db.ts";
import { config } from "./config.ts";

/**
 * The minimum points a user needs to request a cash-out.
 *
 * Falls back to the env-configured value when no Admin has ever set one, so an
 * untouched instance behaves exactly as it did before this setting existed.
 */
export async function minWithdrawPointsNow(): Promise<number> {
  const stored = Number(await getSetting("min_withdraw_points", ""));
  return Number.isFinite(stored) && stored > 0 ? stored : config.minWithdrawPoints;
}

/** The app's own name, for user-facing copy the server generates. */
export async function appName(): Promise<string> {
  return (await getSetting("app_name", "")) || "RoziPay";
}

/**
 * How many hours an "answered" ticket waits with no reply before it
 * auto-closes (ticketAutoClose.ts). 0 = never auto-close.
 *
 * Unlike minWithdrawPointsNow, 0 is a real, deliberate value here (not "not
 * set") — so an unset row (getSetting returns "") falls back to the config
 * default, but an explicit "0" is honoured as "off" rather than being
 * treated as invalid and silently replaced.
 */
export async function ticketAutoCloseHoursNow(): Promise<number> {
  const raw = await getSetting("ticket_auto_close_hours", "");
  if (raw === "") return config.ticketAutoCloseHours;
  const stored = Number(raw);
  return Number.isFinite(stored) && stored >= 0 ? stored : config.ticketAutoCloseHours;
}
