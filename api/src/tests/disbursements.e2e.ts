// E2E for admin-driven reward disbursement (founder, 2026-09-02).
//
// Until this feature the ONLY way money left the platform was a user-filed
// withdrawal request. This suite covers the new admin layer:
//
//   • the eligible pool = approved custom-task proofs awaiting release
//   • create a batch, run it in 'balance' mode -> the reward lands on the
//     user's in-app balance via the SAME releaseProof() the manual flow uses
//   • idempotency: re-running a completed batch is a no-op, and a proof already
//     in a live batch cannot be added to a second
//   • per-recipient isolation: one blocked recipient (exhausted campaign
//     budget) is recorded 'failed' and the rest still pay
//   • permission gating: only admin / finance
//   • audit rows for create + run
//
//   npm run test:disbursements
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId } from "../db.ts";
import { config } from "../config.ts";
import { appRoutes } from "../routes/app.ts";
import { staffTaskRoutes } from "../routes/staffTasks.ts";
import { staffDisbursementRoutes } from "../routes/staffDisbursements.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(appRoutes);
await app.register(staffTaskRoutes);
await app.register(staffDisbursementRoutes);

const TAG = newId().slice(0, 8);
const authOf = (id: string) => ({ authorization: `Bearer ${jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: "1h" })}` });

let seq = 0;
async function mkUser(label: string) {
  const id = newId();
  await sql.run(
    `INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at, kyc_status)
     VALUES (?,?,1,?,?,'active',?, 'approved')`,
    id, `${TAG}-${label}@t.test`, "Pakistan",
    `${TAG}${(seq++).toString(36)}`.toUpperCase().slice(0, 12), new Date(Date.now() - 30 * 86_400_000).toISOString(),
  );
  return id;
}
async function mkStaff(label: string, role: string) {
  const id = await mkUser(label);
  await sql.run("INSERT INTO admin_users (user_id, role, created_at) VALUES (?,?,?)", id, role, now());
  return id;
}

const admin = await mkStaff("admin", "admin");
const agent = await mkStaff("agent", "agent");

type Json = Record<string, unknown>;
const post = (url: string, who: string, payload: Json = {}) =>
  app.inject({ method: "POST", url, headers: authOf(who), payload });
const get = (url: string, who: string) => app.inject({ method: "GET", url, headers: authOf(who) });

async function mkTask(title: string, extra: Json = {}): Promise<string> {
  const r = await post("/staff/tasks", admin, {
    title: `${TAG} ${title}`, verifyMode: "proof", proofRequired: false,
    rewardType: "usdt", rewardUsdtMicro: 1_000_000, countries: ["ALL"], status: "active",
    minutes: 1, ...extra,
  });
  const b = r.json() as { ok: boolean; id?: string; error?: string };
  if (!b.id) throw new Error(`task create failed: ${JSON.stringify(b)}`);
  return b.id;
}

// Submit a proof as `user` and approve it (but do NOT release) -> eligible.
async function approvedProof(taskId: string, user: string): Promise<string> {
  await post(`/tasks/${taskId}/proof`, user, {});
  const q = await get(`/staff/task-proofs?taskId=${taskId}&status=pending&limit=50`, agent);
  const proofs = (q.json() as { proofs: { id: string }[] }).proofs;
  const proofId = proofs[proofs.length - 1].id;
  await post(`/staff/task-proofs/${proofId}/decision`, agent, { action: "approve" });
  return proofId;
}

// earned_usdt_ledger.amount is already signed (a debit is a negative row), so
// the balance is a plain SUM.
const earnedUsdt = async (userId: string) => {
  const r = await sql.get<{ n: string | number }>(
    "SELECT COALESCE(SUM(amount), 0) AS n FROM earned_usdt_ledger WHERE user_id = ?", userId,
  );
  return Number(r?.n ?? 0);
};

// ---------------------------------------------------------------------------
console.log("\n-- the eligible pool --");
const taskA = await mkTask("Alpha");
const u1 = await mkUser("u1");
const u2 = await mkUser("u2");
const p1 = await approvedProof(taskA, u1);
const p2 = await approvedProof(taskA, u2);

{
  const r = await get("/staff/disbursements/eligible", admin);
  const body = r.json() as { items: { proofId: string; usdtMicro: number }[]; total: number };
  check("eligible lists both approved-unreleased proofs", body.total === 2 && body.items.length === 2);
  check("eligible carries the USDT reward amount", body.items.every((i) => i.usdtMicro === 1_000_000));
  check("a still-pending (unapproved) proof is NOT eligible",
    !(await (async () => {
      const u3 = await mkUser("u3");
      await post(`/tasks/${taskA}/proof`, u3, {});
      const e = await get("/staff/disbursements/eligible", admin);
      return (e.json() as { items: { userId: string }[] }).items.some((i) => i.userId === u3);
    })()));
}

console.log("\n-- permission gating --");
{
  const r = await get("/staff/disbursements/eligible", agent);
  check("an agent (not finance/admin) gets 403 on the pool", r.statusCode === 403);
  const c = await post("/staff/disbursements", agent, { mode: "balance", proofIds: [p1] });
  check("an agent gets 403 creating a batch", c.statusCode === 403);
}

console.log("\n-- create + run a balance batch --");
let batchId = "";
{
  const c = await post("/staff/disbursements", admin, { mode: "balance", proofIds: [p1, p2], note: "payday" });
  const cb = c.json() as { batchId: string; added: number; skipped: unknown[] };
  batchId = cb.batchId;
  check("batch created with both recipients", cb.added === 2 && cb.skipped.length === 0);

  const before1 = await earnedUsdt(u1);
  const run = await post(`/staff/disbursements/${batchId}/run`, admin);
  const rb = run.json() as { processed: number; released: number; failed: number };
  check("run releases both", rb.processed === 2 && rb.released === 2 && rb.failed === 0);
  check("u1 earned-USDT went up by the reward", (await earnedUsdt(u1)) - before1 === 1_000_000);
  check("u2 earned-USDT went up by the reward", (await earnedUsdt(u2)) === 1_000_000);

  const proofRow = await sql.get<{ reward_status: string }>("SELECT reward_status FROM task_proofs WHERE id = ?", p1);
  check("the proof is marked released (reward_status = sent)", proofRow?.reward_status === "sent");

  const det = await get(`/staff/disbursements/${batchId}`, admin);
  const db = det.json() as { batch: { status: string; tally: Record<string, number> }; rows: { status: string }[] };
  check("batch status is completed", db.batch.status === "completed");
  check("both disbursement rows are 'released'", db.rows.every((r) => r.status === "released"));
}

console.log("\n-- idempotency --");
{
  const before = await earnedUsdt(u1);
  const run2 = await post(`/staff/disbursements/${batchId}/run`, admin);
  check("re-running a completed batch is refused (409)", run2.statusCode === 409);
  check("no double credit on re-run", (await earnedUsdt(u1)) === before);

  const dupe = await post("/staff/disbursements", admin, { mode: "balance", proofIds: [p1] });
  const dbody = dupe.json() as { added: number; skipped: { reason: string }[] };
  check("a proof already released cannot join a new batch",
    dbody.added === 0 && dbody.skipped[0]?.reason.includes("release"));
}

console.log("\n-- a proof in a live batch is spoken for --");
{
  const taskB = await mkTask("Bravo");
  const ub = await mkUser("ub");
  const pb = await approvedProof(taskB, ub);
  const first = await post("/staff/disbursements", admin, { mode: "balance", proofIds: [pb] });
  check("first batch takes it", (first.json() as { added: number }).added === 1);
  const second = await post("/staff/disbursements", admin, { mode: "balance", proofIds: [pb] });
  const sbody = second.json() as { added: number; skipped: { reason: string }[] };
  check("a second batch cannot take the same proof",
    sbody.added === 0 && sbody.skipped[0]?.reason.includes("batch"));
  // ...and the eligible pool hides it now.
  const pool = await get("/staff/disbursements/eligible", admin);
  check("the eligible pool hides a proof already in a batch",
    !(pool.json() as { items: { proofId: string }[] }).items.some((i) => i.proofId === pb));
}

console.log("\n-- per-recipient isolation: one blocked, the rest still pay --");
{
  // A task whose campaign budget is one micro-USDT — the first release
  // exhausts it, so THAT recipient fails while the other still pays.
  const broke = await mkTask("Broke", { budgetUsdtMicro: 1 });
  const good = await mkTask("Good");
  const ux = await mkUser("ux");
  const uy = await mkUser("uy");
  const px = await approvedProof(broke, ux);
  const py = await approvedProof(good, uy);

  const c = await post("/staff/disbursements", admin, { mode: "balance", proofIds: [px, py] });
  const bid = (c.json() as { batchId: string }).batchId;
  const run = await post(`/staff/disbursements/${bid}/run`, admin);
  const rb = run.json() as { released: number; failed: number; results: { userId: string; status: string }[] };
  check("one row released, one row failed", rb.released === 1 && rb.failed === 1);
  check("the good recipient was paid", (await earnedUsdt(uy)) === 1_000_000);
  check("the blocked recipient was NOT paid", (await earnedUsdt(ux)) === 0);
  const det = await get(`/staff/disbursements/${bid}`, admin);
  check("batch rolled up to partly_failed",
    (det.json() as { batch: { status: string } }).batch.status === "partly_failed");

  // Re-running a partly_failed batch retries ONLY the failed row and never
  // re-touches the one that already released.
  const beforeY = await earnedUsdt(uy);
  const retry = await post(`/staff/disbursements/${bid}/run`, admin);
  const rr = retry.json() as { processed: number; results: { userId: string }[] };
  check("re-run of a partly_failed batch retries only the failed row",
    rr.processed === 1 && rr.results[0]?.userId === ux);
  check("the already-released recipient is untouched on retry", (await earnedUsdt(uy)) === beforeY);
}

console.log("\n-- orphan recovery: a row stuck 'sending' with no payout is retried --");
{
  const t = await mkTask("Orphan");
  const uo = await mkUser("uo");
  const po = await approvedProof(t, uo);
  const c = await post("/staff/disbursements", admin, { mode: "balance", proofIds: [po] });
  const bid = (c.json() as { batchId: string }).batchId;
  // Simulate a crashed run: force the row to 'sending' with no withdrawal_request.
  await sql.run("UPDATE payout_disbursements SET status = 'sending' WHERE batch_id = ?", bid);
  const run = await post(`/staff/disbursements/${bid}/run`, admin);
  check("the orphaned row is recovered and released",
    (run.json() as { released: number }).released === 1 && (await earnedUsdt(uo)) === 1_000_000);
}

console.log("\n-- quick send (one recipient) --");
{
  const t = await mkTask("Quick");
  const uq = await mkUser("uq");
  const pq = await approvedProof(t, uq);
  const r = await post("/staff/disbursements/quick", admin, { proofId: pq });
  const rb = r.json() as { released: number; batchId: string };
  check("quick send releases immediately", rb.released === 1 && (await earnedUsdt(uq)) === 1_000_000);
}

console.log("\n-- cancel a batch --");
{
  const t = await mkTask("Cancelme");
  const uc = await mkUser("uc");
  const pc = await approvedProof(t, uc);
  const c = await post("/staff/disbursements", admin, { mode: "balance", proofIds: [pc] });
  const bid = (c.json() as { batchId: string }).batchId;
  const cancel = await post(`/staff/disbursements/${bid}/cancel`, admin);
  check("a draft batch cancels", (cancel.json() as { ok: boolean }).ok === true);
  const pool = await get("/staff/disbursements/eligible", admin);
  check("cancelling frees the proof back to the pool",
    (pool.json() as { items: { proofId: string }[] }).items.some((i) => i.proofId === pc));
  // Now run it -> the completed one above cannot be cancelled.
  const done = await post(`/staff/disbursements/${batchId}/cancel`, admin);
  check("a batch that already paid cannot be cancelled", done.statusCode === 409);
}

console.log("\n-- on-chain / manual mode: release + a payout request --");
const ADDR = "0x1111111111111111111111111111111111111111";
async function saveAddr(userId: string) {
  await sql.run(
    "INSERT INTO payout_addresses (user_id, chain, address, updated_at) VALUES (?, 'bep20', ?, ?) ON CONFLICT (user_id, chain) DO UPDATE SET address = EXCLUDED.address",
    userId, ADDR, now(),
  );
}
const reqFor = (userId: string) =>
  sql.get<{ id: string; status: string; source_kind: string; earned_usdt_micro: string | number; payout_address: string }>(
    "SELECT id, status, source_kind, earned_usdt_micro, payout_address FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
    userId,
  );
{
  const t = await mkTask("Onchain");
  const uWith = await mkUser("uWith");
  const uNo = await mkUser("uNo");
  await saveAddr(uWith);
  const pWith = await approvedProof(t, uWith);
  const pNo = await approvedProof(t, uNo);

  const c = await post("/staff/disbursements", admin, { mode: "manual", proofIds: [pWith, pNo] });
  const cb = c.json() as { batchId: string; added: number };
  const bid = cb.batchId;
  // The row for the user with no address is pre-marked needs_address at create.
  const d0 = await get(`/staff/disbursements/${bid}`, admin);
  const rows0 = (d0.json() as { rows: { userId: string; status: string }[] }).rows;
  check("a recipient with no saved address is flagged needs_address up front",
    rows0.find((r) => r.userId === uNo)?.status === "needs_address");

  const run = await post(`/staff/disbursements/${bid}/run`, admin);
  const rb = run.json() as { results: { userId: string; status: string }[] };
  check("the addressed recipient goes to 'sending'",
    rb.results.find((r) => r.userId === uWith)?.status === "sending");
  check("the unaddressed recipient stays needs_address",
    rb.results.find((r) => r.userId === uNo)?.status === "needs_address");

  const w = await reqFor(uWith);
  check("a withdrawal_request was created for the addressed recipient",
    !!w && w.source_kind === "earned_usdt" && Number(w.earned_usdt_micro) === 1_000_000 && w.payout_address === ADDR);
  check("its status sits in the manual queue (pending)", w?.status === "pending");
  check("the addressed recipient's task-USDT is held (net 0: released then held)",
    (await earnedUsdt(uWith)) === 0);
  check("the unaddressed recipient KEEPS the released reward on balance (decision B)",
    (await earnedUsdt(uNo)) === 1_000_000);
  check("no withdrawal_request for the unaddressed recipient", !(await reqFor(uNo)));

  // Add an address and re-run -> the needs_address row is picked up.
  await saveAddr(uNo);
  const run2 = await post(`/staff/disbursements/${bid}/run`, admin);
  check("re-run picks up the now-addressed recipient",
    (run2.json() as { results: { userId: string; status: string }[] })
      .results.find((r) => r.userId === uNo)?.status === "sending");
  check("its task-USDT is now held too", (await earnedUsdt(uNo)) === 0);

  // Sync: the withdrawal queue marks one paid, one rejected.
  const wWith = await reqFor(uWith);
  const wNo = await reqFor(uNo);
  await sql.run("UPDATE withdrawal_requests SET status = 'paid', tx_hash = ?, paid_at = ? WHERE id = ?", "0xabc", now(), wWith!.id);
  await sql.run("UPDATE withdrawal_requests SET status = 'rejected' WHERE id = ?", wNo!.id);
  const d1 = await get(`/staff/disbursements/${bid}`, admin);
  const db1 = d1.json() as { batch: { status: string }; rows: { userId: string; status: string; txHash: string | null }[] };
  check("a paid withdrawal flips its disbursement to 'paid' with the tx hash",
    db1.rows.find((r) => r.userId === uWith)?.status === "paid" &&
    db1.rows.find((r) => r.userId === uWith)?.txHash === "0xabc");
  check("a rejected withdrawal flips its disbursement to 'failed'",
    db1.rows.find((r) => r.userId === uNo)?.status === "failed");
  check("the batch rolls up to partly_failed (one paid, one failed)",
    db1.batch.status === "partly_failed");
}

console.log("\n-- mark a manual disbursement paid by hand --");
const HASH = "0x" + "a".repeat(64);
{
  const t = await mkTask("Manualpay");
  const um = await mkUser("um");
  await saveAddr(um);
  const pm = await approvedProof(t, um);
  const c = await post("/staff/disbursements", admin, { mode: "manual", proofIds: [pm] });
  const bid = (c.json() as { batchId: string }).batchId;
  await post(`/staff/disbursements/${bid}/run`, admin);
  const rows = (await get(`/staff/disbursements/${bid}`, admin).then((r) => r.json())) as { rows: { id: string; status: string }[] };
  const rid = rows.rows[0].id;

  const bad = await post(`/staff/disbursements/${bid}/rows/${rid}/mark-paid`, admin, { txHash: "nope" });
  check("a bad tx hash is rejected", bad.statusCode === 409 && String((bad.json() as { error: string }).error).includes("transaction hash"));

  const ok = await post(`/staff/disbursements/${bid}/rows/${rid}/mark-paid`, admin, { txHash: HASH });
  check("mark-paid succeeds with a real-looking hash", (ok.json() as { ok: boolean }).ok === true);

  const det = await get(`/staff/disbursements/${bid}`, admin);
  const db = det.json() as { batch: { status: string }; rows: { status: string; txHash: string | null }[] };
  check("the disbursement row is 'paid' with the hash", db.rows[0].status === "paid" && db.rows[0].txHash === HASH);
  check("the batch is completed", db.batch.status === "completed");
  const w = await sql.get<{ status: string; tx_hash: string }>(
    "SELECT status, tx_hash FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", um);
  check("the underlying withdrawal_request is 'paid' with the hash", w?.status === "paid" && w?.tx_hash === HASH);

  const again = await post(`/staff/disbursements/${bid}/rows/${rid}/mark-paid`, admin, { txHash: HASH });
  check("marking an already-paid row again is refused", again.statusCode === 409);
}

console.log("\n-- CSV export + reconcile round-trip --");
{
  const t = await mkTask("CsvRound");
  const users = await Promise.all(["c1", "c2", "c3"].map((l) => mkUser(l)));
  for (const u of users) await saveAddr(u);
  const proofs = await Promise.all(users.map((u) => approvedProof(t, u)));
  const c = await post("/staff/disbursements", admin, { mode: "csv", proofIds: proofs });
  const bid = (c.json() as { batchId: string }).batchId;
  await post(`/staff/disbursements/${bid}/run`, admin);

  const exp = await get(`/staff/disbursements/${bid}/export`, admin);
  check("export is text/csv", String(exp.headers["content-type"]).includes("text/csv"));
  const lines = exp.body.trim().split("\n");
  check("export has a header + one row per recipient", lines.length === 4);
  check("export header names the id, address and amount columns",
    lines[0].includes("disbursement_id") && lines[0].includes("address") && lines[0].includes("usdt_amount"));
  const rowIds = ((await get(`/staff/disbursements/${bid}`, admin).then((r) => r.json())) as { rows: { id: string; status: string }[] }).rows;

  // Reconcile: one good, one unknown id, one bad hash, and a duplicate of the good one.
  const goodId = rowIds[0].id;
  const badHashId = rowIds[1].id;
  const rec = await post(`/staff/disbursements/${bid}/reconcile`, admin, {
    rows: [
      { disbursementId: goodId, txHash: HASH },
      { disbursementId: goodId, txHash: HASH },            // duplicate -> ignored
      { disbursementId: "ghost-id", txHash: HASH },        // unknown
      { disbursementId: badHashId, txHash: "not-a-hash" }, // bad hash
    ],
  });
  const rb = rec.json() as { paid: string[]; unknown: string[]; notPayable: unknown[]; badHash: string[] };
  check("reconcile pays the good row once", rb.paid.length === 1 && rb.paid[0] === goodId);
  check("reconcile reports the unknown id", rb.unknown.length === 1 && rb.unknown[0] === "ghost-id");
  check("reconcile reports the bad hash", rb.badHash.length === 1 && rb.badHash[0] === badHashId);

  const det = ((await get(`/staff/disbursements/${bid}`, admin).then((r) => r.json())) as { rows: { id: string; status: string; txHash: string | null }[] }).rows;
  check("the reconciled row is paid with the hash",
    det.find((r) => r.id === goodId)?.status === "paid" && det.find((r) => r.id === goodId)?.txHash === HASH);
  check("the bad-hash row is untouched (still sending)",
    det.find((r) => r.id === badHashId)?.status === "sending");

  // A second reconcile of the same good id -> now 'notPayable' (already paid).
  const rec2 = await post(`/staff/disbursements/${bid}/reconcile`, admin, {
    rows: [{ disbursementId: goodId, txHash: HASH }],
  });
  check("re-reconciling a paid row reports it not payable",
    (rec2.json() as { notPayable: { id: string }[] }).notPayable[0]?.id === goodId);

  check("reconcile is audited",
    (await sql.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM admin_audit_log WHERE action = 'disbursement_reconcile'"))!.n >= 1);
}

console.log("\n-- payoutRelay.failJob returns the right currency (regression) --");
{
  // A relay job that gives up on an EARNED_USDT withdrawal must credit task
  // USDT back, not points. Insert the job row directly (attempts already over
  // the cap) so tickPayoutRelay hits the give-up branch without touching a
  // real RPC or the custody key — the branch under test runs before either.
  const u = await mkUser("relayCur");
  const reqId = newId();
  await sql.run(
    `INSERT INTO withdrawal_requests (id,user_id,amount,payout_rail,payout_address,fee_points,address_verified,source_kind,earned_usdt_micro,status,created_at)
     VALUES (?,?,?, 'bep20', ?, 0, 0, 'earned_usdt', ?, 'sending', ?)`,
    reqId, u, 2000, ADDR, 2_000_000, now(),
  );
  await sql.run(
    `INSERT INTO payout_relay_jobs (id,purpose,request_id,chain,user_id,from_address,addr_index,to_address,amount_micro,needs_prefund,status,attempts,last_error,created_at)
     VALUES (?, 'withdrawal', ?, 'bep20', ?, ?, 0, ?, ?, 1, 'pending', 99, 'gave up', ?)`,
    newId(), reqId, u, ADDR, ADDR, 2_000_000, now(),
  );
  const { tickPayoutRelay } = await import("../payoutRelay.ts");
  await tickPayoutRelay();
  const pointsBal = await sql.get<{ n: string | number }>(
    "SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END),0) AS n FROM ledger_entries WHERE user_id = ?", u);
  check("no points were credited for an earned_usdt relay failure", Number(pointsBal?.n ?? 0) === 0);
  check("the task USDT was returned instead", (await earnedUsdt(u)) === 2_000_000);
  check("the withdrawal is marked rejected",
    (await sql.get<{ status: string }>("SELECT status FROM withdrawal_requests WHERE id = ?", reqId))?.status === "rejected");
}

console.log("\n-- audit trail --");
{
  const rows = await sql.all<{ action: string }>(
    "SELECT action FROM admin_audit_log WHERE action LIKE 'disbursement%' ORDER BY created_at",
  );
  const kinds = new Set(rows.map((r) => r.action));
  check("create is audited", kinds.has("disbursement_batch_create"));
  check("run is audited", kinds.has("disbursement_batch_run"));
  check("quick send is audited", kinds.has("disbursement_quick_send"));
  check("cancel is audited", kinds.has("disbursement_batch_cancel"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
