// E2E for USDT top-up credit (founder, 2026-07-29).
//
// This is the one place in the product where REAL MONEY comes in, so the checks
// here are about the money invariants and nothing else:
//
//   1. SPEND-ONLY. Credit enters by a staff-confirmed deposit and leaves only by
//      buying a rig. There is no withdrawal, no transfer, no conversion — and
//      the test asserts the ABSENCE of those routes, because "we just never
//      built it" is exactly the kind of safety property that gets built later by
//      someone who did not read the comment. Holding money we owe back is the
//      licensed activity (PVARA) this product refuses everywhere else.
//
//   2. ONE DEPOSIT, ONE CREDIT. A transaction hash can be claimed once, ever,
//      across all users. Without that a single real deposit gets pasted by ten
//      accounts and confirmed ten times by a reviewer who recognises the hash
//      but not that they have already seen it.
//
//   3. THE REVIEWER'S AMOUNT WINS, NOT THE USER'S. The claim carries what the
//      user typed. Confirmation carries what the reviewer read off the chain.
//      If the claimed number were credited, someone could send $1, claim $500,
//      and the whole review step would be theatre.
//
//   4. A CONFIRMATION CANNOT BE APPLIED TWICE. Two admins on the queue at once
//      must not pay one deposit two times.
//
//   npm run test:usdt
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { HDKey } from "@scure/bip32";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { toChecksumAddress } from "../wallet.ts";
import {
  initDb, sql, now, newId, postLedger, postUsdt, usdtBalanceMicroOf, usdtFromMicro, roziBalanceMicroOf, postRozi,
} from "../db.ts";
import { config } from "../config.ts";
import { appRoutes } from "../routes/app.ts";
import { miningRoutes } from "../routes/mining.ts";
import { staffMiningRoutes } from "../routes/staffMining.ts";
import { withdrawalRoutes } from "../routes/withdrawals.ts";
import { CHAINS, chainById, chainIsOffered } from "../chains.ts";
import { setMiningSetting } from "../mining/settings.ts";
import { toMicro, fromMicro } from "../mining/core.ts";
import { gasCheckHook, type GasCheckResult } from "../payoutRelay.ts";
import { encryptSecret as encryptTreasurySecret } from "../signer.ts";
import { encryptSecret as encryptWith, parseAesKeyHex } from "../crypto/aesSecret.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(appRoutes);
await app.register(miningRoutes);
await app.register(staffMiningRoutes);
await app.register(withdrawalRoutes);

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
const usdtOf = async (u: string) => usdtFromMicro(await usdtBalanceMicroOf(u));
const roziOf = async (u: string) => fromMicro(await roziBalanceMicroOf(u));

// A real BEP20 address (checksum-valid), so the admin-side validator accepts it.
const TREASURY = "0x28C6c06298d514Db089934071355E5743bf21d60";

const admin = await mkUser("usdtadmin", "admin");
const user = await mkUser("usdtuser");
const other = await mkUser("usdtother");

// PGlite persists between runs; clear this suite's own rows so counts are real.
await sql.run("DELETE FROM usdt_topups WHERE tx_hash LIKE 'e2e-%'");

console.log("\n-- it ships OFF, and off means off --");

await setMiningSetting("usdtTopupEnabled", 0);
await setMiningSetting("usdtTreasuryAddress", "");

let res = await app.inject({ method: "GET", url: "/usdt", headers: tok(user) });
check("the feature reports itself disabled", res.json().enabled === false, res.body);
check("and no treasury address is handed out while it is off",
  res.json().treasuryAddress === null, res.body);

res = await app.inject({
  method: "POST", url: "/usdt/topups", headers: tok(user),
  payload: { txHash: "e2e-while-off", amount: 10 },
});
check("a claim while disabled is refused", res.statusCode === 400, res.body);

console.log("\n-- the treasury address is validated before it is published --");

await setMiningSetting("usdtTopupEnabled", 1);

res = await app.inject({
  method: "PATCH", url: "/staff/mining/settings", headers: tok(admin),
  payload: { usdtTreasuryAddress: "not-an-address" },
});
check("a junk treasury address is refused (deposits would be unrecoverable)",
  res.statusCode === 400, res.body);

res = await app.inject({
  method: "PATCH", url: "/staff/mining/settings", headers: tok(admin),
  payload: { usdtTreasuryChain: "dogecoin" },
});
check("an unknown chain is refused", res.statusCode === 400, res.body);

// DEPOSITS ARE BEP20-ONLY (founder, 2026-07-29). Base and Aptos are perfectly
// good chains and are still offered for WITHDRAWALS — but the deposit screen
// hard-codes "BNB Smart Chain (BEP20)" as the network to send on, precisely so
// that the word BNB appears only in the list of coins NOT to send. A treasury
// address on any other chain would leave that copy directing every user to
// deposit on the wrong network, and those deposits are unrecoverable.
for (const other of ["base", "aptos"] as const) {
  const r = await app.inject({
    method: "PATCH", url: "/staff/mining/settings", headers: tok(admin),
    payload: { usdtTreasuryChain: other },
  });
  check(`a ${other} treasury is refused — deposits are BEP20 only`,
    r.statusCode === 400, `${r.statusCode} ${r.body}`);
}
res = await app.inject({
  method: "PATCH", url: "/staff/mining/settings", headers: tok(admin),
  payload: { usdtTreasuryChain: "bep20" },
});
check("and bep20 is accepted", res.statusCode === 200, res.body);

res = await app.inject({
  method: "PATCH", url: "/staff/mining/settings", headers: tok(admin),
  payload: { usdtTreasuryAddress: TREASURY },
});
check("a real address is accepted", res.statusCode === 200, res.body);

console.log("\n-- claiming a deposit --");

res = await app.inject({ method: "GET", url: "/usdt", headers: tok(user) });
check("the feature is now on", res.json().enabled === true, res.body);
check("and the address is published to the user", res.json().treasuryAddress === TREASURY, res.body);

res = await app.inject({
  method: "POST", url: "/usdt/topups", headers: tok(user),
  payload: { txHash: "e2e-tx-1", amount: 20 },
});
check("a claim is accepted", res.statusCode === 200, res.body);
const claimId = res.json().id as string;

check("but NOTHING is credited yet — a claim is not a deposit",
  (await usdtOf(user)) === 0, `balance=${await usdtOf(user)}`);

res = await app.inject({
  method: "POST", url: "/usdt/topups", headers: tok(user),
  payload: { txHash: "e2e-tx-1", amount: 20 },
});
check("the same transaction cannot be claimed twice", res.statusCode === 409, res.body);

// The real attack: a DIFFERENT account pastes the same hash. One deposit, two
// accounts, and a reviewer who has seen that hash before but cannot remember.
res = await app.inject({
  method: "POST", url: "/usdt/topups", headers: tok(other),
  payload: { txHash: "e2e-tx-1", amount: 20 },
});
check("and not by a different account either — one transaction, one claim, ever",
  res.statusCode === 409, res.body);

// THE SPELLING ATTACK. The unique index compares strings, so without
// normalisation "0xABC" and "abc" are two rows for ONE transaction — and a
// reviewer pasting either into a block explorer sees the same real deposit for
// the same real amount, because explorers accept a hash with or without the
// prefix. Claim it twice, get credited twice.
res = await app.inject({
  method: "POST", url: "/usdt/topups", headers: tok(user),
  payload: { txHash: "0xE2E-TX-1", amount: 20 },
});
check("the same hash in a different case, with an 0x prefix, is still the same claim",
  res.statusCode === 409, `${res.statusCode} ${res.body}`);
res = await app.inject({
  method: "POST", url: "/usdt/topups", headers: tok(other),
  payload: { txHash: "  0xe2e-tx-1  ", amount: 20 },
});
check("and padding it with spaces does not make a new one either",
  res.statusCode === 409, `${res.statusCode} ${res.body}`);

res = await app.inject({
  method: "POST", url: "/usdt/topups", headers: tok(user),
  payload: { txHash: "e2e-too-small", amount: 0.01 },
});
check("a claim under the minimum is refused", res.statusCode === 400, res.body);

res = await app.inject({
  method: "POST", url: "/usdt/topups", headers: tok(user),
  payload: { txHash: "e2e-too-big", amount: 999_999 },
});
check("a claim over the ceiling is refused", res.statusCode === 400, res.body);

console.log("\n-- a human confirms it, and their number is the one that counts --");

res = await app.inject({ method: "GET", url: "/staff/mining/topups", headers: tok(admin) });
check("the claim is in the review queue",
  res.json().topups.some((r: { id: string }) => r.id === claimId), res.body);

// The user claimed 20. The reviewer reads 15 off the chain. 15 is what is paid.
res = await app.inject({
  method: "POST", url: `/staff/mining/topups/${claimId}/confirm`, headers: tok(admin),
  payload: { amount: 15 },
});
check("confirming credits the balance", res.statusCode === 200, res.body);
check("and it credits the REVIEWER's amount, not the user's claim",
  (await usdtOf(user)) === 15, `balance=${await usdtOf(user)}, claimed 20`);

res = await app.inject({
  method: "POST", url: `/staff/mining/topups/${claimId}/confirm`, headers: tok(admin),
  payload: { amount: 15 },
});
check("a second confirmation is refused — one deposit is never paid twice",
  res.statusCode === 409, res.body);
check("and the balance did not move", (await usdtOf(user)) === 15, `balance=${await usdtOf(user)}`);

console.log("\n-- a rejection credits nothing --");

res = await app.inject({
  method: "POST", url: "/usdt/topups", headers: tok(user),
  payload: { txHash: "e2e-tx-bad", amount: 50 },
});
const badId = res.json().id as string;
res = await app.inject({
  method: "POST", url: `/staff/mining/topups/${badId}/reject`, headers: tok(admin),
  payload: { reason: "No such transaction on the chain." },
});
check("a claim can be rejected", res.statusCode === 200, res.body);
check("and nothing was credited for it", (await usdtOf(user)) === 15, `balance=${await usdtOf(user)}`);

res = await app.inject({ method: "GET", url: "/usdt", headers: tok(user) });
const rejected = res.json().topups.find((r: { id: string }) => r.id === badId);
check("the user is told why it was rejected",
  rejected?.status === "rejected" && typeof rejected?.rejectReason === "string", res.body);

console.log("\n-- buying a machine with USDT --");

// Give the rig a USDT price. Nothing is priced in USDT by default, on purpose.
const rig = await sql.get<{ id: string; base_cost: number }>(
  "SELECT id, base_cost FROM rigs WHERE status = 'active' ORDER BY sort LIMIT 1");
res = await app.inject({
  method: "PATCH", url: `/staff/mining/rigs/${rig!.id}`, headers: tok(admin),
  payload: { baseCostUsdt: 5 },
});
check("an admin can put a USDT price on a machine", res.statusCode === 200, res.body);

res = await app.inject({ method: "GET", url: "/mining/rigs", headers: tok(user) });
let listed = res.json().rigs.find((r: { id: string }) => r.id === rig!.id);
check("the price is shown to the user", listed?.nextCostUsdtMicro === 5_000_000, JSON.stringify(listed));
check("alongside the ROZI price — both ways to pay, side by side",
  listed?.nextCostMicro > 0, JSON.stringify(listed));

const roziBefore = await roziOf(user);
res = await app.inject({
  method: "POST", url: `/mining/rigs/${rig!.id}/upgrade`, headers: tok(user),
  payload: { pay: "usdt" },
});
check("the machine can be bought with USDT", res.statusCode === 200, res.body);
check("the USDT balance went down by the price",
  (await usdtOf(user)) === 10, `balance=${await usdtOf(user)}, expected 10`);
// THE POINT OF PAYING WITH MONEY: the mined ROZI is untouched. If this ever goes
// red, a user paid twice for one machine.
check("and the ROZI balance was NOT touched",
  (await roziOf(user)) === roziBefore, `${roziBefore} -> ${await roziOf(user)}`);

// Not enough credit for the next level (cost grows), so it must refuse rather
// than go negative.
await sql.run("UPDATE rigs SET base_cost_usdt = ? WHERE id = ?", 500_000_000, rig!.id);
res = await app.inject({
  method: "POST", url: `/mining/rigs/${rig!.id}/upgrade`, headers: tok(user),
  payload: { pay: "usdt" },
});
check("buying beyond the balance is refused", res.statusCode === 400, res.body);
check("and the balance never goes negative", (await usdtOf(user)) === 10, `balance=${await usdtOf(user)}`);

// A rig with no USDT price is ROZI-only, and asking to pay money for it is a
// clean refusal rather than a free machine.
await sql.run("UPDATE rigs SET base_cost_usdt = NULL WHERE id = ?", rig!.id);
res = await app.inject({
  method: "POST", url: `/mining/rigs/${rig!.id}/upgrade`, headers: tok(user),
  payload: { pay: "usdt" },
});
check("a machine with no USDT price cannot be bought with USDT", res.statusCode === 400, res.body);
check("and still nothing was spent", (await usdtOf(user)) === 10, `balance=${await usdtOf(user)}`);

console.log("\n-- paying with ROZI still works, and spends ROZI --");

await postRozi({
  userId: user, micro: toMicro(10_000), direction: "credit",
  sourceType: "mining", sourceRefId: "usdt-e2e", note: "mined",
});
const usdtBefore = await usdtOf(user);
const roziBefore2 = await roziOf(user);
res = await app.inject({
  method: "POST", url: `/mining/rigs/${rig!.id}/upgrade`, headers: tok(user),
  payload: { pay: "rozi" },
});
check("a machine can still be bought with mined ROZI", res.statusCode === 200, res.body);
check("ROZI went down", (await roziOf(user)) < roziBefore2, `${roziBefore2} -> ${await roziOf(user)}`);
check("and the USDT credit was NOT touched",
  (await usdtOf(user)) === usdtBefore, `${usdtBefore} -> ${await usdtOf(user)}`);

console.log("\n-- THE ONLY WAY OUT IS A REFUND OF YOUR OWN DEPOSIT --");

// ⚠️ THIS SECTION WAS REWRITTEN ON 2026-08-01 AND THE REWRITE WAS DELIBERATE.
//
// It used to assert that NOTHING could take this balance out of the app. The
// founder amended that: a user may ask for their own unspent deposit back. So
// the property under test changed shape rather than disappearing — it is no
// longer "nothing leaves", it is "only the user's own unspent deposit leaves,
// only to them, only by hand".
//
// The routes below are still absent, and their absence is still the point: a
// refund is not a transfer to someone else, not a conversion into Points or
// ROZI, and not a way to cash out EARNINGS. Those are what would make this a
// general withdrawal system, which is the licensed activity (PVARA) the product
// still refuses — see MINING_SPEC.md § 7 and CUSTODY_SPEC.md § 2c.
for (const [method, url] of [
  ["POST", "/usdt/withdraw"],
  ["POST", "/usdt/withdrawals"],
  ["POST", "/usdt/transfer"],
  ["POST", "/usdt/send"],
  ["POST", "/usdt/convert"],
] as const) {
  const r = await app.inject({ method, url, headers: tok(user), payload: { amount: 1 } });
  check(`${method} ${url} still does not exist`, r.statusCode === 404, `${r.statusCode}`);
}

// The ledger still refuses a general 'withdrawal' row. 'refund' was added to the
// CHECK; 'withdrawal' was NOT, and that gap is what stops "refund your deposit"
// drifting into "withdraw any balance" by one careless commit.
let ledgerRefused = false;
try {
  await sql.run(
    `INSERT INTO usdt_ledger (id, user_id, amount, direction, source_type, created_at)
     VALUES (?,?,?,'debit','withdrawal',?)`,
    newId(), user, -1_000_000, now(),
  );
} catch { ledgerRefused = true; }
check("the ledger still refuses a 'withdrawal' row outright (database-level)",
  ledgerRefused);

const ADDR = "0x1234567890123456789012345678901234567890";

// The ID check, WHEN TURNED ON, gates a refund exactly like it gates a
// withdrawal. It is off by default since 2026-08-29 (founder: straight in/out
// of the user's own wallet, no KYC, up to $100) — so this flips it on to prove
// the gate still works, then off again for the money-maths tests below.
config.kycRequiredForWithdrawal = true;
res = await app.inject({
  method: "POST", url: "/usdt/refunds", headers: tok(user),
  payload: { amount: 1, address: ADDR },
});
check("a refund is refused while the ID check is on", res.statusCode === 403, res.body);

config.kycRequiredForWithdrawal = false; // rest of the suite tests the money maths

const balBeforeRefund = await usdtOf(user);
check("the user has deposit credit to refund", balBeforeRefund > 0, `${balBeforeRefund}`);

res = await app.inject({
  method: "POST", url: "/usdt/refunds", headers: tok(user),
  payload: { amount: 0.5, address: ADDR },
});
check("dust is refused — a BEP20 send costs more gas than it returns",
  res.statusCode === 400, res.body);

res = await app.inject({
  method: "POST", url: "/usdt/refunds", headers: tok(user),
  payload: { amount: balBeforeRefund + 1000, address: ADDR },
});
check("you cannot refund more than you deposited", res.statusCode === 400, res.body);

res = await app.inject({
  method: "POST", url: "/usdt/refunds", headers: tok(user),
  payload: { amount: 1, address: "not-an-address" },
});
check("a malformed address is refused before anything is held",
  res.statusCode === 400, res.body);

// The debit lands AT REQUEST TIME, not at approval. Without that a user asks for
// their whole balance back and buys a rig with it while the request queues.
res = await app.inject({
  method: "POST", url: "/usdt/refunds", headers: tok(user),
  payload: { amount: 1, address: ADDR },
});
check("a valid refund request is accepted", res.statusCode === 200, res.body);
const refundId = JSON.parse(res.body).id as string;
check("the money is held immediately (debited on request, not on approval)",
  (await usdtOf(user)) === balBeforeRefund - 1, `${balBeforeRefund} -> ${await usdtOf(user)}`);

// Rejecting gives it back — unlike a rejected TOP-UP, where nothing was ever
// credited so there is nothing to reverse.
res = await app.inject({
  method: "POST", url: `/staff/mining/refunds/${refundId}/reject`, headers: tok(admin),
  payload: { reason: "Address did not match our records" },
});
check("staff can reject a refund", res.statusCode === 200, res.body);
check("and rejecting puts the money back", (await usdtOf(user)) === balBeforeRefund,
  `${await usdtOf(user)} vs ${balBeforeRefund}`);

res = await app.inject({
  method: "POST", url: `/staff/mining/refunds/${refundId}/reject`, headers: tok(admin),
  payload: { reason: "second try" },
});
check("a handled refund cannot be handled twice", res.statusCode === 409, res.body);

// Paying it must NOT write a second debit — the money left the balance when the
// user asked. Writing another row here would take it twice.
res = await app.inject({
  method: "POST", url: "/usdt/refunds", headers: tok(user),
  payload: { amount: 1, address: ADDR },
});
const paidId = JSON.parse(res.body).id as string;
const afterHold = await usdtOf(user);
res = await app.inject({
  method: "POST", url: `/staff/mining/refunds/${paidId}/paid`, headers: tok(admin),
  payload: { txHash: "0x" + "a".repeat(64) },
});
check("staff can mark a refund paid with the on-chain proof", res.statusCode === 200, res.body);
check("marking paid does NOT debit a second time",
  (await usdtOf(user)) === afterHold, `${afterHold} -> ${await usdtOf(user)}`);

// The cap is the DEPOSIT ledger, so mined ROZI and earned Points can never walk
// out through this door however large they get. This is the anti-laundering
// property and the reason the refund is capped by ledger rather than by "what
// the user is owed".
const roziRich = await mkUser("rozi-rich");
await postRozi({ userId: roziRich, micro: toMicro(5000), direction: "credit", sourceType: "mining" });
res = await app.inject({
  method: "POST", url: "/usdt/refunds", headers: tok(roziRich),
  payload: { amount: 1, address: ADDR },
});
check("a user with ROZI but no deposit cannot refund a cent",
  res.statusCode === 400, res.body);

config.kycRequiredForWithdrawal = false; // back to the default (off since 2026-08-29)

console.log("\n-- ONE CHAIN IN, ONE CHAIN OUT: payouts are BEP20 only --");

// The other half of the founder's 2026-07-29 narrowing. Deposits are BEP20-only
// for a SAFETY reason (the deposit copy names one network, so the treasury must
// be on it); payouts are BEP20-only for an OPERATIONAL one — one chain to hold
// USDT on, one gas token to keep funded, one answer when a user asks support
// which network to use.
//
// The important part is that Base and Aptos are still KNOWN, just not offered.
// chainById must keep resolving them or every historical withdrawal on those
// chains loses its label in the staff queue, so the check that enforces this is
// chainIsOffered — and these assertions are what stop someone "simplifying" the
// two lists back into one.
check("Base is still a chain we can label (old rows must not go blank)",
  chainById("base")?.label === "Base");
check("Aptos too", chainById("aptos")?.label === "Aptos");
check("but only BEP20 is offered for new requests",
  chainIsOffered("bep20") && !chainIsOffered("base") && !chainIsOffered("aptos"));
check("and the offered list is exactly one chain",
  CHAINS.length === 1 && CHAINS[0].id === "bep20", JSON.stringify(CHAINS));

// A real BEP20 address is accepted as a saved payout address; a Base one is
// refused even though it is the same 0x format and validates cleanly. That is
// the point: the address is fine, the CHAIN is not on offer.
res = await app.inject({
  method: "PUT", url: "/withdrawals/addresses", headers: tok(user),
  payload: { chain: "bep20", address: TREASURY },
});
check("a BEP20 payout address can be saved", res.statusCode === 200, res.body);

res = await app.inject({
  method: "PUT", url: "/withdrawals/addresses", headers: tok(user),
  payload: { chain: "base", address: TREASURY },
});
check("a Base payout address is refused, even though the address itself is valid",
  res.statusCode === 400, `${res.statusCode} ${res.body}`);

console.log("\n-- per-user deposit addresses (CUSTODY_SPEC.md § 5 step 1) --");

await setMiningSetting("usdtTopupEnabled", 1);
await setMiningSetting("usdtTreasuryAddress", TREASURY); // treasury chain defaults to bep20

res = await app.inject({ method: "GET", url: "/usdt", headers: tok(user) });
check("no xpub configured => no personal address, shared treasury still shown",
  res.json().personalAddress === null && res.json().treasuryAddress === TREASURY, res.body);

// A throwaway BIP32 test key (fixed seed, never funded). This is the whole
// point of xpub-only derivation: it is safe to put in a test file because it
// can never authorize a spend on anything, real or not.
config.custodyXpub.bep20 =
  "xpub6DSwDWBPjdopcHjga5am3iJpVY4Doi7xqydtQWimdyWcM7s7op1GcgCKoy5AVZKn5knFtREQjZmP46Rz48nVB21fg4y8gnqj7yUdvHE7AuE";

res = await app.inject({ method: "GET", url: "/usdt", headers: tok(user) });
const addr1 = res.json().personalAddress;
check("with an xpub configured, a personal address is handed out",
  typeof addr1 === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr1), res.body);
check("the shared treasury address still rides along too — this is additive, not a replacement",
  res.json().treasuryAddress === TREASURY);

res = await app.inject({ method: "GET", url: "/usdt", headers: tok(user) });
check("asking again returns the SAME address — it is stored, not re-derived each time",
  res.json().personalAddress === addr1, res.body);

res = await app.inject({ method: "GET", url: "/usdt", headers: tok(other) });
const addr2 = res.json().personalAddress;
check("a different user gets a different address",
  typeof addr2 === "string" && addr2 !== addr1, `${addr1} vs ${addr2}`);

const rows = await sql.all<{ user_id: string }>(
  "SELECT user_id FROM deposit_wallets WHERE chain = 'bep20' AND address IN (?,?)", addr1, addr2);
check("exactly two rows exist for the two addresses just issued", rows.length === 2, JSON.stringify(rows));

config.custodyXpub.bep20 = ""; // leave the gate as we found it

res = await app.inject({ method: "GET", url: "/usdt", headers: tok(user) });
check("turning the xpub back off falls back to the shared address, address already on record or not",
  res.json().personalAddress === null && res.json().treasuryAddress === TREASURY, res.body);

console.log("\n-- wallet balance: Available/Locked (wallet overhaul) --");
{
  // The headline USDT figure folds real deposited USDT together with
  // withdrawable task/referral points at the real 1000pts=$1 rate — see the
  // comment above this computation in routes/app.ts. This is NOT the ROZI
  // case guardrail #7 forbids: points already have a fixed, real rate.
  const u = await mkUser("balmath");

  // A real deposit credit is always Available, whatever the points balance is.
  await postUsdt({
    userId: u, micro: 2_000_000, direction: "credit", sourceType: "topup", sourceRefId: newId(), note: "e2e",
  });

  // Below config.minWithdrawPoints (1000): the points-derived half is
  // entirely Locked, and Available is just the real deposit.
  await postLedger({
    userId: u, points: 500, direction: "credit", sourceType: "admin_adjustment", sourceRefId: newId(), note: "e2e",
  });
  let r = await app.inject({ method: "GET", url: "/wallet/balance", headers: tok(u) });
  let b = r.json();
  check("below the minimum: locked = the points half, available = just the real deposit",
    b.usdtLockedMicro === 500_000 && b.usdtAvailableMicro === 2_000_000, JSON.stringify(b));
  check("total always equals available + locked",
    b.usdtTotalMicro === b.usdtAvailableMicro + b.usdtLockedMicro, JSON.stringify(b));

  // Crossing the minimum with a fresh credit — the SAME live read flips
  // Locked to Available, with no separate unlock event or extra bookkeeping.
  await postLedger({
    userId: u, points: 600, direction: "credit", sourceType: "admin_adjustment", sourceRefId: newId(), note: "e2e",
  });
  r = await app.inject({ method: "GET", url: "/wallet/balance", headers: tok(u) });
  b = r.json();
  check("crossing the minimum: everything is Available, nothing Locked",
    b.usdtLockedMicro === 0 && b.usdtAvailableMicro === 2_000_000 + 1_100_000, JSON.stringify(b));
  check("total still equals available + locked",
    b.usdtTotalMicro === b.usdtAvailableMicro + b.usdtLockedMicro, JSON.stringify(b));
}

console.log("\n-- BNB withdraw: zero treasury involvement, zero ledger entry --");
{
  // Same throwaway BIP32 seed pattern as payoutRelay.e2e.ts / custodySeeds.test.ts
  // — safe in a test file because it can never authorize a real spend.
  const SEED = Buffer.from(
    "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899", "hex",
  ).subarray(0, 32);
  const ACCOUNT = HDKey.fromMasterSeed(SEED).derive("m/44'/60'/0'");
  const TEST_XPUB = ACCOUNT.publicExtendedKey;
  const TEST_XPRV = ACCOUNT.privateExtendedKey;
  const SWEEP_AES_KEY = "e".repeat(64);
  const encryptSweepSeed = (plaintext: string) => encryptWith(plaintext, parseAesKeyHex(SWEEP_AES_KEY, "test key"));

  function testAddress(): string {
    const { publicKey } = secp256k1.keygen();
    const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false);
    return toChecksumAddress("0x" + bytesToHex(keccak_256(uncompressed.slice(1))).slice(-40));
  }

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
  const ALWAYS_READY = async (): Promise<GasCheckResult> =>
    ({ ok: true, address: testAddress(), balanceWei: 10n ** 18n, requiredWei: 1n });
  const NEVER_READY = async (): Promise<GasCheckResult> =>
    ({ ok: false, address: testAddress(), balanceWei: 0n, requiredWei: 10n ** 15n });

  clearGate();
  gasCheckHook.override = ALWAYS_READY;

  {
    const u = await mkUser("bnbwd1");
    const r = await app.inject({
      method: "POST", url: "/wallet/bnb/withdraw", headers: tok(u),
      payload: { address: testAddress(), amountBnb: "0.001" },
    });
    check("nothing configured => refused outright, no queued-forever request",
      r.statusCode === 400, r.body);
  }

  fullyConfigureSigning();
  config.payoutMode = "manual"; // <- the switch stays off
  {
    const u = await mkUser("bnbwd2");
    const r = await app.inject({
      method: "POST", url: "/wallet/bnb/withdraw", headers: tok(u),
      payload: { address: testAddress(), amountBnb: "0.001" },
    });
    check("fully configured signing keys, but payoutMode MANUAL => still refused",
      r.statusCode === 400, r.body);
  }

  config.payoutMode = "onchain";
  gasCheckHook.override = NEVER_READY;
  {
    const u = await mkUser("bnbwd3");
    const r = await app.inject({
      method: "POST", url: "/wallet/bnb/withdraw", headers: tok(u),
      payload: { address: testAddress(), amountBnb: "0.001" },
    });
    check("not enough BNB for the amount + its own network fee => refused, nothing held",
      r.statusCode === 400, r.body);
    const row = await sql.get<{ id: string }>(
      "SELECT id FROM bnb_withdrawal_requests WHERE user_id = ?", u);
    check("...and no request row was created at all", !row);
  }

  gasCheckHook.override = ALWAYS_READY;
  {
    const u = await mkUser("bnbwd4");
    const dest = testAddress();
    const r = await app.inject({
      method: "POST", url: "/wallet/bnb/withdraw", headers: tok(u),
      payload: { address: dest, amountBnb: "0.001" },
    });
    check("fully configured, onchain, enough gas => accepted", r.statusCode === 200, r.body);
    check("status is 'pending' — signing is left to the background tick, never fired from the route",
      r.json().status === "pending", r.body);
    const row = await sql.get<{ status: string; address: string; amount_wei: string }>(
      "SELECT status, address, amount_wei FROM bnb_withdrawal_requests WHERE user_id = ?", u);
    check("a request row was created, targeting the destination the user asked for",
      !!row && row.status === "pending" && row.address.toLowerCase() === dest.toLowerCase(), JSON.stringify(row));
    check("the amount was converted to wei (18 decimals), not micro-USDT (6)",
      row?.amount_wei === "1000000000000000", `${row?.amount_wei}`);

    const second = await app.inject({
      method: "POST", url: "/wallet/bnb/withdraw", headers: tok(u),
      payload: { address: dest, amountBnb: "0.001" },
    });
    check("a second request while one is still in flight is refused (one in-flight request per user)",
      second.statusCode === 409, second.body);
  }

  clearGate();
  gasCheckHook.override = null;
}

// Put the economy back so a re-run and the other suites start clean.
await setMiningSetting("usdtTopupEnabled", 0);
await setMiningSetting("usdtTreasuryAddress", "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
