// E2E for the per-user-wallet payout relay (founder, 2026-08-08) —
// payoutRelay.ts, and its wiring into autoWithdraw.ts, autoRefund.ts,
// routes/staff.ts's "pay" action and routes/staffMining.ts's refund "paid"
// action.
//
// ⚠️ SAME SCOPE BOUNDARY AS autoWithdraw.e2e.ts, AND FOR THE SAME REASON.
// createRelayJob() is pure DB (no network) — that part is tested for real.
// advanceRelayJob()/tickPayoutRelay() sign and broadcast real transactions
// via viem and are deliberately NOT exercised here; proving those needs BSC
// testnet, same as sweep.ts always has (see deposits/sweep.ts's header and
// CUSTODY_SPEC.md § 4). This suite proves the part that decides WHETHER a
// relay job gets created, and — the actually load-bearing check — that it
// NEVER gets created while config.payoutMode is "manual", however fully the
// signing keys are configured.
//
//   npm run test:payoutrelay
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { initDb, sql, now, newId, postLedger, postUsdt, postEarnedUsdt, usdtBalanceMicroOf, earnedUsdtBalanceMicroOf, setSetting } from "../db.ts";
import { config } from "../config.ts";
import { withdrawalRoutes } from "../routes/withdrawals.ts";
import { staffRoutes } from "../routes/staff.ts";
import { miningRoutes } from "../routes/mining.ts";
import { staffMiningRoutes } from "../routes/staffMining.ts";
import { toChecksumAddress } from "../wallet.ts";
import { encryptSecret as encryptTreasurySecret } from "../signer.ts";
import { encryptSecret as encryptWith, parseAesKeyHex } from "../crypto/aesSecret.ts";
import { relayAvailable, createRelayJob, gasCheckHook, type GasCheckResult } from "../payoutRelay.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(withdrawalRoutes);
await app.register(staffRoutes);
await app.register(miningRoutes);
await app.register(staffMiningRoutes);

const mkUser = async (label: string, role: string | null = null) => {
  const id = newId();
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, kyc_status, created_at) VALUES (?,?,1,'Pakistan',?,'active','approved',?)",
    id, `${label}-${id}@t.test`, id.slice(0, 8).toUpperCase(), now(),
  );
  if (role) {
    await sql.run("INSERT INTO admin_users (user_id, role, created_at) VALUES (?,?,?)", id, role, now());
  }
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
  await postUsdt({ userId, micro, direction: "credit", sourceType: "topup", sourceRefId: newId(), note: "e2e funding" });
}

const withdrawalStatus = async (userId: string) => {
  const row = await sql.get<{ status: string }>(
    "SELECT status FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", userId,
  );
  return row?.status;
};
const relayJobFor = async (purpose: "withdrawal" | "refund", requestId: string) =>
  sql.get<{
    status: string; needs_prefund: number; amount_micro: string; from_address: string; to_address: string;
  }>("SELECT * FROM payout_relay_jobs WHERE purpose = ? AND request_id = ?", purpose, requestId);
const jobCount = async (purpose: "withdrawal" | "refund", requestId: string) => {
  const row = await sql.get<{ n: string }>(
    "SELECT COUNT(*) AS n FROM payout_relay_jobs WHERE purpose = ? AND request_id = ?", purpose, requestId,
  );
  return Number(row?.n ?? 0);
};

// A throwaway BIP32 seed (never funded, never used for anything real) — same
// shape as custodySeeds.test.ts. custody.ts's xpub and custodySeeds.ts's xprv
// must be the public/private halves of the SAME account key.
const SEED = Buffer.from("aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899", "hex").subarray(0, 32);
const ACCOUNT = HDKey.fromMasterSeed(SEED).derive("m/44'/60'/0'");
const TEST_XPUB = ACCOUNT.publicExtendedKey;
const TEST_XPRV = ACCOUNT.privateExtendedKey;
const SWEEP_AES_KEY = "e".repeat(64);
const encryptSweepSeed = (plaintext: string) => encryptWith(plaintext, parseAesKeyHex(SWEEP_AES_KEY, "test key"));

function clearGate() {
  config.payoutMode = "manual";
  config.treasuryKeyEncrypted = "";
  config.treasuryKeySecret = "";
  config.custodyXpub.bep20 = "";
  config.custodySweepSeedEncrypted.evm = "";
  config.custodySweepSeedSecret.evm = "";
}
function fullyConfigureSigning() {
  config.treasuryKeySecret = "c".repeat(64);
  config.treasuryKeyEncrypted = encryptTreasurySecret(
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  );
  config.custodyXpub.bep20 = TEST_XPUB;
  config.custodySweepSeedSecret.evm = SWEEP_AES_KEY;
  config.custodySweepSeedEncrypted.evm = encryptSweepSeed(TEST_XPRV);
}

clearGate();
config.kycRequiredForWithdrawal = false;
config.stepUpMinPoints = Infinity; // a separate concern (withdrawControls.e2e.ts) — not what this suite tests

// Gas is the user's own responsibility (founder, 2026-08-08, second pass) —
// routes/withdrawals.ts and routes/mining.ts now check the user's own
// derived address's BNB balance BEFORE any debit. That check reaches the
// real chain over the network, which this suite deliberately never does
// (see the header comment) — a freshly-generated test address could never
// hold real BNB anyway. Default every existing test in this file to "yes,
// enough gas" so tests written to prove OTHER behaviour keep proving it; the
// dedicated "gas gate" section below overrides this to `ok: false` and
// resets it afterward to prove the refusal path specifically.
const ALWAYS_READY = async (): Promise<GasCheckResult> =>
  ({ ok: true, address: testAddress(), balanceWei: 10n ** 18n, requiredWei: 1n });
gasCheckHook.override = ALWAYS_READY;

console.log("\n-- relayAvailable(): gating logic, no network involved --");

// ⚠️ ORDER MATTERS. treasurySignerKey() (signer.ts) caches its result at
// module scope for the life of the PROCESS, same as this whole test file's
// process — see signer.test.ts's header for why that makes "returns null
// when unconfigured" untestable AFTER a real key has been (or is about to
// be) used. So: configure and prove the treasury key FIRST, before any check
// that could reach treasurySignerKey() with an empty one. Every "unavailable"
// case below is reached by custodyEnabled()/sweepSigningEnabled() being
// false, which short-circuit the && BEFORE treasurySignerKey() is ever
// called — those two DO correctly reflect the live config either way (see
// custody.ts / custodySeeds.ts).
{
  clearGate();
  check("nothing configured => unavailable", relayAvailable("bep20") === false);

  config.custodyXpub.bep20 = TEST_XPUB;
  // Must run BEFORE fullyConfigureSigning() below — custodySeeds.ts's sweep
  // key, like the treasury key, caches "enabled" permanently at module scope
  // once it has ever decrypted successfully in this process (same reason as
  // the note above), so this is the last point at which "no sweep key yet"
  // can be observed at all.
  check("only the xpub configured => still unavailable (no sweep-signing key)", relayAvailable("bep20") === false);
  clearGate();

  fullyConfigureSigning();
  check("all three configured => available (first successful decrypt, cached for the rest of this process)",
    relayAvailable("bep20") === true);
  check("a non-bep20 chain is never available (Base/Aptos are manual-only)", relayAvailable("base") === false);
  clearGate();
}

console.log("\n-- createRelayJob(): idempotent, derives the user's own address --");

{
  fullyConfigureSigning();
  const u = await mkUser("relayjob1");
  const requestId = newId();
  await createRelayJob("withdrawal", requestId, {
    chain: "bep20", userId: u, toAddress: testAddress(), amountMicro: 5_000_000, needsPrefund: true,
  });
  await createRelayJob("withdrawal", requestId, {
    chain: "bep20", userId: u, toAddress: testAddress(), amountMicro: 5_000_000, needsPrefund: true,
  }); // called again — must be a no-op, not a second job

  check("exactly one job row exists for this request", (await jobCount("withdrawal", requestId)) === 1);

  const job = await relayJobFor("withdrawal", requestId);
  const walletRow = await sql.get<{ address: string }>(
    "SELECT address FROM deposit_wallets WHERE user_id = ? AND chain = 'bep20'", u,
  );
  check("the job's from_address is the user's OWN derived deposit address, not treasury",
    !!job && !!walletRow && job.from_address.toLowerCase() === walletRow.address.toLowerCase(),
    `${job?.from_address} vs ${walletRow?.address}`);
  check("needs_prefund is set for a withdrawal (money is not really there yet)", Number(job?.needs_prefund) === 1);
  clearGate();
}

console.log("\n-- createRelayJob(): partial prefund for a MIXED withdrawal (2026-09-05) --");

// A 'mixed' withdrawal_requests row (routes/withdrawals.ts's /wallet/withdraw,
// drawing on both a real deposit and task earnings) prefunds only the earned
// PORTION from treasury but forwards the FULL combined amount in one job —
// this is the whole point of the change: one on-chain send instead of two.
{
  fullyConfigureSigning();
  const u = await mkUser("relaymixed1");
  const requestId = newId();
  await createRelayJob("withdrawal", requestId, {
    chain: "bep20", userId: u, toAddress: testAddress(),
    amountMicro: 1_000_000, needsPrefund: true, prefundMicro: 600_000,
  });
  const job = await sql.get<{ amount_micro: string; needs_prefund: number; prefund_micro: string | null }>(
    "SELECT amount_micro, needs_prefund, prefund_micro FROM payout_relay_jobs WHERE purpose = 'withdrawal' AND request_id = ?",
    requestId,
  );
  check("the forward amount is the FULL combined total", Number(job?.amount_micro) === 1_000_000, JSON.stringify(job));
  check("only the earned portion is marked to be prefunded from treasury",
    Number(job?.prefund_micro) === 600_000, JSON.stringify(job));

  const legacyRequestId = newId();
  await createRelayJob("withdrawal", legacyRequestId, {
    chain: "bep20", userId: u, toAddress: testAddress(), amountMicro: 500_000, needsPrefund: true,
  });
  const legacyJob = await sql.get<{ prefund_micro: string | null }>(
    "SELECT prefund_micro FROM payout_relay_jobs WHERE purpose = 'withdrawal' AND request_id = ?", legacyRequestId,
  );
  check("...confirmed: a legacy-shaped call stores NULL, not 0 or the amount",
    legacyJob?.prefund_micro === null, JSON.stringify(legacyJob));

  let threw = false;
  try {
    await createRelayJob("withdrawal", newId(), {
      chain: "bep20", userId: u, toAddress: testAddress(), amountMicro: 500_000, needsPrefund: true, prefundMicro: 900_000,
    });
  } catch { threw = true; }
  check("prefundMicro greater than the total amount is refused", threw);

  threw = false;
  try {
    await createRelayJob("withdrawal", newId(), {
      chain: "bep20", userId: u, toAddress: testAddress(), amountMicro: 500_000, needsPrefund: false, prefundMicro: 100_000,
    });
  } catch { threw = true; }
  check("prefundMicro set alongside needsPrefund:false is refused — a refund never prefunds anything", threw);
  clearGate();
}

console.log("\n-- withdrawal auto-settle, relay available: 'sending', not 'paid', and a job is opened --");

{
  fullyConfigureSigning();
  config.payoutMode = "onchain";
  const u = await mkUser("relaywd1");
  await fundPoints(u, 10_000);
  const dest = testAddress();
  const r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u),
    payload: { amountPoints: 2000, chain: "bep20", address: dest },
  });
  check("request succeeds", r.statusCode === 200, r.body);
  check("response status is 'sending' — routed through the relay, not settled synchronously",
    r.json().request.status === "sending", r.body);
  check("the row itself agrees", (await withdrawalStatus(u)) === "sending");

  const row = await sql.get<{ id: string }>(
    "SELECT id FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", u,
  );
  const job = await relayJobFor("withdrawal", row!.id);
  check("a relay job was opened, targeting the user's requested destination",
    !!job && job.to_address.toLowerCase() === dest.toLowerCase(), JSON.stringify(job));
  check("the job amount matches the withdrawn points converted to USDT (1 USDT = 1000 pts by default)",
    Number(job?.amount_micro) === 2_000_000, `${job?.amount_micro}`);
  clearGate();
}

console.log("\n-- ONE WITHDRAWAL, ONE TRANSACTION: /wallet/withdraw draws on both a deposit and task USDT (2026-09-05) --");

// This is the actual complaint the change fixes: a founder-reported live
// withdrawal that drew on both a real deposit and task earnings produced TWO
// separate on-chain sends (a refund job AND a withdrawal job) for one user
// action. Now it is a single relay job that prefunds only the earned portion
// and forwards the FULL combined amount.
{
  fullyConfigureSigning();
  config.payoutMode = "onchain";
  const u = await mkUser("relaymixed2");
  await fundUsdt(u, 400_000); // $0.40 real deposit
  await postEarnedUsdt({
    userId: u, micro: 600_000, direction: "credit", sourceType: "task_reward", sourceRefId: newId(), note: "e2e",
  }); // $0.60 task USDT
  const dest = testAddress();
  const r = await app.inject({
    method: "POST", url: "/wallet/withdraw", headers: tok(u),
    payload: { amountUsdtMicro: 1_000_000, chain: "bep20", address: dest },
  });
  check("the combined $1.00 request succeeds", r.statusCode === 200, r.body);
  check("response status is 'sending' — routed through the relay", r.json().status === "sending", r.body);

  const refundCount = await sql.get<{ n: string }>("SELECT COUNT(*) AS n FROM usdt_refund_requests WHERE user_id = ?", u);
  check("no separate usdt_refund_requests row exists", Number(refundCount?.n) === 0, JSON.stringify(refundCount));

  const row = await sql.get<{ id: string; source_kind: string }>(
    "SELECT id, source_kind FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", u,
  );
  check("exactly one 'mixed' withdrawal_requests row", row?.source_kind === "mixed", JSON.stringify(row));

  const job = await sql.get<{ amount_micro: string; prefund_micro: string | null; to_address: string }>(
    "SELECT amount_micro, prefund_micro, to_address FROM payout_relay_jobs WHERE purpose = 'withdrawal' AND request_id = ?",
    row!.id,
  );
  check("ONE relay job targets the requested destination",
    !!job && job.to_address.toLowerCase() === dest.toLowerCase(), JSON.stringify(job));
  check("the job forwards the FULL combined $1.00 in one transaction",
    Number(job?.amount_micro) === 1_000_000, JSON.stringify(job));
  check("...but only prefunds the $0.60 earned portion from treasury — the $0.40 deposit already sits at this address",
    Number(job?.prefund_micro) === 600_000, JSON.stringify(job));

  // Now prove a give-up credits BOTH components back — the founder's own
  // required test case ("no money disappears"), extended to the mixed shape.
  // Same pattern as disbursements.e2e.ts's "failJob returns the right
  // currency" regression: push attempts past the cap so tickPayoutRelay()
  // hits the give-up branch immediately, before any network call — the job
  // never left 'pending', so it is safe to credit back.
  await sql.run("UPDATE payout_relay_jobs SET attempts = ? WHERE purpose = 'withdrawal' AND request_id = ?",
    config.relayMaxAttempts, row!.id);
  const { tickPayoutRelay } = await import("../payoutRelay.ts");
  await tickPayoutRelay();
  check("the request is now 'rejected'", (await withdrawalStatus(u)) === "rejected");
  check("the deposit component was credited back to the real deposit balance",
    (await usdtBalanceMicroOf(u)) === 400_000, `${await usdtBalanceMicroOf(u)}`);
  check("the earned component was credited back to the task-USDT balance",
    (await earnedUsdtBalanceMicroOf(u)) === 600_000, `${await earnedUsdtBalanceMicroOf(u)}`);
  clearGate();
}

console.log("\n-- give up by WALL-CLOCK AGE, not just attempt count (founder, 2026-09-05) --");

// The founder's own ask: "it should get rejected after ten, twenty, or thirty
// minutes instead of wasting the platform's API credits" — a SECOND,
// independent give-up condition alongside relayMaxAttempts, so a job gives up
// in a bounded amount of TIME even if the tick interval (shared with
// unrelated cost-tuning knobs — payoutRelayIntervalMs's own comment) were
// ever slowed down. A job with very FEW attempts but an old created_at must
// still give up and credit back.
{
  const u = await mkUser("relayage1");
  await fundUsdt(u, 2_000_000);
  const dest = testAddress();
  const r = await app.inject({
    method: "POST", url: "/usdt/refunds", headers: tok(u),
    payload: { amount: 2, address: dest },
  });
  check("refund request succeeds", r.statusCode === 200, r.body);
  const refundId = r.json().id as string;
  // No relay job exists yet (payoutMode is manual by default here / clearGate
  // ran last, so the request stayed 'pending') — insert one directly, old and
  // barely-attempted, exactly the shape a real stuck job has: created long
  // ago, only 1 attempt logged.
  const oldCreatedAt = new Date(Date.now() - (config.relayMaxAgeMs + 60_000)).toISOString();
  const jobId = newId();
  await sql.run(
    `INSERT INTO payout_relay_jobs (id,purpose,request_id,chain,user_id,from_address,addr_index,to_address,amount_micro,needs_prefund,status,attempts,last_error,created_at)
     VALUES (?, 'refund', ?, 'bep20', ?, ?, 0, ?, 2000000, 0, 'pending', 1, 'stuck', ?)`,
    jobId, refundId, u, dest, dest, oldCreatedAt,
  );
  await sql.run("UPDATE usdt_refund_requests SET status = 'sending' WHERE id = ?", refundId);
  const { tickPayoutRelay } = await import("../payoutRelay.ts");
  await tickPayoutRelay();
  const job = await sql.get<{ status: string }>("SELECT status FROM payout_relay_jobs WHERE id = ?", jobId);
  check("the job gave up on AGE alone — attempts (1) never reached relayMaxAttempts (15)",
    job?.status === "failed", JSON.stringify(job));
  check("the refund request was rejected and the deposit credited back — nothing left stuck",
    (await usdtBalanceMicroOf(u)) === 2_000_000, `${await usdtBalanceMicroOf(u)}`);
}

console.log("\n-- an admin disbursement's relay job gets a LONGER leash (founder, 2026-09-05, same day) --");

// The founder, on the same call: "when the platform money is going to be
// sent, extend this window of the retry ... to one hour" — but only for
// PLATFORM-initiated payouts (routes/staffDisbursements.ts's runPayoutRow).
// A user's own withdrawal keeps the ordinary ceiling, unchanged (the control
// case at the end of this block).
{
  config.payoutMode = "manual"; // job must give up (or not) on age/attempts alone, never reach the network
  const staffUser = await mkUser("relaydisbadmin", "admin");
  const u = await mkUser("relaydisb1");
  const dest = testAddress();
  const reqId = newId();
  await sql.run(
    `INSERT INTO withdrawal_requests (id,user_id,amount,payout_rail,payout_address,fee_points,address_verified,source_kind,earned_usdt_micro,status,reviewed_by,created_at)
     VALUES (?,?,?, 'bep20', ?, 0, 0, 'earned_usdt', ?, 'sending', 'system:auto', ?)`,
    reqId, u, 1000, dest, 1_000_000, now(),
  );
  const batchId = newId();
  await sql.run(
    "INSERT INTO payout_batches (id, mode, status, created_by, created_at) VALUES (?, 'onchain', 'processing', ?, ?)",
    batchId, staffUser, now(),
  );
  await sql.run(
    `INSERT INTO payout_disbursements (id, batch_id, user_id, withdrawal_request_id, status, usdt_micro, created_at)
     VALUES (?,?,?,?, 'sending', ?, ?)`,
    newId(), batchId, u, reqId, 1_000_000, now(),
  );

  // Old enough to have already failed under the ORDINARY ceiling, but well
  // inside the disbursement-specific one.
  const oldEnoughForOrdinary = new Date(Date.now() - (config.relayMaxAgeMs + 60_000)).toISOString();
  const jobId = newId();
  await sql.run(
    `INSERT INTO payout_relay_jobs (id,purpose,request_id,chain,user_id,from_address,addr_index,to_address,amount_micro,needs_prefund,status,attempts,last_error,created_at)
     VALUES (?, 'withdrawal', ?, 'bep20', ?, ?, 0, ?, 1000000, 1, 'pending', 1, 'stuck', ?)`,
    jobId, reqId, u, dest, dest, oldEnoughForOrdinary,
  );
  const { tickPayoutRelay } = await import("../payoutRelay.ts");
  await tickPayoutRelay();
  const job = await sql.get<{ status: string }>("SELECT status FROM payout_relay_jobs WHERE id = ?", jobId);
  check("a disbursement-sourced job SURVIVES past the ordinary relayMaxAgeMs",
    job?.status === "pending", JSON.stringify(job));

  // Now push it past the disbursement's OWN (longer) ceiling too.
  await sql.run(
    "UPDATE payout_relay_jobs SET created_at = ? WHERE id = ?",
    new Date(Date.now() - (config.relayMaxAgeMsDisbursement + 60_000)).toISOString(), jobId,
  );
  await tickPayoutRelay();
  const job2 = await sql.get<{ status: string }>("SELECT status FROM payout_relay_jobs WHERE id = ?", jobId);
  check("...but still gives up once past its OWN (longer) ceiling",
    job2?.status === "failed", JSON.stringify(job2));

  // Control: an ordinary user withdrawal (no payout_disbursements row at all)
  // with the exact same age gives up exactly as before — completely
  // unaffected by this change.
  const u2 = await mkUser("relaydisb2");
  const dest2 = testAddress();
  const reqId2 = newId();
  await sql.run(
    `INSERT INTO withdrawal_requests (id,user_id,amount,payout_rail,payout_address,fee_points,address_verified,source_kind,earned_usdt_micro,status,created_at)
     VALUES (?,?,?, 'bep20', ?, 0, 0, 'earned_usdt', ?, 'sending', ?)`,
    reqId2, u2, 1000, dest2, 1_000_000, now(),
  );
  const jobId2 = newId();
  await sql.run(
    `INSERT INTO payout_relay_jobs (id,purpose,request_id,chain,user_id,from_address,addr_index,to_address,amount_micro,needs_prefund,status,attempts,last_error,created_at)
     VALUES (?, 'withdrawal', ?, 'bep20', ?, ?, 0, ?, 1000000, 1, 'pending', 1, 'stuck', ?)`,
    jobId2, reqId2, u2, dest2, dest2, oldEnoughForOrdinary,
  );
  await tickPayoutRelay();
  const job3 = await sql.get<{ status: string }>("SELECT status FROM payout_relay_jobs WHERE id = ?", jobId2);
  check("a PLAIN user withdrawal (not disbursement-linked) still gives up at the ordinary ceiling, unchanged",
    job3?.status === "failed", JSON.stringify(job3));
}

console.log("\n-- ⚠️ THE LOAD-BEARING CHECK: fully configured signing keys, but payoutMode is MANUAL --");

// This is the exact bug this feature's staff.ts/staffMining.ts wiring had to
// avoid: relayAvailable() alone does not know about payoutMode, so every call
// site must check config.payoutMode === "onchain" explicitly BEFORE branching
// into the relay. If this regresses, a staff member clicking "pay" while the
// founder has deliberately left the switch on "manual" would silently
// broadcast a real automatic send.
{
  fullyConfigureSigning();
  config.payoutMode = "manual"; // <- the switch stays off
  const u = await mkUser("relaywd2");
  await fundPoints(u, 10_000);
  const r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u),
    payload: { amountPoints: 2000, chain: "bep20", address: testAddress() },
  });
  check("stays 'pending' — manual mode wins even though every signing key exists",
    r.json().request.status === "pending", r.body);
  const row = await sql.get<{ id: string }>(
    "SELECT id FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", u,
  );
  check("no relay job was ever opened", (await jobCount("withdrawal", row!.id)) === 0);
  clearGate();
}

console.log("\n-- staff 'pay' action: relay available => one-click, no pasted hash required --");

{
  fullyConfigureSigning();
  config.payoutMode = "onchain";
  const admin = await mkUser("relaystaff-admin", "admin");
  const u = await mkUser("relaywd3");
  await fundPoints(u, 200_000);
  const overCeiling = config.autoWithdrawMaxPoints + 5000; // forces the manual queue, not auto-settle
  const dest = testAddress();
  let r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u),
    payload: { amountPoints: overCeiling, chain: "bep20", address: dest },
  });
  check("above the ceiling => stays pending for staff", r.json().request.status === "pending", r.body);
  const reqId = r.json().request.id as string;

  r = await app.inject({
    method: "POST", url: `/staff/withdrawals/${reqId}/decision`,
    headers: tok(admin), payload: { action: "approve" },
  });
  check("staff approves", r.statusCode === 200, r.body);

  r = await app.inject({
    method: "POST", url: `/staff/withdrawals/${reqId}/decision`,
    headers: tok(admin), payload: { action: "pay" }, // no txHash — relay does not need one
  });
  check("'pay' succeeds without a pasted hash", r.statusCode === 200, r.body);
  check("status is 'sending', not 'paid' — the relay hasn't broadcast yet", r.json().status === "sending", r.body);

  const job = await relayJobFor("withdrawal", reqId);
  check("a relay job now exists, routed to the destination the user asked for",
    !!job && job.to_address.toLowerCase() === dest.toLowerCase(), JSON.stringify(job));

  // ⚠️ CODE-REVIEW FIX: the top-of-transaction terminal-state guard in
  // routes/staff.ts used to only block 'paid'/'rejected', so a 'sending' row
  // (a relay job actively signing/broadcasting) could still be approved or
  // rejected. 'reject' would credit the points back to the user while the
  // on-chain send still completes — a real double payment. Both must now be
  // refused with 409 while the request is 'sending'.
  r = await app.inject({
    method: "POST", url: `/staff/withdrawals/${reqId}/decision`,
    headers: tok(admin), payload: { action: "reject", note: "e2e: must be refused" },
  });
  check("'reject' on a 'sending' request is refused (409), not a double payment",
    r.statusCode === 409, r.body);
  check("...and the request is still 'sending', not 'rejected'",
    (await withdrawalStatus(u)) === "sending");

  r = await app.inject({
    method: "POST", url: `/staff/withdrawals/${reqId}/decision`,
    headers: tok(admin), payload: { action: "approve" },
  });
  check("'approve' on a 'sending' request is also refused (409)", r.statusCode === 409, r.body);
  check("...status still 'sending' — not knocked back to agent_approved, which would orphan the relay's completion",
    (await withdrawalStatus(u)) === "sending");

  clearGate();
}

console.log("\n-- staff 'pay' action, relay unavailable (manual mode): pasted hash still required --");

{
  clearGate(); // manual mode, nothing configured — today's behaviour, unchanged
  const admin = await mkUser("relaystaff-admin2", "admin");
  const u = await mkUser("relaywd4");
  await fundPoints(u, 200_000);
  const overCeiling = config.autoWithdrawMaxPoints + 5000;
  let r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u),
    payload: { amountPoints: overCeiling, chain: "bep20", address: testAddress() },
  });
  const reqId = r.json().request.id as string;
  await app.inject({
    method: "POST", url: `/staff/withdrawals/${reqId}/decision`,
    headers: tok(admin), payload: { action: "approve" },
  });

  r = await app.inject({
    method: "POST", url: `/staff/withdrawals/${reqId}/decision`,
    headers: tok(admin), payload: { action: "pay" }, // still no hash
  });
  check("manual mode still requires a pasted hash — the manual path is untouched",
    r.statusCode === 400, r.body);

  r = await app.inject({
    method: "POST", url: `/staff/withdrawals/${reqId}/decision`,
    headers: tok(admin), payload: { action: "pay", txHash: "0x" + "b".repeat(64) },
  });
  check("pasting one still works exactly as before", r.statusCode === 200 && r.json().status === "paid", r.body);
}

console.log("\n-- refund auto-settle, relay available: THIS is the case that's actually real --");

{
  fullyConfigureSigning();
  config.payoutMode = "onchain";
  const u = await mkUser("relayrf1");
  await fundUsdt(u, 5_000_000); // 5 USDT deposited
  const dest = testAddress();
  const r = await app.inject({
    method: "POST", url: "/usdt/refunds", headers: tok(u),
    payload: { amount: 2, address: dest },
  });
  check("refund request succeeds", r.statusCode === 200, r.body);
  check("response status is 'sending'", r.json().status === "sending", r.body);
  const refundId = r.json().id as string;

  const row = await sql.get<{ status: string }>("SELECT status FROM usdt_refund_requests WHERE id = ?", refundId);
  check("the row itself agrees", row?.status === "sending", JSON.stringify(row));

  const job = await relayJobFor("refund", refundId);
  check("needs_prefund is FALSE — the user's own address already holds this money",
    Number(job?.needs_prefund) === 0, JSON.stringify(job));
  check("job destination matches what the user asked for", job?.to_address.toLowerCase() === dest.toLowerCase());
  clearGate();
}

console.log("\n-- refund staff 'paid' action: relay available => no pasted hash needed --");

{
  fullyConfigureSigning();
  config.payoutMode = "onchain";
  const admin = await mkUser("relaystaff-admin3", "admin");
  const u = await mkUser("relayrf2");
  const overCeiling = config.autoRefundMaxMicro + 5_000_000; // forces the manual queue
  await fundUsdt(u, overCeiling + 1_000_000); // enough deposit credit to cover the request itself
  let r = await app.inject({
    method: "POST", url: "/usdt/refunds", headers: tok(u),
    payload: { amount: overCeiling / 1_000_000, address: testAddress() },
  });
  check("above the refund ceiling stays pending", r.json().status === "pending", r.body);
  const refundId = r.json().id as string;

  r = await app.inject({
    method: "POST", url: `/staff/mining/refunds/${refundId}/paid`, headers: tok(admin), payload: {},
  });
  check("no hash required — the relay path handles it", r.statusCode === 200 && r.json().status === "sending", r.body);
  clearGate();
}

console.log("\n-- refund staff 'paid' action, relay unavailable (manual mode): pasted hash still required --");

{
  clearGate();
  const admin = await mkUser("relaystaff-admin4", "admin");
  const u = await mkUser("relayrf3");
  await fundUsdt(u, 5_000_000);
  let r = await app.inject({
    method: "POST", url: "/usdt/refunds", headers: tok(u),
    payload: { amount: 2, address: testAddress() },
  });
  const refundId = r.json().id as string;

  r = await app.inject({
    method: "POST", url: `/staff/mining/refunds/${refundId}/paid`, headers: tok(admin), payload: {},
  });
  check("manual mode refuses without a hash", r.statusCode === 400, r.body);

  r = await app.inject({
    method: "POST", url: `/staff/mining/refunds/${refundId}/paid`,
    headers: tok(admin), payload: { txHash: "0x" + "c".repeat(64) },
  });
  check("pasting one still works exactly as before", r.statusCode === 200 && r.json().status === "paid", r.body);
  check("no ledger row was written a second time (the debit happened at request time)",
    (await usdtBalanceMicroOf(u)) === 3_000_000, `${await usdtBalanceMicroOf(u)}`);
}

console.log("\n-- GAS IS THE USER'S OWN RESPONSIBILITY: refused BEFORE any debit --");

// The exact production bug, closed at the source: a request used to be
// debited and queued even though nothing could ever actually pay it (the
// treasury had 0 BNB). Now the check happens BEFORE the debit, on the
// address that actually needs to hold the gas, and nothing is held if it
// can't.
{
  fullyConfigureSigning();
  config.payoutMode = "onchain";
  const NOT_READY = async (): Promise<GasCheckResult> =>
    ({ ok: false, address: testAddress(), balanceWei: 0n, requiredWei: 10n ** 15n });

  {
    const u = await mkUser("gaswd1");
    await fundPoints(u, 10_000);
    gasCheckHook.override = NOT_READY;
    const r = await app.inject({
      method: "POST", url: "/withdrawals", headers: tok(u),
      payload: { amountPoints: 2000, chain: "bep20", address: testAddress() },
    });
    gasCheckHook.override = ALWAYS_READY;
    check("withdrawal refused (400) when the user's own address has no gas", r.statusCode === 400, r.body);
    check("...and says so in plain language", /BNB/.test(r.json().error ?? ""), r.body);
    check("no withdrawal_requests row was created at all — nothing was held",
      (await withdrawalStatus(u)) === undefined);
    const ledgerRows = await sql.get<{ n: string | number }>(
      "SELECT COUNT(*) AS n FROM ledger_entries WHERE user_id = ? AND source_type = 'withdrawal'", u,
    );
    check("no points were ever debited", Number(ledgerRows?.n) === 0, JSON.stringify(ledgerRows));
  }

  {
    const u = await mkUser("gasrf1");
    await fundUsdt(u, 5_000_000);
    const before = await usdtBalanceMicroOf(u);
    gasCheckHook.override = NOT_READY;
    const r = await app.inject({
      method: "POST", url: "/usdt/refunds", headers: tok(u),
      payload: { amount: 2, address: testAddress() },
    });
    gasCheckHook.override = ALWAYS_READY;
    check("refund refused (400) when the user's own address has no gas", r.statusCode === 400, r.body);
    check("...and says so in plain language", /BNB/.test(r.json().error ?? ""), r.body);
    const refundRows = await sql.get<{ n: string | number }>(
      "SELECT COUNT(*) AS n FROM usdt_refund_requests WHERE user_id = ?", u,
    );
    check("no usdt_refund_requests row was created", Number(refundRows?.n) === 0, JSON.stringify(refundRows));
    check("deposit balance is untouched — nothing was debited",
      (await usdtBalanceMicroOf(u)) === before, `${await usdtBalanceMicroOf(u)}`);
  }

  clearGate();
}

console.log("\n-- NO MORE FAKE USDT GAS FEE ON THE RELAY PATH --");

// The founder's own words: "Do not subtract 0.05 USDT for gas... the
// platform is pretending to provide gas." Once the relay signs from the
// user's own address, the platform pays zero gas on a refund and only its
// own fixed prefund cost on a withdrawal — neither is a USDT amount to take
// from the user. The admin-set gas_fee_percent/fixed must be IGNORED on this
// path, even though it is still honoured on the direct-treasury fallback
// (proven by fees.e2e.ts, which never configures the relay at all).
{
  fullyConfigureSigning();
  config.payoutMode = "onchain";
  await setSetting("gas_fee_percent", "5");
  await setSetting("gas_fee_fixed_micro", "10000"); // $0.01 — the founder's own example

  {
    const u = await mkUser("nofeewd1");
    await fundPoints(u, 10_000);
    const r = await app.inject({
      method: "POST", url: "/withdrawals", headers: tok(u),
      payload: { amountPoints: 2000, chain: "bep20", address: testAddress() },
    });
    check("withdrawal still succeeds", r.statusCode === 200, r.body);
    const row = await sql.get<{ id: string; fee_points: string }>(
      "SELECT id, fee_points FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", u,
    );
    check("fee_points is 0 — the gas-fee rate was NOT applied on the relay path",
      Number(row?.fee_points) === 0, JSON.stringify(row));
  }

  {
    const u = await mkUser("nofeerf1");
    await fundUsdt(u, 5_000_000);
    const r = await app.inject({
      method: "POST", url: "/usdt/refunds", headers: tok(u),
      payload: { amount: 2, address: testAddress() },
    });
    check("refund still succeeds", r.statusCode === 200, r.body);
    const refundId = r.json().id as string;
    const row = await sql.get<{ fee_micro: string }>(
      "SELECT fee_micro FROM usdt_refund_requests WHERE id = ?", refundId,
    );
    check("fee_micro is 0 — the gas-fee rate was NOT applied on the relay path",
      Number(row?.fee_micro) === 0, JSON.stringify(row));
    check("the response itself agrees (netMicro === the full requested amount)",
      r.json().netMicro === 2_000_000, r.body);
  }

  await setSetting("gas_fee_percent", "0");
  await setSetting("gas_fee_fixed_micro", "0");
  clearGate();
}

clearGate();
gasCheckHook.override = null;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
