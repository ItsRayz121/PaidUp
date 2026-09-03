// E2E for the Users panel's bulk actions + CSV export (founder, 2026-08-27) and
// the "under review" account state built alongside it.
//
//   npm run test:usersadmin
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId } from "../db.ts";
import { config } from "../config.ts";
import { staffRoutes } from "../routes/staff.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(staffRoutes);

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

// ---------------------------------------------------------------------------
console.log("\n-- single-row status route still works after the setUserStatusOne refactor --");
{
  const admin = await mkStaff("admin1", "admin");
  const target = await mkUser("single-target");

  const r = await app.inject({
    method: "POST", url: `/staff/users/${target}/status`, headers: authOf(admin),
    payload: { status: "suspended", reason: "manual test" },
  });
  check("200 on suspend", r.statusCode === 200, r.body);
  const row = await sql.get<{ status: string }>("SELECT status FROM users WHERE id = ?", target);
  check("status actually changed", row?.status === "suspended");

  const noReason = await app.inject({
    method: "POST", url: `/staff/users/${target}/status`, headers: authOf(admin),
    payload: { status: "active", reason: "" },
  });
  check("empty reason refused (400)", noReason.statusCode === 400);
}

// ---------------------------------------------------------------------------
console.log("\n-- bulk status: N separate decisions, not one --");
{
  const admin = await mkStaff("admin2", "admin");
  const a = await mkUser("bulk-a");
  const b = await mkUser("bulk-b");
  const alreadySuspended = await mkUser("bulk-already");
  await sql.run("UPDATE users SET status = 'suspended' WHERE id = ?", alreadySuspended);

  const r = await app.inject({
    method: "POST", url: "/staff/users/bulk-status", headers: authOf(admin),
    payload: { ids: [a, b, admin, "nope-does-not-exist"], status: "suspended", reason: "farm sweep" },
  });
  check("200 on a mixed batch", r.statusCode === 200, r.body);
  const d = r.json() as { done: number; failed: number; results: { id: string; ok: boolean; error?: string }[] };
  check("two real accounts suspended", d.done === 2, JSON.stringify(d));
  check("two rows failed (self + not-found)", d.failed === 2, JSON.stringify(d));

  const selfRow = d.results.find((x) => x.id === admin);
  check("the actor's OWN id in the batch fails, not the whole batch",
    selfRow?.ok === false && selfRow.error === "You cannot suspend your own account.", JSON.stringify(selfRow));
  const missingRow = d.results.find((x) => x.id === "nope-does-not-exist");
  check("a not-found id fails on its own row", missingRow?.ok === false && missingRow.error === "User not found.");

  check("a valid a is actually suspended",
    (await sql.get<{ status: string }>("SELECT status FROM users WHERE id = ?", a))?.status === "suspended");
  check("a valid b is actually suspended",
    (await sql.get<{ status: string }>("SELECT status FROM users WHERE id = ?", b))?.status === "suspended");
  check("the admin itself was NOT suspended by its own bad row",
    (await sql.get<{ status: string }>("SELECT status FROM users WHERE id = ?", admin))?.status === "active");

  // Duplicate ids collapse to one decision, not two audit rows.
  const dupe = await app.inject({
    method: "POST", url: "/staff/users/bulk-status", headers: authOf(admin),
    payload: { ids: [a, a], status: "active", reason: "restore" },
  });
  const dupeBody = dupe.json() as { done: number; failed: number };
  check("duplicate ids in one batch are processed once", dupeBody.done === 1 && dupeBody.failed === 0, JSON.stringify(dupeBody));

  // Permission: an agent lacks users.status (admin-tier).
  const agent = await mkStaff("agent1", "agent");
  const refused = await app.inject({
    method: "POST", url: "/staff/users/bulk-status", headers: authOf(agent),
    payload: { ids: [b], status: "active", reason: "should not be allowed" },
  });
  check("an agent (no users.status) is refused (403)", refused.statusCode === 403, String(refused.statusCode));

  // Validation.
  const badBody = await app.inject({
    method: "POST", url: "/staff/users/bulk-status", headers: authOf(admin),
    payload: { ids: [], status: "active", reason: "empty selection" },
  });
  check("empty id list refused (400)", badBody.statusCode === 400);
}

// ---------------------------------------------------------------------------
console.log("\n-- CSV export gains a 'users' export type --");
{
  const admin = await mkStaff("admin3", "admin");
  await mkUser("export-target");

  const r = await app.inject({ method: "GET", url: "/staff/export/users", headers: authOf(admin) });
  check("200 for a known export type", r.statusCode === 200, r.body.slice(0, 200));
  check("content-type is CSV", (r.headers["content-type"] as string ?? "").includes("text/csv"));
  check("has a header row with email", r.body.split("\n")[0].includes("email"));

  const unknown = await app.inject({ method: "GET", url: "/staff/export/bogus", headers: authOf(admin) });
  check("an unknown export type is 404, not a crash", unknown.statusCode === 404);

  // export.data is admin-tier; an agent must be refused.
  const agent = await mkStaff("agent2", "agent");
  const refused = await app.inject({ method: "GET", url: "/staff/export/users", headers: authOf(agent) });
  check("an agent cannot export (403)", refused.statusCode === 403);
}

// ---------------------------------------------------------------------------
console.log("\n-- the 'under review' state is distinct from active/suspended --");
{
  const admin = await mkStaff("admin4", "admin");
  const target = await mkUser("review-target");

  const mark = await app.inject({
    method: "POST", url: `/staff/users/${target}/review`, headers: authOf(admin),
    payload: { reason: "checking a device-share cluster" },
  });
  check("200 on marking for review", mark.statusCode === 200, mark.body);
  const markBody = mark.json() as { underReview: boolean };
  check("response says underReview: true", markBody.underReview === true);

  // ⚠️ THE WHOLE POINT: it must NOT touch `status`, and requireActiveUser must
  // still pass — a real third status value would silently lock the account
  // out, which is exactly what "distinct from active/suspended" forbids.
  const row = await sql.get<{ status: string; under_review_reason: string | null }>(
    "SELECT status, under_review_reason FROM users WHERE id = ?", target,
  );
  check("status is untouched (still active)", row?.status === "active", String(row?.status));
  check("the reason is stored", row?.under_review_reason === "checking a device-share cluster");

  // It shows up on the list endpoint.
  const list = await app.inject({ method: "GET", url: `/staff/users?q=${target}`, headers: authOf(admin) });
  const listBody = list.json() as { users: { id: string; underReview: boolean }[] };
  check("the list endpoint reports underReview: true", listBody.users.find((u) => u.id === target)?.underReview === true);

  // And on the detail endpoint, as a decided boolean plus the raw reason.
  const detail = await app.inject({ method: "GET", url: `/staff/users/${target}`, headers: authOf(admin) });
  const detailBody = detail.json() as { user: { underReview: boolean; under_review_reason: string | null } };
  check("the detail endpoint reports underReview: true", detailBody.user.underReview === true);
  check("the detail endpoint carries the raw reason too",
    detailBody.user.under_review_reason === "checking a device-share cluster");

  // Clearing it: reason: null.
  const clear = await app.inject({
    method: "POST", url: `/staff/users/${target}/review`, headers: authOf(admin),
    payload: { reason: null },
  });
  check("200 on clearing", clear.statusCode === 200);
  const clearBody = clear.json() as { underReview: boolean };
  check("response says underReview: false", clearBody.underReview === false);
  const clearedRow = await sql.get<{ under_review_reason: string | null }>(
    "SELECT under_review_reason FROM users WHERE id = ?", target,
  );
  check("the reason is actually cleared", clearedRow?.under_review_reason === null);

  // Validation: a reason under 3 chars is refused when SETTING (mirrors the hold route).
  const tooShort = await app.inject({
    method: "POST", url: `/staff/users/${target}/review`, headers: authOf(admin),
    payload: { reason: "no" },
  });
  check("a too-short reason is refused (400)", tooShort.statusCode === 400);

  // Permission: users.review is manager-tier, so an agent must be refused.
  const agent = await mkStaff("agent3", "agent");
  const refused = await app.inject({
    method: "POST", url: `/staff/users/${target}/review`, headers: authOf(agent),
    payload: { reason: "should not be allowed" },
  });
  check("an agent (no users.review) is refused (403)", refused.statusCode === 403, String(refused.statusCode));

  // A manager (not just admin) CAN use it — it's tagged manager-tier on purpose.
  const manager = await mkStaff("manager1", "manager");
  const managerOk = await app.inject({
    method: "POST", url: `/staff/users/${target}/review`, headers: authOf(manager),
    payload: { reason: "manager can do this too" },
  });
  check("a manager can mark for review (200)", managerOk.statusCode === 200, managerOk.body);
}

// ---------------------------------------------------------------------------
console.log("\n-- user list: server-side filters + sort (admin rebuild, Phase B) --");
{
  const admin = await mkStaff("list-admin", "admin");
  const active1 = await mkUser("list-active-1");
  const active2 = await mkUser("list-active-2");
  const banned = await mkUser("list-banned");
  await sql.run("UPDATE users SET status = 'suspended' WHERE id = ?", banned);
  await sql.run("UPDATE users SET kyc_status = 'approved' WHERE id = ?", active1);

  const suspOnly = await app.inject({ method: "GET", url: "/staff/users?status=suspended&limit=200", headers: authOf(admin) });
  const suspIds = suspOnly.json().users.map((u: { id: string }) => u.id);
  check("status=suspended returns only suspended", suspIds.includes(banned) && !suspIds.includes(active1), suspOnly.body);

  const kycOnly = await app.inject({ method: "GET", url: "/staff/users?kyc=approved&limit=200", headers: authOf(admin) });
  const kycIds = kycOnly.json().users.map((u: { id: string }) => u.id);
  check("kyc=approved filters to approved users", kycIds.includes(active1) && !kycIds.includes(active2));

  const asc = await app.inject({ method: "GET", url: "/staff/users?sort=created_at&dir=asc&limit=200", headers: authOf(admin) });
  const times = asc.json().users.map((u: { created_at: string }) => u.created_at);
  check("sort=created_at&dir=asc is actually ascending",
    times.every((t: string, i: number) => i === 0 || times[i - 1] <= t), asc.body);

  const total = suspOnly.json().total;
  check("total matches the filter, not the whole table", total === suspIds.length);

  const badSort = await app.inject({ method: "GET", url: "/staff/users?sort=email);DROP&dir=asc", headers: authOf(admin) });
  check("an unknown sort key is ignored, not injected", badSort.statusCode === 200);
}

// ---------------------------------------------------------------------------
console.log("\n-- user 360: the tabbed detail endpoint (admin rebuild, Phase B) --");
{
  const admin = await mkStaff("u360-admin", "admin");
  const subject = await mkUser("u360-subject");
  await sql.run(
    `INSERT INTO ledger_entries (id, user_id, amount, direction, source_type, note, created_at) VALUES (?,?,?,?,?,?,?)`,
    newId(), subject, 250, "credit", "task_completion", "test task", now(),
  );

  const r = await app.inject({ method: "GET", url: `/staff/users/${subject}`, headers: authOf(admin) });
  check("detail endpoint 200s", r.statusCode === 200, r.body);
  const b = r.json();
  check("carries an activity timeline array", Array.isArray(b.activity));
  check("the seeded ledger row shows in the activity timeline",
    b.activity.some((a: { kind: string; detail: string }) => a.kind === "points" && a.detail.includes("250")));
  check("carries roziLedger / usdtLedger / audit arrays",
    Array.isArray(b.roziLedger) && Array.isArray(b.usdtLedger) && Array.isArray(b.audit));
  check("carries a referral block", b.referral && typeof b.referral.joined2Count === "number");
  check("still NO combined balance total (guardrail #7)",
    b.user.balancePoints !== undefined && b.user.roziMicro !== undefined && b.user.usdtMicro !== undefined
    && b.user.totalBalance === undefined && b.total === undefined);
}

// ---------------------------------------------------------------------------
console.log("\n-- console-wide record search (admin rebuild, Phase A) --");
{
  const admin = await mkStaff("search-admin", "admin");
  const target = await mkUser("findme");
  const targetRow = await sql.get<{ email: string; referral_code: string }>(
    "SELECT email, referral_code FROM users WHERE id = ?", target);

  const byEmail = await app.inject({
    method: "GET", url: `/staff/search?q=${encodeURIComponent(targetRow!.email)}`, headers: authOf(admin),
  });
  check("search by email returns the user", byEmail.statusCode === 200
    && byEmail.json().results.some((r: { type: string; id: string }) => r.type === "user" && r.id === target), byEmail.body);

  const byId = await app.inject({
    method: "GET", url: `/staff/search?q=${target}`, headers: authOf(admin),
  });
  check("search by full id returns the user", byId.json().results.some((r: { id: string }) => r.id === target));

  const byCode = await app.inject({
    method: "GET", url: `/staff/search?q=${encodeURIComponent(targetRow!.referral_code)}`, headers: authOf(admin),
  });
  check("search by invite code returns the user", byCode.json().results.some((r: { id: string }) => r.id === target));

  const tooShort = await app.inject({ method: "GET", url: "/staff/search?q=a", headers: authOf(admin) });
  check("a 1-char query returns nothing (no scan)", tooShort.statusCode === 200 && tooShort.json().results.length === 0);

  // A support role holds users.view but NOT withdrawals.view — its search must
  // never surface a withdrawal row.
  const support = await mkStaff("search-support", "support");
  const supportSearch = await app.inject({
    method: "GET", url: `/staff/search?q=${encodeURIComponent(targetRow!.email)}`, headers: authOf(support),
  });
  check("support can search users", supportSearch.json().results.some((r: { type: string }) => r.type === "user"));
  check("support search never returns a withdrawal type",
    supportSearch.json().results.every((r: { type: string }) => r.type !== "withdrawal"));

  const earner = await mkUser("not-staff");
  const refused = await app.inject({ method: "GET", url: "/staff/search?q=findme", headers: authOf(earner) });
  check("a non-staff caller is refused (403)", refused.statusCode === 403, String(refused.statusCode));
}

// ---------------------------------------------------------------------------
// "Instead of Telegram user, show his username" (founder, 2026-09-03).
//
// The username IS captured at login. Two populations never had it written: an
// account that connected Telegram from the WEBSITE (bindTelegramToUser wrote
// only telegram_id until this date), and accounts older than the columns. This
// endpoint is how a human fills those in, and the count is how the button knows
// whether to appear at all.
console.log("\n-- filling in missing Telegram names --");
{
  const admin = await mkStaff("tg-admin", "admin");
  const agent = await mkStaff("tg-agent", "agent");

  const before = (await app.inject({
    method: "GET", url: "/staff/users/telegram/pending", headers: authOf(admin),
  })).json() as { pending: number; batchSize: number };

  // An account with a Telegram id and nothing readable — exactly the row that
  // rendered as "Telegram user".
  const nameless = await mkUser("tg-nameless");
  await sql.run("UPDATE users SET telegram_id = ? WHERE id = ?", `9${Date.now()}`.slice(0, 12), nameless);

  const after = (await app.inject({
    method: "GET", url: "/staff/users/telegram/pending", headers: authOf(admin),
  })).json() as { pending: number };
  check("an account with a Telegram id and no name is counted as needing one",
    after.pending === before.pending + 1, `${before.pending} -> ${after.pending}`);

  // An account that already has a username must NOT be re-asked — one outbound
  // request per account is the cost, so the query has to be selective.
  const named = await mkUser("tg-named");
  await sql.run(
    "UPDATE users SET telegram_id = ?, telegram_username = 'realhandle' WHERE id = ?",
    `8${Date.now()}`.slice(0, 12), named,
  );
  const after2 = (await app.inject({
    method: "GET", url: "/staff/users/telegram/pending", headers: authOf(admin),
  })).json() as { pending: number };
  check("an account that already has a username is not counted again",
    after2.pending === after.pending, `${after.pending} -> ${after2.pending}`);

  // With no bot token configured (the test environment), fetchTelegramChatIdentity
  // returns null rather than throwing — a Telegram outage must never be an
  // error on a staff screen, and "no token" is the same code path.
  const run = await app.inject({
    method: "POST", url: "/staff/users/telegram/refresh", headers: authOf(admin),
  });
  const out = run.json() as { checked: number; updated: number; notFound: number; pending: number };
  check("the refresh answers rather than failing when Telegram cannot be reached",
    run.statusCode === 200, run.body);
  check("and it reports nothing updated instead of pretending", out.updated === 0 && out.notFound === out.checked,
    JSON.stringify(out));
  check("the refresh is audited",
    Boolean(await sql.get("SELECT 1 AS x FROM admin_audit_log WHERE action = 'telegram_identity_refresh'")));

  check("an agent cannot run it — it writes to user rows",
    (await app.inject({ method: "POST", url: "/staff/users/telegram/refresh", headers: authOf(agent) })).statusCode === 403);

  // ⚠️ THE MARKER IS WHAT LETS THE BACKFILL FINISH. Telegram genuinely has
  // nothing on file for some accounts (no username, no last name). Without
  // recording the ATTEMPT, those rows keep matching the same query, so the
  // first batch of unfixable accounts occupies it forever, nothing past them
  // is ever reached, and the count never drops — a button that can never be
  // pressed to completion and never goes away.
  check("an account we already asked about is not asked again",
    out.pending < after2.pending || out.pending === 0,
    `checked ${out.checked}, pending now ${out.pending} (was ${after2.pending})`);
  const stamped = await sql.get<{ n: string | number }>(
    "SELECT COUNT(*) AS n FROM users WHERE telegram_checked_at IS NOT NULL",
  );
  check("because the attempt itself is recorded, not just a success",
    Number(stamped?.n ?? 0) >= out.checked, JSON.stringify(stamped));

  // The button's visibility gate is this count, so it has to need the same
  // permission the action does — or marketing/finance (users.list, no
  // users.review) see a button that 403s every time.
  check("the count needs the same permission as the refresh, so the button hides for roles that cannot press it",
    (await app.inject({ method: "GET", url: "/staff/users/telegram/pending", headers: authOf(agent) })).statusCode === 403);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
