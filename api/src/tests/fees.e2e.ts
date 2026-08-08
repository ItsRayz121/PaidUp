// E2E for the gas-cost fee (founder, 2026-08-08): sending USDT on BEP20 costs
// the platform real gas, and before this neither a withdrawal nor a deposit
// refund recovered any of it — a refund of the full requested amount was a
// guaranteed per-request loss. Percent-of-amount + a fixed floor, applied to
// BOTH withdrawals (on top of the pre-existing flat fee) and refunds (which
// had no fee at all). See api/src/fees.ts.
//
// What this suite checks:
//   1. Off by default (0%/$0) — no behaviour change for anyone until an Admin
//      sets a rate.
//   2. The fee math itself, on both flows, matches the founder's own example
//      (5% + $0.01 on a $1 request).
//   3. WITHDRAWALS: the user is still debited the full requested amount —
//      only the fee reduces what gets PAID, never what gets HELD.
//   4. REFUNDS: identical shape — the user is debited the full requested
//      amount; only the fee reduces what gets SENT. A REJECTED refund must
//      credit back the FULL gross amount, not the discounted net — nothing
//      was sent, so nothing should be kept.
//   5. A fee that would consume the entire request is refused up front,
//      on both flows, rather than settling for $0 or a negative net.
//
//   npm run test:fees
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  initDb, sql, now, newId, postLedger, postUsdt, balanceOf, usdtBalanceMicroOf, setSetting,
} from "../db.ts";
import { config } from "../config.ts";
import { withdrawalRoutes } from "../routes/withdrawals.ts";
import { miningRoutes } from "../routes/mining.ts";
import { staffMiningRoutes } from "../routes/staffMining.ts";
import { toChecksumAddress } from "../wallet.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(withdrawalRoutes);
await app.register(miningRoutes);
await app.register(staffMiningRoutes);

// payoutMode stays manual throughout — this suite is about the FEE MATH and
// what gets held/credited, not about a real broadcast (see autoWithdraw.e2e.ts
// / autoRefund.e2e.ts for why that needs BSC testnet and is out of scope for
// an offline suite).
config.payoutMode = "manual";
config.kycRequiredForWithdrawal = false;

const mkUser = async (label: string) => {
  const id = newId();
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, kyc_status, created_at) VALUES (?,?,1,'Pakistan',?,'active','approved',?)",
    id, `${label}-${id}@t.test`, id.slice(0, 8).toUpperCase(), now(),
  );
  return id;
};
const mkAdmin = async (label: string) => {
  const id = await mkUser(label);
  await sql.run(
    "INSERT INTO admin_users (user_id, role, created_at) VALUES (?,'admin',?)", id, now(),
  );
  return id;
};
const tok = (userId: string) => ({ authorization: `Bearer ${jwt.sign({ sub: userId }, config.jwtSecret)}` });

function testAddress(): string {
  const { publicKey } = secp256k1.keygen();
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false);
  return toChecksumAddress("0x" + bytesToHex(keccak_256(uncompressed.slice(1))).slice(-40));
}

async function fundPoints(userId: string, points: number) {
  await postLedger({
    userId, points, direction: "credit",
    sourceType: "admin_adjustment", sourceRefId: newId(), note: "e2e funding",
  });
}
async function fundUsdt(userId: string, micro: number) {
  await postUsdt({
    userId, micro, direction: "credit", sourceType: "topup",
    sourceRefId: newId(), note: "e2e funding",
  });
}

// Every block sets its own rate and resets to 0/0 afterward, so blocks never
// leak state into each other (PGlite persists across the whole process).
async function setGasFee(percent: number, fixedMicro: number) {
  await setSetting("gas_fee_percent", String(percent));
  await setSetting("gas_fee_fixed_micro", String(fixedMicro));
}

console.log("\n-- off by default: no fee anywhere until an Admin sets a rate --");

{
  await setGasFee(0, 0);
  const u = await mkUser("feeoff1");
  await fundPoints(u, 10_000);
  const r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u),
    payload: { amountPoints: 2000, chain: "bep20", address: testAddress() },
  });
  check("withdrawal succeeds", r.statusCode === 200, r.body);
  const row = await sql.get<{ fee_points: number }>(
    "SELECT fee_points FROM withdrawal_requests WHERE user_id = ?", u,
  );
  check("fee_points is 0 with no rate configured", row?.fee_points === 0, JSON.stringify(row));
}

console.log("\n-- withdrawals: 5% + $0.01 fixed, the founder's own example --");

{
  await setGasFee(5, 10_000); // 5% + $0.01 (10,000 micro-USDT)
  const u = await mkUser("feewd1");
  await fundPoints(u, 10_000); // $10 headroom
  const r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u),
    payload: { amountPoints: 1000, chain: "bep20", address: testAddress() }, // $1
  });
  check("request succeeds", r.statusCode === 200, r.body);
  // 5% of 1000 points = 50, plus $0.01 at pointsPerUsdt=1000 = 10 points. 60 total.
  const row = await sql.get<{ fee_points: number; amount: number }>(
    "SELECT fee_points, amount FROM withdrawal_requests WHERE user_id = ?", u,
  );
  check("fee_points matches 5% + fixed (60 points on a $1 request)", row?.fee_points === 60, JSON.stringify(row));
  check("amount held is the FULL request, not the discounted net", row?.amount === 1000, JSON.stringify(row));

  // The user must still have been debited the FULL 1000, not 940 — the fee
  // only reduces what gets PAID OUT later, never what gets HELD now.
  const bal = await balanceOf(u);
  check("balance was debited the full 1000, not the net 940", bal === 10_000 - 1000, String(bal));

  await setGasFee(0, 0);
}

console.log("\n-- withdrawals: a fee that would consume the whole request is refused --");

{
  // 100% + a fixed floor guarantees the fee is >= any amount.
  await setGasFee(100, 10_000);
  const u = await mkUser("feewdrefuse1");
  await fundPoints(u, 10_000);
  const r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u),
    payload: { amountPoints: 1000, chain: "bep20", address: testAddress() },
  });
  check("refused with 400", r.statusCode === 400, r.body);
  check("no request row was created", !(await sql.get(
    "SELECT id FROM withdrawal_requests WHERE user_id = ?", u,
  )));
  await setGasFee(0, 0);
}

console.log("\n-- refunds: 5% + $0.01 fixed, same rate, same example --");

{
  await setGasFee(5, 10_000);
  const u = await mkUser("feerf1");
  await fundUsdt(u, 10_000_000); // $10
  const r = await app.inject({
    method: "POST", url: "/usdt/refunds", headers: tok(u),
    payload: { amount: 1, address: testAddress() }, // $1
  });
  check("request succeeds", r.statusCode === 200, r.body);
  const body = r.json();
  check("feeMicro matches 5% + fixed (60,000 micro on a $1 request)", body.feeMicro === 60_000, r.body);
  check("netMicro is amount minus fee (940,000 micro)", body.netMicro === 940_000, r.body);

  const row = await sql.get<{ amount: number; fee_micro: number; user_id: string }>(
    "SELECT amount, fee_micro, user_id FROM usdt_refund_requests WHERE user_id = ?", u,
  );
  check("the row snapshots amount as the FULL request", Number(row?.amount) === 1_000_000, JSON.stringify(row));
  check("and fee_micro alongside it", Number(row?.fee_micro) === 60_000, JSON.stringify(row));

  check("the user's deposit balance was debited the FULL 1,000,000, not 940,000",
    (await usdtBalanceMicroOf(u)) === 10_000_000 - 1_000_000);

  await setGasFee(0, 0);
}

console.log("\n-- refunds: rejecting returns the FULL gross amount, not the discounted net --");

{
  await setGasFee(5, 10_000);
  const admin = await mkAdmin("feeadmin1");
  const u = await mkUser("feerfreject1");
  await fundUsdt(u, 10_000_000);
  const before = await usdtBalanceMicroOf(u);

  const created = await app.inject({
    method: "POST", url: "/usdt/refunds", headers: tok(u),
    payload: { amount: 1, address: testAddress() },
  });
  const id = created.json().id as string;

  const rej = await app.inject({
    method: "POST", url: `/staff/mining/refunds/${id}/reject`, headers: tok(admin),
    payload: { reason: "e2e test rejection" },
  });
  check("reject succeeds", rej.statusCode === 200, rej.body);
  check("the FULL 1,000,000 came back, not the 940,000 net — nothing was sent, so nothing is kept",
    (await usdtBalanceMicroOf(u)) === before,
    `before=${before} after=${await usdtBalanceMicroOf(u)}`);

  await setGasFee(0, 0);
}

console.log("\n-- refunds: staff queue shows the net to actually send, alongside the gross --");

{
  await setGasFee(5, 10_000);
  const admin = await mkAdmin("feeadmin2");
  const u = await mkUser("feerfqueue1");
  await fundUsdt(u, 10_000_000);
  await app.inject({
    method: "POST", url: "/usdt/refunds", headers: tok(u),
    payload: { amount: 1, address: testAddress() },
  });

  const q = await app.inject({ method: "GET", url: "/staff/mining/refunds?status=pending", headers: tok(admin) });
  check("queue call succeeds", q.statusCode === 200, q.body);
  const row = (q.json().refunds as Array<{ user_id: string; amount: number; feeAmount: number; netAmount: number }>)
    .find((x) => x.user_id === u);
  check("row found in queue", Boolean(row));
  check("amount is the gross request (1 USDT)", row?.amount === 1, JSON.stringify(row));
  check("feeAmount is the gas fee (0.06 USDT)", row?.feeAmount === 0.06, JSON.stringify(row));
  check("netAmount is what staff should actually send (0.94 USDT)", row?.netAmount === 0.94, JSON.stringify(row));

  await setGasFee(0, 0);
}

console.log("\n-- refunds: a fee that would consume the whole request is refused up front --");

{
  // Comfortably above the $1 minimum request either way.
  await setGasFee(0, 2_000_000); // $2 fixed alone exceeds a $1 request
  const u = await mkUser("feerfrefuse1");
  await fundUsdt(u, 10_000_000);
  const r = await app.inject({
    method: "POST", url: "/usdt/refunds", headers: tok(u),
    payload: { amount: 1, address: testAddress() },
  });
  check("refused with 400", r.statusCode === 400, r.body);
  check("no request row was created", !(await sql.get(
    "SELECT id FROM usdt_refund_requests WHERE user_id = ?", u,
  )));
  // Nothing should have been held either — the request never got to the debit.
  check("no money was held", (await usdtBalanceMicroOf(u)) === 10_000_000);

  await setGasFee(0, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
