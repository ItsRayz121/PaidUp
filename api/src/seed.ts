// Seeds the offer feed. Idempotent — safe to run repeatedly.
// Tasks mirror the frontend demo set; real offers come from ad-network
// adapters later (docs/ARCHITECTURE.md).
import { db, now } from "./db.ts";

const tasks = [
  { id: "t1", type: "install", title: "Install Cricket Live and open it once", points: 350, network: "AdGate", advertiser: "Cricket Live", minutes: 3, requirement: "Keep the app installed for 24 hours to get your points." },
  { id: "t2", type: "video", title: "Watch a short video", points: 40, network: "BitLabs", advertiser: "BitLabs", minutes: 1, requirement: null },
  { id: "t3", type: "survey", title: "Answer a few questions about shopping", points: 220, network: "BitLabs", advertiser: "Survey partner", minutes: 6, requirement: "Answer honestly. If answers don't match, points may not be added." },
  { id: "t4", type: "install", title: "Install Fast Wallet and make an account", points: 900, network: "AdGate", advertiser: "Fast Wallet", minutes: 5, requirement: "You must finish sign up inside the app to get your points." },
  { id: "t5", type: "video", title: "Watch a video about a new game", points: 40, network: "BitLabs", advertiser: "GameHub", minutes: 1, requirement: null },
];

const insert = db.prepare(
  `INSERT OR IGNORE INTO tasks (id, type, title, points, network, advertiser, minutes, requirement, country, status, created_at)
   VALUES (?,?,?,?,?,?,?,?, 'Pakistan', 'active', ?)`,
);

let added = 0;
for (const t of tasks) {
  const res = insert.run(t.id, t.type, t.title, t.points, t.network, t.advertiser, t.minutes, t.requirement, now());
  if (res.changes) added++;
}
console.log(`Seed complete. ${added} task(s) added, ${tasks.length - added} already present.`);
