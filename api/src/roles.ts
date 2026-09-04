import type { FastifyRequest } from "fastify";
import { sql, now } from "./db.ts";
import { config } from "./config.ts";
import { getUserId, requireActiveUser } from "./auth.ts";
import {
  type Permission, type Role, hasPermission, permissionsOf, isRole,
} from "./permissions.ts";

// `Role` lives in permissions.ts (it is defined by the permission bundles), and
// is re-exported here because every route file already imports it from this
// module. Two definitions of the same union is how they drift apart.
export type { Permission, Role };
export { hasPermission, permissionsOf, isRole };

export async function roleOf(userId: string): Promise<Role | null> {
  const row = await sql.get<{ role: string }>("SELECT role FROM admin_users WHERE user_id = ?", userId);
  // Guard against a role string the code no longer knows about (a row written
  // by a newer deploy, or an old role that has since been removed). Treating it
  // as "not staff" fails CLOSED — the alternative is an unknown string falling
  // through a permission check that cannot evaluate it.
  return row && isRole(row.role) ? row.role : null;
}

// Promote a user to admin if their email is in the configured founder list.
// Called on login so the founder gets staff access without manual DB edits.
export async function ensureAdminRole(userId: string, email: string): Promise<void> {
  if (!config.adminEmails.includes(email.toLowerCase())) return;
  const existing = await roleOf(userId);
  if (existing === "admin") return;
  await sql.run(
    "INSERT INTO admin_users (user_id, role, created_at) VALUES (?, 'admin', ?) " +
    "ON CONFLICT(user_id) DO UPDATE SET role = 'admin'",
    userId, now(),
  );
}

// Gate a staff route on ONE NAMED PERMISSION. Throws {statusCode} which the
// route guards turn into JSON.
//
// Suspension must revoke EVERY privilege, staff included. A JWT issued before a
// suspension stays cryptographically valid until it expires, so without this
// check a suspended staff account would keep full access — and admins can now
// mint points redeemable for real USDT. Suspending a compromised admin would
// have looked like it worked while the attacker kept paying themselves.
export async function requirePermission(
  req: FastifyRequest, perm: Permission,
): Promise<{ userId: string; role: Role }> {
  const userId = getUserId(req); // throws 401 if not signed in
  await requireActiveUser(userId, req); // 403 if the account is suspended
  const role = await roleOf(userId);
  if (!role || !hasPermission(role, perm)) {
    throw { statusCode: 403, message: "You do not have access to this." };
  }
  return { userId, role };
}

// Any staff role at all — for the handful of places that only need to know the
// caller is staff, not what they may do.
export async function requireStaff(req: FastifyRequest): Promise<{ userId: string; role: Role }> {
  const userId = getUserId(req);
  await requireActiveUser(userId, req);
  const role = await roleOf(userId);
  if (!role) throw { statusCode: 403, message: "You do not have access to this." };
  return { userId, role };
}

// A withdrawal above this size needs someone trusted with `decide_any`. Roles
// without it (agent, support) are capped — the cap is the point of the role.
export function canApproveAmount(role: Role, points: number): boolean {
  if (hasPermission(role, "withdrawals.decide_any")) return true;
  return points <= config.agentApprovalMaxPoints;
}
