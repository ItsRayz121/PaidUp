// E2E for the Money & payouts queues (admin console rebuild, Phase C):
// server-side search / sort / pagination on the withdrawal, deposit and refund
// queues, plus the two new read-only surfaces — BNB withdrawals and payout
// relay jobs — and the reconciliation history.
//
//   npm run test:moneyadmin
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId } from "../db.ts";
import { config } from "../config.ts";
import { staffRoutes } from "../routes/staff.ts";
import { staffMiningRoutes } from "../routes/staffMining.ts";

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

let seq = 0;
async function mkUser(label: string) {
  const id = newId();
  await sql.run(
    `INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at)
     VALUES (?,?,1,'Pakistan',?,'active',?)`,
    id, `${TAG}-${label}@t.test`, `${TAG}${(seq++).toString(36)}`.toUpperCase().slice(0, 12), now(),
  );
  return id;
}
async function mkStaff(label: string, role: string) {
  const id = await mkUser(label);
  await sql.run("INSERT INTO admin_users (user_id, role, created_at) VALUES (?,?,?)", id, role, now());
  return id;
}

// stagger created_at so ORDER BY is deterministic
let clock = Date.parse("2026-08-01T00:00:00Z");
const tick = () => new Date((clock += 60_000)).toISOString();

const admin = await mkStaff("admin", "admin");
const agent = await mkStaff("agent", "agent");

// ---------------------------------------------------------------------------
console.log("\n-- withdrawals: pagination, total, sort --");
{
  const u = await mkUser("w-user");
  for (let i = 0; i < 7; i++) {
    await sql.run(
      `INSERT INTO withdrawal_requests (id, user_id, amount, payout_rail, payout_address, status, created_at)
       VALUES (?,?,?,?,?,'pending',?)`,
      newId(), u, 1000 + i * 100, "bep20", `0xaddr${i}${TAG}`, tick(),
    );
  }

  const p1 = await app.inject({ method: "GET", url: "/staff/withdrawals?status=pending&limit=3&offset=0", headers: authOf(admin) });
  check("200", p1.statusCode === 200, p1.body);
  const d1 = p1.json() as { requests: unknown[]; total: number; offset: number; limit: number; pendingTotal: { count: number; points: number } };
  check("page 1 has 3 rows", d1.requests.length === 3, JSON.stringify(d1.requests.length));
  check("total is 7 (whole filtered set, not the page)", d1.total === 7, String(d1.total));
  check("offset/limit echoed", d1.offset === 0 && d1.limit === 3);
  check("pendingTotal.count is 7 (whole set, not page)", d1.pendingTotal.count === 7, JSON.stringify(d1.pendingTotal));
  check("pendingTotal.points sums all 7", d1.pendingTotal.points === (1000 * 7 + 100 * (0 + 1 + 2 + 3 + 4 + 5 + 6)), String(d1.pendingTotal.points));

  const p3 = await app.inject({ method: "GET", url: "/staff/withdrawals?status=pending&limit=3&offset=6", headers: authOf(admin) });
  check("last page has the 1 remaining row", (p3.json() as { requests: unknown[] }).requests.length === 1);

  const asc = await app.inject({ method: "GET", url: "/staff/withdrawals?status=pending&sort=amount&dir=asc&limit=100", headers: authOf(admin) });
  const amts = (asc.json() as { requests: { amount: number }[] }).requests.map((r) => r.amount);
  check("sort=amount asc is ascending", amts.join() === [...amts].sort((a, b) => a - b).join(), amts.join());
}

// ---------------------------------------------------------------------------
console.log("\n-- withdrawals: search + status filter, agent cap in SQL --");
{
  const target = await mkUser("w-search");
  await sql.run(
    `INSERT INTO withdrawal_requests (id, user_id, amount, payout_rail, payout_address, status, created_at)
     VALUES (?,?,?,?,?,'paid',?)`,
    newId(), target, 500, "bep20", `0xNEEDLE${TAG}`, tick(),
  );
  const big = await mkUser("w-big");
  await sql.run(
    `INSERT INTO withdrawal_requests (id, user_id, amount, payout_rail, payout_address, status, created_at)
     VALUES (?,?,?,?,?,'pending',?)`,
    newId(), big, config.agentApprovalMaxPoints + 5000, "bep20", `0xBIG${TAG}`, tick(),
  );

  const byAddr = await app.inject({ method: "GET", url: `/staff/withdrawals?status=paid&q=needle${TAG}`.toLowerCase(), headers: authOf(admin) });
  const dA = byAddr.json() as { requests: { address: string }[]; total: number };
  check("search by address (paid tab) finds exactly 1", dA.total === 1 && dA.requests.length === 1, JSON.stringify(dA));

  const paidNoTotal = await app.inject({ method: "GET", url: "/staff/withdrawals?status=paid", headers: authOf(admin) });
  check("pendingTotal is null on the paid tab", (paidNoTotal.json() as { pendingTotal: unknown }).pendingTotal === null);

  const agentView = await app.inject({ method: "GET", url: "/staff/withdrawals?status=pending&limit=100", headers: authOf(agent) });
  const dAg = agentView.json() as { requests: { amount: number }[]; total: number };
  check("agent never sees an over-cap request (filtered in SQL)",
    dAg.requests.every((r) => r.amount <= config.agentApprovalMaxPoints), JSON.stringify(dAg.requests.map((r) => r.amount)));
  const adminView = await app.inject({ method: "GET", url: "/staff/withdrawals?status=pending&limit=100", headers: authOf(admin) });
  check("admin total > agent total (cap really excluded rows)",
    (adminView.json() as { total: number }).total > dAg.total);
}

// ---------------------------------------------------------------------------
console.log("\n-- deposits + refunds: pagination + total --");
{
  const u = await mkUser("dep-user");
  for (let i = 0; i < 5; i++) {
    await sql.run(
      `INSERT INTO usdt_topups (id, user_id, chain, tx_hash, amount, status, created_at)
       VALUES (?,?,?,?,?,'pending',?)`,
      newId(), u, "bep20", `0xtop${i}${TAG}`, 2_000_000 + i, tick(),
    );
    await sql.run(
      `INSERT INTO usdt_refund_requests (id, user_id, chain, address, amount, fee_micro, status, created_at)
       VALUES (?,?,?,?,?,0,'pending',?)`,
      newId(), u, "bep20", `0xref${i}${TAG}`, 3_000_000 + i, tick(),
    );
  }

  const t = await app.inject({ method: "GET", url: "/staff/mining/topups?status=pending&limit=2", headers: authOf(admin) });
  const dt = t.json() as { topups: unknown[]; total: number; offset: number; limit: number; treasuryChain: string };
  check("topups page = 2", dt.topups.length === 2, String(dt.topups.length));
  check("topups total >= 5", dt.total >= 5, String(dt.total));
  check("topups still carries treasuryChain", typeof dt.treasuryChain === "string");

  const tSearch = await app.inject({ method: "GET", url: `/staff/mining/topups?status=pending&q=0xtop3${TAG}`, headers: authOf(admin) });
  check("topups search by tx hash finds 1", (tSearch.json() as { total: number }).total === 1);

  const r = await app.inject({ method: "GET", url: "/staff/mining/refunds?status=pending&limit=2&offset=4", headers: authOf(admin) });
  const dr = r.json() as { refunds: unknown[]; total: number };
  check("refunds total >= 5", dr.total >= 5, String(dr.total));
  check("refunds offset past the end returns fewer than a full page", dr.refunds.length <= 2);
}

// ---------------------------------------------------------------------------
console.log("\n-- BNB withdrawals: new read-only queue --");
{
  const u = await mkUser("bnb-user");
  await sql.run(
    `INSERT INTO bnb_withdrawal_requests (id, user_id, chain, address, amount_wei, status, last_error, created_at)
     VALUES (?,?,?,?,?,'failed',?,?)`,
    newId(), u, "bep20", `0xbnb${TAG}`, "1000000000000000", "insufficient gas", tick(),
  );
  await sql.run(
    `INSERT INTO bnb_withdrawal_requests (id, user_id, chain, address, amount_wei, status, created_at)
     VALUES (?,?,?,?,?,'paid',?)`,
    newId(), u, "bep20", `0xbnb2${TAG}`, "2000000000000000", tick(),
  );

  const def = await app.inject({ method: "GET", url: "/staff/bnb-withdrawals", headers: authOf(admin) });
  check("200", def.statusCode === 200, def.body);
  const d = def.json() as { rows: { status: string; userEmail: string; lastError: string | null }[]; total: number };
  check("defaults to the failed tab", d.rows.length === 1 && d.rows[0].status === "failed", JSON.stringify(d.rows));
  check("row carries userEmail + lastError", d.rows[0].userEmail.includes(TAG) && d.rows[0].lastError === "insufficient gas");

  const paid = await app.inject({ method: "GET", url: "/staff/bnb-withdrawals?status=paid", headers: authOf(admin) });
  check("status=paid returns the paid row", (paid.json() as { rows: { status: string }[] }).rows.some((r) => r.status === "paid"));

  const noAuth = await app.inject({ method: "GET", url: "/staff/bnb-withdrawals" });
  check("no token => not 200", noAuth.statusCode !== 200, String(noAuth.statusCode));
}

// ---------------------------------------------------------------------------
console.log("\n-- payout relay jobs: new read-only queue --");
{
  const u = await mkUser("relay-user");
  const wid = newId();
  await sql.run(
    `INSERT INTO withdrawal_requests (id, user_id, amount, payout_rail, payout_address, status, created_at)
     VALUES (?,?,?,?,?,'sending',?)`,
    wid, u, 4000, "bep20", `0xrelayto${TAG}`, tick(),
  );
  await sql.run(
    `INSERT INTO payout_relay_jobs
       (id, purpose, request_id, chain, user_id, from_address, addr_index, to_address, amount_micro, needs_prefund, status, last_error, created_at)
     VALUES (?, 'withdrawal', ?, 'bep20', ?, ?, 1, ?, 4000000, 1, 'failed', 'revert', ?)`,
    newId(), wid, u, `0xfrom${TAG}`, `0xrelayto${TAG}`, tick(),
  );
  await sql.run(
    `INSERT INTO payout_relay_jobs
       (id, purpose, request_id, chain, user_id, from_address, addr_index, to_address, amount_micro, needs_prefund, status, created_at)
     VALUES (?, 'refund', ?, 'bep20', ?, ?, 2, ?, 5000000, 0, 'forward_confirmed', ?)`,
    newId(), newId(), u, `0xfrom2${TAG}`, `0xrefto${TAG}`, tick(),
  );

  const def = await app.inject({ method: "GET", url: "/staff/relay-jobs", headers: authOf(admin) });
  check("200", def.statusCode === 200, def.body);
  const d = def.json() as { rows: { status: string; purpose: string; amountMicro: number }[]; total: number };
  check("defaults to failed", d.rows.length === 1 && d.rows[0].status === "failed", JSON.stringify(d.rows));
  check("failed row is the withdrawal job", d.rows[0].purpose === "withdrawal" && d.rows[0].amountMicro === 4_000_000);

  const active = await app.inject({ method: "GET", url: "/staff/relay-jobs?status=active", headers: authOf(admin) });
  check("status=active excludes forward_confirmed + failed",
    (active.json() as { rows: unknown[] }).rows.length === 0, JSON.stringify(active.json()));

  const byPurpose = await app.inject({ method: "GET", url: "/staff/relay-jobs?status=forward_confirmed&purpose=refund", headers: authOf(admin) });
  check("purpose filter narrows to the refund job", (byPurpose.json() as { rows: { purpose: string }[] }).rows.every((r) => r.purpose === "refund"));

  const noAuth = await app.inject({ method: "GET", url: "/staff/relay-jobs" });
  check("no token => not 200", noAuth.statusCode !== 200);
}

// ---------------------------------------------------------------------------
console.log("\n-- mark a failed relay job / BNB withdrawal handled --");
{
  const u = await mkUser("handle-user");
  const jobId = newId();
  await sql.run(
    `INSERT INTO payout_relay_jobs
       (id, purpose, request_id, chain, user_id, from_address, addr_index, to_address, amount_micro, needs_prefund, status, last_error, created_at)
     VALUES (?, 'refund', ?, 'bep20', ?, ?, 9, ?, 1000000, 0, 'failed', 'gave up', ?)`,
    jobId, newId(), u, `0xfromh${TAG}`, `0xtoh${TAG}`, tick(),
  );
  const okJob = newId();
  await sql.run(
    `INSERT INTO payout_relay_jobs
       (id, purpose, request_id, chain, user_id, from_address, addr_index, to_address, amount_micro, needs_prefund, status, created_at)
     VALUES (?, 'refund', ?, 'bep20', ?, ?, 10, ?, 1000000, 0, 'forward_confirmed', ?)`,
    okJob, newId(), u, `0xfromh2${TAG}`, `0xtoh2${TAG}`, tick(),
  );

  const noPerm = await app.inject({ method: "POST", url: `/staff/relay-jobs/${jobId}/handled`, headers: authOf(u), payload: {} });
  check("an earner cannot mark a job handled (403)", noPerm.statusCode === 403, String(noPerm.statusCode));

  const notFound = await app.inject({ method: "POST", url: `/staff/relay-jobs/${newId()}/handled`, headers: authOf(admin), payload: {} });
  check("unknown job id => 404", notFound.statusCode === 404, String(notFound.statusCode));

  const notFailed = await app.inject({ method: "POST", url: `/staff/relay-jobs/${okJob}/handled`, headers: authOf(admin), payload: {} });
  check("a non-failed job cannot be marked handled (400)", notFailed.statusCode === 400, String(notFailed.statusCode));

  const done = await app.inject({ method: "POST", url: `/staff/relay-jobs/${jobId}/handled`, headers: authOf(agent), payload: { note: "checked chain — money returned" } });
  check("agent (holds withdrawals.decide) can mark handled", done.statusCode === 200, done.body);

  const again = await app.inject({ method: "POST", url: `/staff/relay-jobs/${jobId}/handled`, headers: authOf(admin), payload: {} });
  check("marking handled twice => 400", again.statusCode === 400, String(again.statusCode));

  const row = await sql.get<{ handled_at: string | null; handled_note: string | null }>(
    "SELECT handled_at, handled_note FROM payout_relay_jobs WHERE id = ?", jobId);
  check("handled_at + note persisted", !!row?.handled_at && row?.handled_note === "checked chain — money returned", JSON.stringify(row));

  const listed = await app.inject({ method: "GET", url: "/staff/relay-jobs", headers: authOf(admin) });
  const handledRow = (listed.json() as { rows: { id: string; handledAt: string | null }[] }).rows.find((r) => r.id === jobId);
  check("the failed row still lists, now carrying handledAt", !!handledRow?.handledAt, JSON.stringify(handledRow));

  // BNB side: same shape, own table.
  const bnbId = newId();
  await sql.run(
    `INSERT INTO bnb_withdrawal_requests (id, user_id, chain, address, amount_wei, status, last_error, created_at)
     VALUES (?,?,?,?,?,'failed','no gas',?)`,
    bnbId, u, "bep20", `0xbnbh${TAG}`, "1000000000000000", tick(),
  );
  const bnbDone = await app.inject({ method: "POST", url: `/staff/bnb-withdrawals/${bnbId}/handled`, headers: authOf(admin), payload: {} });
  check("a failed BNB withdrawal can be marked handled", bnbDone.statusCode === 200, bnbDone.body);
}

// ---------------------------------------------------------------------------
console.log("\n-- admin USDT adjustment (reconciliation fix) --");
{
  const u = await mkUser("usdt-adj");
  await sql.run(
    `INSERT INTO usdt_ledger (id, user_id, amount, direction, source_type, chain, created_at)
     VALUES (?,?,?, 'credit', 'topup', 'bep20', ?)`,
    newId(), u, 2_000_000, tick(),
  );

  const earner = await app.inject({ method: "POST", url: `/staff/users/${u}/usdt-adjust`, headers: authOf(u), payload: { usdt: -1, reason: "nope" } });
  check("an earner cannot adjust USDT (403)", earner.statusCode === 403, String(earner.statusCode));

  const agentTry = await app.inject({ method: "POST", url: `/staff/users/${u}/usdt-adjust`, headers: authOf(agent), payload: { usdt: -1, reason: "nope" } });
  check("an agent (no users.adjust) cannot adjust USDT (403)", agentTry.statusCode === 403, String(agentTry.statusCode));

  const zero = await app.inject({ method: "POST", url: `/staff/users/${u}/usdt-adjust`, headers: authOf(admin), payload: { usdt: 0, reason: "zero" } });
  check("zero amount => 400", zero.statusCode === 400, String(zero.statusCode));

  const tooBig = await app.inject({ method: "POST", url: `/staff/users/${u}/usdt-adjust`, headers: authOf(admin), payload: { usdt: 9999, reason: "too big" } });
  check("over the per-call cap => 400", tooBig.statusCode === 400, String(tooBig.statusCode));

  const fix = await app.inject({ method: "POST", url: `/staff/users/${u}/usdt-adjust`, headers: authOf(admin), payload: { usdt: -2, reason: "reconcile 2026-08-12 double-credit residue" } });
  check("admin can post a correcting -2 USDT debit", fix.statusCode === 200, fix.body);
  const fj = fix.json() as { beforeMicro: number; afterMicro: number };
  check("before was +2,000,000 micro, after is 0", fj.beforeMicro === 2_000_000 && fj.afterMicro === 0, JSON.stringify(fj));

  const sum = await sql.get<{ bal: string | number }>("SELECT COALESCE(SUM(amount),0) AS bal FROM usdt_ledger WHERE user_id = ?", u);
  check("usdt_ledger now sums to 0 for this user", Number(sum?.bal ?? -1) === 0, JSON.stringify(sum));

  const goNeg = await app.inject({ method: "POST", url: `/staff/users/${u}/usdt-adjust`, headers: authOf(admin), payload: { usdt: -1, reason: "books were still wrong" } });
  check("a debit MAY take the balance negative (200, not blocked)", goNeg.statusCode === 200, goNeg.body);
  check("resulting balance is -1,000,000 micro", (goNeg.json() as { afterMicro: number }).afterMicro === -1_000_000, goNeg.body);
}

// ---------------------------------------------------------------------------
console.log("\n-- reconciliation history --");
{
  await sql.run(
    `INSERT INTO treasury_balance_snapshots (id, chain, token, onchain_balance, ledger_total, delta, checked_at)
     VALUES (?, 'bep20', 'USDT', 100000000, 120000000, -20000000, ?)`,
    newId(), tick(),
  );
  const r = await app.inject({ method: "GET", url: "/staff/mining/reconciliation?chain=bep20&limit=10", headers: authOf(admin) });
  check("200", r.statusCode === 200, r.body);
  const d = r.json() as { snapshots: { delta: number }[] };
  check("returns the snapshot with a negative delta", d.snapshots.some((s) => s.delta < 0), JSON.stringify(d.snapshots));
}

// ---------------------------------------------------------------------------
console.log("\n-- resolve a FAILED relay job (acknowledge / credit_back / retry) --");
{
  // withdrawal purpose, underlying request still at 'sending', prefund not
  // broadcast => safe => owedBack + retryable.
  const u = await mkUser("relay-resolve");
  const wdId = newId();
  await sql.run(
    `INSERT INTO withdrawal_requests (id, user_id, amount, payout_rail, payout_address, status, created_at)
     VALUES (?,?,?,?,?, 'sending', ?)`,
    wdId, u, 1500, "bep20", `0xdst${TAG}`, tick(),
  );
  const jobId = newId();
  await sql.run(
    `INSERT INTO payout_relay_jobs
       (id, purpose, request_id, chain, user_id, from_address, addr_index, to_address,
        amount_micro, needs_prefund, status, attempts, last_error, created_at)
     VALUES (?, 'withdrawal', ?, 'bep20', ?, ?, 0, ?, 1500000, 1, 'failed', 15, 'insufficient gas', ?)`,
    jobId, wdId, u, `0xfrom${TAG}`, `0xdst${TAG}`, tick(),
  );

  const list = await app.inject({ method: "GET", url: "/staff/relay-jobs?status=failed&limit=100", headers: authOf(admin) });
  const lj = (list.json() as { rows: { id: string; owedBack: boolean; retryable: boolean; reqStatus: string }[] }).rows.find((r) => r.id === jobId)!;
  check("failed relay row carries owedBack=true", lj?.owedBack === true, JSON.stringify(lj));
  check("failed relay row carries retryable=true", lj?.retryable === true, JSON.stringify(lj));
  check("failed relay row reports reqStatus='sending'", lj?.reqStatus === "sending", JSON.stringify(lj));

  const noNote = await app.inject({ method: "POST", url: `/staff/relay-jobs/${jobId}/resolve`, headers: authOf(admin), payload: { action: "acknowledge" } });
  check("resolve without a note => 400", noNote.statusCode === 400, String(noNote.statusCode));

  const notStaff = await app.inject({ method: "POST", url: `/staff/relay-jobs/${jobId}/resolve`, headers: authOf(u), payload: { action: "acknowledge", note: "x" } });
  check("an earner cannot resolve (403)", notStaff.statusCode === 403, String(notStaff.statusCode));

  const cb = await app.inject({ method: "POST", url: `/staff/relay-jobs/${jobId}/resolve`, headers: authOf(admin), payload: { action: "credit_back", note: "gas never funded, returning" } });
  check("credit_back => 200", cb.statusCode === 200, cb.body);
  const wdAfter = await sql.get<{ status: string }>("SELECT status FROM withdrawal_requests WHERE id = ?", wdId);
  check("underlying withdrawal is now 'rejected'", wdAfter?.status === "rejected", JSON.stringify(wdAfter));
  const creditRow = await sql.get<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM ledger_entries WHERE source_ref_id = ? AND direction = 'credit' AND amount = 1500", wdId,
  );
  check("a +1500 compensating credit was posted once", Number(creditRow?.n) === 1, JSON.stringify(creditRow));
  const jobAfter = await sql.get<{ handled_at: string | null }>("SELECT handled_at FROM payout_relay_jobs WHERE id = ?", jobId);
  check("relay job is stamped handled", !!jobAfter?.handled_at, JSON.stringify(jobAfter));

  const cb2 = await app.inject({ method: "POST", url: `/staff/relay-jobs/${jobId}/resolve`, headers: authOf(admin), payload: { action: "credit_back", note: "again" } });
  check("second credit_back => 409 (idempotent, not a double credit)", cb2.statusCode === 409, cb2.body);
  const creditRow2 = await sql.get<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM ledger_entries WHERE source_ref_id = ? AND direction = 'credit'", wdId,
  );
  check("still exactly one compensating credit", Number(creditRow2?.n) === 1, JSON.stringify(creditRow2));
}

{
  // retry path: fresh failed job, still 'sending', safe => retry re-queues it.
  const u = await mkUser("relay-retry");
  const wdId = newId();
  await sql.run(
    `INSERT INTO withdrawal_requests (id, user_id, amount, payout_rail, payout_address, status, created_at)
     VALUES (?,?,?,?,?, 'sending', ?)`,
    wdId, u, 900, "bep20", `0xr${TAG}`, tick(),
  );
  const jobId = newId();
  await sql.run(
    `INSERT INTO payout_relay_jobs
       (id, purpose, request_id, chain, user_id, from_address, addr_index, to_address,
        amount_micro, needs_prefund, status, attempts, last_error, created_at)
     VALUES (?, 'withdrawal', ?, 'bep20', ?, ?, 0, ?, 900000, 1, 'failed', 15, 'rpc down', ?)`,
    jobId, wdId, u, `0xf2${TAG}`, `0xr${TAG}`, tick(),
  );
  const retry = await app.inject({ method: "POST", url: `/staff/relay-jobs/${jobId}/resolve`, headers: authOf(admin), payload: { action: "retry", note: "checked chain, nothing sent" } });
  check("retry => 200", retry.statusCode === 200, retry.body);
  const j = await sql.get<{ status: string; attempts: number; handled_at: string | null }>(
    "SELECT status, attempts, handled_at FROM payout_relay_jobs WHERE id = ?", jobId,
  );
  check("job is back to 'pending', attempts reset, handled cleared", j?.status === "pending" && Number(j?.attempts) === 0 && !j?.handled_at, JSON.stringify(j));

  // Now make it unsafe (prefund broadcast) and fail it again — retry must refuse.
  await sql.run("UPDATE payout_relay_jobs SET status = 'failed', prefund_tx_hash = ? WHERE id = ?", `0xpre${TAG}`, jobId);
  const retry2 = await app.inject({ method: "POST", url: `/staff/relay-jobs/${jobId}/resolve`, headers: authOf(admin), payload: { action: "retry", note: "try again" } });
  check("retry refused once value moved on-chain (409)", retry2.statusCode === 409, retry2.body);
  const cbUnsafe = await app.inject({ method: "POST", url: `/staff/relay-jobs/${jobId}/resolve`, headers: authOf(admin), payload: { action: "credit_back", note: "?" } });
  check("credit_back also refused once value moved (409)", cbUnsafe.statusCode === 409, cbUnsafe.body);
  const ack = await app.inject({ method: "POST", url: `/staff/relay-jobs/${jobId}/resolve`, headers: authOf(admin), payload: { action: "acknowledge", note: "checked chain, prefund landed, reconciling by hand" } });
  check("acknowledge still works on the unsafe job (200)", ack.statusCode === 200, ack.body);
}

// ---------------------------------------------------------------------------
console.log("\n-- resolve a FAILED BNB withdrawal (acknowledge / retry) --");
{
  const u = await mkUser("bnb-resolve");
  const bnbId = newId();
  await sql.run(
    `INSERT INTO bnb_withdrawal_requests (id, user_id, chain, address, amount_wei, status, last_error, created_at)
     VALUES (?,?,?,?,?, 'failed', 'no gas', ?)`,
    bnbId, u, "bep20", `0xb${TAG}`, "500000000000000", tick(),
  );
  const list = await app.inject({ method: "GET", url: "/staff/bnb-withdrawals?status=failed&limit=100", headers: authOf(admin) });
  const row = (list.json() as { rows: { id: string; owedBack: boolean; retryable: boolean }[] }).rows.find((r) => r.id === bnbId)!;
  check("failed BNB row: owedBack=false, retryable=true (no tx hash)", row?.owedBack === false && row?.retryable === true, JSON.stringify(row));

  const cbNo = await app.inject({ method: "POST", url: `/staff/bnb-withdrawals/${bnbId}/resolve`, headers: authOf(admin), payload: { action: "credit_back", note: "x" } });
  check("BNB resolve rejects credit_back as an action (400)", cbNo.statusCode === 400, String(cbNo.statusCode));

  const retry = await app.inject({ method: "POST", url: `/staff/bnb-withdrawals/${bnbId}/resolve`, headers: authOf(admin), payload: { action: "retry", note: "gas funded now" } });
  check("BNB retry => 200", retry.statusCode === 200, retry.body);
  const b = await sql.get<{ status: string; attempts: number }>("SELECT status, attempts FROM bnb_withdrawal_requests WHERE id = ?", bnbId);
  check("BNB job back to 'pending', attempts reset", b?.status === "pending" && Number(b?.attempts) === 0, JSON.stringify(b));

  // broadcast one, fail it — retry must refuse now.
  await sql.run("UPDATE bnb_withdrawal_requests SET status = 'failed', tx_hash = ? WHERE id = ?", `0xtx${TAG}`, bnbId);
  const retry2 = await app.inject({ method: "POST", url: `/staff/bnb-withdrawals/${bnbId}/resolve`, headers: authOf(admin), payload: { action: "retry", note: "again" } });
  check("BNB retry refused once a tx was broadcast (409)", retry2.statusCode === 409, retry2.body);
  const ack = await app.inject({ method: "POST", url: `/staff/bnb-withdrawals/${bnbId}/resolve`, headers: authOf(admin), payload: { action: "acknowledge", note: "tx reverted on chain, nothing owed" } });
  check("BNB acknowledge => 200", ack.statusCode === 200, ack.body);
}

// ---------------------------------------------------------------------------
console.log("\n-- reconciliation re-check on demand --");
{
  const rc = await app.inject({ method: "POST", url: "/staff/mining/reconciliation/recheck", headers: authOf(admin), payload: { chain: "bep20" } });
  check("recheck => 200", rc.statusCode === 200, rc.body);
  const body = rc.json() as { ok: boolean; chain: string; snapshot: { delta: number } | null };
  check("recheck returns ok + a fresh snapshot", body.ok === true && body.chain === "bep20" && body.snapshot !== null, JSON.stringify(body).slice(0, 200));
  const asEarner = await app.inject({ method: "POST", url: "/staff/mining/reconciliation/recheck", headers: authOf(agent), payload: {} });
  check("an agent without analytics.view cannot recheck (403)", asEarner.statusCode === 403, String(asEarner.statusCode));
}

// ---------------------------------------------------------------------------
console.log("\n-- money overview (held now + inflow/outflow windows) --");
{
  // A confirmed deposit credit (money IN) and a paid withdrawal (money OUT),
  // both dated NOW so they land in every window including h1.
  const u = await mkUser("overview");
  await sql.run(
    `INSERT INTO usdt_ledger (id, user_id, amount, direction, source_type, chain, created_at)
     VALUES (?,?,?, 'credit', 'topup', 'bep20', ?)`,
    newId(), u, 5_000_000, now(),
  );
  await sql.run(
    `INSERT INTO withdrawal_requests (id, user_id, amount, payout_rail, payout_address, status, fee_points, created_at, paid_at)
     VALUES (?,?,?,?,?, 'paid', 0, ?, ?)`,
    newId(), u, 1000, "bep20", `0xovw${TAG}`, now(), now(),
  );

  const res = await app.inject({ method: "GET", url: "/staff/money/overview", headers: authOf(admin) });
  check("200", res.statusCode === 200, res.body);
  const o = res.json() as {
    heldNow: { treasuryTotalMicro: number; outstandingPoints: number; usdtDepositLiabilityMicro: number };
    windows: string[];
    flows: Record<string, { depositsInMicro: number; outMicro: number; netMicro: number; withdrawalsOutMicro: number }>;
    latest: { withdrawals: unknown[]; deposits: unknown[]; refunds: unknown[]; bnb: unknown[]; relayFailed: unknown[] };
    owed: { paidPoints: number; pendingPoints: number };
  };
  check("all six windows present", ["h1", "h24", "d7", "d30", "d365", "all"].every((k) => o.windows.includes(k) && o.flows[k]), JSON.stringify(o.windows));
  check("h1 deposits-in includes the 5 USDT just credited", o.flows.h1.depositsInMicro >= 5_000_000, String(o.flows.h1.depositsInMicro));
  check("h1 withdrawals-out includes the 1000-pt payout (=1 USDT)", o.flows.h1.withdrawalsOutMicro >= 1_000_000, String(o.flows.h1.withdrawalsOutMicro));
  check("net = in - out for h1", o.flows.h1.netMicro === o.flows.h1.depositsInMicro - o.flows.h1.outMicro, JSON.stringify(o.flows.h1));
  const ledgerSum = Number((await sql.get<{ v: string | number }>("SELECT COALESCE(SUM(amount),0) AS v FROM usdt_ledger"))?.v ?? -1);
  check("held-now USDT deposit liability == SUM(usdt_ledger)", o.heldNow.usdtDepositLiabilityMicro === ledgerSum, `${o.heldNow.usdtDepositLiabilityMicro} vs ${ledgerSum}`);
  check("latest lists are arrays", Array.isArray(o.latest.withdrawals) && Array.isArray(o.latest.relayFailed), JSON.stringify(Object.keys(o.latest)));
  check("owed.paidPoints > 0 after a paid withdrawal exists", o.owed.paidPoints >= 1000, String(o.owed.paidPoints));

  const asEarner = await app.inject({ method: "GET", url: "/staff/money/overview", headers: authOf(u) });
  check("an earner cannot read the money overview (403)", asEarner.statusCode === 403, String(asEarner.statusCode));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
