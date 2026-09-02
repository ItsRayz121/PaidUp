// Granular staff permissions.
//
// WHY THIS EXISTS
// ---------------
// Until this file, a staff route said `staffGuard(["manager", "admin"])` — the
// gate WAS the role, and the three roles were a strict ladder
// (agent ⊂ manager ⊂ admin). That works for three roles and stops working the
// moment you want a Finance person who can pay a withdrawal but must not edit a
// task campaign, or a Task Manager who is the reverse. Those two are not a
// ladder; neither contains the other. A ladder cannot express them, no matter
// how many rungs you add.
//
// So the gate is now a NAMED PERMISSION and a role is just a bundle of them.
// Adding a role is a line in ROLE_PERMISSIONS; it never touches a route.
//
// ⚠️ THE THREE OLD ROLES MUST KEEP EXACTLY THE ACCESS THEY HAVE TODAY.
// There are live staff accounts holding 'agent' / 'manager' / 'admin', and this
// refactor is not the place to quietly widen or narrow any of them. Every
// permission below is tagged with the lowest legacy role that already had it,
// and AGENT_PERMS / MANAGER_PERMS / ADMIN_PERMS are built from those tags — so
// the old ladder is reproduced by construction rather than by hand. There is a
// test (`test:permissions`) that walks every route's guard and asserts the
// legacy roles' reach is unchanged.

// ---- The permissions -------------------------------------------------------
// Named `area.verb`, and each carries two facts:
//
//   tier  — the LOWEST legacy role that already held it. AGENT/MANAGER/ADMIN_PERMS
//           are built from this, so the old ladder is reproduced by construction.
//   write — does exercising it CHANGE anything? Stated explicitly rather than
//           inferred from the name: `users.list` reads, `users.status` writes,
//           and no naming convention survives contact with forty permissions.
//           It is what makes "analyst is read-only" a checkable property of the
//           model instead of a promise in a comment.
//
// Keep them coarse enough that a human can hold the list in their head — one per
// thing a staff member is trusted to DO, not one per route.
type Tier = "agent" | "manager" | "admin";
const R = (tier: Tier) => ({ tier, write: false }) as const;  // read
const W = (tier: Tier) => ({ tier, write: true }) as const;   // write

export const PERMISSIONS = {
  // Money out
  "withdrawals.view": R("agent"),
  "withdrawals.decide": W("agent"),        // approve / reject / mark paid
  "withdrawals.decide_any": W("manager"),  // without this, capped at agentApprovalMaxPoints
  "disbursements.manage": W("admin"),      // admin-initiated batch reward payout — release / send / reconcile
  // Money in
  "deposits.view": R("manager"),
  "deposits.decide": W("admin"),           // confirm / reject a pasted tx hash
  "refunds.view": R("manager"),
  "refunds.decide": W("admin"),
  "treasury.view": R("admin"),
  "money.view": R("admin"),                // what we owe vs what we've paid
  // Users
  "users.view": R("agent"),                // look one up (disputes)
  "users.list": R("manager"),
  "users.status": W("admin"),              // suspend / unsuspend
  "users.hold": W("manager"),              // stop automatic payouts on one account
  "users.review": W("manager"),            // mark/clear a staff triage label — never a hold or a suspension
  "users.adjust": W("admin"),              // mint or burn points — the sharpest tool here
  "users.notify": W("manager"),            // send one user a message
  // Identity
  "kyc.view": R("admin"),
  "kyc.decide": W("admin"),
  // Fraud
  "fraud.view": R("manager"),
  "fraud.resolve": W("manager"),
  // Tasks
  "tasks.view": R("admin"),
  "tasks.manage": W("admin"),              // create / edit / read a postback secret
  "tasks.review": W("agent"),              // approve or reject a submitted proof
  "networks.manage": W("admin"),
  "referrals.manage": W("admin"),
  // Mining
  "mining.view": R("manager"),
  "mining.manage": W("admin"),             // rates, settlement, conversion windows
  "mining.adjust": W("admin"),             // hand-credit or debit ROZI
  "machines.manage": W("admin"),           // rigs, boosters, the ROZI store
  "store.view": R("manager"),
  "store.redemptions.view": R("agent"),
  "store.redemptions.decide": W("manager"),
  // Support
  "support.view": R("agent"),
  "support.reply": W("agent"),
  // Growth
  "leaderboard.manage": W("admin"),
  "notifications.send": W("admin"),
  "content.manage": W("admin"),            // home banners, announcements
  // Platform
  "analytics.view": R("manager"),
  "audit.view": R("manager"),
  "settings.manage": W("admin"),
  "flags.manage": W("admin"),
  "infra.view": R("admin"),                // RPC health, reconciliation internals
  "staff.manage": W("admin"),              // hand out roles — the keys to everything
  "export.data": R("admin"),
} as const;

export type Permission = keyof typeof PERMISSIONS;
const ALL = Object.keys(PERMISSIONS) as Permission[];

export const tierOf = (p: Permission): Tier => PERMISSIONS[p].tier;
export const isWrite = (p: Permission): boolean => PERMISSIONS[p].write;

// Built from the tiers above, so the legacy ladder cannot drift out of step with
// the permission list. Do not hand-edit these three.
const legacy = (...tiers: Tier[]) => ALL.filter((p) => tiers.includes(tierOf(p)));
const AGENT_PERMS = legacy("agent");
const MANAGER_PERMS = legacy("agent", "manager");
const ADMIN_PERMS = ALL;

// ---- The roles -------------------------------------------------------------
export type Role =
  // The three that already exist in the database. Kept, not renamed: live rows
  // hold these strings, and renaming them would be a migration for no gain.
  | "admin" | "manager" | "agent"
  // The job-shaped roles. These are NOT a ladder — `finance` and `task_manager`
  // deliberately do not contain one another, which is the whole point.
  | "operations" | "task_manager" | "finance" | "support" | "marketing" | "analyst";

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // — Super Admin. Everything, including handing out roles.
  admin: ADMIN_PERMS,
  // — Legacy tiers, frozen at today's reach.
  manager: MANAGER_PERMS,
  agent: AGENT_PERMS,

  // — Operations: runs the day-to-day. Sees the money moving and can hold an
  //   account, but cannot MINT — `users.adjust` and `treasury.view` are the
  //   line between running the platform and being able to pay yourself.
  operations: [
    "withdrawals.view", "withdrawals.decide", "withdrawals.decide_any",
    "deposits.view", "refunds.view",
    "users.view", "users.list", "users.hold", "users.review", "users.notify",
    "fraud.view", "fraud.resolve",
    "tasks.view", "tasks.review",
    "mining.view", "store.view", "store.redemptions.view", "store.redemptions.decide",
    "support.view", "support.reply",
    "analytics.view", "audit.view",
  ],

  // — Task Manager: owns the offer catalogue end to end and nothing else.
  //   No withdrawals, by design (brief part 47).
  task_manager: [
    "tasks.view", "tasks.manage", "tasks.review",
    "networks.manage", "referrals.manage",
    "users.view", "analytics.view",
  ],

  // — Finance: owns money in and money out, and cannot touch a campaign.
  finance: [
    "withdrawals.view", "withdrawals.decide", "withdrawals.decide_any",
    "disbursements.manage",
    "deposits.view", "deposits.decide",
    "refunds.view", "refunds.decide",
    "treasury.view", "money.view",
    "users.view", "users.list", "users.hold",
    "kyc.view", "kyc.decide",
    "analytics.view", "audit.view", "export.data",
  ],

  // — Support: the brief's own example — "can view users, can answer tickets,
  //   cannot change balances".
  support: [
    "users.view", "support.view", "support.reply",
    "tasks.review", "store.redemptions.view",
  ],

  // — Marketing: reaches users and shapes what they see. No money, no users.
  marketing: [
    "notifications.send", "content.manage",
    "leaderboard.manage", "referrals.manage",
    "users.list", "analytics.view",
  ],

  // — Analyst: read-only, everywhere it is safe to read. No write permission at
  //   all, which is what makes this the safe role to hand out freely.
  analyst: ["analytics.view", "audit.view", "users.list", "users.view", "mining.view"],
};

// What a role is called on screen. The staff panel never shows the raw key.
export const ROLE_LABELS: Record<Role, string> = {
  admin: "Super Admin",
  manager: "Manager (legacy)",
  agent: "Agent (legacy)",
  operations: "Operations",
  task_manager: "Task Manager",
  finance: "Finance",
  support: "Support",
  marketing: "Marketing",
  analyst: "Analyst",
};

export const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];
export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as string[]).includes(v);
}

export function permissionsOf(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function hasPermission(role: Role, perm: Permission): boolean {
  return permissionsOf(role).includes(perm);
}
