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
import { initDb, sql, now, newId, usdtBalanceMicroOf, usdtFromMicro, roziBalanceMicroOf, postRozi } from "../db.ts";
import { config } from "../config.ts";
import { miningRoutes } from "../routes/mining.ts";
import { staffMiningRoutes } from "../routes/staffMining.ts";
import { withdrawalRoutes } from "../routes/withdrawals.ts";
import { CHAINS, chainById, chainIsOffered } from "../chains.ts";
import { setMiningSetting } from "../mining/settings.ts";
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

console.log("\n-- SPEND-ONLY: there is no way out, and that is the safety property --");

// Asserting the ABSENCE of routes. This is the check that stops "we just never
// built a withdrawal" from quietly becoming "someone built one" — the moment
// this credit can leave the app we are holding customer funds, which is the
// licensed activity the whole product is shaped to avoid (MINING_SPEC.md § 7).
for (const [method, url] of [
  ["POST", "/usdt/withdraw"],
  ["POST", "/usdt/withdrawals"],
  ["POST", "/usdt/transfer"],
  ["POST", "/usdt/send"],
  ["POST", "/usdt/convert"],
] as const) {
  const r = await app.inject({ method, url, headers: tok(user), payload: { amount: 1 } });
  check(`${method} ${url} does not exist`, r.statusCode === 404, `${r.statusCode}`);
}

// And the ledger itself cannot record one: the source_type CHECK constraint only
// permits the three kinds this feature has.
let ledgerRefused = false;
try {
  await sql.run(
    `INSERT INTO usdt_ledger (id, user_id, amount, direction, source_type, created_at)
     VALUES (?,?,?,'debit','withdrawal',?)`,
    newId(), user, -1_000_000, now(),
  );
} catch { ledgerRefused = true; }
check("the ledger refuses a 'withdrawal' row outright (database-level, not just routing)",
  ledgerRefused);

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

// Put the economy back so a re-run and the other suites start clean.
await setMiningSetting("usdtTopupEnabled", 0);
await setMiningSetting("usdtTreasuryAddress", "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
