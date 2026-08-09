// E2E for the admin rebuild, stage 7 — the task engine: configurable input
// fields, categories and targeting, and the review dashboard.
//
// WHY THIS FILE EXISTS
// --------------------
// The usual reason first: SQL that typechecks is not SQL that runs, and this
// stage adds a table, five columns and rewrites both the earner feed and the
// review queries. The `networks.label` bug class has now bitten twice in this
// project, both times invisible to the compiler.
//
// But the property that actually matters here is one line:
//
//   ⚠️ TARGETING IS AN ELIGIBILITY GATE, NOT A FEED FILTER.
//   Country targeting used to be a WHERE clause in GET /tasks and nowhere
//   else. Hiding a task from a list has never stopped anyone who has its id —
//   from a screenshot, a shared link, a stale cached feed — from POSTing a
//   proof to it. Every rule now lives in taskTargeting.ts and is asked by BOTH
//   paths, and there is a test below that skips the feed entirely and submits
//   straight to a task it was never shown.
//
// And two more worth pinning:
//
//   • A FIELD'S LABEL IS SNAPSHOTTED ONTO THE ANSWER. An Admin renaming "Your
//     username" to "Your email" afterwards must not relabel evidence a
//     reviewer has already read.
//   • A URL ANSWER IS SCHEME-CHECKED SERVER-SIDE. It is rendered as a link in
//     the staff queue, and an admin session is the session worth stealing.
//
//   npm run test:stage7
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId } from "../db.ts";
import { config } from "../config.ts";
import { appRoutes } from "../routes/app.ts";
import { staffTaskRoutes } from "../routes/staffTasks.ts";
import { countryMatches, packCountries, eligibility } from "../taskTargeting.ts";

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
async function mkUser(label: string, opts: { country?: string; ageDays?: number } = {}) {
  const id = newId();
  const created = new Date(Date.now() - (opts.ageDays ?? 30) * 86_400_000).toISOString();
  await sql.run(
    `INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at, kyc_status)
     VALUES (?,?,1,?,?,'active',?, 'approved')`,
    id, `${TAG}-${label}@t.test`, opts.country ?? "Pakistan",
    `${TAG}${(seq++).toString(36)}`.toUpperCase().slice(0, 12), created,
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

const createTask = async (payload: Record<string, unknown>) => {
  const r = await app.inject({ method: "POST", url: "/staff/tasks", headers: authOf(admin), payload });
  return { statusCode: r.statusCode, body: r.json() as { ok: boolean; id?: string; error?: string } };
};
const feedFor = async (userId: string) => {
  const r = await app.inject({ method: "GET", url: "/tasks", headers: authOf(userId) });
  return (r.json() as { tasks: { id: string; lockedReason?: string; category?: string }[] }).tasks;
};

// ---------------------------------------------------------------------------
console.log("\n-- the storage form of a country list --");
{
  check("one country packs comma-wrapped", packCountries(["Pakistan"]) === ",Pakistan,");
  check("many countries pack in one string", packCountries(["Pakistan", "India"]) === ",Pakistan,India,");
  check("duplicates collapse", packCountries(["India", "India"]) === ",India,");
  // A task targeted at nothing would show to nobody, which is indistinguishable
  // from a broken feed. The wider reading wins.
  check("an empty list means everywhere", packCountries([]) === ",ALL,");
  check("ALL beside a country list wins", packCountries(["Pakistan", "ALL"]) === ",ALL,");

  const row = { target_countries: ",Pakistan,India,", country: "Pakistan +1" };
  check("a listed country matches", countryMatches(row, "India"));
  check("case does not matter", countryMatches(row, "india"));
  check("an unlisted country does not match", !countryMatches(row, "Nigeria"));
  // The comma wrapping is what makes this safe: a bare LIKE '%India%' would
  // also match a country whose name merely contains it.
  check("a prefix of a listed country does not match", !countryMatches(row, "Ind"));
  check("ALL matches anyone", countryMatches({ target_countries: ",ALL,", country: "ALL" }, "Nigeria"));
  // Rows written before this feature existed have no target_countries.
  check("an unset list falls back to the old single column",
    countryMatches({ target_countries: null, country: "Pakistan" }, "Pakistan"));
  check("...and still refuses the wrong country",
    !countryMatches({ target_countries: null, country: "Pakistan" }, "India"));
}

// ---------------------------------------------------------------------------
console.log("\n-- hide vs lock: the two kinds of 'no' --");
{
  const base = {
    target_countries: ",ALL,", country: "ALL",
    target_min_account_days: null, target_max_account_days: null, target_min_completed: null,
  };
  const ctx = { country: "Pakistan", accountDays: 5, completedTasks: 1 };
  check("no rules = eligible", eligibility(base, ctx).ok);

  const wrongCountry = eligibility({ ...base, target_countries: ",India," }, ctx);
  check("the wrong country is HIDDEN, not locked",
    !wrongCountry.ok && wrongCountry.hide === true);

  const tooOld = eligibility({ ...base, target_max_account_days: 3 }, ctx);
  check("'new members only' is HIDDEN for an older account — no amount of effort reaches it",
    !tooOld.ok && tooOld.hide === true);

  const tooNew = eligibility({ ...base, target_min_account_days: 10 }, ctx);
  check("'account too new' is LOCKED, not hidden — waiting fixes it",
    !tooNew.ok && tooNew.hide === false);
  check("...and the reason counts the days left in plain English",
    !tooNew.ok && tooNew.reason.includes("5 days"), !tooNew.ok ? tooNew.reason : "");

  const needMore = eligibility({ ...base, target_min_completed: 4 }, ctx);
  check("'finish more tasks' is LOCKED — it is a goal",
    !needMore.ok && needMore.hide === false);
  check("...and says how many more, not how many in total",
    !needMore.ok && needMore.reason.includes("3 more"), !needMore.ok ? needMore.reason : "");
}

// ---------------------------------------------------------------------------
console.log("\n-- a campaign's country targeting reaches the feed --");
const pkUser = await mkUser("pk", { country: "Pakistan" });
const ngUser = await mkUser("ng", { country: "Nigeria" });
let multiId = "";
{
  const r = await createTask({
    title: `${TAG} two countries`, points: 60, verifyMode: "proof",
    countries: ["Pakistan", "India"], category: "social",
  });
  check("created", r.body.ok === true, JSON.stringify(r.body));
  multiId = r.body.id!;

  const row = await sql.get<{ country: string; target_countries: string; category: string }>(
    "SELECT country, target_countries, category FROM tasks WHERE id = ?", multiId,
  );
  check("the list is stored comma-wrapped", row?.target_countries === ",Pakistan,India,", row?.target_countries);
  // ⚠️ Both columns move together — `country` is the readable summary every
  // pre-stage-7 query still reads, and a save that touched only one would give
  // a task reading "Pakistan" in the panel while showing in India.
  check("the old single column is kept as a readable summary", row?.country === "Pakistan +1", row?.country);
  check("the category is stored", row?.category === "social", String(row?.category));

  const pkFeed = await feedFor(pkUser);
  check("a targeted user sees it", pkFeed.some((t) => t.id === multiId));
  check("...with its category, so the chips have something to filter on",
    pkFeed.find((t) => t.id === multiId)?.category === "social");
  check("an untargeted user does not", !(await feedFor(ngUser)).some((t) => t.id === multiId));
}

// ---------------------------------------------------------------------------
console.log("\n-- ⚠️ THE GATE IS ON THE WRITE PATH, NOT ONLY ON THE FEED --");
{
  // The whole point. Nigeria never sees this task; Nigeria posting straight at
  // its id must still be refused.
  const r = await app.inject({
    method: "POST", url: `/tasks/${multiId}/proof`, headers: authOf(ngUser),
    payload: { proof: "I did it, honest" },
  });
  const b = r.json() as { ok: boolean; error?: string };
  check("a user the task was hidden from cannot submit to it anyway", b.ok === false, JSON.stringify(b));
  check("...and is told why, in plain English",
    (b.error ?? "").includes("not open in your country"), b.error);
  const n = await sql.get<{ n: string | number }>(
    "SELECT COUNT(*) AS n FROM task_proofs WHERE task_id = ? AND user_id = ?", multiId, ngUser,
  );
  check("nothing was filed", Number(n?.n) === 0);

  // The detail page must not render it either — otherwise the feed hides a task
  // and the page it links to hands it straight back.
  const d = await app.inject({ method: "GET", url: `/tasks/${multiId}`, headers: authOf(ngUser) });
  check("the task's own page refuses it too", (d.json() as { ok: boolean }).ok === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- a locked task IS shown, with the reason, and still cannot be claimed --");
let lockedId = "";
{
  const brandNew = await mkUser("fresh", { ageDays: 0 });
  const r = await createTask({
    title: `${TAG} for settled accounts`, points: 200, verifyMode: "proof",
    countries: ["ALL"], targetMinAccountDays: 7,
  });
  lockedId = r.body.id!;

  const feed = await feedFor(brandNew);
  const row = feed.find((t) => t.id === lockedId);
  check("a gate they can still pass keeps the task on screen", !!row);
  check("...carrying the reason", (row?.lockedReason ?? "").includes("too new"), row?.lockedReason);

  const post = await app.inject({
    method: "POST", url: `/tasks/${lockedId}/proof`, headers: authOf(brandNew),
    payload: { proof: "let me in" },
  });
  check("but submitting is still refused", (post.json() as { ok: boolean }).ok === false);

  // An account old enough sees no lock at all.
  const settled = await feedFor(pkUser);
  check("a settled account sees the same task unlocked",
    settled.find((t) => t.id === lockedId)?.lockedReason === undefined);
}

// ---------------------------------------------------------------------------
console.log("\n-- configurable input fields --");
let fieldTask = "";
let fUser = "", fEmail = "", fLink = "", fPick = "", fOptional = "";
{
  const r = await createTask({
    title: `${TAG} sign up for our partner`, points: 500, verifyMode: "proof", countries: ["ALL"],
  });
  fieldTask = r.body.id!;

  const put = await app.inject({
    method: "PUT", url: `/staff/tasks/${fieldTask}/fields`, headers: authOf(admin),
    payload: {
      fields: [
        { label: "Your username", kind: "text", required: true, help: "The one you signed up with" },
        { label: "Your email", kind: "email", required: true },
        { label: "Screenshot link", kind: "url", required: true },
        { label: "Which plan?", kind: "choice", required: true, options: "Free\nPaid" },
        { label: "Anything else?", kind: "longtext", required: false },
      ],
    },
  });
  check("the fields save", put.statusCode === 200 && (put.json() as { ok: boolean }).ok === true, put.body.slice(0, 300));
  const saved = (put.json() as { fields: { id: string; label: string; options?: string[] }[] }).fields;
  check("five come back in order", saved.length === 5 && saved[0].label === "Your username");
  check("choices are served as a list, not a blob",
    JSON.stringify(saved[3].options) === JSON.stringify(["Free", "Paid"]), JSON.stringify(saved[3]));
  [fUser, fEmail, fLink, fPick, fOptional] = saved.map((f) => f.id);

  // A choice field with no choices renders a question that cannot be answered.
  const bad = await app.inject({
    method: "PUT", url: `/staff/tasks/${fieldTask}/fields`, headers: authOf(admin),
    payload: { fields: [{ label: "Pick", kind: "choice", required: true, options: "  \n " }] },
  });
  check("a choice question with no choices is refused before a user can meet it",
    (bad.json() as { ok: boolean }).ok === false, bad.body.slice(0, 200));

  const detail = await app.inject({ method: "GET", url: `/tasks/${fieldTask}`, headers: authOf(pkUser) });
  const dj = detail.json() as { ok: boolean; fields: { id: string; required: boolean }[] };
  check("the earner's task page is served the same fields", dj.ok && dj.fields.length === 5);
  check("required is carried through", dj.fields[0].required === true && dj.fields[4].required === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- the answers are checked on the SERVER --");
{
  const submit = (userId: string, answers: Record<string, string>) =>
    app.inject({
      method: "POST", url: `/tasks/${fieldTask}/proof`, headers: authOf(userId), payload: { answers },
    }).then((r) => r.json() as { ok: boolean; error?: string });

  const good = {
    [fUser]: "ahmed", [fEmail]: "ahmed@example.com",
    [fLink]: "https://example.com/shot.png", [fPick]: "Paid",
  };

  let r = await submit(pkUser, { ...good, [fUser]: "" });
  check("a missing required answer is refused", !r.ok && (r.error ?? "").includes("Your username"), r.error);

  r = await submit(pkUser, { ...good, [fEmail]: "not-an-email" });
  check("a bad email is refused", !r.ok && (r.error ?? "").includes("email address"), r.error);

  // ⚠️ THE SCHEME CHECK. This value ends up as an href in the staff queue.
  r = await submit(pkUser, { ...good, [fLink]: "javascript:alert(1)" });
  check("a javascript: link is refused — it would be an href on an admin screen",
    !r.ok && (r.error ?? "").includes("http"), r.error);
  r = await submit(pkUser, { ...good, [fLink]: "data:text/html,<script>x</script>" });
  check("a data: link is refused too", !r.ok, r.error);

  r = await submit(pkUser, { ...good, [fPick]: "Enterprise" });
  check("an answer that is not one of the choices is refused", !r.ok, r.error);

  r = await submit(pkUser, { ...good, [fUser]: "x".repeat(500) });
  check("an over-long answer is refused", !r.ok && (r.error ?? "").includes("too long"), r.error);

  // The client sends only what it was shown; a request with nothing at all must
  // not file a blank proof.
  r = await submit(pkUser, {});
  check("an empty submission files nothing", !r.ok);

  r = await submit(pkUser, good);
  check("a complete, valid set is accepted", r.ok === true, r.error);
}

// ---------------------------------------------------------------------------
console.log("\n-- ⚠️ THE LABEL IS SNAPSHOTTED ONTO THE ANSWER --");
{
  const before = await sql.get<{ answers: string; proof_text: string }>(
    "SELECT answers, proof_text FROM task_proofs WHERE task_id = ? AND user_id = ?", fieldTask, pkUser,
  );
  const parsed = JSON.parse(before!.answers) as { label: string; value: string; kind: string }[];
  check("four answers stored (the optional one was skipped, not stored blank)", parsed.length === 4,
    String(parsed.length));
  check("each answer carries the question it answered", parsed[0].label === "Your username");
  // Every row keeps a readable proof_text, so nothing downstream needs a
  // "structured or not" branch.
  check("proof_text still renders the same answers",
    before!.proof_text.includes("Your username: ahmed"), before!.proof_text);

  // Now rename the question underneath it.
  await app.inject({
    method: "PUT", url: `/staff/tasks/${fieldTask}/fields`, headers: authOf(admin),
    payload: {
      fields: [
        { id: fUser, label: "Your PARTNER ID", kind: "text", required: true },
        { id: fEmail, label: "Your email", kind: "email", required: true },
        { id: fLink, label: "Screenshot link", kind: "url", required: true },
        { id: fPick, label: "Which plan?", kind: "choice", required: true, options: "Free\nPaid" },
        { id: fOptional, label: "Anything else?", kind: "longtext", required: false },
      ],
    },
  });
  const after = await sql.get<{ answers: string }>(
    "SELECT answers FROM task_proofs WHERE task_id = ? AND user_id = ?", fieldTask, pkUser,
  );
  const stillOld = (JSON.parse(after!.answers) as { label: string }[])[0].label;
  check("renaming the question does NOT relabel evidence already submitted",
    stillOld === "Your username", stillOld);

  // Keeping ids is what stops a re-save duplicating the whole form.
  const count = await sql.get<{ n: string | number }>(
    "SELECT COUNT(*) AS n FROM task_fields WHERE task_id = ?", fieldTask,
  );
  check("re-saving with ids edits in place instead of duplicating", Number(count?.n) === 5, String(count?.n));
}

// ---------------------------------------------------------------------------
console.log("\n-- a task with no fields keeps the old single box --");
{
  const r = await createTask({
    title: `${TAG} join our channel`, points: 50, verifyMode: "proof",
    countries: ["ALL"], proofRequired: false,
  });
  const id = r.body.id!;
  const u = await mkUser("tapper");
  const post = await app.inject({
    method: "POST", url: `/tasks/${id}/proof`, headers: authOf(u), payload: {},
  });
  check("a tap-to-confirm task still works with no answers at all",
    (post.json() as { ok: boolean }).ok === true, post.body.slice(0, 200));
  const row = await sql.get<{ answers: string | null; proof_text: string; status: string }>(
    "SELECT answers, proof_text, status FROM task_proofs WHERE task_id = ? AND user_id = ?", id, u,
  );
  check("it files no structured answers", row?.answers === null);
  check("...but still a readable proof_text", (row?.proof_text ?? "").length > 0);
  // ⚠️ NOT A SELF-CREDIT SWITCH. Both shapes end in a human decision.
  check("...and it is PENDING — nothing credited itself", row?.status === "pending");
}

// ---------------------------------------------------------------------------
console.log("\n-- the review dashboard --");
{
  const r = await app.inject({ method: "GET", url: "/staff/task-proofs", headers: authOf(agent) });
  check("200, not a 500 from a mistyped column", r.statusCode === 200, r.body.slice(0, 400));
  const d = r.json() as {
    counts: Record<string, number>;
    tasks: { id: string; pending: number }[];
    proofs: { id: string; answers: unknown[]; userHistory: { approved: number; rejected: number }; user_email: string }[];
  };
  check("counts are served per status", typeof d.counts.pending === "number" && d.counts.pending >= 2);
  check("the task filter lists tasks that actually have proofs waiting",
    d.tasks.some((t) => t.id === fieldTask && t.pending >= 1), JSON.stringify(d.tasks));
  const mine = d.proofs.find((p) => p.user_email.includes(`${TAG}-pk@`));
  check("a structured proof arrives with its answers parsed", (mine?.answers.length ?? 0) === 4);
  check("every row carries the user's own record", !!mine && typeof mine.userHistory.approved === "number");

  // ⚠️ THE COUNTS ARE OVER ALL PROOFS, NEVER THE FILTER. A pending number that
  // shrank because someone typed a search reads as the backlog clearing.
  const filtered = await app.inject({
    method: "GET", url: `/staff/task-proofs?taskId=${fieldTask}`, headers: authOf(agent),
  });
  const f = filtered.json() as { counts: Record<string, number>; proofs: unknown[] };
  check("filtering by task narrows the rows", f.proofs.length < d.proofs.length, `${f.proofs.length} of ${d.proofs.length}`);
  check("...but not the counts", f.counts.pending === d.counts.pending);

  const searched = await app.inject({
    method: "GET", url: `/staff/task-proofs?q=${TAG}-pk@`, headers: authOf(agent),
  });
  const s = searched.json() as { proofs: { user_email: string }[]; counts: Record<string, number> };
  check("search finds a user by email", s.proofs.length >= 1 && s.proofs.every((p) => p.user_email.includes(`${TAG}-pk@`)));
  check("...and still reports the whole backlog", s.counts.pending === d.counts.pending);
}

// ---------------------------------------------------------------------------
console.log("\n-- ⚠️ A BULK DECISION IS N SEPARATE DECISIONS --");
{
  // Three users on one task. One of them will already have been decided, so the
  // bulk call has to report a partial result rather than a single ok.
  const t = await createTask({
    title: `${TAG} bulk`, points: 25, verifyMode: "proof", countries: ["ALL"], proofRequired: false,
  });
  const taskId = t.body.id!;
  const users = [await mkUser("b1"), await mkUser("b2"), await mkUser("b3")];
  const ids: string[] = [];
  for (const u of users) {
    await app.inject({ method: "POST", url: `/tasks/${taskId}/proof`, headers: authOf(u), payload: {} });
    const p = await sql.get<{ id: string }>(
      "SELECT id FROM task_proofs WHERE task_id = ? AND user_id = ?", taskId, u,
    );
    ids.push(p!.id);
  }

  // Decide one on its own first.
  await app.inject({
    method: "POST", url: `/staff/task-proofs/${ids[0]}/decision`, headers: authOf(agent),
    payload: { action: "approve" },
  });

  const bulk = await app.inject({
    method: "POST", url: "/staff/task-proofs/bulk", headers: authOf(agent),
    payload: { ids, action: "approve" },
  });
  const b = bulk.json() as {
    done: number; failed: number; creditedPoints: number;
    results: { id: string; ok: boolean; error?: string }[];
  };
  check("the two still open are approved", b.done === 2, JSON.stringify(b));
  check("the one already decided is reported as NOT done, not silently counted", b.failed === 1);
  check("...with its own reason", b.results.find((x) => !x.ok)?.error === "already reviewed");
  check("the points credited are reported", b.creditedPoints === 50, String(b.creditedPoints));

  // Every approval went through the shared credit path, so the ledger moved.
  for (const u of users) {
    const n = await sql.get<{ n: string | number }>(
      "SELECT COUNT(*) AS n FROM task_completions WHERE user_id = ? AND task_id = ? AND status = 'credited'",
      u, taskId,
    );
    check(`each approved user really got a credited completion (${u.slice(0, 4)})`, Number(n?.n) === 1);
  }

  const rejected = await app.inject({
    method: "POST", url: "/staff/task-proofs/bulk", headers: authOf(agent),
    payload: { ids: [ids[0]], action: "reject", note: "not this time" },
  });
  check("re-deciding an approved row does nothing", (rejected.json() as { done: number }).done === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- who may do what --");
{
  check("an agent reviews but cannot write a campaign", (await app.inject({
    method: "POST", url: "/staff/tasks", headers: authOf(agent),
    payload: { title: `${TAG} nope`, points: 10, verifyMode: "proof" },
  })).statusCode === 403);
  check("an agent cannot edit a task's questions", (await app.inject({
    method: "PUT", url: `/staff/tasks/${fieldTask}/fields`, headers: authOf(agent),
    payload: { fields: [] },
  })).statusCode === 403);
  check("an ordinary user cannot read the review queue",
    (await app.inject({ method: "GET", url: "/staff/task-proofs", headers: authOf(pkUser) })).statusCode === 403);
  check("...nor a task's questions",
    (await app.inject({ method: "GET", url: `/staff/tasks/${fieldTask}/fields`, headers: authOf(pkUser) })).statusCode === 403);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
