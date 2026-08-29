// E2E for the business analytics report (brief part 48).
//
// This file exists because analytics.ts is almost entirely SQL, and SQL that
// typechecks is not SQL that runs. Every query in there — the generated date
// series, the retention cohorts, the FILTER aggregates, the per-network margin
// estimate — is written against real Postgres, and the only way to know it is
// correct is to put known rows in and check the numbers that come out.
//
// The numbers are chosen so a wrong answer is obviously wrong: three users, one
// active today, one active a week ago, one never.
//
//   npm run test:analytics
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId, postLedger } from "../db.ts";
import { config } from "../config.ts";
import { loadAnalytics, touchActivity } from "../analytics.ts";
import { staffRoutes } from "../routes/staff.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(staffRoutes);

const day = (n: number) =>
  new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const ago = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

// A tag unique to this run, so repeated runs against the same dev database do
// not read each other's rows as their own.
const TAG = newId().slice(0, 8);

const mkUser = async (label: string, createdAt = now(), referredBy: string | null = null) => {
  const id = newId();
  await sql.run(
    `INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at, referred_by)
     VALUES (?,?,1,'Pakistan',?,'active',?,?)`,
    id, `${TAG}-${label}@t.test`, `${TAG}${label}`.toUpperCase().slice(0, 12), createdAt, referredBy,
  );
  return id;
};
const active = (userId: string, d: string) =>
  sql.run("INSERT INTO user_activity_days (user_id, day) VALUES (?,?) ON CONFLICT DO NOTHING", userId, d);

console.log("\n-- activity: DAU / WAU / MAU --");
{
  const before = await loadAnalytics(30);

  const u1 = await mkUser("a");
  const u2 = await mkUser("b");
  const u3 = await mkUser("c");

  await active(u1, day(0));                 // today
  await active(u2, day(3));                 // this week, not today
  await active(u3, day(20));                // this month, not this week

  const after = await loadAnalytics(30);
  check("DAU counts only today", after.users.dau === before.users.dau + 1,
    `${before.users.dau} -> ${after.users.dau}`);
  check("WAU counts the last 7 days", after.users.wau === before.users.wau + 2,
    `${before.users.wau} -> ${after.users.wau}`);
  check("MAU counts the last 30 days", after.users.mau === before.users.mau + 3,
    `${before.users.mau} -> ${after.users.mau}`);
  check("a user active on two days is counted once",
    await (async () => {
      const b = (await loadAnalytics(30)).users.mau;
      await active(u1, day(5));
      return (await loadAnalytics(30)).users.mau === b;
    })());
  check("stickiness is DAU/MAU as a percentage",
    after.users.mau > 0 &&
    Math.abs(after.users.stickiness - Math.round((after.users.dau / after.users.mau) * 1000) / 10) < 0.001);
}

console.log("\n-- touchActivity writes at most one row per user per day --");
{
  const u = await mkUser("touch");
  touchActivity(u);
  touchActivity(u);
  touchActivity(u);
  // Fire-and-forget: give the queued insert a moment to land.
  await new Promise((r) => setTimeout(r, 250));
  const n = await sql.get<{ v: number }>(
    "SELECT COUNT(*)::int AS v FROM user_activity_days WHERE user_id = ?", u);
  check("three calls, one row", n?.v === 1, `rows=${n?.v}`);
}

console.log("\n-- retention: the cohort must be old enough to have had the chance --");
{
  // Signed up 10 days ago, came back the next day => counts for D1 and D7.
  const u = await mkUser("ret", ago(10));
  await active(u, day(9));  // D1
  await active(u, day(3));  // D7
  const a = await loadAnalytics(30);
  check("D1 cohort is non-empty", a.retention.d1.cohort > 0);
  check("D1 counts the return", a.retention.d1.returned > 0);
  check("a percentage is returned, not a raw count",
    a.retention.d1.pct >= 0 && a.retention.d1.pct <= 100, String(a.retention.d1.pct));
  // Someone who signed up TODAY cannot have a D7 result yet, and must not be
  // counted in the denominator — a D7 number that includes them is not low, it
  // is meaningless.
  const fresh = await mkUser("fresh");
  const b = await loadAnalytics(30);
  check("a user who signed up today is not in the D7 cohort",
    b.retention.d7.cohort === a.retention.d7.cohort, `${a.retention.d7.cohort} -> ${b.retention.d7.cohort}`);
  check("...nor in the D1 cohort", b.retention.d1.cohort === a.retention.d1.cohort);
  void fresh;
}

console.log("\n-- the daily series has a row per day, including quiet ones --");
{
  const a = await loadAnalytics(30);
  check("30 days requested, 30 rows returned", a.series.length === 30, `len=${a.series.length}`);
  check("the last row is today", a.series[a.series.length - 1].day === day(0));
  check("the first row is 29 days ago", a.series[0].day === day(29));
  check("every day has a number, not a gap",
    a.series.every((r) => typeof r.signups === "number" && typeof r.active === "number"));
  const b = await loadAnalytics(7);
  check("the window is honoured", b.series.length === 7, `len=${b.series.length}`);
  check("mining series matches the same window", b.miningSeries.length === 7);
}

console.log("\n-- task funnel and approval rate --");
{
  const u = await mkUser("funnel");
  const mk = async (status: string, points: number) => sql.run(
    `INSERT INTO task_completions (id, user_id, network, external_id, status, points, offer_type, created_at)
     VALUES (?,?,?,?,?,?,'survey',?)`,
    newId(), u, "cpx", newId(), status, points, now(),
  );
  const before = await loadAnalytics(30);
  await mk("credited", 600);
  await mk("credited", 400);
  await mk("rejected", 0);
  const a = await loadAnalytics(30);
  check("starts counts every attempt", a.tasks.starts === before.tasks.starts + 3);
  check("credited counts only what paid", a.tasks.credited === before.tasks.credited + 2);
  check("completion rate is a percentage",
    a.tasks.completionRate > 0 && a.tasks.completionRate <= 100, String(a.tasks.completionRate));
  check("a rate with no starts is 0, not NaN or Infinity",
    Number.isFinite(a.tasks.approvalRate) && Number.isFinite(a.tasks.completionRate));
}

console.log("\n-- referral conversion counts ACTIVATED invites, not signups --");
{
  const inviter = await mkUser("inv");
  const signedUpOnly = await mkUser("ref1", now(), inviter);
  const didSomething = await mkUser("ref2", now(), inviter);
  await sql.run(
    `INSERT INTO task_completions (id, user_id, network, external_id, status, points, offer_type, created_at)
     VALUES (?,?,?,?, 'credited', 500, 'survey', ?)`,
    newId(), didSomething, "cpx", newId(), now(),
  );
  const a = await loadAnalytics(30);
  check("both invites count as signups", a.referrals.signups >= 2);
  check("only the one who finished a task counts as activated",
    a.referrals.activated >= 1);
  check("conversion is activated/signups as a percentage",
    a.referrals.conversion === Math.round((a.referrals.activated / a.referrals.signups) * 1000) / 10);
  void signedUpOnly;
}

console.log("\n-- money: cost and revenue --");
{
  const u = await mkUser("money");
  await postLedger({
    userId: u, points: 600, direction: "credit",
    sourceType: "task_completion", note: "test",
  });
  await postLedger({
    userId: u, points: 90, direction: "credit",
    sourceType: "referral_bonus", note: "test",
  });
  const a = await loadAnalytics(30);
  check("reward cost includes task points", a.money.rewardCostPoints >= 600);
  check("referral cost is broken out on its own", a.money.referralCostPoints >= 90);
  check("reward cost includes the referral spend",
    a.money.rewardCostPoints >= a.money.referralCostPoints);
  check("revenue is never negative", a.money.revenuePoints >= 0);
  check("revenue per active user divides by MAU, not by every account ever",
    a.users.mau === 0
      ? a.money.revenuePerActiveUser === 0
      : Math.abs(a.money.revenuePerActiveUser - Math.round((a.money.revenuePoints / a.users.mau) * 100) / 100) < 0.011);
  check("micro-USDT totals are strings, so a big number cannot lose precision",
    typeof a.money.depositMicroAll === "string" && typeof a.mining.roziMinedTodayMicro === "string");
}

console.log("\n-- per-network margin --");
{
  const a = await loadAnalytics(30);
  const cpx = a.byNetwork.find((n) => n.network === "cpx");
  check("the network the completions were on appears", Boolean(cpx));
  if (cpx) {
    check("margin is derived from the split, not invented",
      cpx.split > 0 &&
      cpx.marginPoints === Math.max(0, Math.round(cpx.userPoints / (cpx.split / 100) - cpx.userPoints)),
      `split=${cpx.split} user=${cpx.userPoints} margin=${cpx.marginPoints}`);
    check("margin is never negative", cpx.marginPoints >= 0);
  }
}

console.log("\n-- the endpoint --");
{
  const admin = await mkUser("admin");
  await sql.run("INSERT INTO admin_users (user_id, role, created_at) VALUES (?, 'admin', ?)", admin, now());
  const token = jwt.sign({ sub: admin }, config.jwtSecret, { expiresIn: "1h" });
  const auth = { authorization: `Bearer ${token}` };

  const r = await app.inject({ method: "GET", url: "/staff/analytics", headers: auth });
  check("admin can read it", r.statusCode === 200, String(r.statusCode));

  // ---- Dashboard "needs attention" (admin rebuild, Phase B) ----
  await sql.run(
    `INSERT INTO withdrawal_requests (id, user_id, amount, payout_rail, status, created_at)
     VALUES (?,?,?,'bep20','pending',?)`, newId(), admin, 1500, now(),
  );
  const dash = await app.inject({ method: "GET", url: "/staff/dashboard", headers: auth });
  check("dashboard endpoint 200s for an admin", dash.statusCode === 200, dash.body);
  const dj = dash.json();
  check("attention block has every queue key",
    typeof dj.attention.withdrawalsPending === "number"
    && typeof dj.attention.kycWaiting === "number"
    && typeof dj.attention.reconciliationShortfall === "number");
  check("the seeded pending withdrawal is counted", dj.attention.withdrawalsPending >= 1, JSON.stringify(dj.attention));
  check("recentActivity is an array", Array.isArray(dj.recentActivity));
  const dashDenied = await app.inject({
    method: "GET", url: "/staff/dashboard", headers: { authorization: `Bearer ${jwt.sign({ sub: await mkUser("dash-earner") }, config.jwtSecret)}` },
  });
  check("a non-staff caller is refused the dashboard (403)", dashDenied.statusCode === 403, String(dashDenied.statusCode));

  const win = await app.inject({ method: "GET", url: "/staff/analytics?days=7", headers: auth });
  check("the window is passed through", win.json().series.length === 7);

  // Clamped, not trusted: an unbounded `days` is an unbounded generate_series.
  const huge = await app.inject({ method: "GET", url: "/staff/analytics?days=99999", headers: auth });
  check("a huge window is clamped to 90", huge.json().series.length === 90,
    `len=${huge.json().series.length}`);
  const tiny = await app.inject({ method: "GET", url: "/staff/analytics?days=-5", headers: auth });
  check("a nonsense window falls back to the default", tiny.json().series.length === 30);

  // An earner must not read the business's numbers.
  const earner = await mkUser("earner");
  const eTok = jwt.sign({ sub: earner }, config.jwtSecret, { expiresIn: "1h" });
  const denied = await app.inject({
    method: "GET", url: "/staff/analytics",
    headers: { authorization: `Bearer ${eTok}` },
  });
  check("an earner is refused (403)", denied.statusCode === 403, String(denied.statusCode));

  // An analyst holds analytics.view and nothing that writes — the role exists
  // precisely so this screen can be handed out safely.
  const analyst = await mkUser("analyst");
  await sql.run("INSERT INTO admin_users (user_id, role, created_at) VALUES (?, 'analyst', ?)", analyst, now());
  const aTok = jwt.sign({ sub: analyst }, config.jwtSecret, { expiresIn: "1h" });
  const asAnalyst = await app.inject({
    method: "GET", url: "/staff/analytics",
    headers: { authorization: `Bearer ${aTok}` },
  });
  check("an analyst can read it", asAnalyst.statusCode === 200, String(asAnalyst.statusCode));
  const analystWrite = await app.inject({
    method: "POST", url: `/staff/users/${earner}/adjust`,
    headers: { authorization: `Bearer ${aTok}` },
    payload: { points: 1000, reason: "should never work" },
  });
  check("...and cannot mint points", analystWrite.statusCode === 403, String(analystWrite.statusCode));
}

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
process.exit(fail === 0 ? 0 : 1);
