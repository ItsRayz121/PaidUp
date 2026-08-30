// E2E for Tasks & offers (admin console rebuild, Phase D): server-side search /
// sort / pagination + `total` on GET /staff/tasks and GET /staff/task-proofs.
//
// ⚠️ This is a PRESENTATION migration — the decision paths (create/edit/lifecycle
// on a task, approve/reject/bulk on a proof) are unchanged and covered by
// test:stage7. This file only proves the new list plumbing: the pager math, the
// sort whitelist, the search filter, and that `total`/counts stay honest.
//
//   npm run test:tasksadmin
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId } from "../db.ts";
import { config } from "../config.ts";
import { appRoutes } from "../routes/app.ts";
import { staffTaskRoutes } from "../routes/staffTasks.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(appRoutes);
await app.register(staffTaskRoutes);

const TAG = newId().slice(0, 8);
const authOf = (id: string) => ({ authorization: `Bearer ${jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: "1h" })}` });

let seq = 0;
async function mkUser(label: string) {
  const id = newId();
  await sql.run(
    `INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at, kyc_status)
     VALUES (?,?,1,'Pakistan',?,'active',?, 'approved')`,
    id, `${TAG}-${label}@t.test`, `${TAG}${(seq++).toString(36)}`.toUpperCase().slice(0, 12), now(),
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
const outsider = await mkUser("outsider");

const createTask = async (payload: Record<string, unknown>) => {
  const r = await app.inject({ method: "POST", url: "/staff/tasks", headers: authOf(admin), payload });
  return (r.json() as { ok: boolean; id?: string; error?: string });
};

// ---------------------------------------------------------------------------
console.log("\n-- GET /staff/tasks: pagination + total --");
let firstTaskId = "";
{
  for (let i = 0; i < 7; i++) {
    const t = await createTask({
      title: `${TAG} campaign ${String.fromCharCode(97 + i)}`, // a..g — sortable by title
      verifyMode: "proof", rewardType: "rozi", rewardRoziMicro: (i + 1) * 1_000_000,
      countries: ["ALL"], proofRequired: false, status: i % 2 === 0 ? "active" : "draft",
    });
    if (i === 0) firstTaskId = t.id!;
  }

  const p1 = await app.inject({ method: "GET", url: `/staff/tasks?q=${TAG}&limit=3&offset=0`, headers: authOf(admin) });
  check("200", p1.statusCode === 200, p1.body.slice(0, 300));
  const d1 = p1.json() as { tasks: { id: string; title: string }[]; total: number; offset: number; limit: number };
  check("page 1 returns 3 rows", d1.tasks.length === 3, String(d1.tasks.length));
  check("total is the whole filtered set (7), not the page", d1.total === 7, String(d1.total));
  check("offset / limit echoed", d1.offset === 0 && d1.limit === 3);

  const p3 = await app.inject({ method: "GET", url: `/staff/tasks?q=${TAG}&limit=3&offset=6`, headers: authOf(admin) });
  check("last page has the 1 remaining row", (p3.json() as { tasks: unknown[] }).tasks.length === 1);
}

// ---------------------------------------------------------------------------
console.log("\n-- GET /staff/tasks: sort whitelist + status filter --");
{
  const asc = await app.inject({ method: "GET", url: `/staff/tasks?q=${TAG}&sort=title&dir=asc&limit=100`, headers: authOf(admin) });
  const titles = (asc.json() as { tasks: { title: string }[] }).tasks.map((t) => t.title);
  check("sort=title asc is ascending", titles.join("|") === [...titles].sort().join("|"), titles.join("|"));

  const desc = await app.inject({ method: "GET", url: `/staff/tasks?q=${TAG}&sort=title&dir=desc&limit=100`, headers: authOf(admin) });
  const dtitles = (desc.json() as { tasks: { title: string }[] }).tasks.map((t) => t.title);
  check("dir=desc reverses it", dtitles.join("|") === [...titles].reverse().join("|"));

  const bogus = await app.inject({ method: "GET", url: `/staff/tasks?q=${TAG}&sort=DROP%20TABLE&dir=asc&limit=100`, headers: authOf(admin) });
  check("an unknown sort key is ignored, not injected (falls back to created_at)", bogus.statusCode === 200);

  const activeOnly = await app.inject({ method: "GET", url: `/staff/tasks?q=${TAG}&status=active&limit=100`, headers: authOf(admin) });
  const ad = activeOnly.json() as { tasks: { status: string }[]; total: number };
  check("status=active filters the rows", ad.tasks.length === 4 && ad.tasks.every((t) => t.status === "active"), JSON.stringify(ad.tasks.map((t) => t.status)));
  check("...and total matches the filter (4), not the whole set", ad.total === 4, String(ad.total));
}

// ---------------------------------------------------------------------------
console.log("\n-- GET /staff/tasks: search by title, existing money fields intact --");
{
  await createTask({
    title: `${TAG} NEEDLE special`, verifyMode: "proof", rewardType: "rozi",
    rewardRoziMicro: 5_000_000, countries: ["ALL"], proofRequired: false, status: "active",
  });
  const s = await app.inject({ method: "GET", url: `/staff/tasks?q=${TAG}%20needle&limit=100`, headers: authOf(admin) });
  const sd = s.json() as { tasks: { title: string; spentConversions: number; budgetUsedPct: number | null; effectiveStatus: string; countries: string[] }[] };
  check("search matches the title case-insensitively", sd.tasks.length === 1 && sd.tasks[0].title.includes("NEEDLE"));
  check("row still carries the Phase-15/16 money fields", "spentConversions" in sd.tasks[0] && "budgetUsedPct" in sd.tasks[0]);
  check("row still carries effectiveStatus + unpacked countries", sd.tasks[0].effectiveStatus === "active" && Array.isArray(sd.tasks[0].countries));
}

// ---------------------------------------------------------------------------
console.log("\n-- GET /staff/task-proofs: pagination + total + counts --");
{
  // 5 users each submit the same tap-to-confirm task -> 5 pending proofs.
  const proofUsers: string[] = [];
  for (let i = 0; i < 5; i++) {
    const u = await mkUser(`p${i}`);
    proofUsers.push(u);
    const post = await app.inject({ method: "POST", url: `/tasks/${firstTaskId}/proof`, headers: authOf(u), payload: {} });
    check(`proof ${i} submitted`, (post.json() as { ok?: boolean }).ok === true, post.body.slice(0, 200));
  }

  const p1 = await app.inject({ method: "GET", url: `/staff/task-proofs?taskId=${firstTaskId}&limit=2&offset=0`, headers: authOf(agent) });
  check("200", p1.statusCode === 200, p1.body.slice(0, 300));
  const d1 = p1.json() as {
    proofs: { id: string }[]; total: number; offset: number; limit: number;
    counts: { pending: number };
  };
  check("page 1 returns 2 proofs", d1.proofs.length === 2, String(d1.proofs.length));
  check("total is the whole filtered set (5)", d1.total === 5, String(d1.total));
  check("offset / limit echoed", d1.offset === 0 && d1.limit === 2);
  check("counts are over ALL proofs, never this page", d1.counts.pending >= 5, String(d1.counts.pending));

  const p3 = await app.inject({ method: "GET", url: `/staff/task-proofs?taskId=${firstTaskId}&limit=2&offset=4`, headers: authOf(agent) });
  check("last page has the 1 remaining proof", (p3.json() as { proofs: unknown[] }).proofs.length === 1);

  // Default order is oldest-first (a work queue); dir=desc flips it.
  const asc = await app.inject({ method: "GET", url: `/staff/task-proofs?taskId=${firstTaskId}&limit=100`, headers: authOf(agent) });
  const ascIds = (asc.json() as { proofs: { id: string; created_at: string }[] }).proofs.map((p) => p.created_at);
  check("default order is created_at ascending (oldest waiting first)",
    ascIds.join("|") === [...ascIds].sort().join("|"), ascIds.join("|"));
  const desc = await app.inject({ method: "GET", url: `/staff/task-proofs?taskId=${firstTaskId}&dir=desc&limit=100`, headers: authOf(agent) });
  const descIds = (desc.json() as { proofs: { created_at: string }[] }).proofs.map((p) => p.created_at);
  check("dir=desc reverses to newest-first", descIds.join("|") === [...ascIds].reverse().join("|"));

  // Search narrows rows but NOT counts.
  const searched = await app.inject({ method: "GET", url: `/staff/task-proofs?taskId=${firstTaskId}&q=${TAG}-p2@&limit=100`, headers: authOf(agent) });
  const sr = searched.json() as { proofs: { user_email: string }[]; total: number; counts: { pending: number } };
  check("search finds the one user by email", sr.proofs.length === 1 && sr.proofs[0].user_email.includes(`${TAG}-p2@`));
  check("...total follows the search (1)", sr.total === 1, String(sr.total));
  check("...but counts still report the whole backlog", sr.counts.pending === d1.counts.pending, `${sr.counts.pending} vs ${d1.counts.pending}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- permission gates unchanged --");
{
  check("a non-staff user gets 403 on /staff/tasks",
    (await app.inject({ method: "GET", url: "/staff/tasks", headers: authOf(outsider) })).statusCode === 403);
  check("a non-staff user gets 403 on /staff/task-proofs",
    (await app.inject({ method: "GET", url: "/staff/task-proofs", headers: authOf(outsider) })).statusCode === 403);
  check("no token -> not 200 on /staff/tasks",
    (await app.inject({ method: "GET", url: "/staff/tasks" })).statusCode !== 200);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
