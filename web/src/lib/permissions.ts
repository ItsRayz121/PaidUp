// What the signed-in staff member may do — the web half of api/src/permissions.ts.
//
// ⚠️ THIS DECIDES WHAT TO DRAW, NEVER WHETHER SOMETHING IS ALLOWED.
// Every staff route re-checks the caller's permission server-side against the
// role it reads from the database (`requirePermission` in api/src/roles.ts).
// Editing localStorage here gets you a panel full of buttons that each return
// 403 — which is exactly the property that makes it safe to keep this list on
// the client at all.

import type { SessionUser } from "./api";

// Only the permissions the panel actually branches on. Deliberately not a
// mirror of all forty: a list that has to be kept in sync is a list that drifts,
// and the API is the authority. Adding one here is a one-line change.
export type UiPermission =
  | "withdrawals.view" | "withdrawals.decide"
  | "deposits.view" | "deposits.decide"
  | "refunds.view" | "refunds.decide"
  | "treasury.view" | "money.view"
  | "users.view" | "users.list" | "users.status" | "users.hold" | "users.adjust" | "users.notify"
  | "kyc.view" | "kyc.decide"
  | "fraud.view" | "fraud.resolve"
  | "tasks.view" | "tasks.manage" | "tasks.review"
  | "networks.manage" | "referrals.manage"
  | "mining.view" | "mining.manage" | "mining.adjust" | "machines.manage"
  | "store.view" | "store.redemptions.view" | "store.redemptions.decide"
  | "support.view" | "support.reply"
  | "leaderboard.manage" | "notifications.send" | "content.manage"
  | "analytics.view" | "audit.view" | "settings.manage" | "flags.manage"
  | "infra.view" | "staff.manage" | "export.data";

/**
 * Does this user hold `perm`?
 *
 * The stale-session case is the interesting one. `user` comes out of
 * localStorage, and a staff member who signed in before the deploy that added
 * `permissions` has a stored session without it. Rather than guess — a guess
 * that is wrong in the generous direction shows buttons that 403, and wrong in
 * the strict direction hides a manager's whole panel — the staff page re-reads
 * /auth/me on mount and writes the fresh copy back (see `useStaffSession`).
 * Until that lands, a missing list means "not yet known", and the panel shows
 * its loading state instead of a wrong screen.
 */
export function can(user: SessionUser | null | undefined, perm: UiPermission): boolean {
  if (!user?.role) return false;
  return Array.isArray(user.permissions) && user.permissions.includes(perm);
}

/** True if the user holds at least one of these — for a section fed by several panels. */
export function canAny(user: SessionUser | null | undefined, perms: UiPermission[]): boolean {
  return perms.some((p) => can(user, p));
}

/** Has the permission list arrived yet? False only for a session predating it. */
export function permissionsKnown(user: SessionUser | null | undefined): boolean {
  return !user?.role || Array.isArray(user.permissions);
}
