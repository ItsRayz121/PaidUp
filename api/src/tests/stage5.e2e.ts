// E2E for the admin operations rebuild, stage 5 — machines, referral admin and
// the leaderboard (brief parts 38/41/42).
//
// WHY THIS FILE EXISTS
// --------------------
// The same reason stage4.e2e.ts and analytics.e2e.ts do, and by now it has
// earned its keep twice in two stages: `networks.label` (a column that does not
// exist) and `chain`/`address`/`note` (three columns that do not exist) both
// typechecked cleanly and would both have 500'd the first admin who opened the
// screen. TypeScript cannot see inside a SQL string. Every query added in this
// stage is executed here against real Postgres before it is believed.
//
// It also pins the three properties that are easy to write wrong and impossible
// to notice from the panel:
//
//   1. THE ADVERTISED REFERRAL RATE IS THE MIN ACROSS *ACTIVE* NETWORKS. That
//      is what /referrals/me promises users. If this screen computed it over
//      all rows, a disabled network with a 0% rate would report the platform as
//      paying 0% — and an admin would "fix" a number that was never broken.
//
//   2. A LEADERBOARD EXCLUSION HIDES THE USER FROM THE EARNER BOARD TOO, AND
//      IMMEDIATELY. The board is cached for a minute; without the cache bust an
//      admin hides a seeded test account, reloads, still sees it, and clicks
//      again.
//
//   3. MACHINE BURN IS REPORTED AS A MAGNITUDE. Both ledgers store a debit as a
//      negative number, so the naive SUM is negative and "burned −1,400 ROZI"
//      reads as a refund.
//
//   npm run test:stage5
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import {
  initDb, sql, now, newId, postLedger, postRozi, postUsdt, setSetting,
} from "../db.ts";
import { config } from "../config.ts";
import { appRoutes } from "../routes/app.ts";
import { staffGrowthRoutes } from "../routes/staffGrowth.ts";
import { staffMiningRoutes } from "../routes/staffMining.ts";
import { invalidateLeaderboard } from "../leaderboard.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(appRoutes);
await app.register(staffGrowthRoutes);
await app.register(staffMiningRoutes);

const TAG = newId().slice(0, 8);
const tok = (id: string) => jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: "1h" });
const authOf = (id: string) => ({ authorization: `Bearer ${tok(id)}` });

// The referral code is UNIQUE and short — build it from a counter, not the
// label, or two labels truncate to the same string and the run dies on a
// unique violation before the first check (see stage4.e2e.ts).
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

const admin = await mkStaff("admin", "admin");
const marketing = await mkStaff("marketing", "marketing");
const support = await mkStaff("support", "support");
const analyst = await mkStaff("analyst", "analyst");

// ---------------------------------------------------------------------------
console.log("\n-- part 38: the machine endpoints RUN, and report what was really spent --");
{
  // A rig nobody has bought, and a rig two people have. The first is the case
  // the panel exists to surface — a sink that never ran.
  const cold = `${TAG}-cold`;
  const hot = `${TAG}-hot`;
  for (const [id, name] of [[cold, "Cold rig"], [hot, "Hot rig"]]) {
    await sql.run(
      `INSERT INTO rigs (id, name, icon, base_cost, base_power, sort, created_at)
       VALUES (?,?, 'chip', 100, 10, 99, ?)`, id, name, now(),
    );
  }
  const buyer1 = await mkUser("buyer1");
  const buyer2 = await mkUser("buyer2");
  for (const [u, level] of [[buyer1, 2], [buyer2, 1]] as [string, number][]) {
    await sql.run(
      "INSERT INTO user_rigs (user_id, rig_id, level, updated_at) VALUES (?,?,?,?)",
      u, hot, level, now(),
    );
  }
  // A level-0 row: looked at, never bought. Must NOT count as an owner.
  await sql.run(
    "INSERT INTO user_rigs (user_id, rig_id, level, updated_at) VALUES (?,?,0,?)",
    buyer1, cold, now(),
  );
  await postRozi({ userId: buyer1, micro: 1_000_000, direction: "debit", sourceType: "rig_purchase", sourceRefId: hot });
  await postRozi({ userId: buyer2, micro: 2_000_000, direction: "debit", sourceType: "rig_purchase", sourceRefId: hot });
  await postUsdt({ userId: buyer1, micro: 5_000_000, direction: "credit", sourceType: "topup", chain: "bep20" });
  await postUsdt({ userId: buyer1, micro: 4_000_000, direction: "debit", sourceType: "rig_purchase", sourceRefId: hot });

  const r = await app.inject({ method: "GET", url: "/staff/mining/rigs", headers: authOf(admin) });
  check("200, not a 500 from a mistyped column", r.statusCode === 200, r.body.slice(0, 300));
  const rigs = r.json().rigs as Record<string, number | string>[];
  const h = rigs.find((x) => x.id === hot)!;
  const c = rigs.find((x) => x.id === cold)!;
  check("owners counts holders, not rows", h.owners === 2, JSON.stringify(h));
  check("a level-0 row is not an owner", c.owners === 0 && c.levelsSold === 0, JSON.stringify(c));
  check("levels sold is the sum of levels", h.levelsSold === 3, String(h.levelsSold));
  // 3 ROZI burned, reported POSITIVE. The ledger holds -3_000_000.
  check("ROZI burn is a magnitude, never negative", h.roziBurned === 3, String(h.roziBurned));
  check("USDT spend is a magnitude too", h.usdtSpent === 4, String(h.usdtSpent));
  check("a machine nobody bought reports zero, not null", c.roziBurned === 0 && c.usdtSpent === 0);
}

{
  const bid = newId();
  await sql.run(
    "INSERT INTO boosters (id, name, price_points, multiplier_pct, hours, status, created_at) VALUES (?,?,?,?,?, 'active', ?)",
    bid, `${TAG} booster`, 500, 100, 4, now(),
  );
  const spender = await mkUser("spender");
  await postLedger({ userId: spender, points: 10_000, direction: "credit", sourceType: "admin_adjustment", note: "t" });
  await postLedger({ userId: spender, points: 500, direction: "debit", sourceType: "booster_purchase", sourceRefId: bid });
  await postLedger({ userId: spender, points: 500, direction: "debit", sourceType: "booster_purchase", sourceRefId: bid });

  const r = await app.inject({ method: "GET", url: "/staff/mining/boosters", headers: authOf(admin) });
  check("boosters: 200, not a 500", r.statusCode === 200, r.body.slice(0, 300));
  const b = (r.json().boosters as Record<string, number | string>[]).find((x) => x.id === bid)!;
  check("purchases are counted", b.purchases === 2, JSON.stringify(b));
  check("points spent is a magnitude, from the ledger", b.pointsSpent === 1000, String(b.pointsSpent));
}

// ---------------------------------------------------------------------------
console.log("\n-- part 41: the advertised rate is the MIN across ACTIVE networks --");
{
  // Three rows: a generous active one, a stingy active one, and a DISABLED row
  // that is stingier than both. The advertised figure must follow the stingy
  // ACTIVE row and ignore the disabled one entirely.
  const rich = `${TAG}rich`, poor = `${TAG}poor`, dead = `${TAG}dead`;
  await sql.run(
    `INSERT INTO networks (id, name, type, status, commission_split_pct, referral_bonus_pct, referral_bonus_pct_l2, referral_first_task_bonus, referral_bonus_days, created_at)
     VALUES (?,?, 'offerwall','active', 60, 20, 8, 300, 0, ?)`, rich, "Rich", now());
  await sql.run(
    `INSERT INTO networks (id, name, type, status, commission_split_pct, referral_bonus_pct, referral_bonus_pct_l2, referral_first_task_bonus, referral_bonus_days, created_at)
     VALUES (?,?, 'offerwall','active', 60, 12, 4, 150, 0, ?)`, poor, "Poor", now());
  await sql.run(
    `INSERT INTO networks (id, name, type, status, commission_split_pct, referral_bonus_pct, referral_bonus_pct_l2, referral_first_task_bonus, referral_bonus_days, created_at)
     VALUES (?,?, 'offerwall','disabled', 60, 1, 1, 1, 5, ?)`, dead, "Dead", now());

  const r = await app.inject({ method: "GET", url: "/staff/referrals", headers: authOf(admin) });
  check("200, not a 500 from a mistyped column", r.statusCode === 200, r.body.slice(0, 300));
  const d = r.json();

  // The seeded networks (cpx, custom, …) all sit at 15/5/100, so the floor is
  // the "poor" row above and NOT the disabled 1/1/1.
  check("advertised L1 is the lowest ACTIVE rate", d.advertised.l1 === 12, JSON.stringify(d.advertised));
  check("advertised L2 is the lowest ACTIVE rate", d.advertised.l2 === 4, JSON.stringify(d.advertised));
  check("advertised first-task bonus is the lowest ACTIVE one", d.advertised.firstTaskBonus === 100,
    JSON.stringify(d.advertised));
  check("a DISABLED network cannot drag the advertised rate down",
    d.advertised.l1 !== 1 && d.advertised.l2 !== 1 && d.advertised.firstTaskBonus !== 1);
  // Every seeded network is lifetime (days = 0) and so are the two new active
  // rows, so the honest answer is "lifetime" — NOT the disabled row's 5 days.
  check("a window of 0 means lifetime, and one limited row does not become the floor",
    d.advertised.windowDays === 0, String(d.advertised.windowDays));
  check("the rows pinning the advertised rate are named", (d.pinning as string[]).includes(poor),
    JSON.stringify(d.pinning));
  check("margin and headroom are served, not left to the panel",
    d.networks.find((n: { id: string }) => n.id === poor)?.marginPct === 40 &&
    d.networks.find((n: { id: string }) => n.id === poor)?.headroomPct === 24);

  // Now make every active network limited, and the floor becomes the shortest.
  await sql.run("UPDATE networks SET referral_bonus_days = 30 WHERE status = 'active'");
  await sql.run("UPDATE networks SET referral_bonus_days = 7 WHERE id = ?", poor);
  const r2 = await app.inject({ method: "GET", url: "/staff/referrals", headers: authOf(admin) });
  check("when every active network is limited, the floor is the SHORTEST window",
    r2.json().advertised.windowDays === 7, String(r2.json().advertised.windowDays));
  await sql.run("UPDATE networks SET referral_bonus_days = 0");
}

console.log("\n-- part 41: the totals are derived from the ledger, not a counter --");
{
  const inviter = await mkUser("inviter");
  const worker = await mkUser("worker", inviter);
  const lurker = await mkUser("lurker", inviter);
  await postLedger({ userId: inviter, points: 250, direction: "credit", sourceType: "referral_bonus", note: "t" });
  await postLedger({ userId: worker, points: 40, direction: "credit", sourceType: "task_completion", note: "t" });
  await sql.run(
    `INSERT INTO task_completions (id, user_id, network, external_id, status, points, offer_type, created_at)
     VALUES (?,?, 'cpx', ?, 'credited', 40, 'survey', ?)`,
    newId(), worker, newId(), now(),
  );

  const d = (await app.inject({ method: "GET", url: "/staff/referrals", headers: authOf(admin) })).json();
  check("referral points paid include this credit", d.totals.paidAll >= 250, JSON.stringify(d.totals));
  check("referred users are counted", d.totals.referredUsers >= 2, String(d.totals.referredUsers));
  check("an invite that did a task counts as activated, one that did nothing does not",
    d.totals.activatedUsers >= 1 && d.totals.activatedUsers < d.totals.referredUsers,
    JSON.stringify({ a: d.totals.activatedUsers, r: d.totals.referredUsers }));
  check("activation rate is a whole percent, computed once",
    d.totals.activationPct === Math.round((d.totals.activatedUsers / d.totals.referredUsers) * 100));

  const me = (d.topReferrers as { id: string; invites: number; activeInvites: number; points: number }[])
    .find((x) => x.id === inviter);
  check("the inviter appears in the top list with real counts",
    me?.invites === 2 && me?.activeInvites === 1 && me?.points === 250, JSON.stringify(me));
  check("open fraud flags ride along, so a ring is visible on the same row",
    typeof (d.topReferrers as { openFlags: number }[])[0]?.openFlags === "number");
  // A lurker with no completion must not be counted as active.
  check("an invite with no credited task is not 'active'",
    !(d.topReferrers as { id: string }[]).some((x) => x.id === lurker));
}

// ---------------------------------------------------------------------------
console.log("\n-- part 42: the leaderboard, and what an exclusion really does --");
const star = await mkUser("star");
{
  // A big, obvious top earner — the shape of a seeded test account sitting at
  // rank 1 on a board whose whole job is social proof.
  await postLedger({ userId: star, points: 9_000_000, direction: "credit", sourceType: "task_completion", note: "t" });
  await postLedger({ userId: star, points: 500_000, direction: "credit", sourceType: "referral_bonus", note: "t" });
  invalidateLeaderboard();

  const r = await app.inject({ method: "GET", url: "/staff/leaderboard", headers: authOf(admin) });
  check("200, not a 500 from a mistyped column", r.statusCode === 200, r.body.slice(0, 300));
  const d = r.json();
  check("staff see the REAL email, not a masked handle — they have to act on it",
    d.topEarners[0]?.email?.includes("@"), JSON.stringify(d.topEarners[0]));
  check("the seeded account is at rank 1, which is the problem this screen exists for",
    d.topEarners[0]?.id === star, JSON.stringify(d.topEarners[0]));
  check("the on/off flag is reported next to the board", typeof d.enabled === "boolean");
  check("exclusions come back with the board, not from a second call", Array.isArray(d.exclusions));

  // And the earner board shows the same person, masked.
  const pub = (await app.inject({ method: "GET", url: "/leaderboard", headers: authOf(star) })).json();
  check("the earner board masks the name", !String(pub.topEarners[0]?.name ?? "").includes("@"),
    JSON.stringify(pub.topEarners[0]));
  check("the earner board flags the caller's own row", pub.topEarners[0]?.isMe === true);
}

{
  const r = await app.inject({
    method: "POST", url: "/staff/leaderboard/exclusions", headers: authOf(admin),
    payload: { userId: star, reason: "seeded test account" },
  });
  check("excluding a user works", r.statusCode === 200, r.body);

  const staffBoard = (await app.inject({ method: "GET", url: "/staff/leaderboard", headers: authOf(admin) })).json();
  check("the staff board drops them straight away — the cache is busted, not waited out",
    !(staffBoard.topEarners as { id: string }[]).some((x) => x.id === star));
  check("and they are listed as hidden, with the reason",
    (staffBoard.exclusions as { userId: string; reason: string }[])
      .some((x) => x.userId === star && x.reason === "seeded test account"));

  // ⚠️ The one that matters: the EARNER board must drop them too. A staff-only
  // filter would be a screen that lies to the person reading it.
  const pub = (await app.inject({ method: "GET", url: "/leaderboard", headers: authOf(star) })).json();
  check("the EARNER board drops them too", !(pub.topEarners as { isMe: boolean }[]).some((x) => x.isMe));
  check("and off the referrer board as well", !(pub.topReferrers as { isMe: boolean }[]).some((x) => x.isMe));
}

{
  const r = await app.inject({
    method: "POST", url: "/staff/leaderboard/exclusions", headers: authOf(admin),
    payload: { userId: star, reason: "under review" },
  });
  check("re-hiding an already-hidden user updates the reason instead of failing", r.statusCode === 200, r.body);
  const d = (await app.inject({ method: "GET", url: "/staff/leaderboard", headers: authOf(admin) })).json();
  check("the new reason is what is stored",
    (d.exclusions as { userId: string; reason: string }[]).find((x) => x.userId === star)?.reason === "under review");

  check("a reason is required", (await app.inject({
    method: "POST", url: "/staff/leaderboard/exclusions", headers: authOf(admin),
    payload: { userId: star },
  })).statusCode === 400);
  check("an unknown user is 404, not a row against a ghost", (await app.inject({
    method: "POST", url: "/staff/leaderboard/exclusions", headers: authOf(admin),
    payload: { userId: "nope", reason: "x" },
  })).statusCode === 404);

  const del = await app.inject({
    method: "DELETE", url: `/staff/leaderboard/exclusions/${star}`, headers: authOf(admin),
  });
  check("un-hiding works", del.statusCode === 200, del.body);
  const back = (await app.inject({ method: "GET", url: "/staff/leaderboard", headers: authOf(admin) })).json();
  check("and they are back on the board immediately", (back.topEarners as { id: string }[]).some((x) => x.id === star));
  check("un-hiding someone who is not hidden is 404", (await app.inject({
    method: "DELETE", url: `/staff/leaderboard/exclusions/${star}`, headers: authOf(admin),
  })).statusCode === 404);
}

{
  // The board is computed either way; the flag only decides what USERS see. The
  // staff screen says which it is, so it cannot be read as "this is live".
  await setSetting("flag.leaderboard", "0");
  const d = (await app.inject({ method: "GET", url: "/staff/leaderboard", headers: authOf(admin) })).json();
  check("with the flag off, the staff screen says so", d.enabled === false);
  check("but staff can still see the board to work on it", d.topEarners.length > 0);
  const pub = (await app.inject({ method: "GET", url: "/leaderboard", headers: authOf(star) })).json();
  check("while the earner board is empty", pub.topEarners.length === 0);
  await setSetting("flag.leaderboard", "1");
}

// ---------------------------------------------------------------------------
console.log("\n-- the permissions these screens are gated on --");
{
  // Marketing exists to run growth. If it cannot reach these two screens, the
  // role is decorative (permissions.ts already grants it both).
  check("marketing can read the referral screen",
    (await app.inject({ method: "GET", url: "/staff/referrals", headers: authOf(marketing) })).statusCode === 200);
  check("marketing can read the leaderboard screen",
    (await app.inject({ method: "GET", url: "/staff/leaderboard", headers: authOf(marketing) })).statusCode === 200);
  check("marketing can hide someone", (await app.inject({
    method: "POST", url: "/staff/leaderboard/exclusions", headers: authOf(marketing),
    payload: { userId: star, reason: "growth call" },
  })).statusCode === 200);
  await app.inject({ method: "DELETE", url: `/staff/leaderboard/exclusions/${star}`, headers: authOf(marketing) });

  check("support cannot reach the referral rates",
    (await app.inject({ method: "GET", url: "/staff/referrals", headers: authOf(support) })).statusCode === 403);
  check("support cannot reach the leaderboard controls",
    (await app.inject({ method: "GET", url: "/staff/leaderboard", headers: authOf(support) })).statusCode === 403);
  // The property that makes analyst the safe role to hand out: read-only means
  // it holds no write permission at all, so it cannot reach a write route.
  check("an analyst cannot hide anyone", (await app.inject({
    method: "POST", url: "/staff/leaderboard/exclusions", headers: authOf(analyst),
    payload: { userId: star, reason: "x" },
  })).statusCode === 403);
  check("machines stay admin-only — a marketing role cannot reprice a rig",
    (await app.inject({ method: "GET", url: "/staff/mining/rigs", headers: authOf(marketing) })).statusCode === 403);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
