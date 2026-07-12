// Seeds the ad networks and the offer feed. Idempotent — safe to run
// repeatedly. Real offers come from the ad-network adapters later; these mirror
// the frontend demo set (docs/ARCHITECTURE.md).
import { sql, now, initDb } from "./db.ts";

// tasks.network is the ADAPTER KEY (networks.id), so the feed can hide a
// disabled network's offers and postbacks map back to a configured network.
// commission_split_pct is the user's share of net network payout. Launch
// decision (founder, 2026-07-11): 60% to users / 40% margin, across the board.
// Referral launch defaults (founder 2026-07-11): L1 15% + L2 5% + 100pt bonus
// when an invited user finishes their FIRST task. Generous to drive early growth;
// all from margin, Admin-tunable in /staff.
const networks = [
  { id: "offerhub", name: "OfferHub", type: "offerwall", commission_split_pct: 60, referral_bonus_pct: 15, referral_bonus_pct_l2: 5, referral_first_task_bonus: 100, referral_bonus_days: 0 },
  { id: "tapvid", name: "TapVid", type: "rewarded_video", commission_split_pct: 60, referral_bonus_pct: 15, referral_bonus_pct_l2: 5, referral_first_task_bonus: 100, referral_bonus_days: 0 },
  { id: "surveyx", name: "SurveyX", type: "offerwall", commission_split_pct: 60, referral_bonus_pct: 15, referral_bonus_pct_l2: 5, referral_first_task_bonus: 100, referral_bonus_days: 0 },
  // CPX Research — REAL, live survey wall. Its split is enforced by the
  // conversion rate in the CPX dashboard (1 USD = 600 points = 60% to the user).
  { id: "cpx", name: "CPX Research", type: "offerwall", commission_split_pct: 60, referral_bonus_pct: 15, referral_bonus_pct_l2: 5, referral_first_task_bonus: 100, referral_bonus_days: 0 },
];

const tasks = [
  { id: "t1", type: "install", title: "Install Cricket Live and open it once", points: 350, network: "offerhub", advertiser: "Cricket Live", minutes: 3, requirement: "Keep the app installed for 24 hours to get your points." },
  { id: "t2", type: "video", title: "Watch a short video", points: 40, network: "tapvid", advertiser: "TapVid", minutes: 1, requirement: null },
  { id: "t3", type: "survey", title: "Answer a few questions about shopping", points: 220, network: "offerhub", advertiser: "Survey partner", minutes: 6, requirement: "Answer honestly. If answers don't match, points may not be added." },
  { id: "t4", type: "install", title: "Install Fast Wallet and make an account", points: 900, network: "offerhub", advertiser: "Fast Wallet", minutes: 5, requirement: "You must finish sign up inside the app to get your points." },
  { id: "t5", type: "video", title: "Watch a video about a new game", points: 40, network: "tapvid", advertiser: "GameHub", minutes: 1, requirement: null },
  { id: "t6", type: "survey", title: "Share your opinion on mobile brands", points: 260, network: "surveyx", advertiser: "SurveyX", minutes: 7, requirement: "Answer honestly. If you are screened out, points may not be added." },
  { id: "t7", type: "survey", title: "Quick survey about your daily commute", points: 150, network: "surveyx", advertiser: "SurveyX", minutes: 4, requirement: "Finish all questions to get your points." },
];

await initDb();

let nets = 0;
for (const n of networks) {
  // Seed is the canonical "apply launch config" step: re-running it pushes the
  // decided commission/referral numbers to existing rows too (initDb only
  // inserts-if-absent, so it can't fix a network already at an old placeholder).
  // status is deliberately NOT overwritten, so an Admin-disabled network stays
  // disabled and live /staff tuning of a network's split is only reset on an
  // explicit re-seed, never on a normal boot.
  const res = await sql.run(
    `INSERT INTO networks (id, name, type, status, commission_split_pct, referral_bonus_pct, referral_bonus_pct_l2, referral_first_task_bonus, referral_bonus_days, created_at)
     VALUES (?,?,?, 'active', ?,?,?,?,?, ?)
     ON CONFLICT (id) DO UPDATE SET
       commission_split_pct      = EXCLUDED.commission_split_pct,
       referral_bonus_pct        = EXCLUDED.referral_bonus_pct,
       referral_bonus_pct_l2     = EXCLUDED.referral_bonus_pct_l2,
       referral_first_task_bonus = EXCLUDED.referral_first_task_bonus,
       referral_bonus_days       = EXCLUDED.referral_bonus_days,
       updated_at                = EXCLUDED.created_at`,
    n.id, n.name, n.type, n.commission_split_pct, n.referral_bonus_pct, n.referral_bonus_pct_l2, n.referral_first_task_bonus, n.referral_bonus_days, now(),
  );
  if (res.rowCount) nets++;
}

let added = 0;
for (const t of tasks) {
  // Upsert the network key so re-seeding realigns tasks created before the
  // networks table existed (their old free-text network names).
  const res = await sql.run(
    `INSERT INTO tasks (id, type, title, points, network, advertiser, minutes, requirement, country, status, created_at)
     VALUES (?,?,?,?,?,?,?,?, 'Pakistan', 'active', ?)
     ON CONFLICT (id) DO UPDATE SET network = EXCLUDED.network`,
    t.id, t.type, t.title, t.points, t.network, t.advertiser, t.minutes, t.requirement, now(),
  );
  if (res.rowCount) added++;
}
console.log(`Seed complete. ${nets} network(s) added; ${added} task(s) upserted.`);
process.exit(0);
