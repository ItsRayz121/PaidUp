// E2E for per-campaign budget + revenue (brief parts 15 + 16).
//
// WHY THIS FILE EXISTS
// --------------------
// Two reasons, and the second is the one that matters.
//
// 1. The `networks.label` bug class, twice in two stages now: SQL that
//    typechecks is not SQL that runs. Every query added for this feature —
//    including the correlated referral-bonus subquery in campaignMoney() — is
//    executed here against real Postgres.
//
// 2. THE CAP IS A CONCURRENCY CONTROL, and a cap that only holds when requests
//    arrive one at a time is not a cap. The whole point of this feature is a
//    partner who bought 2,000 conversions not being given 20,000, and the way
//    that happens in production is a burst of postbacks, not a careful
//    sequence. There is a test below that fires them simultaneously.
//
//   npm run test:taskbudget
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId, usingRealPostgres } from "../db.ts";
import { config } from "../config.ts";
import { staffTaskRoutes } from "../routes/staffTasks.ts";
import { creditCompletion } from "../credit.ts";
import { campaignMoney, overBudget } from "../taskBudget.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(staffTaskRoutes);
const log = { error: () => {} };

const TAG = newId().slice(0, 8);
const authOf = (id: string) => ({ authorization: `Bearer ${jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: "1h" })}` });

let seq = 0;
async function mkUser(label: string, referredBy: string | null = null) {
  const id = newId();
  await sql.run(
    `INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at, referred_by, kyc_status, kyc_approved_at)
     VALUES (?,?,1,'Pakistan',?,'active',?,?,'approved',?)`,
    id, `${TAG}-${label}@t.test`, `${TAG}${(seq++).toString(36)}`.toUpperCase().slice(0, 12),
    now(), referredBy, now(),
  );
  return id;
}
async function mkStaff(label: string, role: string) {
  const id = await mkUser(label);
  await sql.run("INSERT INTO admin_users (user_id, role, created_at) VALUES (?,?,?)", id, role, now());
  return id;
}
async function mkTask(opts: {
  points: number; budgetConversions?: number | null; budgetPoints?: number | null;
  revenueMicro?: number;
}) {
  const id = newId();
  await sql.run(
    `INSERT INTO tasks (id, type, title, points, network, advertiser, minutes, country, status,
                        source, verify_mode, budget_conversions, budget_points,
                        revenue_per_conversion_micro, created_at)
     VALUES (?, 'custom', ?, ?, 'custom', 'RoziPay', 1, 'Pakistan', 'active', 'custom', 'postback', ?,?,?,?)`,
    id, `${TAG} campaign`, opts.points,
    opts.budgetConversions ?? null, opts.budgetPoints ?? null, opts.revenueMicro ?? 0, now(),
  );
  return id;
}
const credit = (userId: string, taskId: string, points: number, tag: string) =>
  creditCompletion({
    userId, network: "custom", externalId: `${TAG}-${tag}`, taskId, points,
    offerType: "custom", payload: {},
  }, log);
const statusOf = async (taskId: string) =>
  (await sql.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", taskId))?.status;

const admin = await mkStaff("admin", "admin");

// ---------------------------------------------------------------------------
console.log("\n-- an uncapped campaign is unchanged: every existing row keeps today's behaviour --");
{
  const t = await mkTask({ points: 10 });
  const u = await mkUser("free1");
  for (let i = 0; i < 5; i++) {
    const o = await credit(u, t, 10, `free${i}`);
    check(`credit ${i + 1} of 5 goes through with no budget set`, o.status === "credited", o.status);
  }
  check("an uncapped campaign never pauses itself", (await statusOf(t)) === "active");
}

// ---------------------------------------------------------------------------
console.log("\n-- the conversion cap stops exactly at the number bought --");
{
  const t = await mkTask({ points: 10, budgetConversions: 3 });
  const u = await mkUser("cap1");
  for (let i = 0; i < 3; i++) {
    check(`conversion ${i + 1} is within budget`, (await credit(u, t, 10, `cap1-${i}`)).status === "credited");
  }
  const over = await credit(u, t, 10, "cap1-over");
  check("the 4th is refused", over.status === "budget_exhausted", over.status);
  check("...and says which cap it hit",
    over.status === "budget_exhausted" && over.reason === "conversions" && over.cap === 3,
    JSON.stringify(over));
  // THE AUTO-PAUSE. Without this the cap only refuses; the campaign keeps being
  // offered to users who then complete a task nobody will pay for.
  check("the campaign paused ITSELF", (await statusOf(t)) === "exhausted");
  check("and stamped when", Boolean(
    (await sql.get<{ a: string | null }>("SELECT budget_exhausted_at AS a FROM tasks WHERE id = ?", t))?.a));
  check("exactly 3 credited completions exist, not 4",
    (await sql.get<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM task_completions WHERE task_id = ? AND status = 'credited'", t))?.n === 3);
}

// ---------------------------------------------------------------------------
console.log("\n-- CONCURRENCY: the cap holds when postbacks arrive together --");
// The reason this feature is a lock and not an `if`. Ten simultaneous credits
// against a budget of 4: without pg_advisory_xact_lock they all read the same
// count of 0, all pass the check, and the partner is handed 10.
//
// ⚠️ THIS CANNOT BE TESTED UNDER PGlite, AND A RUN THAT "FAILS" HERE LOCALLY IS
// NOT A BROKEN LOCK. PGlite is SINGLE-CONNECTION (see makePgliteDriver in
// db.ts): every sql.tx() shares one session, so ten overlapping transactions
// are really one, and `pg_advisory_xact_lock` never blocks because a session
// re-acquiring its own advisory lock succeeds immediately. Under the pooled
// node-postgres driver every transaction gets its own client, its own session,
// and the lock genuinely serializes.
//
// So: run the real race only when DATABASE_URL points at a real Postgres, and
// keep a structural tripwire that holds either way. This is the same split
// mining.e2e.ts already uses for the concurrent-spend race — written down again
// here because the next person to see 10/4 locally will otherwise "fix" a lock
// that was never broken.
{
  const t = await mkTask({ points: 10, budgetConversions: 4 });
  const u = await mkUser("race");
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => credit(u, t, 10, `race-${i}`)),
  );
  const credited = results.filter((r) => r.status === "credited").length;

  if (usingRealPostgres) {
    const refused = results.filter((r) => r.status === "budget_exhausted").length;
    check("exactly 4 were credited, not 10", credited === 4, `credited=${credited} refused=${refused}`);
    check("the rest were refused as over budget", credited + refused === 10);
    check("the completions table agrees",
      (await sql.get<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM task_completions WHERE task_id = ? AND status = 'credited'", t))?.n === 4);
    check("the campaign paused itself once", (await statusOf(t)) === "exhausted");
  } else {
    console.log(`  skip concurrent-budget race — PGlite is single-session, so it cannot isolate `
      + `transactions (${credited}/10 credits went through against a cap of 4). `
      + `Set DATABASE_URL to test this for real.`);
  }

  // Structural tripwire, so the protection cannot be silently deleted under a
  // driver that cannot exercise it. The budget check is a read-then-write on a
  // shared total — guardrail #8 one level up from a user balance — so the lock
  // MUST be taken, and it must be taken BEFORE the spend is read. Locking after
  // the read is the same non-fix as checking a balance outside lockUser().
  const src = (await import("node:fs")).readFileSync(
    new URL("../credit.ts", import.meta.url), "utf8",
  );
  const lockAt = src.indexOf("lockCampaign(t, taskId)");
  const readAt = src.indexOf("campaignSpend(t, taskId)");
  check("credit.ts takes the campaign lock", lockAt > -1);
  check("...BEFORE it reads what the campaign has spent", lockAt > -1 && readAt > lockAt,
    `lock@${lockAt} read@${readAt}`);
  // And the lock has to be inside the transaction that writes, or it is released
  // at the end of its own statement and protects nothing.
  check("...inside the same transaction as the completion insert",
    lockAt > src.indexOf("const verdict = await sql.tx")
    && lockAt < src.indexOf("INSERT INTO task_completions (id, user_id, task_id, network, external_id, status, points, usdt_micro,"));
}

// ---------------------------------------------------------------------------
console.log("\n-- the points cap refuses the completion that would BREAK it, not the one after --");
// ⚠️ `used + points > cap`, never `used >= cap`. Checked the lazy way, the last
// conversion always overshoots by a whole reward — which on a campaign with a
// big reward is most of the overspend the cap exists to prevent.
{
  const t = await mkTask({ points: 40, budgetPoints: 100 });
  const u = await mkUser("pts1");
  check("40 of 100 fits", (await credit(u, t, 40, "pts1-a")).status === "credited");
  check("80 of 100 fits", (await credit(u, t, 40, "pts1-b")).status === "credited");
  const third = await credit(u, t, 40, "pts1-c");
  check("120 of 100 does NOT fit — refused BEFORE it overshoots",
    third.status === "budget_exhausted" && third.reason === "points", JSON.stringify(third));
  check("total points paid never exceeded the cap",
    (await sql.get<{ p: number }>(
      "SELECT COALESCE(SUM(points),0)::int AS p FROM task_completions WHERE task_id = ? AND status='credited'", t))?.p === 80);
}

// ---------------------------------------------------------------------------
console.log("\n-- a paused campaign is invisible and unusable to earners --");
{
  const t = await mkTask({ points: 10, budgetConversions: 1 });
  const u = await mkUser("hide1");
  await credit(u, t, 10, "hide-a");
  await credit(u, t, 10, "hide-b"); // exhausts it
  check("status is exhausted", (await statusOf(t)) === "exhausted");
  // The earner feed has always filtered on status = 'active', which is why
  // auto-pause needed no new condition there — assert that still holds.
  const visible = await sql.all<{ id: string }>(
    "SELECT id FROM tasks WHERE status = 'active' AND id = ?", t);
  check("it is gone from the active set the earner feed reads", visible.length === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- an Admin's own 'disabled' is never relabelled by a late postback --");
// "I turned this off" and "it ran out" are different answers to "why did it
// stop", and staff act on them differently.
{
  const t = await mkTask({ points: 10, budgetConversions: 1 });
  const u = await mkUser("dis1");
  await credit(u, t, 10, "dis-a");
  await sql.run("UPDATE tasks SET status = 'disabled' WHERE id = ?", t);
  await credit(u, t, 10, "dis-b");
  check("a disabled campaign stays disabled", (await statusOf(t)) === "disabled");
}

// ---------------------------------------------------------------------------
console.log("\n-- raising the budget reopens the campaign --");
{
  const t = await mkTask({ points: 10, budgetConversions: 1 });
  const u = await mkUser("raise1");
  await credit(u, t, 10, "raise-a");
  await credit(u, t, 10, "raise-b");
  check("paused", (await statusOf(t)) === "exhausted");

  const r = await app.inject({
    method: "PATCH", url: `/staff/tasks/${t}`, headers: authOf(admin),
    payload: { budgetConversions: 5 },
  });
  check("the admin can raise it", r.statusCode === 200, r.body.slice(0, 200));
  // Otherwise the one action that fixes the problem leaves it paused, and the
  // Admin has to know to flip the status back too.
  check("raising the cap reactivates it", (await statusOf(t)) === "active", String(await statusOf(t)));
  check("the it-ran-out-once stamp is NOT erased", Boolean(
    (await sql.get<{ a: string | null }>("SELECT budget_exhausted_at AS a FROM tasks WHERE id = ?", t))?.a));
  check("and it credits again", (await credit(u, t, 10, "raise-c")).status === "credited");

  // Clearing a cap to unlimited has to be expressible, or "this campaign has no
  // budget" becomes a state you can enter but never return to.
  await app.inject({
    method: "PATCH", url: `/staff/tasks/${t}`, headers: authOf(admin),
    payload: { budgetConversions: null },
  });
  const cleared = await sql.get<{ c: number | null }>(
    "SELECT budget_conversions AS c FROM tasks WHERE id = ?", t);
  check("null clears the cap back to unlimited", cleared?.c === null, String(cleared?.c));
}

// ---------------------------------------------------------------------------
console.log("\n-- a dynamic survey (no task row) is untouched by any of this --");
// CPX and friends arrive with no task_id. There is no campaign to budget, and
// the budget code must not invent one or refuse them.
{
  const u = await mkUser("dyn1");
  const o = await creditCompletion({
    userId: u, network: "cpx", externalId: `${TAG}-dyn`, taskId: null,
    points: 250, offerType: "survey", payload: {},
  }, log);
  check("credited normally with no task row", o.status === "credited", o.status);
}

// ---------------------------------------------------------------------------
console.log("\n-- part 15: revenue, cost and margin per campaign --");
{
  // $0.50 in per conversion, 100 points (= $0.10 at 1000 pts/USDT) out.
  const t = await mkTask({ points: 100, revenueMicro: 500_000 });
  const inviter = await mkUser("m-inviter");
  const u = await mkUser("m-earner", inviter);
  for (let i = 0; i < 3; i++) await credit(u, t, 100, `money-${i}`);

  const m = (await campaignMoney(config.pointsPerUsdt)).get(t)!;
  check("conversions counted", m.conversions === 3, String(m.conversions));
  check("points paid counted", m.points === 300, String(m.points));
  check("revenue = rate x conversions", m.revenueMicro === 1_500_000, String(m.revenueMicro));
  // ⚠️ Referral commission is real spend out of margin. A margin that ignored
  // it would flatter every campaign that has any referred users on it.
  check("referral commission is counted as cost", m.referralPoints > 0, String(m.referralPoints));
  const expected = 1_500_000 - Math.round(((300 + m.referralPoints) / config.pointsPerUsdt) * 1e6);
  check("margin = revenue - (task points + referral points)", m.marginMicro === expected,
    `${m.marginMicro} vs ${expected}`);

  // And the same numbers reach the panel.
  const list = (await app.inject({ method: "GET", url: "/staff/tasks", headers: authOf(admin) })).json();
  const row = list.tasks.find((x: { id: string }) => x.id === t);
  check("the staff list serves them pre-computed", row?.revenueMicro === 1_500_000
    && row?.spentConversions === 3 && row?.marginMicro === expected, JSON.stringify(row?.marginMicro));
}

// ---------------------------------------------------------------------------
console.log("\n-- a losing campaign is reported as losing, not hidden --");
{
  // $0.01 in, 500 points (= $0.50) out. Every conversion loses money.
  const t = await mkTask({ points: 500, revenueMicro: 10_000 });
  const u = await mkUser("loss1");
  await credit(u, t, 500, "loss-a");
  const m = (await campaignMoney(config.pointsPerUsdt)).get(t)!;
  check("margin is negative", m.marginMicro < 0, String(m.marginMicro));
}

// ---------------------------------------------------------------------------
console.log("\n-- budgetUsedPct is null for an uncapped campaign, never 0 --");
// An uncapped campaign is not "0% used", and a progress bar frozen at 0% is how
// one gets mistaken for a budget that is not moving.
{
  const list = (await app.inject({ method: "GET", url: "/staff/tasks", headers: authOf(admin) })).json();
  const uncapped = list.tasks.find((x: { budget_conversions: number | null }) => x.budget_conversions === null);
  check("no cap => budgetUsedPct is null", uncapped?.budgetUsedPct === null, JSON.stringify(uncapped?.budgetUsedPct));
  const capped = list.tasks.find((x: { budget_conversions: number | null }) => x.budget_conversions !== null);
  check("a cap => a real percentage", typeof capped?.budgetUsedPct === "number", JSON.stringify(capped?.budgetUsedPct));
}

// ---------------------------------------------------------------------------
console.log("\n-- the pure arithmetic, at its edges --");
{
  const none = { budget_conversions: null, budget_points: null };
  check("no caps is never over budget", overBudget(none, { conversions: 9e9, points: 9e9 }, 1).ok);
  check("exactly at the conversion cap refuses the next one",
    !overBudget({ budget_conversions: 5, budget_points: null }, { conversions: 5, points: 0 }, 1).ok);
  check("one under the conversion cap allows it",
    overBudget({ budget_conversions: 5, budget_points: null }, { conversions: 4, points: 0 }, 1).ok);
  check("landing exactly ON the points cap is allowed",
    overBudget({ budget_conversions: null, budget_points: 100 }, { conversions: 0, points: 60 }, 40).ok);
  check("one point over the points cap is refused",
    !overBudget({ budget_conversions: null, budget_points: 100 }, { conversions: 0, points: 60 }, 41).ok);
  check("a zero-point completion never breaks a points cap",
    overBudget({ budget_conversions: null, budget_points: 100 }, { conversions: 0, points: 100 }, 0).ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
// Always exit explicitly — PGlite keeps the event loop alive otherwise.
process.exit(fail > 0 ? 1 : 0);
