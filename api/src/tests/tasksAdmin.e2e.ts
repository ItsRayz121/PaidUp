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
console.log("\n-- no duplicate wording + soft delete (founder, 2026-09-01) --");
{
  const first = await createTask({
    title: `${TAG} Only One Of These`, verifyMode: "proof", rewardType: "rozi",
    rewardRoziMicro: 1_000_000, countries: ["ALL"], proofRequired: false, status: "active",
  });
  check("first create with a fresh title succeeds", first.ok === true, JSON.stringify(first));

  const dupExact = await app.inject({
    method: "POST", url: "/staff/tasks", headers: authOf(admin),
    payload: { title: `${TAG} Only One Of These`, verifyMode: "proof", rewardType: "rozi", rewardRoziMicro: 1_000_000, countries: ["ALL"], proofRequired: false },
  });
  check("an identical title is refused with 409", dupExact.statusCode === 409, `${dupExact.statusCode} ${dupExact.body.slice(0, 120)}`);

  const dupNorm = await app.inject({
    method: "POST", url: "/staff/tasks", headers: authOf(admin),
    payload: { title: `  ${TAG}   only one OF these `, verifyMode: "proof", rewardType: "rozi", rewardRoziMicro: 1_000_000, countries: ["ALL"], proofRequired: false },
  });
  check("...and so is the same title with different spacing/case", dupNorm.statusCode === 409, String(dupNorm.statusCode));

  // Delete it, then the title is free again.
  const del = await app.inject({ method: "DELETE", url: `/staff/tasks/${first.id}`, headers: authOf(admin) });
  check("DELETE soft-deletes the task", del.statusCode === 200 && (del.json() as { ok: boolean }).ok === true);

  const listDefault = await app.inject({ method: "GET", url: `/staff/tasks?q=${TAG}%20only%20one&limit=100`, headers: authOf(admin) });
  check("a deleted task is gone from the default admin list",
    (listDefault.json() as { tasks: unknown[] }).tasks.length === 0, listDefault.body.slice(0, 200));

  const listDeleted = await app.inject({ method: "GET", url: `/staff/tasks?q=${TAG}%20only%20one&status=deleted&limit=100`, headers: authOf(admin) });
  check("...but visible under the status=deleted filter",
    (listDeleted.json() as { tasks: { effectiveStatus: string }[] }).tasks.some((t) => t.effectiveStatus === "deleted"));

  const reuse = await createTask({
    title: `${TAG} Only One Of These`, verifyMode: "proof", rewardType: "rozi",
    rewardRoziMicro: 1_000_000, countries: ["ALL"], proofRequired: false, status: "active",
  });
  check("the freed title can be reused after delete", reuse.ok === true, JSON.stringify(reuse));
}

// ---------------------------------------------------------------------------
console.log("\n-- effective status: an expired campaign reads as 'ended' --");
{
  const t = await createTask({
    title: `${TAG} Expired Campaign`, verifyMode: "proof", rewardType: "rozi",
    rewardRoziMicro: 1_000_000, countries: ["ALL"], proofRequired: false, status: "active",
  });
  // Push ends_at into the past directly — the same state a task reaches when its
  // schedule lapses before the 15-min sweep runs.
  await sql.run("UPDATE tasks SET ends_at = ? WHERE id = ?", "2000-01-01T00:00:00Z", t.id);

  const asActive = await app.inject({ method: "GET", url: `/staff/tasks?q=${TAG}%20expired&status=active&limit=100`, headers: authOf(admin) });
  check("the expired task does NOT match status=active", (asActive.json() as { tasks: unknown[] }).tasks.length === 0);

  const asEnded = await app.inject({ method: "GET", url: `/staff/tasks?q=${TAG}%20expired&status=ended&limit=100`, headers: authOf(admin) });
  const ed = asEnded.json() as { tasks: { id: string; status: string; effectiveStatus: string }[] };
  check("...it matches status=ended (the value the badge shows)",
    ed.tasks.length === 1 && ed.tasks[0].id === t.id && ed.tasks[0].effectiveStatus === "ended",
    JSON.stringify(ed.tasks));
  check("...even though its stored column is still 'active' until the sweep",
    ed.tasks[0].status === "active", ed.tasks[0].status);
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
console.log("\n-- per-task metrics: the funnel adds up (founder, 2026-09-01) --");
{
  const t = await createTask({
    title: `${TAG} Funnel Task`, verifyMode: "proof", rewardType: "rozi",
    rewardRoziMicro: 2_000_000, countries: ["ALL"], proofRequired: true,
    proofLabel: "Your username", status: "active",
  });
  const tid = t.id!;

  // 3 users open it; 2 of those start it; 2 submit a proof; 1 is approved.
  const fu = await Promise.all([0, 1, 2].map((i) => mkUser(`fn${i}`)));
  for (const u of fu) await app.inject({ method: "GET", url: `/tasks/${tid}`, headers: authOf(u) });
  for (const u of fu.slice(0, 2)) await app.inject({ method: "POST", url: `/tasks/${tid}/start`, headers: authOf(u) });
  const proofIds: string[] = [];
  for (const u of fu.slice(0, 2)) {
    const r = await app.inject({ method: "POST", url: `/tasks/${tid}/proof`, headers: authOf(u), payload: { proof: "done" } });
    proofIds.push((r.json() as { proofId?: string; id?: string }).proofId ?? (r.json() as { id?: string }).id ?? "");
  }
  // Approve the first via the staff queue.
  const queue = await app.inject({ method: "GET", url: `/staff/task-proofs?taskId=${tid}&status=pending&limit=50`, headers: authOf(agent) });
  const firstProof = (queue.json() as { proofs: { id: string }[] }).proofs[0];
  await app.inject({ method: "POST", url: `/staff/task-proofs/${firstProof.id}/decision`, headers: authOf(agent), payload: { action: "approve" } });

  const m = await app.inject({ method: "GET", url: `/staff/tasks/${tid}/metrics`, headers: authOf(admin) });
  check("metrics: 200", m.statusCode === 200, m.body.slice(0, 200));
  const md = m.json() as {
    funnel: { opened: number; started: number; submitted: number; approved: number; pending: number; completed: number };
    conversion: { openedToStarted: number | null };
    totalOpens: number;
  };
  check("metrics: opened counts the 3 viewers", md.funnel.opened === 3, String(md.funnel.opened));
  check("metrics: started counts the 2 who tapped start", md.funnel.started === 2, String(md.funnel.started));
  check("metrics: submitted counts the 2 proofs", md.funnel.submitted === 2, String(md.funnel.submitted));
  check("metrics: approved is 1", md.funnel.approved === 1, String(md.funnel.approved));
  check("metrics: pending is the other 1", md.funnel.pending === 1, String(md.funnel.pending));
  check("metrics: completed (credited) is 1", md.funnel.completed === 1, String(md.funnel.completed));
  check("metrics: opened->started rate is 67%", md.conversion.openedToStarted === 67, String(md.conversion.openedToStarted));

  // A task nobody has touched returns a clean zero funnel.
  const dead = await createTask({
    title: `${TAG} Untouched Task`, verifyMode: "proof", rewardType: "rozi",
    rewardRoziMicro: 1_000_000, countries: ["ALL"], proofRequired: false, status: "active",
  });
  const zm = await app.inject({ method: "GET", url: `/staff/tasks/${dead.id}/metrics`, headers: authOf(admin) });
  const zd = zm.json() as { funnel: { opened: number; completed: number }; conversion: { openedToCompleted: number | null } };
  check("metrics: an untouched task is all zeros", zd.funnel.opened === 0 && zd.funnel.completed === 0);
  check("metrics: ...and its conversion % is null, not NaN or 0", zd.conversion.openedToCompleted === null);

  // The overview rolls this campaign in.
  const ov = await app.inject({ method: "GET", url: "/staff/tasks/overview", headers: authOf(admin) });
  check("overview: 200", ov.statusCode === 200);
  const od = ov.json() as { window30d: { opened: number; completed: number }; campaigns: { active: number; total: number } };
  check("overview: opened >= 3 (this campaign's viewers included)", od.window30d.opened >= 3, String(od.window30d.opened));
  check("overview: completed >= 1", od.window30d.completed >= 1, String(od.window30d.completed));
  check("overview: campaign counts are present", od.campaigns.total >= 2 && od.campaigns.active >= 2);

  // A non-staff user cannot read either.
  check("metrics: outsider gets 403",
    (await app.inject({ method: "GET", url: `/staff/tasks/${tid}/metrics`, headers: authOf(outsider) })).statusCode === 403);
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
