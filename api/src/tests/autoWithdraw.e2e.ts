// E2E for fully-automatic on-chain withdrawal (founder decision, 2026-08-05)
// and its safety valve, the per-account withdrawal hold.
//
// ⚠️ WHAT THIS SUITE DOES NOT COVER. It never lets tryAutoSettle() reach a
// real network call — every scenario here is refused BEFORE that point (mode
// off, above the auto ceiling, account held, no signer configured). Proving
// the actual broadcast (provider.send() succeeding against a real chain)
// needs BSC testnet and a funded gas wallet, which is a deliberate separate
// step — see CUSTODY_SPEC.md § 4 and payout.ts's header comment. This suite
// exists to make sure the REFUSALS are airtight, since those are what keep an
// unproven signer from firing at all.
//
//   npm run test:autowithdraw
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { initDb, sql, now, newId, postLedger } from "../db.ts";
import { config } from "../config.ts";
import { withdrawalRoutes } from "../routes/withdrawals.ts";
import { staffRoutes } from "../routes/staff.ts";
import { toChecksumAddress } from "../wallet.ts";
import { encryptSecret } from "../signer.ts";
import { isWithdrawalHeld } from "../db.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(withdrawalRoutes);
await app.register(staffRoutes);

const mkUser = async (label: string, role: string | null = null) => {
  const id = newId();
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, kyc_status, created_at) VALUES (?,?,1,'Pakistan',?,'active','approved',?)",
    id, `${label}-${id}@t.test`, id.slice(0, 8).toUpperCase(), now(),
  );
  if (role) {
    await sql.run(
      "INSERT INTO admin_users (user_id, role, created_at) VALUES (?,?,?)",
      id, role, now(),
    );
  }
  return id;
};
const tok = (userId: string) => ({
  authorization: `Bearer ${jwt.sign({ sub: userId }, config.jwtSecret)}`,
});

function testAddress(): string {
  const { publicKey } = secp256k1.keygen();
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false);
  return toChecksumAddress("0x" + bytesToHex(keccak_256(uncompressed.slice(1))).slice(-40));
}

async function fund(userId: string, points: number) {
  await postLedger({
    userId, points, direction: "credit",
    sourceType: "admin_adjustment", sourceRefId: newId(), note: "e2e funding",
  });
}

const requestStatus = async (userId: string) => {
  const row = await sql.get<{ status: string }>(
    "SELECT status FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", userId,
  );
  return row?.status;
};

// Everything below runs with a fresh gate each time: manual mode, no signer.
config.payoutMode = "manual";
config.treasuryKeyEncrypted = "";
config.treasuryKeySecret = "";
// Step-up auth (docs/CUSTODY_SPEC.md § 3.3) is a SEPARATE concern with its
// own suite (withdrawControls.e2e.ts) — disabled here so amounts chosen to
// exercise the auto-ceiling/hold gates don't also trip it.
config.stepUpMinPoints = Infinity;

console.log("\n-- payout mode off => never auto-settles --");

{
  const u = await mkUser("autow1");
  await fund(u, 10_000);
  const r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u),
    payload: { amountPoints: 2000, chain: "bep20", address: testAddress() },
  });
  check("request succeeds", r.statusCode === 200, r.body);
  check("stays pending — manual mode never auto-settles", r.json().request.status === "pending", r.body);
  check("and the row itself agrees", (await requestStatus(u)) === "pending");
}

console.log("\n-- onchain mode, but no treasury key configured => never auto-settles --");

{
  config.payoutMode = "onchain";
  const u = await mkUser("autow2");
  await fund(u, 10_000);
  const r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u),
    payload: { amountPoints: 2000, chain: "bep20", address: testAddress() },
  });
  check("stays pending — no signer means canSettle() is false", r.json().request.status === "pending", r.body);
}

console.log("\n-- onchain mode + signer configured, above the auto ceiling => stays manual --");

{
  config.treasuryKeySecret = "c".repeat(64);
  config.treasuryKeyEncrypted = encryptSecret(
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  );
  const u = await mkUser("autow3");
  await fund(u, 100_000);
  const overCeiling = config.autoWithdrawMaxPoints + 1000;
  const r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u),
    payload: { amountPoints: overCeiling, chain: "bep20", address: testAddress() },
  });
  check("stays pending — above config.autoWithdrawMaxPoints falls back to manual",
    r.json().request.status === "pending", r.body);
}

console.log("\n-- under the per-request ceiling, but over the ROLLING 24H CAP => stays manual --");

// Security-review fix (2026-08-06): the per-request ceiling bounds ONE
// request; this rolling-window cap bounds the SUM, closing "many requests
// just under the ceiling" — the compensating control for having no
// per-request human approval. Seeds prior auto-paid history directly (no
// real network call needed) rather than actually settling several requests.
{
  const u = await mkUser("autow3b");
  await fund(u, 100_000);

  // Simulate history: this user already had a request auto-paid recently,
  // close to the cap.
  const priorAmount = config.autoWithdrawMaxPointsPer24h - 500;
  await sql.run(
    `INSERT INTO withdrawal_requests
       (id, user_id, amount, payout_rail, payout_address, status, reviewed_by, paid_at, created_at)
     VALUES (?,?,?,'bep20',?,'paid','system:auto',?,?)`,
    newId(), u, priorAmount, testAddress(), now(), now(),
  );

  const r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u),
    payload: { amountPoints: 1000, chain: "bep20", address: testAddress() }, // under autoWithdrawMaxPoints alone
  });
  check("stays pending — priorAmount + this request exceeds the 24h cap",
    r.json().request?.status === "pending", r.body);
  // This refusal must happen BEFORE provider.send() — confirmed by the fact
  // that it returns at all without this suite's no-real-network-call
  // invariant (see file header) being violated: the cap check now runs
  // inside the locked transaction, ahead of the send, exactly like the
  // per-request ceiling check above it always has.
}

// ⚠️ The concurrent-race this cap exists to close (two auto-settle attempts
// for the same user reading the rolling total before either commits) is NOT
// re-tested here with real concurrency: doing so would require either
// reaching a real provider.send() network call — which this whole suite
// deliberately never does, see the file header — or mocking viem's full
// RPC call sequence, which is out of scope for this file. The fix itself
// (pg_advisory_xact_lock(hashtext(userId)) taken before the read, inside the
// same transaction that writes 'paid') is the same pattern guardrail #8
// already requires and this codebase already trusts elsewhere without a
// dedicated concurrency test (e.g. the withdrawal-creation balance debit in
// routes/withdrawals.ts). Reviewed by inspection, not integration-tested.

console.log("\n-- signer configured, under the ceiling, but the account is HELD => stays manual --");

{
  const u = await mkUser("autow4");
  await fund(u, 10_000);
  await sql.run(
    "UPDATE users SET withdrawal_hold_reason = 'e2e: testing the hold' WHERE id = ?", u,
  );
  const r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u),
    payload: { amountPoints: 2000, chain: "bep20", address: testAddress() },
  });
  check("stays pending — a held account is never auto-settled", r.json().request.status === "pending", r.body);
}

console.log("\n-- a timed hold in the past has already lifted --");

// Tested directly against isWithdrawalHeld(), NOT through a full withdrawal
// request: with onchain mode + a signer configured (as the block above left
// it), a request that clears every gate would fall through to a REAL
// provider.send() call against live BSC RPC endpoints. That is deliberately
// out of scope for this suite — see the header comment — so this checks the
// exact piece of logic ("has the hold's date already passed?") in isolation.
{
  const u = await mkUser("autow5");
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  await sql.run(
    "UPDATE users SET withdrawal_hold_reason = 'e2e: expired hold', withdrawal_hold_until = ? WHERE id = ?",
    yesterday, u,
  );
  const held = await isWithdrawalHeld(u);
  check("a hold whose `until` date has passed reads as not held",
    held.held === false, JSON.stringify(held));

  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  await sql.run(
    "UPDATE users SET withdrawal_hold_until = ? WHERE id = ?", tomorrow, u,
  );
  const stillHeld = await isWithdrawalHeld(u);
  check("a hold whose `until` date is in the future still reads as held",
    stillHeld.held === true, JSON.stringify(stillHeld));

  await sql.run(
    "UPDATE users SET withdrawal_hold_reason = 'e2e: permanent', withdrawal_hold_until = NULL WHERE id = ?", u,
  );
  const permanent = await isWithdrawalHeld(u);
  check("a hold with no `until` date is permanent",
    permanent.held === true, JSON.stringify(permanent));
}

console.log("\n-- the withdrawal-hold endpoint itself --");

{
  const manager = await mkUser("holdmanager", "manager");
  const agent = await mkUser("holdagent", "agent");
  const target = await mkUser("holdtarget");

  let r = await app.inject({
    method: "POST", url: `/staff/users/${target}/withdrawal-hold`,
    headers: tok(agent), payload: { reason: "e2e" },
  });
  check("an agent cannot set a hold (manager/admin only)", r.statusCode === 403, r.body);

  r = await app.inject({
    method: "POST", url: `/staff/users/${target}/withdrawal-hold`,
    headers: tok(manager), payload: { reason: "" },
  });
  check("an empty reason is refused when setting a hold", r.statusCode === 400, r.body);

  r = await app.inject({
    method: "POST", url: `/staff/users/${target}/withdrawal-hold`,
    headers: tok(manager), payload: { reason: "e2e: suspicious activity" },
  });
  check("a manager can set a hold with a reason", r.statusCode === 200 && r.json().held === true, r.body);

  let row = await sql.get<{ withdrawal_hold_reason: string | null; withdrawal_hold_by: string | null }>(
    "SELECT withdrawal_hold_reason, withdrawal_hold_by FROM users WHERE id = ?", target,
  );
  check("the reason and the acting staff member are recorded",
    row?.withdrawal_hold_reason === "e2e: suspicious activity" && row?.withdrawal_hold_by === manager,
    JSON.stringify(row));

  r = await app.inject({
    method: "POST", url: `/staff/users/${target}/withdrawal-hold`,
    headers: tok(manager), payload: { reason: null },
  });
  check("reason: null clears the hold", r.statusCode === 200 && r.json().held === false, r.body);

  row = await sql.get(
    "SELECT withdrawal_hold_reason FROM users WHERE id = ?", target,
  );
  check("and the row agrees it is cleared", row?.withdrawal_hold_reason === null, JSON.stringify(row));
}

// Put the gate back so a re-run and the other suites start clean.
config.payoutMode = "manual";
config.treasuryKeyEncrypted = "";
config.treasuryKeySecret = "";

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
