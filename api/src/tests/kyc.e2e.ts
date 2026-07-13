// E2E for KYC (founder decision, 2026-07-13): selfie + ID front/back, reviewed by
// a human, and the three things that "verified" actually unlocks.
//
// The tests that matter most here are the ones that ATTACK it:
//   • an SVG/HTML payload dressed up as a JPEG, which would otherwise be stored
//     and later served back to an admin's browser
//   • a referral farm trying to earn hashrate from unverified invitees
//   • a second submission flooding the review queue
//
//   npm run test:kyc
import { sql, now, newId, initDb, balanceOf } from "../db.ts";
import { config } from "../config.ts";
import { creditCompletion } from "../credit.ts";
import { encryptImage, decryptImage, parseDataUrl } from "../kyc.ts";
import { minerPopulation } from "../mining/engine.ts";
import { loadMiningSettings } from "../mining/settings.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();

// A real, minimal JPEG: the SOI marker (ff d8 ff) is what sniff() looks for.
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from("JFIF-ish body, long enough to be a plausible photo".repeat(4)),
]);
const jpegUrl = `data:image/jpeg;base64,${JPEG.toString("base64")}`;

const mkUser = async (label: string, kyc = "none") => {
  const id = newId();
  await sql.run(
    `INSERT INTO users (id, email, email_verified, country, referral_code, status, kyc_status, created_at)
     VALUES (?,?,1,'Pakistan',?,'active',?,?)`,
    id, `${label}-${id}@t.test`, id.slice(0, 8).toUpperCase(), kyc, now(),
  );
  return id;
};

console.log("\n-- the photos are ENCRYPTED at rest --");

const cipher = encryptImage(JPEG);
check("ciphertext does not contain the plaintext", !cipher.includes(JPEG.toString("base64").slice(0, 32)));
check("it round-trips back to the exact original bytes", decryptImage(cipher).equals(JPEG));
check("encrypting twice gives DIFFERENT ciphertext (the IV is random, never reused)",
  encryptImage(JPEG) !== encryptImage(JPEG));

// Tampering must fail LOUDLY. A GCM tag that does not verify means we hand a
// reviewer nothing, rather than handing them bytes we cannot vouch for.
const raw = Buffer.from(cipher, "base64");
raw[raw.length - 1] ^= 0xff; // flip a bit in the ciphertext body
let tamperThrew = false;
try { decryptImage(raw.toString("base64")); } catch { tamperThrew = true; }
check("a tampered ciphertext throws instead of returning garbage", tamperThrew);

console.log("\n-- upload validation: what is actually in the file, not what it claims --");

const ok = parseDataUrl(jpegUrl, "selfie");
check("a real JPEG is accepted", ok.mime === "image/jpeg" && ok.bytes.equals(JPEG));

// THE ATTACK. An SVG can carry script. Declaring it as image/jpeg gets it past a
// naive MIME check, and it is then stored and served back to an admin's browser.
// sniff() reads the magic bytes, so the declared type is treated as a hint and
// nothing more.
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
let svgRejected = false;
try {
  parseDataUrl(`data:image/jpeg;base64,${svg.toString("base64")}`, "selfie");
} catch { svgRejected = true; }
check("an SVG payload DECLARED as image/jpeg is rejected on its magic bytes", svgRejected);

let htmlRejected = false;
try {
  const html = Buffer.from("<html><script>fetch('/steal')</script></html>");
  parseDataUrl(`data:image/png;base64,${html.toString("base64")}`, "ID front");
} catch { htmlRejected = true; }
check("an HTML payload declared as image/png is rejected", htmlRejected);

let svgMimeRejected = false;
try { parseDataUrl(`data:image/svg+xml;base64,${svg.toString("base64")}`, "selfie"); }
catch { svgMimeRejected = true; }
check("image/svg+xml is not an allowed type at all", svgMimeRejected);

let bigRejected = false;
try {
  const big = Buffer.alloc(5_000_000, 1);
  big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
  parseDataUrl(`data:image/jpeg;base64,${big.toString("base64")}`, "selfie");
} catch { bigRejected = true; }
check("an oversized photo is rejected (before we allocate it)", bigRejected);

let junkRejected = false;
try { parseDataUrl("not-a-data-url", "selfie"); } catch { junkRejected = true; }
check("a non-data-URL is rejected", junkRejected);

console.log("\n-- one pending submission per user (the queue cannot be flooded) --");

const flood = await mkUser("flood");
const submit = (uid: string) => sql.run(
  `INSERT INTO kyc_submissions (id, user_id, selfie, id_front, id_back, status, created_at)
   VALUES (?,?,?,?,?,'pending',?)`,
  newId(), uid, encryptImage(JPEG), encryptImage(JPEG), encryptImage(JPEG), now(),
);
await submit(flood);
let secondBlocked = false;
try { await submit(flood); } catch { secondBlocked = true; }
check("a second PENDING submission is refused by the database", secondBlocked);

// ...but a resubmission AFTER a rejection is allowed — otherwise a user whose
// photo was blurry could never fix it.
await sql.run("UPDATE kyc_submissions SET status = 'rejected' WHERE user_id = ?", flood);
let resubmitOk = true;
try { await submit(flood); } catch { resubmitOk = false; }
check("but a resubmission after a rejection IS allowed", resubmitOk);

console.log("\n-- GATE 1: only VALID users count toward a halving milestone --");

// A farm of unverified signups must not drag everyone through a halving and cut
// every honest miner's rate in half.
const popBefore = await minerPopulation();
for (let i = 0; i < 5; i++) await mkUser(`bot${i}`, "none");
const popAfterBots = await minerPopulation();
check("five unverified signups do NOT move the halving population",
  popAfterBots === popBefore, `${popBefore} -> ${popAfterBots}`);

await mkUser("verified-one", "approved");
const popAfterReal = await minerPopulation();
check("one APPROVED user does move it", popAfterReal === popBefore + 1,
  `${popBefore} -> ${popAfterReal}`);

await mkUser("pending-one", "pending");
check("a PENDING user does not count yet", (await minerPopulation()) === popAfterReal);

console.log("\n-- GATE 2: an unverified invitee earns their inviter NOTHING --");

const { hashrateOf } = await import("../mining/engine.ts");
const s = await loadMiningSettings();

const inviter = await mkUser("inviter", "approved");
const solo = (await hashrateOf(inviter, s)).hashrate;

// Five invitees, all actively mining, none of them verified. This is the farm.
const mineNow = async (uid: string) => sql.run(
  `INSERT INTO mining_sessions (id, user_id, device_id, started_at, expires_at, last_accrued_at, status)
   VALUES (?,?,?,?,?,?,'active')`,
  newId(), uid, `dev-${uid.slice(0, 6)}`, now(),
  new Date(Date.now() + 8 * 3600_000).toISOString(), now(),
);
const fakes: string[] = [];
for (let i = 0; i < 5; i++) {
  const f = await mkUser(`fake${i}`, "none");
  await sql.run("UPDATE users SET referred_by = ? WHERE id = ?", inviter, f);
  await mineNow(f);
  fakes.push(f);
}

const withFakes = (await hashrateOf(inviter, s)).hashrate;
check("five UNVERIFIED, actively-mining invitees add ZERO referral hashrate",
  withFakes === solo, `${solo} -> ${withFakes}`);

// Now verify one of them. The inviter should immediately start earning from it.
await sql.run("UPDATE users SET kyc_status = 'approved' WHERE id = ?", fakes[0]);
const withOneReal = (await hashrateOf(inviter, s)).hashrate;
check("verifying ONE invitee starts paying the inviter referral hashrate",
  withOneReal > solo, `${solo} -> ${withOneReal}`);

// And an approved-but-INACTIVE invitee is still worth nothing — the old rule
// still stands on top of the new one.
const idle = await mkUser("idle", "approved");
await sql.run("UPDATE users SET referred_by = ? WHERE id = ?", inviter, idle);
check("an approved but INACTIVE invitee still adds nothing (both rules apply)",
  (await hashrateOf(inviter, s)).hashrate === withOneReal);

console.log("\n-- GATE 3: a user cannot withdraw before they are verified --");

// The gate itself is in routes/withdrawals.ts; here we prove the column it reads
// is what the review actually writes.
const payee = await mkUser("payee", "none");
const beforeApprove = await sql.get<{ kyc_status: string }>(
  "SELECT kyc_status FROM users WHERE id = ?", payee);
check("a new user starts unverified", beforeApprove?.kyc_status === "none");

await submit(payee);
await sql.run("UPDATE users SET kyc_status = 'pending' WHERE id = ?", payee);
check("submitting moves them to pending, not approved",
  (await sql.get<{ kyc_status: string }>("SELECT kyc_status FROM users WHERE id = ?", payee))
    ?.kyc_status === "pending");

// A review decision is idempotent: the conditional UPDATE means two admins
// clicking approve at once cannot both win.
const sub = await sql.get<{ id: string }>(
  "SELECT id FROM kyc_submissions WHERE user_id = ? AND status = 'pending'", payee);
const first = await sql.run(
  "UPDATE kyc_submissions SET status = 'approved', reviewed_at = ? WHERE id = ? AND status = 'pending'",
  now(), sub!.id);
const second = await sql.run(
  "UPDATE kyc_submissions SET status = 'approved', reviewed_at = ? WHERE id = ? AND status = 'pending'",
  now(), sub!.id);
check("the first review decision wins", first.rowCount === 1);
check("a second, concurrent decision on the same submission changes nothing",
  second.rowCount === 0);

console.log("\n-- GATE 4: the referral first-task bonus fires on the first task AFTER verifying --");

// The bug this guards: referral pay is KYC-gated, but people verify near the
// withdrawal threshold — long after their real first task. Anchored to the literal
// first task, the bonus was used up while the invitee was still unverified and the
// inviter never saw it. It now fires on the first credited task on/after approval.
const silentLog = { error() {} };
const TASK_POINTS = 500;
const firstBonus = config.referralFirstTaskBonusPoints;                 // 100
const commission = Math.floor(TASK_POINTS * config.referralCommissionPct); // 15% of 500 = 75

const boss = await mkUser("boss", "approved");   // the inviter, who collects the pay
const rookie = await mkUser("rookie", "none");   // the invitee, not yet verified
await sql.run("UPDATE users SET referred_by = ? WHERE id = ?", boss, rookie);

const doTask = (tag: string) => creditCompletion({
  userId: rookie, network: "test", externalId: `${tag}-${newId()}`,
  taskId: null, points: TASK_POINTS, offerType: "offerwall", payload: {},
}, silentLog);

// 1) An unverified invitee's first task pays the inviter nothing — not the
//    commission (KYC-gated) and not the one-time bonus.
const bossBefore = await balanceOf(boss);
await doTask("pre");
const afterUnverified = await balanceOf(boss);
check("an UNVERIFIED invitee's first task pays the inviter nothing",
  afterUnverified === bossBefore, `delta ${afterUnverified - bossBefore}`);

// 2) The invitee verifies — AFTER they already burned their literal first task.
await sql.run("UPDATE users SET kyc_status = 'approved', kyc_approved_at = ? WHERE id = ?", now(), rookie);

// 3) Their first task AFTER approval pays commission + the one-time bonus.
const beforeFirstVerified = await balanceOf(boss);
await doTask("post1");
const gain1 = (await balanceOf(boss)) - beforeFirstVerified;
check("the first task AFTER verifying pays commission + the first-task bonus",
  gain1 === commission + firstBonus, `got ${gain1}, want ${commission + firstBonus}`);

// 4) The next task pays commission only — the one-time bonus never fires twice.
const beforeSecond = await balanceOf(boss);
await doTask("post2");
const gain2 = (await balanceOf(boss)) - beforeSecond;
check("the one-time bonus does NOT fire again on the next task",
  gain2 === commission, `got ${gain2}, want ${commission}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
