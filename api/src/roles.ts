import type { FastifyRequest } from "fastify";
import { db, now } from "./db.ts";
import { config } from "./config.ts";
import { getUserId } from "./auth.ts";

export type Role = "agent" | "manager" | "admin";

export function roleOf(userId: string): Role | null {
  const row = db.prepare("SELECT role FROM admin_users WHERE user_id = ?").get(userId) as
    | { role: Role } | undefined;
  return row?.role ?? null;
}

// Promote a user to admin if their email is in the configured founder list.
// Called on login so the founder gets staff access without manual DB edits.
export function ensureAdminRole(userId: string, email: string): void {
  if (!config.adminEmails.includes(email.toLowerCase())) return;
  const existing = roleOf(userId);
  if (existing === "admin") return;
  db.prepare(
    "INSERT INTO admin_users (user_id, role, created_at) VALUES (?, 'admin', ?) " +
    "ON CONFLICT(user_id) DO UPDATE SET role = 'admin'",
  ).run(userId, now());
}

// Gate a staff route. Throws {statusCode} which route guards turn into JSON.
export function requireStaff(req: FastifyRequest, allowed: Role[]): { userId: string; role: Role } {
  const userId = getUserId(req); // throws 401 if not signed in
  const role = roleOf(userId);
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
