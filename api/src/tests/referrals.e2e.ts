// E2E for GET /referrals/me — the numbers the invite screens advertise.
//
// This endpoint now serves the REWARD RATES, not just the counters, because the
// home / refer / wallet screens print "you get N% of what your friends earn".
// That makes it a promise surface: whatever comes out of here is what a user
// repeats to their friends over WhatsApp, and it has to match what credit.ts
// will actually pay them.
//
// So the two things pinned hardest are:
//   • the advertised rate is the MINIMUM across ACTIVE networks — never a rate
//     some network does not pay, and never a rate from a DISABLED one
//   • friends-of-friends are counted one level deep and no further
//
//   npm run test:referrals
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId, postLedger } from "../db.ts";
import { config } from "../config.ts";
import { appRoutes } from "../routes/app.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(appRoutes);

const mkUser = async (label: string) => {
  const id = newId();
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at) VALUES (?,?,1,'Pakistan',?,'active',?)",
    id, `${label}-${id}@t.test`, id.slice(0, 8).toUpperCase(), now(),
  );
  return id;
};
const link = (referrer: string, referred: string) => sql.run(
  "INSERT INTO referrals (id, referrer_user_id, referred_user_id, created_at) VALUES (?,?,?,?)",
  newId(), referrer, referred, now(),
);
const me = async (userId: string) => {
  const res = await app.inject({
    method: "GET", url: "/referrals/me",
    headers: { authorization: `Bearer ${jwt.sign({ sub: userId }, config.jwtSecret)}` },
  });
  return { status: res.statusCode, body: res.json() };
};

// PGlite persists between runs, so the network rows this test writes are torn
// down at the end — otherwise the SECOND run reads the first run's leftovers.
const TEST_NETS = ["e2e-ref-low", "e2e-ref-high", "e2e-ref-off"];
const mkNetwork = (id: string, status: string, l1: number, l2: number, first: number) => sql.run(
  `INSERT INTO networks (id, name, type, status, commission_split_pct, referral_bonus_pct,
                         referral_bonus_pct_l2, referral_first_task_bonus, created_at)
   VALUES (?,?,'offerwall',?,60,?,?,?,?)`,
  id, id, status, l1, l2, first, now(),
);
const cleanupNets = () => sql.run(
  `DELETE FROM networks WHERE id IN (${TEST_NETS.map(() => "?").join(",")})`, ...TEST_NETS,
);
await cleanupNets();

console.log("\n-- counting friends, and friends of friends --");

// alice -> bob -> carol, plus alice -> dave. One level down = 2, two levels = 1.
const alice = await mkUser("alice");
const bob = await mkUser("bob");
const carol = await mkUser("carol");
const dave = await mkUser("dave");
const erin = await mkUser("erin"); // carol's invite: THREE levels below alice
await link(alice, bob);
await link(alice, dave);
await link(bob, carol);
await link(carol, erin);

let r = await me(alice);
check("endpoint answers", r.status === 200, `status=${r.status}`);
check("counts direct friends", r.body.joined === 2, `got ${r.body.joined}`);
check("counts friends of friends", r.body.joined2 === 1, `got ${r.body.joined2}`);
// The bonus is paid two levels deep and no further (credit.ts), so the counter
// must stop there too. Counting erin here would advertise a level we never pay.
check("does NOT count three levels down", r.body.joined2 === 1, `got ${r.body.joined2}`);

r = await me(bob);
check("each user sees their OWN tree", r.body.joined === 1 && r.body.joined2 === 1,
  `joined=${r.body.joined} joined2=${r.body.joined2}`);

r = await me(erin);
check("someone with no invites sees zeroes", r.body.joined === 0 && r.body.joined2 === 0);

console.log("\n-- the advertised rate is a floor we always meet --");

await mkNetwork("e2e-ref-low", "active", 12, 4, 80);
await mkNetwork("e2e-ref-high", "active", 25, 9, 500);
r = await me(alice);
check("advertises the LOWEST active L1 rate, not the best one",
  r.body.rewards.l1Pct === 12, `got ${r.body.rewards.l1Pct}`);
check("advertises the LOWEST active L2 rate", r.body.rewards.l2Pct === 4, `got ${r.body.rewards.l2Pct}`);
check("advertises the LOWEST active first-task bonus",
  r.body.rewards.firstTaskBonus === 80, `got ${r.body.rewards.firstTaskBonus}`);

// A network an Admin switched OFF pays nothing, so its rate must not drag the
// advertised floor down — the user would see a number no live offer can pay.
await mkNetwork("e2e-ref-off", "disabled", 1, 1, 1);
r = await me(alice);
check("a DISABLED network cannot lower the advertised rate",
  r.body.rewards.l1Pct === 12 && r.body.rewards.firstTaskBonus === 80,
  `l1=${r.body.rewards.l1Pct} first=${r.body.rewards.firstTaskBonus}`);

console.log("\n-- mining speed from friends is advertised too --");

check("serves the referral mining percentages",
  typeof r.body.rewards.miningL1Pct === "number" && r.body.rewards.miningL1Pct > 0
  && typeof r.body.rewards.miningL2Pct === "number" && r.body.rewards.miningL2Pct > 0,
  JSON.stringify(r.body.rewards));
check("a friend's friend is worth less than a friend, in both currencies",
  r.body.rewards.l2Pct < r.body.rewards.l1Pct
  && r.body.rewards.miningL2Pct < r.body.rewards.miningL1Pct);

console.log("\n-- earnings still come from the ledger --");

check("earnedPoints starts at zero for a user with no bonuses", r.body.earnedPoints === 0);
await postLedger({
  userId: alice, points: 250, direction: "credit",
  sourceType: "referral_bonus", note: "referrals e2e",
});
r = await me(alice);
check("earnedPoints sums the referral_bonus ledger rows", r.body.earnedPoints === 250,
  `got ${r.body.earnedPoints}`);

await cleanupNets();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
