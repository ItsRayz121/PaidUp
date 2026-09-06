// E2E for the Mined ROZI / Wallet ROZI split (founder, 2026-09-06).
//
// They are NOT two separate rewards — every micro-ROZI a user holds is counted
// in exactly one of the two, and the two always sum to the existing total
// (roziBalanceMicroOf). Mined ROZI stays inside Mining until a user passes KYC
// and a staff member runs the approved release process
// (POST /staff/mining/users/:id/release-to-wallet); that moves ROZI from Mined
// to Wallet atomically, same currency, never a mint or a duplicate.
//
// The cases that matter:
//   • the split is conserved: mined + wallet === total, always
//   • KYC is actually enforced, not just documented
//   • a release cannot move more than the user has Mined
//   • it is atomic under concurrency (guardrail #8's advisory lock)
//   • the earner-facing /mining/state balance drops by exactly what moved out
//   • Wallet ROZI is not reachable through any earner-facing spend/transfer
//   • only mining.adjust (admin) can call the staff route
//
//   npm run test:roziwallet
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import {
  initDb, sql, now, newId, postRozi,
  roziBalanceMicroOf, roziMinedBalanceMicroOf, roziWalletBalanceMicroOf,
} from "../db.ts";
import { config } from "../config.ts";
import { miningRoutes } from "../routes/mining.ts";
import { staffMiningRoutes } from "../routes/staffMining.ts";
import { staffRoutes } from "../routes/staff.ts";
import { toMicro, fromMicro } from "../mining/core.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(miningRoutes);
await app.register(staffMiningRoutes);
await app.register(staffRoutes);

const mkUser = async (label: string, role: string | null = null) => {
  const id = newId();
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at) VALUES (?,?,1,'Pakistan',?,'active',?)",
    id, `${label}-${id}@t.test`, id.slice(0, 8).toUpperCase(), now(),
  );
  if (role) {
    await sql.run(
      "INSERT INTO admin_users (user_id, role, created_at) VALUES (?,?,?) " +
      "ON CONFLICT(user_id) DO UPDATE SET role = EXCLUDED.role",
      id, role, now(),
    );
  }
  return id;
};
const tok = (userId: string) => ({
  authorization: `Bearer ${jwt.sign({ sub: userId }, config.jwtSecret)}`,
});
const mine = (userId: string, rozi: number) => postRozi({
  userId, micro: toMicro(rozi), direction: "credit",
  sourceType: "mining", sourceRefId: "rozi-wallet-e2e", note: "mined",
});
const taskReward = (userId: string, rozi: number) => postRozi({
  userId, micro: toMicro(rozi), direction: "credit",
  sourceType: "task_reward", sourceRefId: "rozi-wallet-e2e", note: "task",
});
const approveKyc = (userId: string) =>
  sql.run("UPDATE users SET kyc_status = 'approved' WHERE id = ?", userId);
const release = (adminId: string, targetId: string, rozi: number, note = "release for test") =>
  app.inject({
    method: "POST", url: `/staff/mining/users/${targetId}/release-to-wallet`,
    headers: tok(adminId), payload: { rozi, note },
  });
const miningState = (userId: string) =>
  app.inject({ method: "GET", url: "/mining/state", headers: tok(userId) });

const admin = await mkUser("roziwalletadmin", "admin");
const manager = await mkUser("roziwalletmanager", "manager");

// ---------------------------------------------------------------------------
console.log("\n-- the split is conserved: mined + wallet always equals the total --");
{
  const u = await mkUser("split");
  await mine(u, 40);
  await taskReward(u, 10);
  await approveKyc(u);

  const totalBefore = await roziBalanceMicroOf(u);
  const minedBefore = await roziMinedBalanceMicroOf(u);
  const walletBefore = await roziWalletBalanceMicroOf(u);
  check("before any release, mined is the whole total", minedBefore === totalBefore);
  check("before any release, wallet is zero", walletBefore === 0);

  const r = await release(admin, u, 15);
  check("the release succeeds", r.statusCode === 200, r.body);
  const body = JSON.parse(r.body);

  const totalAfter = await roziBalanceMicroOf(u);
  const minedAfter = await roziMinedBalanceMicroOf(u);
  const walletAfter = await roziWalletBalanceMicroOf(u);
  check("total ROZI is exactly conserved — nothing minted, nothing destroyed", totalAfter === totalBefore);
  check("mined dropped by exactly the released amount", minedAfter === minedBefore - toMicro(15));
  check("wallet rose by exactly the released amount", walletAfter === toMicro(15));
  check("mined + wallet still equals the total after the move", minedAfter + walletAfter === totalAfter);
  check("the response reports the same numbers the ledger now holds",
    body.minedAfter === minedAfter && body.walletAfter === walletAfter);
}

// ---------------------------------------------------------------------------
console.log("\n-- KYC is actually enforced, not just documented --");
{
  const u = await mkUser("nokyc");
  await mine(u, 20);
  const r = await release(admin, u, 5);
  check("refused before KYC is approved", r.statusCode === 400);
  check("nothing moved", (await roziWalletBalanceMicroOf(u)) === 0);

  await approveKyc(u);
  const r2 = await release(admin, u, 5);
  check("succeeds once KYC is approved", r2.statusCode === 200, r2.body);
}

// ---------------------------------------------------------------------------
console.log("\n-- a release cannot move more Mined ROZI than the user has --");
{
  const u = await mkUser("shortfall");
  await mine(u, 3);
  await approveKyc(u);
  const r = await release(admin, u, 10);
  check("refused — not enough Mined ROZI", r.statusCode === 400);
  check("wallet stays at zero", (await roziWalletBalanceMicroOf(u)) === 0);
  check("mined is untouched", (await roziMinedBalanceMicroOf(u)) === toMicro(3));
}

// ---------------------------------------------------------------------------
console.log("\n-- a zero or negative amount is refused --");
{
  const u = await mkUser("badamount");
  await mine(u, 10);
  await approveKyc(u);
  const r = await release(admin, u, 0);
  check("zero is refused", r.statusCode === 400);
  const r2 = await release(admin, u, -5);
  check("negative is refused", r2.statusCode === 400);
}

// ---------------------------------------------------------------------------
console.log("\n-- only mining.adjust (admin) can call this route --");
{
  const u = await mkUser("permcheck");
  await mine(u, 10);
  await approveKyc(u);
  const r = await release(manager, u, 5);
  check("a manager (no mining.adjust) is refused", r.statusCode === 403);
  const earner = await mkUser("earnernoperm");
  const r2 = await release(earner, u, 5);
  check("an earner with no staff role is refused", r2.statusCode === 403);
  check("nothing moved either time", (await roziWalletBalanceMicroOf(u)) === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- the earner-facing /mining/state balance drops by exactly what moved out --");
{
  const u = await mkUser("earnerview");
  await mine(u, 50);
  await approveKyc(u);
  const before = await miningState(u);
  const beforeBody = JSON.parse(before.body);
  check("state shows the full mined amount before any release", beforeBody.roziMicro === toMicro(50));

  await release(admin, u, 20);
  const after = await miningState(u);
  const afterBody = JSON.parse(after.body);
  check("state now shows Mined ROZI only, reduced by the release", afterBody.roziMicro === toMicro(30));
}

// ---------------------------------------------------------------------------
console.log("\n-- concurrent releases cannot jointly move more than one release's worth --");
{
  const u = await mkUser("concurrent");
  await mine(u, 20);
  await approveKyc(u);
  // Two releases of 15 each against a balance of 20 — at most one can succeed.
  const [r1, r2] = await Promise.all([release(admin, u, 15), release(admin, u, 15)]);
  const okCount = [r1, r2].filter((r) => r.statusCode === 200).length;
  check("exactly one of the two concurrent releases succeeded", okCount === 1, `okCount=${okCount}`);
  const walletMicro = await roziWalletBalanceMicroOf(u);
  check("the ledger agrees — only one release's worth moved", walletMicro === toMicro(15), `wallet=${walletMicro}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- GET /staff/users and GET /staff/users/:id report the split correctly --");
{
  const u = await mkUser("listcheck");
  await mine(u, 30);
  await taskReward(u, 5);
  await approveKyc(u);
  await release(admin, u, 12);

  const listR = await app.inject({
    method: "GET", url: `/staff/users?q=${encodeURIComponent(u)}`, headers: tok(admin),
  });
  check("the list endpoint answers", listR.statusCode === 200, listR.body);
  const listBody = JSON.parse(listR.body);
  const row = listBody.users.find((x: { id: string }) => x.id === u);
  check("the user is in the list", Boolean(row));
  if (row) {
    check("list: total = mined + wallet", row.roziMicro === row.roziMinedMicro + row.roziWalletMicro);
    check("list: wallet is exactly what was released", row.roziWalletMicro === toMicro(12));
    check("list: mined is total minus what was released", row.roziMinedMicro === toMicro(35 - 12));
  }

  const detailR = await app.inject({ method: "GET", url: `/staff/users/${u}`, headers: tok(admin) });
  check("the detail endpoint answers", detailR.statusCode === 200, detailR.body);
  const detailBody = JSON.parse(detailR.body);
  check("detail: total = mined + wallet", detailBody.user.roziMicro === detailBody.user.roziMinedMicro + detailBody.user.roziWalletMicro);
  check("detail: wallet is exactly what was released", detailBody.user.roziWalletMicro === toMicro(12));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
