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
  // Our OWN tasks, written in /staff. Not an ad network — there is no external
  // payout behind these, so the "commission split" is meaningless here and the
  // points come straight off margin. It gets a networks row anyway so referral
  // rates on custom tasks stay Admin-tunable like every other source, and so an
  // Admin can switch ALL custom tasks off in one click.
  { id: "custom", name: "Our own tasks", type: "custom", commission_split_pct: 0, referral_bonus_pct: 15, referral_bonus_pct_l2: 5, referral_first_task_bonus: 100, referral_bonus_days: 0 },
];

// Demo offers for the three SPEC adapters (offerhub/tapvid/surveyx). No real
// network sits behind them, so a completion can never produce a verified
// postback and the user could never be credited. Seeding them into a live DB
// would show real users offers that cannot pay — so they are OFF unless asked
// for explicitly (local/dev). Production seeds networks only.
const seedDemoTasks = process.env.SEED_DEMO_TASKS === "true";

const tasks = [
  { id: "t1", type: "install", title: "Install Cricket Live and open it once", points: 350, network: "offerhub", advertiser: "Cricket Live", minutes: 3, requirement: "Keep the app installed for 24 hours to get your points." },
  { id: "t2", type: "video", title: "Watch a short video", points: 40, network: "tapvid", advertiser: "TapVid", minutes: 1, requirement: null },
  { id: "t3", type: "survey", title: "Answer a few questions about shopping", points: 220, network: "offerhub", advertiser: "Survey partner", minutes: 6, requirement: "Answer honestly. If answers don't match, points may not be added." },
  { id: "t4", type: "install", title: "Install Fast Wallet and make an account", points: 900, network: "offerhub", advertiser: "Fast Wallet", minutes: 5, requirement: "You must finish sign up inside the app to get your points." },
  { id: "t5", type: "video", title: "Watch a video about a new game", points: 40, network: "tapvid", advertiser: "GameHub", minutes: 1, requirement: null },
  { id: "t6", type: "survey", title: "Share your opinion on mobile brands", points: 260, network: "surveyx", advertiser: "SurveyX", minutes: 7, requirement: "Answer honestly. If you are screened out, points may not be added." },
  { id: "t7", type: "survey", title: "Quick survey about your daily commute", points: 150, network: "surveyx", advertiser: "SurveyX", minutes: 4, requirement: "Finish all questions to get your points." },
];

// ---- Our own social tasks (founder, 2026-07-30) ----------------------------
//
// Three starter tasks so the Tasks tab is never empty: follow RoziPay on
// WhatsApp, Telegram and X. They pay from margin, not from a network, which is
// why they are small — they exist to make the tab worth opening on a day CPX has
// no survey for Pakistani traffic, not to be a payout route.
//
// They are seeded DISABLED with no link, and that is deliberate. Guessing a URL
// would ship three tasks that send users to a 404 and then ask them to prove
// they followed something that isn't there. The Admin pastes the real link in
// /staff -> Our own tasks and flips the task on; the panel flags any active
// proof task that still has no link.
//
// ON CONFLICT DO NOTHING, NOT DO UPDATE: after the first seed these rows belong
// to the Admin. Re-running the seed to apply network config must never reset a
// link they pasted, a reward they retuned, or a task they switched off.
const socialTasks = [
  { id: "social-whatsapp", icon: "whatsapp", title: "Follow RoziPay on WhatsApp", proof_label: "Your WhatsApp name", instructions: "Open our WhatsApp channel and press Follow. Then send us the name you follow with, so we can check it." },
  { id: "social-telegram", icon: "telegram", title: "Join the RoziPay Telegram channel", proof_label: "Your Telegram @username", instructions: "Open our Telegram channel and press Join. Then send us your Telegram @username, so we can check it." },
  { id: "social-twitter", icon: "twitter", title: "Follow RoziPay on X (Twitter)", proof_label: "Your X @username", instructions: "Open our X page and press Follow. Then send us your X @username, so we can check it." },
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
if (seedDemoTasks) {
  for (const t of tasks) {
    // Upsert the network key so re-seeding realigns tasks created before the
    // networks table existed (their old free-text network names).
    const res = await sql.run(
      `INSERT INTO tasks (id, type, title, points, network, advertiser, minutes, requirement, country, target_countries, status, created_at)
       VALUES (?,?,?,?,?,?,?,?, 'Pakistan', ',Pakistan,', 'active', ?)
       ON CONFLICT (id) DO UPDATE SET network = EXCLUDED.network`,
      t.id, t.type, t.title, t.points, t.network, t.advertiser, t.minutes, t.requirement, now(),
    );
    if (res.rowCount) added++;
  }
}
let social = 0;
for (const s of socialTasks) {
  const res = await sql.run(
    `INSERT INTO tasks
       (id, type, title, points, network, advertiser, minutes, requirement, country, target_countries,
        status, source, verify_mode, category, instructions, proof_label, action_url, icon, created_at)
     VALUES (?, 'custom', ?, 50, 'custom', 'RoziPay', 2, NULL, 'ALL', ',ALL,', 'disabled',
             'custom', 'proof', 'social', ?, ?, NULL, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    s.id, s.title, s.instructions, s.proof_label, s.icon, now(),
  );
  if (res.rowCount) social++;
}

console.log(
  `Seed complete. ${nets} network(s) added; ` +
    (seedDemoTasks
      ? `${added} demo task(s) upserted.`
      : "demo tasks skipped (set SEED_DEMO_TASKS=true to add them).") +
    (social > 0
      ? `\n${social} social task(s) added, switched OFF. Paste each link in /staff -> Our own tasks, then switch it on.`
      : "\nSocial tasks already present (left alone — they are yours to edit now)."),
);
process.exit(0);
