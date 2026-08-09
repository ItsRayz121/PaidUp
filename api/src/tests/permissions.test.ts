// Unit tests for the staff permission model (brief part 47).
//
// The single most important assertion in this file is the FIRST one: the three
// roles that already exist in the live database — agent, manager, admin — must
// come out of this refactor with exactly the reach they went in with. Every
// other test here is about the new roles; that one is about not breaking the
// people currently using the panel.
//
// Pure unit test on purpose: permissions.ts imports nothing, so this file never
// opens a database connection. (See mining.test.ts's header for the node:test
// hang that a stray connection in a unit-test file causes.)
//
//   npm run test:permissions
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  PERMISSIONS, ROLE_PERMISSIONS, ROLES, ROLE_LABELS,
  permissionsOf, hasPermission, isRole, tierOf, isWrite,
  type Permission, type Role,
} from "../permissions.ts";

const ALL = Object.keys(PERMISSIONS) as Permission[];
const tagged = (...tiers: string[]) => ALL.filter((p) => tiers.includes(tierOf(p)));

test("THE THREE LEGACY ROLES KEEP EXACTLY THE ACCESS THEY HAD", () => {
  // Before this refactor the gate was a role list and the three roles were a
  // strict ladder: every ["agent",…] route admitted managers and admins too.
  // These three assertions are that ladder, restated. If one of them fails,
  // some live staff account either lost access it had this morning or gained
  // access nobody granted it — both are incidents, not refactors.
  assert.deepEqual([...permissionsOf("agent")].sort(), tagged("agent").sort());
  assert.deepEqual(
    [...permissionsOf("manager")].sort(), tagged("agent", "manager").sort(),
  );
  assert.deepEqual([...permissionsOf("admin")].sort(), ALL.sort());

  // And the ladder itself: agent ⊂ manager ⊂ admin, still.
  for (const p of permissionsOf("agent")) assert.ok(hasPermission("manager", p), p);
  for (const p of permissionsOf("manager")) assert.ok(hasPermission("admin", p), p);
});

test("admin is the only role that can hand out roles", () => {
  // staff.manage is the keys to everything else: whoever holds it can grant
  // themselves any other permission. If a second role ever legitimately needs
  // it, this test should be updated deliberately — never incidentally.
  const holders = ROLES.filter((r) => hasPermission(r, "staff.manage"));
  assert.deepEqual(holders, ["admin"]);
});

test("only admin can mint or burn a user's balance", () => {
  // users.adjust writes to the points ledger, and points are redeemable for
  // real USDT. This is the sharpest tool in the panel.
  const minters = ROLES.filter((r) => hasPermission(r, "users.adjust"));
  assert.deepEqual(minters, ["admin"]);
  const roziMinters = ROLES.filter((r) => hasPermission(r, "mining.adjust"));
  assert.deepEqual(roziMinters, ["admin"]);
});

test("the brief's own role examples hold", () => {
  // Part 47 states these three by name. They are the acceptance criteria.
  //   "Support: can view users, can answer tickets, cannot change balances"
  assert.ok(hasPermission("support", "users.view"));
  assert.ok(hasPermission("support", "support.reply"));
  assert.ok(!hasPermission("support", "users.adjust"));
  assert.ok(!hasPermission("support", "mining.adjust"));

  //   "Task Manager: can create tasks, can review submissions,
  //    cannot access withdrawals"
  assert.ok(hasPermission("task_manager", "tasks.manage"));
  assert.ok(hasPermission("task_manager", "tasks.review"));
  assert.ok(!hasPermission("task_manager", "withdrawals.view"));
  assert.ok(!hasPermission("task_manager", "withdrawals.decide"));

  //   "Finance: can view wallet operations, cannot modify task campaigns"
  assert.ok(hasPermission("finance", "withdrawals.decide"));
  assert.ok(hasPermission("finance", "deposits.decide"));
  assert.ok(hasPermission("finance", "refunds.decide"));
  assert.ok(!hasPermission("finance", "tasks.manage"));
  assert.ok(!hasPermission("finance", "networks.manage"));
});

test("finance and task_manager are NOT a ladder — neither contains the other", () => {
  // This is the entire reason the role list stopped being a ladder. If either
  // direction of containment is ever true, someone has flattened the model back
  // into tiers and the two jobs can no longer be separated.
  const fin = new Set<string>(permissionsOf("finance"));
  const tm = new Set<string>(permissionsOf("task_manager"));
  assert.ok([...tm].some((p) => !fin.has(p)), "task_manager has something finance lacks");
  assert.ok([...fin].some((p) => !tm.has(p)), "finance has something task_manager lacks");
});

test("analyst can read and cannot write anything", () => {
  // The safe role to hand out freely. Its value is entirely in what it lacks,
  // so the test is written as "no permission that writes", not as a list — and
  // "writes" is read off the model (permissions.ts's W()), not guessed from the
  // permission's name. `users.list` is exactly why: it reads, and no naming rule
  // that keys off ".view" would know that.
  const writes = permissionsOf("analyst").filter(isWrite);
  assert.deepEqual(writes, [], `analyst should be read-only, has: ${writes.join(", ")}`);
});

test("operations runs the platform but cannot pay itself", () => {
  assert.ok(hasPermission("operations", "withdrawals.decide"));
  assert.ok(hasPermission("operations", "users.hold"));
  assert.ok(hasPermission("operations", "fraud.resolve"));
  // The line between running the platform and being able to take money out of
  // it: minting points, and seeing/holding the treasury keys.
  assert.ok(!hasPermission("operations", "users.adjust"));
  assert.ok(!hasPermission("operations", "treasury.view"));
  assert.ok(!hasPermission("operations", "settings.manage"));
  assert.ok(!hasPermission("operations", "staff.manage"));
});

test("marketing can reach users but not read or move their money", () => {
  assert.ok(hasPermission("marketing", "notifications.send"));
  assert.ok(hasPermission("marketing", "content.manage"));
  assert.ok(!hasPermission("marketing", "withdrawals.view"));
  assert.ok(!hasPermission("marketing", "users.adjust"));
  assert.ok(!hasPermission("marketing", "kyc.view"));
});

test("nobody but admin and finance sees a stranger's ID photos", () => {
  // KYC images are national ID cards. The narrowest sensible audience.
  const viewers = ROLES.filter((r) => hasPermission(r, "kyc.view"));
  assert.deepEqual(viewers.sort(), ["admin", "finance"]);
});

test("every role's permissions are real permissions", () => {
  // Catches a typo in ROLE_PERMISSIONS, which TypeScript would catch too — but
  // only until someone widens the type to string[] to silence an error.
  for (const role of ROLES) {
    for (const p of ROLE_PERMISSIONS[role]) {
      assert.ok(ALL.includes(p), `${role} has unknown permission ${p}`);
    }
  }
});

test("every role has a human label, and every permission a legacy tier", () => {
  for (const role of ROLES) {
    assert.ok(ROLE_LABELS[role], `${role} has no label`);
  }
  for (const p of ALL) {
    assert.ok(
      ["agent", "manager", "admin"].includes(tierOf(p)),
      `${p} has no legacy tier — the legacy ladder is built from these tags`,
    );
    assert.equal(typeof isWrite(p), "boolean", `${p} does not say whether it writes`);
  }
});

test("every permission is reachable by at least one role", () => {
  // A permission no role holds is a route nobody can call — usually a rename
  // that only got applied on one side.
  for (const p of ALL) {
    assert.ok(ROLES.some((r) => hasPermission(r, p)), `${p} is held by no role`);
  }
});

test("isRole fails closed on anything it does not know", () => {
  // roleOf() runs this against a raw database string. Anything unrecognised
  // must read as "not staff", never fall through to a permission check.
  assert.ok(isRole("admin"));
  assert.ok(isRole("task_manager"));
  assert.ok(!isRole("superadmin"));
  assert.ok(!isRole("ADMIN"));
  assert.ok(!isRole(""));
  assert.ok(!isRole(null));
  assert.ok(!isRole(undefined));
  assert.ok(!isRole(["admin"] as unknown));
});

test("a capped approver is defined by the missing permission, not by its name", () => {
  // staff.ts asks `hasPermission(role, "withdrawals.decide_any")` rather than
  // `role === "agent"`. These two are the roles that must stay capped; if a new
  // role is added that can decide but not decide_any, it is capped for free.
  const canDecide = ROLES.filter((r) => hasPermission(r, "withdrawals.decide"));
  const capped = canDecide.filter((r) => !hasPermission(r, "withdrawals.decide_any"));
  assert.deepEqual(capped.sort(), ["agent"]);
  // ...and every capped role can still SEE the queue, or the cap would just
  // look like a broken screen.
  for (const r of capped) assert.ok(hasPermission(r, "withdrawals.view"));
});

test("a role that can decide a withdrawal can also see one", () => {
  for (const r of ROLES) {
    if (hasPermission(r, "withdrawals.decide")) {
      assert.ok(hasPermission(r, "withdrawals.view"), `${r} can decide but not view`);
    }
    if (hasPermission(r, "deposits.decide")) {
      assert.ok(hasPermission(r, "deposits.view"), `${r} can decide but not view deposits`);
    }
    if (hasPermission(r, "refunds.decide")) {
      assert.ok(hasPermission(r, "refunds.view"), `${r} can decide but not view refunds`);
    }
    if (hasPermission(r, "kyc.decide")) {
      assert.ok(hasPermission(r, "kyc.view"), `${r} can decide but not view IDs`);
    }
  }
});

test("role ids are stable strings the database already accepts", () => {
  // admin_users.role has a CHECK constraint listing these exact strings
  // (db.ts). A role added here but not there is a 500 on save, not a bug you
  // find in review.
  const EXPECTED: Role[] = [
    "admin", "manager", "agent",
    "operations", "task_manager", "finance", "support", "marketing", "analyst",
  ];
  assert.deepEqual([...ROLES].sort(), [...EXPECTED].sort());
});
