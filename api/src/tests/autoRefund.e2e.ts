// E2E for fully-automatic settlement of a USDT deposit REFUND (founder,
// 2026-08-06: "the money he deposited, he can withdraw it any time with no
// issues" — the only gate should be staff approval, above a ceiling). This is
// autoWithdraw.e2e.ts's exact shape, applied to /usdt/refunds instead of
// /withdrawals — see autoRefund.ts for the settlement code being tested.
//
// ⚠️ WHAT THIS SUITE DOES NOT COVER, for the identical reason autoWithdraw's
// suite doesn't: every scenario here is refused BEFORE tryAutoSettleRefund()
// would reach a real network call (mode off, above the ceiling, above the
// rolling 24h cap, account held, no signer configured). Proving the actual
// broadcast needs BSC testnet and a funded gas wallet — see CUSTODY_SPEC.md
// § 4 and payout.ts's header comment. This suite exists to make sure the
// REFUSALS are airtight, since those are what keep an unproven signer from
// firing at all.
//
//   npm run test:autorefund
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId, postUsdt, usdtBalanceMicroOf, isWithdrawalHeld } from "../db.ts";
import { config } from "../config.ts";
import { miningRoutes } from "../routes/mining.ts";
import { staffMiningRoutes } from "../routes/staffMining.ts";
import { encryptSecret } from "../signer.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(miningRoutes);
await app.register(staffMiningRoutes);

const mkUser = async (label: string) => {
  const id = newId();
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, kyc_status, created_at) VALUES (?,?,1,'Pakistan',?,'active','approved',?)",
    id, `${label}-${id}@t.test`, id.slice(0, 8).toUpperCase(), now(),
  );
  return id;
};
const tok = (userId: string) => ({
  authorization: `Bearer ${jwt.sign({ sub: userId }, config.jwtSecret)}`,
});

const ADDR = "0x1234567890123456789012345678901234567890";

async function fund(userId: string, micro: number) {
  await postUsdt({
    userId, micro, direction: "credit", sourceType: "topup",
    sourceRefId: newId(), note: "e2e funding",
  });
}

const requestStatus = async (userId: string) => {
  const row = await sql.get<{ status: string }>(
    "SELECT status FROM usdt_refund_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", userId,
  );
  return row?.status;
};

// Everything below runs with a fresh gate each time: manual mode, no signer,
// and the ID check off (a separate concern the usdt.e2e.ts suite already
// covers) so the amounts chosen to exercise the auto-ceiling/hold gates don't
// also trip that unrelated check.
config.payoutMode = "manual";
config.treasuryKeyEncrypted = "";
config.treasuryKeySecret = "";
config.kycRequiredForWithdrawal = false;

console.log("\n-- payout mode off => never auto-settles, exactly today's live behaviour --");

{
  const u = await mkUser("autor1");
  await fund(u, 10_000_000); // $10
  const r = await app.inject({
    method: "POST", url: "/usdt/refunds", headers: tok(u),
    payload: { amount: 2, address: ADDR },
  });
  check("request succeeds", r.statusCode === 200, r.body);
  check("stays pending — manual mode never auto-settles", r.json().status === "pending", r.body);
  check("and the row itself agrees", (await requestStatus(u)) === "pending");
}

console.log("\n-- onchain mode, but no treasury key configured => never auto-settles --");

{
  config.payoutMode = "onchain";
  const u = await mkUser("autor2");
  await fund(u, 10_000_000);
  const r = await app.inject({
    method: "POST", url: "/usdt/refunds", headers: tok(u),
    payload: { amount: 2, address: ADDR },
  });
  check("stays pending — no signer means canSettle() is false", r.json().status === "pending", r.body);
}

console.log("\n-- onchain mode + signer configured, above the per-request ceiling => stays manual --");

{
  config.treasuryKeySecret = "c".repeat(64);
  config.treasuryKeyEncrypted = encryptSecret(
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  );
  const u = await mkUser("autor3");
  const overCeilingMicro = config.autoRefundMaxMicro + 1_000_000;
  await fund(u, overCeilingMicro + 1_000_000);
  const r = await app.inject({
    method: "POST", url: "/usdt/refunds", headers: tok(u),
    payload: { amount: overCeilingMicro / 1_000_000, address: ADDR },
  });
  check("stays pending — above config.autoRefundMaxMicro falls back to manual",
    r.json().status === "pending", r.body);
}

console.log("\n-- under the per-request ceiling, but over the ROLLING 24H CAP => stays manual --");

// Same compensating control as the withdrawal side (CUSTODY_SPEC.md § 3.3):
// the per-request ceiling bounds ONE request, this bounds the SUM. Seeds
// prior auto-paid history directly rather than actually settling several
// requests, same technique autoWithdraw.e2e.ts uses.
{
  const u = await mkUser("autor3b");
  await fund(u, 100_000_000); // $100

  const priorMicro = config.autoRefundMaxMicroPer24h - 500_000;
  await sql.run(
    `INSERT INTO usdt_refund_requests
       (id, user_id, chain, address, amount, status, reviewed_by, reviewed_at, created_at)
     VALUES (?,?,'bep20',?,?,'paid','system:auto',?,?)`,
    newId(), u, ADDR, priorMicro, now(), now(),
  );

  const r = await app.inject({
    method: "POST", url: "/usdt/refunds", headers: tok(u),
    payload: { amount: 1, address: ADDR }, // under autoRefundMaxMicro alone
  });
  check("stays pending — priorMicro + this request exceeds the 24h cap",
    r.json().status === "pending", r.body);
}

console.log("\n-- signer configured, under the ceiling, but the account is HELD => stays manual --");

{
  const u = await mkUser("autor4");
  await fund(u, 10_000_000);
  await sql.run(
    "UPDATE users SET withdrawal_hold_reason = 'e2e: testing the hold' WHERE id = ?", u,
  );
  const r = await app.inject({
    method: "POST", url: "/usdt/refunds", headers: tok(u),
    payload: { amount: 2, address: ADDR },
  });
  check("stays pending — a held account is never auto-settled (same hold as withdrawals)",
    r.json().status === "pending", r.body);
  const held = await isWithdrawalHeld(u);
  check("the reusable hold check agrees", held.held === true, JSON.stringify(held));
}

// A "clears every refusal gate" scenario (fresh account, under both ceilings,
// not held) would fall through to a REAL provider.send() network call against
// live BSC RPC endpoints — deliberately out of scope for this suite, same as
// autoWithdraw.e2e.ts's identical note. Nothing further to test here without
// crossing that line; the manual-queue reject/paid behaviour for a refund
// that never attempted auto-settle is already covered by usdt.e2e.ts.

// Put the gates back so a re-run and the other suites start clean.
config.payoutMode = "manual";
config.treasuryKeyEncrypted = "";
config.treasuryKeySecret = "";
config.kycRequiredForWithdrawal = false; // default is off since 2026-08-29

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
