// E2E for the admin operations rebuild, stage 4 — user detail, deposits and
// withdrawals (brief parts 34/35/36).
//
// WHY THIS FILE EXISTS
// --------------------
// The same reason analytics.e2e.ts does, and it earned its keep the same way.
// `GET /staff/users/:id` is a pile of hand-written SQL against six tables, and
// SQL that typechecks is not SQL that runs: writing it, three columns were
// named wrong on the first pass (`chain`/`address`/`note` — the table really
// holds `payout_rail`/`payout_address`/`review_note`). That is exactly the
// shape of the `networks.label` bug, and TypeScript is blind to all of it.
// Every query added in this stage is executed here against real Postgres.
//
// It also pins the two DEFECTS this stage fixed, because both are the kind that
// come back:
//
//   1. A Finance role could not reach the deposit or refund queues at all. It
//      holds `deposits.decide` and `refunds.decide`, but the only screens
//      rendering those queues sat inside the Mining section, gated on
//      `mining.manage` — which Finance does not hold. That is a web-layer bug,
//      so what is checked HERE is the permission truth the panel must follow:
//      Finance can call the deposit and refund endpoints and cannot call the
//      mining ones. If that ever flips, the panel's section list is wrong again.
//
//   2. The withdrawal queue served only the GROSS `amount`. Manual payout is a
//      human reading that screen and sending USDT by hand, so with a fee set
//      they send the gross and the platform eats the fee it just charged. The
//      queue now serves `feePoints` and `netUsdt` per row, plus a queue total.
//
//   npm run test:stage4
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import {
  initDb, sql, now, newId, postLedger, postRozi, postUsdt,
} from "../db.ts";
import { config } from "../config.ts";
import { staffRoutes } from "../routes/staff.ts";
import { staffMiningRoutes } from "../routes/staffMining.ts";
import { ROLE_PERMISSIONS } from "../permissions.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(staffRoutes);
await app.register(staffMiningRoutes);

const TAG = newId().slice(0, 8);
const tok = (id: string) => jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: "1h" });
const authOf = (id: string) => ({ authorization: `Bearer ${tok(id)}` });

// The referral code is UNIQUE and short, so it is built from a counter rather
// than the label: `${TAG}${label}`.slice(0,12) truncates "inviter" and
// "invitee" to the same string, which is a unique-violation crash, not a test
// failure — it takes the whole run down before the first check.
let seq = 0;
async function mkUser(label: string, referredBy: string | null = null) {
  const id = newId();
  await sql.run(
    `INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at, referred_by)
     VALUES (?,?,1,'Pakistan',?,'active',?,?)`,
    id, `${TAG}-${label}@t.test`, `${TAG}${(seq++).toString(36)}`.toUpperCase().slice(0, 12), now(), referredBy,
  );
  return id;
}
async function mkStaff(label: string, role: string) {
  const id = await mkUser(label);
  await sql.run("INSERT INTO admin_users (user_id, role, created_at) VALUES (?,?,?)", id, role, now());
  return id;
}

// ---------------------------------------------------------------------------
console.log("\n-- part 34: the user detail endpoint runs at all --");
// The whole point: every column named in that handler has to exist. A single
// wrong name is a 500, and the panel's most-used screen is blank.
const subject = await mkUser("subject");
const inviter = await mkUser("inviter");
await sql.run("UPDATE users SET referred_by = ? WHERE id = ?", inviter, subject);
const invitee = await mkUser("invitee", subject);
const admin = await mkStaff("admin", "admin");

{
  const r = await app.inject({ method: "GET", url: `/staff/users/${subject}`, headers: authOf(admin) });
  check("200, not a 500 from a mistyped column", r.statusCode === 200, r.body.slice(0, 300));
  const d = r.json();
  check("the user is the one asked for", d.user?.id === subject);
  check("all three balances are present and numeric",
    typeof d.user?.balancePoints === "number" &&
    typeof d.user?.roziMicro === "number" &&
    typeof d.user?.usdtMicro === "number",
    JSON.stringify({ p: d.user?.balancePoints, r: d.user?.roziMicro, u: d.user?.usdtMicro }));
  check("every new collection is an array", Array.isArray(d.withdrawals) && Array.isArray(d.invitees)
    && Array.isArray(d.tickets) && Array.isArray(d.usdtTopups) && Array.isArray(d.usdtRefunds));
  check("both referral directions are answered",
    d.invitedBy?.id === inviter && d.invitees.some((x: { id: string }) => x.id === invitee),
    JSON.stringify({ by: d.invitedBy?.id, n: d.invitees.length }));
  check("a missing user is 404, not 500",
    (await app.inject({ method: "GET", url: "/staff/users/nope", headers: authOf(admin) })).statusCode === 404);
}

// ---------------------------------------------------------------------------
console.log("\n-- part 34: the three balances are the three LEDGERS, never summed --");
{
  await postLedger({ userId: subject, points: 2500, direction: "credit", sourceType: "admin_adjustment", note: "t" });
  await postRozi({ userId: subject, micro: 7_000_000, direction: "credit", sourceType: "mining" });
  await postUsdt({ userId: subject, micro: 3_000_000, direction: "credit", sourceType: "topup", chain: "bep20" });

  const d = (await app.inject({ method: "GET", url: `/staff/users/${subject}`, headers: authOf(admin) })).json();
  check("points read from the points ledger", d.user.balancePoints === 2500, String(d.user.balancePoints));
  check("ROZI reads from the ROZI ledger, in micro", d.user.roziMicro === 7_000_000, String(d.user.roziMicro));
  check("USDT reads from the USDT ledger, in micro", d.user.usdtMicro === 3_000_000, String(d.user.usdtMicro));
  // Guardrail #7: ROZI has no rate, so any total would invent one.
  check("no combined total is served", d.user.totalBalance === undefined && d.user.total === undefined);
}

// ---------------------------------------------------------------------------
console.log("\n-- part 34: the withdrawal history joins and aliases correctly --");
{
  const wid = newId();
  await sql.run(
    `INSERT INTO withdrawal_requests
       (id, user_id, amount, fee_points, payout_rail, payout_address, address_verified,
        status, review_note, created_at, tx_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    wid, subject, 3000, 100, "bep20", "0x" + "a".repeat(40), 1, "paid", "looks fine", now(), "0x" + "b".repeat(64),
  );
  const d = (await app.inject({ method: "GET", url: `/staff/users/${subject}`, headers: authOf(admin) })).json();
  const row = d.withdrawals.find((w: { id: string }) => w.id === wid);
  check("the row comes back", Boolean(row));
  // The three columns that were wrong on the first pass.
  check("payout_rail is served as `chain`", row?.chain === "bep20", String(row?.chain));
  check("payout_address is served as `address`", String(row?.address).startsWith("0x"), String(row?.address));
  check("review_note is served as `note`", row?.note === "looks fine", String(row?.note));
  check("the signed-address proof survives", row?.address_verified === 1 || row?.address_verified === true,
    String(row?.address_verified));
  // Counted from `paid` rows only, and NET of the fee — it is what left the
  // treasury, not what was asked for.
  check("paid summary counts only paid rows, net of fee",
    d.paidSummary.count === 1 && d.paidSummary.totalPoints === 2900,
    JSON.stringify(d.paidSummary));

  const pending = newId();
  await sql.run(
    `INSERT INTO withdrawal_requests (id, user_id, amount, fee_points, payout_rail, status, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    pending, subject, 9999, 0, "bep20", "pending", now(),
  );
  const d2 = (await app.inject({ method: "GET", url: `/staff/users/${subject}`, headers: authOf(admin) })).json();
  check("a pending request does not count as paid", d2.paidSummary.count === 1, JSON.stringify(d2.paidSummary));
}

// ---------------------------------------------------------------------------
console.log("\n-- part 34: the hold is served as a decided boolean --");
// The panel must not have to re-derive "is this hold still in force" from a
// date string; getting that wrong shows a lifted hold as active.
{
  const held = await mkUser("held");
  await sql.run(
    "UPDATE users SET withdrawal_hold_reason = ?, withdrawal_hold_at = ? WHERE id = ?",
    "under review", now(), held,
  );
  const a = (await app.inject({ method: "GET", url: `/staff/users/${held}`, headers: authOf(admin) })).json();
  check("an open-ended hold is held", a.user.withdrawalHeld === true);

  const past = new Date(Date.now() - 86400_000).toISOString();
  await sql.run("UPDATE users SET withdrawal_hold_until = ? WHERE id = ?", past, held);
  const b = (await app.inject({ method: "GET", url: `/staff/users/${held}`, headers: authOf(admin) })).json();
  check("a hold whose end date has passed is NOT held", b.user.withdrawalHeld === false);

  const future = new Date(Date.now() + 86400_000).toISOString();
  await sql.run("UPDATE users SET withdrawal_hold_until = ? WHERE id = ?", future, held);
  const c = (await app.inject({ method: "GET", url: `/staff/users/${held}`, headers: authOf(admin) })).json();
  check("a hold with a future end date is held", c.user.withdrawalHeld === true);

  const none = (await app.inject({ method: "GET", url: `/staff/users/${subject}`, headers: authOf(admin) })).json();
  check("no hold reason means not held", none.user.withdrawalHeld === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- part 36: the withdrawal queue serves the NET, not just the gross --");
{
  const feeUser = await mkUser("feeuser");
  await sql.run(
    `INSERT INTO withdrawal_requests
       (id, user_id, amount, fee_points, payout_rail, payout_address, status, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    newId(), feeUser, 5000, 500, "bep20", "0x" + "c".repeat(40), "pending", now(),
  );
  const q = await app.inject({ method: "GET", url: "/staff/withdrawals?status=pending", headers: authOf(admin) });
  check("the queue still reads", q.statusCode === 200, String(q.statusCode));
  const body = q.json();
  const row = body.requests.find((r: { userEmail: string }) => r.userEmail.includes("feeuser"));
  check("the fee is on the row", row?.feePoints === 500, String(row?.feePoints));
  // 5000 - 500 = 4500 points, at 1000 points = 1 USDT.
  check("netUsdt is amount MINUS fee, not the gross", row?.netUsdt === "4.500000", String(row?.netUsdt));
  check("the gross is still served too", row?.amount === 5000, String(row?.amount));

  check("the queue totals its own rows", typeof body.pendingTotal?.count === "number"
    && body.pendingTotal.count === body.requests.length,
    JSON.stringify(body.pendingTotal));
  // The number to fund the treasury with is the NET total.
  const expected = body.requests.reduce(
    (a: number, r: { amount: number; feePoints?: number }) => a + r.amount - (r.feePoints ?? 0), 0);
  check("the total to send is net of every fee",
    Number(body.pendingTotal.usdt) === Math.floor((expected / 1000) * 1e6) / 1e6,
    `${body.pendingTotal.usdt} vs ${expected} pts`);
}

// ---------------------------------------------------------------------------
console.log("\n-- cross-check: a 'to send' total only exists where money is OWED --");
// Found reviewing this stage. The queue takes a status filter and the panel
// renders the total as "to send" — but it was computed for EVERY filter, so the
// `paid` tab told whoever funds the treasury to send money that had already
// left, and `rejected` told them to send money nobody is owed.
{
  const doneUser = await mkUser("donerows");
  for (const st of ["paid", "rejected"]) {
    await sql.run(
      `INSERT INTO withdrawal_requests (id, user_id, amount, fee_points, payout_rail, status, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      newId(), doneUser, 4000, 0, "bep20", st, now(),
    );
  }
  for (const st of ["paid", "rejected"]) {
    const r = (await app.inject({
      method: "GET", url: `/staff/withdrawals?status=${st}`, headers: authOf(admin),
    })).json();
    check(`the ${st} tab still lists its rows`, r.requests.length > 0, String(r.requests.length));
    check(`...but serves NO 'to send' total`, r.pendingTotal === null, JSON.stringify(r.pendingTotal));
  }
  for (const st of ["pending", "agent_approved", "manager_approved"]) {
    const r = (await app.inject({
      method: "GET", url: `/staff/withdrawals?status=${st}`, headers: authOf(admin),
    })).json();
    check(`${st} is still owed, so the total is served`, r.pendingTotal !== null
      && typeof r.pendingTotal.usdt === "string", JSON.stringify(r.pendingTotal));
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- cross-check: the invite COUNT is not the page size --");
// Also found reviewing this stage. `invitees` is capped at 50 rows, and the
// header read "invited {invitees.length}" — so an account with 300 invites, the
// exact shape a referral ring makes, displayed as 50. That number is the one a
// fraud reviewer acts on.
{
  const ring = await mkUser("ringleader");
  for (let i = 0; i < 55; i++) await mkUser(`ring${i}`, ring);
  const d = (await app.inject({ method: "GET", url: `/staff/users/${ring}`, headers: authOf(admin) })).json();
  check("the list is still capped at 50", d.invitees.length === 50, String(d.invitees.length));
  check("the COUNT is the real total, not the page size",
    d.inviteeCount === 55, String(d.inviteeCount));
  check("a user with no invites counts zero, not null",
    (await app.inject({ method: "GET", url: `/staff/users/${invitee}`, headers: authOf(admin) })).json().inviteeCount === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- part 35: Finance can actually reach the money-in queues --");
// The defect this stage fixed lived in the web sidebar, but its shape is a
// permission mismatch, and THAT is checkable here. If these ever disagree with
// what staff/page.tsx gates the Money section on, the panel is wrong again.
{
  const finance = await mkStaff("finance", "finance");

  const dep = await app.inject({ method: "GET", url: "/staff/mining/topups?status=pending", headers: authOf(finance) });
  check("Finance can read the deposit queue", dep.statusCode === 200, String(dep.statusCode));
  const ref = await app.inject({ method: "GET", url: "/staff/mining/refunds?status=pending", headers: authOf(finance) });
  check("Finance can read the refund queue", ref.statusCode === 200, String(ref.statusCode));
  const wq = await app.inject({ method: "GET", url: "/staff/withdrawals", headers: authOf(finance) });
  check("Finance can read the withdrawal queue", wq.statusCode === 200, String(wq.statusCode));

  // ...and the reason those screens must NOT live in the Mining section: this
  // is the permission the section is gated on, and Finance does not have it.
  const mining = await app.inject({ method: "GET", url: "/staff/mining/settings", headers: authOf(finance) });
  check("Finance is refused the mining settings the old placement required",
    mining.statusCode === 403, String(mining.statusCode));
  check("...which is why deposits/refunds cannot be gated behind mining.manage",
    !ROLE_PERMISSIONS.finance.includes("mining.manage")
    && ROLE_PERMISSIONS.finance.includes("deposits.decide")
    && ROLE_PERMISSIONS.finance.includes("refunds.decide"));

  // Operations reads both queues but decides neither — the read/write split has
  // to survive the move to a new section.
  const ops = await mkStaff("ops", "operations");
  check("Operations can read the deposit queue",
    (await app.inject({ method: "GET", url: "/staff/mining/topups?status=pending", headers: authOf(ops) })).statusCode === 200);
  check("Operations cannot confirm a deposit",
    (await app.inject({
      method: "POST", url: "/staff/mining/topups/whatever/confirm",
      headers: authOf(ops), payload: { amount: 1 },
    })).statusCode === 403);
}

// ---------------------------------------------------------------------------
console.log("\n-- the detail screen stays shut to the people it was always shut to --");
{
  const earner = await mkUser("earner");
  check("an earner is refused (403)",
    (await app.inject({ method: "GET", url: `/staff/users/${subject}`, headers: authOf(earner) })).statusCode === 403);

  // Support's own brief: can view users, cannot change balances.
  const support = await mkStaff("support", "support");
  check("Support can open a user",
    (await app.inject({ method: "GET", url: `/staff/users/${subject}`, headers: authOf(support) })).statusCode === 200);
  check("...and still cannot mint points",
    (await app.inject({
      method: "POST", url: `/staff/users/${subject}/adjust`,
      headers: authOf(support), payload: { points: 1000, reason: "no" },
    })).statusCode === 403);
  check("...and cannot see the withdrawal queue's money",
    (await app.inject({ method: "GET", url: "/staff/withdrawals", headers: authOf(support) })).statusCode === 403);
}

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
process.exit(fail === 0 ? 0 : 1);
