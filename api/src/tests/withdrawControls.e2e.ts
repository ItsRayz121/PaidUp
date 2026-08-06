// E2E for the withdrawal abuse controls added alongside fully-automatic
// on-chain withdrawal (docs/CUSTODY_SPEC.md § 3.3): step-up email
// confirmation on a large request, and the soft velocity flag. Neither of
// these lets a real network broadcast happen — see autoWithdraw.e2e.ts's own
// header for why that is out of scope for an offline suite; payoutMode stays
// "manual" throughout this file on purpose, so every request here is a
// pending-queue outcome and the assertions are entirely about WHETHER a
// request gets created, not what happens to it after.
//
//   npm run test:withdrawcontrols
import { createHash } from "node:crypto";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { initDb, sql, now, newId, postLedger } from "../db.ts";
import { config } from "../config.ts";
import { withdrawalRoutes } from "../routes/withdrawals.ts";
import { toChecksumAddress } from "../wallet.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(withdrawalRoutes);

// payoutMode stays manual — this file never wants tryAutoSettle to reach a
// real network call, only to observe whether a request gets CREATED.
config.payoutMode = "manual";
config.stepUpMinPoints = 4000;
config.withdrawalVelocityFlagCount = 3;

const mkUser = async (label: string) => {
  const id = newId();
  const email = `${label}-${id}@t.test`;
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, kyc_status, created_at) VALUES (?,?,1,'Pakistan',?,'active','approved',?)",
    id, email, id.slice(0, 8).toUpperCase(), now(),
  );
  return { id, email };
};
const tok = (userId: string) => ({ authorization: `Bearer ${jwt.sign({ sub: userId }, config.jwtSecret)}` });

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

// Same trick telegram.e2e.ts uses: the code goes to the inbox (dev: console),
// so patch a KNOWN code into the row the same way the pepper hashes it.
async function patchKnownCode(email: string, purpose: string, knownCode: string): Promise<void> {
  await sql.run(
    "UPDATE email_codes SET code_hash = ? WHERE email = ? AND purpose = ? AND consumed = 0",
    createHash("sha256").update(`${knownCode}:${config.otpPepper}`).digest("hex"), email, purpose,
  );
}

console.log("\n-- below the step-up threshold: no code needed --");

{
  const u = await mkUser("stepup1");
  await fund(u.id, 10_000);
  const r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u.id),
    payload: { amountPoints: 2000, chain: "bep20", address: testAddress() },
  });
  check("request succeeds with no stepUpCode field at all", r.statusCode === 200, r.body);
  check("stays pending (manual mode)", r.json().request?.status === "pending", r.body);
}

console.log("\n-- at/above the threshold: refused without a code --");

{
  const u = await mkUser("stepup2");
  await fund(u.id, 10_000);
  const r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u.id),
    payload: { amountPoints: config.stepUpMinPoints, chain: "bep20", address: testAddress() },
  });
  check("refused with 400", r.statusCode === 400, r.body);
  check("tells the client a step-up code is needed", r.json().stepUpRequired === true, r.body);
  check("and NOTHING was held — no request row was created", !(await sql.get(
    "SELECT id FROM withdrawal_requests WHERE user_id = ?", u.id,
  )));
}

console.log("\n-- requesting the code, then using the WRONG one --");

{
  const u = await mkUser("stepup3");
  await fund(u.id, 10_000);

  const reqCode = await app.inject({
    method: "POST", url: "/withdrawals/request-step-up", headers: tok(u.id),
  });
  check("request-step-up succeeds", reqCode.statusCode === 200 && reqCode.json().sent === true, reqCode.body);

  const wrong = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u.id),
    payload: { amountPoints: config.stepUpMinPoints, chain: "bep20", address: testAddress(), stepUpCode: "000000" },
  });
  check("the wrong code is refused", wrong.statusCode === 400 && wrong.json().stepUpRequired === true, wrong.body);
  check("still nothing was held", !(await sql.get(
    "SELECT id FROM withdrawal_requests WHERE user_id = ?", u.id,
  )));
}

console.log("\n-- the RIGHT code succeeds, and cannot be replayed --");

{
  const u = await mkUser("stepup4");
  await fund(u.id, 10_000);

  await app.inject({ method: "POST", url: "/withdrawals/request-step-up", headers: tok(u.id) });
  await patchKnownCode(u.email, "withdraw", "555555");

  const first = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u.id),
    payload: { amountPoints: config.stepUpMinPoints, chain: "bep20", address: testAddress(), stepUpCode: "555555" },
  });
  check("the correct code is accepted", first.statusCode === 200, first.body);
  check("and the request is created (pending, manual mode)", first.json().request?.status === "pending", first.body);

  const replay = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u.id),
    payload: { amountPoints: config.stepUpMinPoints, chain: "bep20", address: testAddress(), stepUpCode: "555555" },
  });
  check("replaying the SAME code a second time is refused", replay.statusCode === 400, replay.body);
}

console.log("\n-- security fix: splitting into sub-threshold requests does not skip step-up --");

// A single request under stepUpMinPoints used to require no code at all, even
// after several such requests in one day added up to well over the
// threshold. The trigger is now the ROLLING 24H TOTAL, not just this
// request's own amount.
{
  const u = await mkUser("stepup5");
  await fund(u.id, 100_000);
  // Three of these: the first two individually AND together stay under the
  // threshold (2 * chunk < stepUpMinPoints), the third pushes the rolling
  // total over it (3 * chunk >= stepUpMinPoints).
  const chunk = Math.ceil(config.stepUpMinPoints / 3) + 1;

  const r1 = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u.id),
    payload: { amountPoints: chunk, chain: "bep20", address: testAddress() },
  });
  check("first chunk needs no code (well under the threshold alone)", r1.statusCode === 200, r1.body);

  const r2 = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u.id),
    payload: { amountPoints: chunk, chain: "bep20", address: testAddress() },
  });
  check("second chunk still needs no code (2*chunk still under threshold)", r2.statusCode === 200, r2.body);

  const r3 = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u.id),
    payload: { amountPoints: chunk, chain: "bep20", address: testAddress() }, // no stepUpCode
  });
  check("the THIRD chunk — individually still under the threshold — now requires a code, because the 24h total crossed it",
    r3.statusCode === 400 && r3.json().stepUpRequired === true, r3.body);

  await app.inject({ method: "POST", url: "/withdrawals/request-step-up", headers: tok(u.id) });
  await patchKnownCode(u.email, "withdraw", "777777");
  const r3ok = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u.id),
    payload: { amountPoints: chunk, chain: "bep20", address: testAddress(), stepUpCode: "777777" },
  });
  check("...and succeeds once the code is supplied", r3ok.statusCode === 200, r3ok.body);
}

console.log("\n-- a Telegram-only account (synthetic email) cannot be asked for a large withdrawal --");

{
  const id = newId();
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, kyc_status, created_at) VALUES (?,?,0,'Pakistan',?,'active','approved',?)",
    id, `tg${id}@telegram.local`, id.slice(0, 8).toUpperCase(), now(),
  );
  await fund(id, 10_000);
  const r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(id),
    payload: { amountPoints: config.stepUpMinPoints, chain: "bep20", address: testAddress() },
  });
  check("refused with a clear reason instead of a stuck stepUpRequired loop", r.statusCode === 400, r.body);
}

// Velocity is a separate concern from step-up (the cumulative step-up trigger
// added after this suite was first written would otherwise fire partway
// through the loop below, since it also sums the rolling 24h total).
config.stepUpMinPoints = Infinity;

console.log("\n-- velocity: many small requests in 24h raise a soft flag, and never block --");

{
  const u = await mkUser("velocity1");
  await fund(u.id, 100_000);

  let lastStatus = 0;
  for (let i = 0; i < config.withdrawalVelocityFlagCount; i++) {
    const r = await app.inject({
      method: "POST", url: "/withdrawals", headers: tok(u.id),
      payload: { amountPoints: 1500, chain: "bep20", address: testAddress() },
    });
    lastStatus = r.statusCode;
  }
  check("every request in the run still succeeds — this NEVER blocks", lastStatus === 200);

  const flag = await sql.get<{ id: string; severity: string }>(
    "SELECT id, severity FROM fraud_flags WHERE flag_type = 'withdrawal_velocity' AND user_id = ?", u.id,
  );
  check("a withdrawal_velocity flag was raised", !!flag, JSON.stringify(flag));
  check("it is medium severity, not a hard signal", flag?.severity === "medium", JSON.stringify(flag));

  const countAfter = await sql.get<{ n: string }>(
    "SELECT COUNT(*) AS n FROM fraud_flags WHERE flag_type = 'withdrawal_velocity' AND user_id = ?", u.id,
  );
  // One more request should NOT raise a second flag row — flagOnce dedupes
  // against the unresolved flag, same as every other fraud.ts check.
  await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u.id),
    payload: { amountPoints: 1500, chain: "bep20", address: testAddress() },
  });
  const countStill = await sql.get<{ n: string }>(
    "SELECT COUNT(*) AS n FROM fraud_flags WHERE flag_type = 'withdrawal_velocity' AND user_id = ?", u.id,
  );
  check("one more request does not raise a SECOND flag (deduped)", countStill?.n === countAfter?.n,
    `${countAfter?.n} -> ${countStill?.n}`);
}

console.log("\n-- velocity: staying under the count raises nothing --");

{
  const u = await mkUser("velocity2");
  await fund(u.id, 10_000);
  await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(u.id),
    payload: { amountPoints: 1500, chain: "bep20", address: testAddress() },
  });
  const flag = await sql.get(
    "SELECT id FROM fraud_flags WHERE flag_type = 'withdrawal_velocity' AND user_id = ?", u.id,
  );
  check("no flag for a single ordinary request", !flag);
}

// Leave the gate as we found it for any other suite that runs after this one.
config.stepUpMinPoints = Infinity;
config.withdrawalVelocityFlagCount = 4;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
