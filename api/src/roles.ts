import type { FastifyRequest } from "fastify";
import { sql, now } from "./db.ts";
import { config } from "./config.ts";
import { getUserId, requireActiveUser } from "./auth.ts";

export type Role = "agent" | "manager" | "admin";

export async function roleOf(userId: string): Promise<Role | null> {
  const row = await sql.get<{ role: Role }>("SELECT role FROM admin_users WHERE user_id = ?", userId);
  return row?.role ?? null;
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

// Gate a staff route. Throws {statusCode} which route guards turn into JSON.
//
// Suspension must revoke EVERY privilege, staff included. A JWT issued before a
// suspension stays cryptographically valid until it expires, so without this
// check a suspended staff account would keep full access — and admins can now
// mint points redeemable for real USDT. Suspending a compromised admin would
// have looked like it worked while the attacker kept paying themselves.
export async function requireStaff(req: FastifyRequest, allowed: Role[]): Promise<{ userId: string; role: Role }> {
  const userId = getUserId(req); // throws 401 if not signed in
  await requireActiveUser(userId); // 403 if the account is suspended
  const role = await roleOf(userId);
  if (!role || !allowed.includes(role)) {
    throw { statusCode: 403, message: "You do not have access to this." };
  }
  return { userId, role };
}

// Managers and admins can do anything an agent can; agents are limited.
export function canApproveAmount(role: Role, points: number): boolean {
  if (role === "manager" || role === "admin") return true;
  return points <= config.agentApprovalMaxPoints; // agent
}
