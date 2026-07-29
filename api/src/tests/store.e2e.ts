// E2E for the ROZI store — the sink that gives ROZI real-world use without a
// buy-back rate (MINING_SPEC.md § 6, founder 2026-07-29).
//
// The invariants that matter are the money ones:
//   • ROZI leaves the ledger when the order is placed, not when staff get to it
//   • a rejection refunds EXACTLY what was taken, from the row's own snapshot,
//     even if an admin changed the price meanwhile
//   • a decision cannot be applied twice (no double refund)
//   • stock is a real ceiling under concurrency — the last item goes to one user
//
// Also covers the bulk referral-rate endpoint, which shares the "one careless
// admin write costs real money" character.
//
//   npm run test:store
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId, postRozi, roziBalanceMicroOf } from "../db.ts";
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
  // Staff role lives in its own table (roles.ts), not on the user row.
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
  sourceType: "mining", sourceRefId: "store-e2e", note: "mined",
});
const roziOf = async (u: string) => fromMicro(await roziBalanceMicroOf(u));

const admin = await mkUser("storeadmin", "admin");

// PGlite persists between runs — clear this test's own rows so counts are real.
await sql.run("DELETE FROM rozi_redemptions WHERE item_id IN (SELECT id FROM rozi_store_items WHERE title LIKE 'E2E %')");
await sql.run("DELETE FROM rozi_store_items WHERE title LIKE 'E2E %'");

console.log("\n-- admin creates an item --");

let res = await app.inject({
  method: "POST", url: "/staff/mining/store", headers: tok(admin),
  payload: { title: "E2E Top-up", description: "100 rupees of credit", costRozi: 500, inputLabel: "Phone number", stock: 2 },
});
check("admin can add an item", res.statusCode === 200, res.body);
const itemId = res.json().id as string;

res = await app.inject({ method: "GET", url: "/staff/mining/store", headers: tok(admin) });
const created = res.json().items.find((i: { id: string }) => i.id === itemId);
check("the item is in the catalogue with its stock", created?.stock === 2, JSON.stringify(created));

console.log("\n-- a user spends ROZI on it --");

const rida = await mkUser("rida");
await mine(rida, 1000);

res = await app.inject({ method: "GET", url: "/mining/store", headers: tok(rida) });
let body = res.json();
const shown = body.items.find((i: { id: string }) => i.id === itemId);
check("the item is on the shelf", shown?.inStock === true, JSON.stringify(shown));
check("the price is in micro-ROZI", shown?.costMicro === toMicro(500), `got ${shown?.costMicro}`);

// An item that asks for a phone number must not be redeemable without one — the
// staff member would otherwise have an order they cannot fulfil.
res = await app.inject({
  method: "POST", url: `/mining/store/${itemId}/redeem`, headers: tok(rida), payload: {},
});
check("an item needing a delivery detail refuses an empty one", res.statusCode === 400, res.body);

res = await app.inject({
  method: "POST", url: `/mining/store/${itemId}/redeem`, headers: tok(rida),
  payload: { target: "03001234567" },
});
check("the order goes through", res.statusCode === 200, res.body);
check("ROZI left the ledger AT ORDER TIME, not at fulfilment",
  (await roziOf(rida)) === 500, `got ${await roziOf(rida)}`);
const orderId = res.json().id as string;

res = await app.inject({ method: "GET", url: "/mining/store", headers: tok(rida) });
body = res.json();
check("the user sees their order as pending",
  body.redemptions[0]?.id === orderId && body.redemptions[0]?.status === "pending",
  JSON.stringify(body.redemptions[0]));

console.log("\n-- rejecting refunds exactly what was taken --");

// The admin raises the price AFTER the order. The refund must use the snapshot
// on the row, not the new catalogue price.
await app.inject({
  method: "PATCH", url: `/staff/mining/store/${itemId}`, headers: tok(admin),
  payload: { costRozi: 9000 },
});
res = await app.inject({
  method: "POST", url: `/staff/mining/redemptions/${orderId}`, headers: tok(admin),
  payload: { action: "reject", note: "Out of stock at the vendor" },
});
check("staff can reject an order", res.statusCode === 200, res.body);
check("the refund is the ORIGINAL price, not the new one",
  (await roziOf(rida)) === 1000, `got ${await roziOf(rida)}`);

res = await app.inject({
  method: "POST", url: `/staff/mining/redemptions/${orderId}`, headers: tok(admin),
  payload: { action: "reject" },
});
check("the same order cannot be rejected twice", res.statusCode === 400, res.body);
check("and the double-reject refunded nothing", (await roziOf(rida)) === 1000,
  `got ${await roziOf(rida)}`);

// Put the price back for the rest of the test.
await app.inject({
  method: "PATCH", url: `/staff/mining/store/${itemId}`, headers: tok(admin),
  payload: { costRozi: 500 },
});

console.log("\n-- fulfilling keeps the ROZI --");

res = await app.inject({
  method: "POST", url: `/mining/store/${itemId}/redeem`, headers: tok(rida),
  payload: { target: "03001234567" },
});
const keptId = res.json().id as string;
res = await app.inject({
  method: "POST", url: `/staff/mining/redemptions/${keptId}`, headers: tok(admin),
  payload: { action: "fulfil" },
});
check("staff can mark an order done", res.statusCode === 200, res.body);
check("a fulfilled order does NOT return the ROZI", (await roziOf(rida)) === 500,
  `got ${await roziOf(rida)}`);

console.log("\n-- stock is a real ceiling, even under concurrency --");

// One item left. Ten users go for it at once; exactly one may win.
await app.inject({
  method: "PATCH", url: `/staff/mining/store/${itemId}`, headers: tok(admin),
  payload: { stock: 1 },
});
const racers = await Promise.all(
  Array.from({ length: 10 }, (_, i) => mkUser(`racer${i}`)),
);
for (const r of racers) await mine(r, 1000);
const attempts = await Promise.all(racers.map((r) => app.inject({
  method: "POST", url: `/mining/store/${itemId}/redeem`, headers: tok(r),
  payload: { target: "03000000000" },
})));
const won = attempts.filter((a) => a.statusCode === 200).length;
check("exactly one racer got the last item", won === 1, `${won} of 10 succeeded`);
const charged = (await Promise.all(racers.map(roziOf))).filter((b) => b === 500).length;
check("and exactly one racer was charged", charged === 1, `${charged} charged`);

console.log("\n-- a user cannot buy what they cannot afford --");

const broke = await mkUser("broke");
await mine(broke, 10);
await app.inject({
  method: "PATCH", url: `/staff/mining/store/${itemId}`, headers: tok(admin), payload: { stock: 5 },
});
res = await app.inject({
  method: "POST", url: `/mining/store/${itemId}/redeem`, headers: tok(broke),
  payload: { target: "03000000000" },
});
check("an unaffordable order is refused", res.statusCode === 400, res.body);
check("and took nothing", (await roziOf(broke)) === 10, `got ${await roziOf(broke)}`);

console.log("\n-- a hidden item cannot be bought --");

await app.inject({
  method: "PATCH", url: `/staff/mining/store/${itemId}`, headers: tok(admin), payload: { status: "hidden" },
});
res = await app.inject({ method: "GET", url: "/mining/store", headers: tok(rida) });
check("a hidden item is off the shelf",
  !res.json().items.some((i: { id: string }) => i.id === itemId));
res = await app.inject({
  method: "POST", url: `/mining/store/${itemId}/redeem`, headers: tok(rida),
  payload: { target: "03000000000" },
});
check("and cannot be bought by id", res.statusCode === 404, res.body);

console.log("\n-- staff routes are staff-only --");

res = await app.inject({
  method: "POST", url: "/staff/mining/store", headers: tok(rida),
  payload: { title: "E2E Sneaky", costRozi: 1, stock: 999 },
});
check("an earner cannot create store items", res.statusCode === 401 || res.statusCode === 403,
  `status ${res.statusCode}`);
res = await app.inject({
  method: "POST", url: `/staff/mining/redemptions/${keptId}`, headers: tok(rida),
  payload: { action: "reject" },
});
check("an earner cannot decide redemptions", res.statusCode === 401 || res.statusCode === 403,
  `status ${res.statusCode}`);

console.log("\n-- bulk referral rates --");

res = await app.inject({
  method: "PATCH", url: "/staff/networks/referrals/all", headers: tok(admin),
  payload: { referralBonusPct: 20, referralBonusPctL2: 6 },
});
check("an admin can set referral rates on every network", res.statusCode === 200, res.body);
const rows = await sql.all<{ l1: number; l2: number }>(
  "SELECT referral_bonus_pct AS l1, referral_bonus_pct_l2 AS l2 FROM networks");
check("EVERY network moved, not just one",
  rows.length > 0 && rows.every((r) => r.l1 === 20 && r.l2 === 6),
  JSON.stringify(rows));

// The guard that matters: referral pay comes out of margin. At a 60/40 split the
// margin is 40 points per 100, so 30 + 15 would lose money on every task.
res = await app.inject({
  method: "PATCH", url: "/staff/networks/referrals/all", headers: tok(admin),
  payload: { referralBonusPct: 30, referralBonusPctL2: 15 },
});
check("rates above the margin are refused", res.statusCode === 400, res.body);
check("the refusal explains why", String(res.json().error).includes("margin"), res.json().error);
const after = await sql.all<{ l1: number }>("SELECT referral_bonus_pct AS l1 FROM networks");
check("and nothing was written", after.every((r) => r.l1 === 20), JSON.stringify(after));

// Setting ONLY L2 must still be checked against each row's existing L1.
res = await app.inject({
  method: "PATCH", url: "/staff/networks/referrals/all", headers: tok(admin),
  payload: { referralBonusPctL2: 90 },
});
check("a partial update is still checked against the stored L1", res.statusCode === 400, res.body);

res = await app.inject({
  method: "PATCH", url: "/staff/networks/referrals/all", headers: tok(rida),
  payload: { referralBonusPct: 99 },
});
check("an earner cannot change referral rates", res.statusCode === 401 || res.statusCode === 403,
  `status ${res.statusCode}`);

// Restore the launch defaults so a later run of another suite is not surprised.
await app.inject({
  method: "PATCH", url: "/staff/networks/referrals/all", headers: tok(admin),
  payload: { referralBonusPct: 15, referralBonusPctL2: 5, referralFirstTaskBonus: 100 },
});
await sql.run("DELETE FROM rozi_redemptions WHERE item_id = ?", itemId);
await sql.run("DELETE FROM rozi_store_items WHERE id = ?", itemId);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
