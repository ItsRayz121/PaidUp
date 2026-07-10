// Seeds the ad networks and the offer feed. Idempotent — safe to run
// repeatedly. Real offers come from the ad-network adapters later; these mirror
// the frontend demo set (docs/ARCHITECTURE.md).
import { sql, now, initDb } from "./db.ts";

// tasks.network is the ADAPTER KEY (networks.id), so the feed can hide a
// disabled network's offers and postbacks map back to a configured network.
const networks = [
  { id: "offerhub", name: "OfferHub", type: "offerwall", commission_split_pct: 55, referral_bonus_pct: 10 },
  { id: "tapvid", name: "TapVid", type: "rewarded_video", commission_split_pct: 60, referral_bonus_pct: 10 },
];

const tasks = [
  { id: "t1", type: "install", title: "Install Cricket Live and open it once", points: 350, network: "offerhub", advertiser: "Cricket Live", minutes: 3, requirement: "Keep the app installed for 24 hours to get your points." },
  { id: "t2", type: "video", title: "Watch a short video", points: 40, network: "tapvid", advertiser: "TapVid", minutes: 1, requirement: null },
  { id: "t3", type: "survey", title: "Answer a few questions about shopping", points: 220, network: "offerhub", advertiser: "Survey partner", minutes: 6, requirement: "Answer honestly. If answers don't match, points may not be added." },
  { id: "t4", type: "install", title: "Install Fast Wallet and make an account", points: 900, network: "offerhub", advertiser: "Fast Wallet", minutes: 5, requirement: "You must finish sign up inside the app to get your points." },
  { id: "t5", type: "video", title: "Watch a video about a new game", points: 40, network: "tapvid", advertiser: "GameHub", minutes: 1, requirement: null },
];

await initDb();

let nets = 0;
for (const n of networks) {
  const res = await sql.run(
    `INSERT INTO networks (id, name, type, status, commission_split_pct, referral_bonus_pct, created_at)
     VALUES (?,?,?, 'active', ?,?, ?)
     ON CONFLICT (id) DO NOTHING`,
    n.id, n.name, n.type, n.commission_split_pct, n.referral_bonus_pct, now(),
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
