import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId, earnedUsdtBalanceMicroOf } from "../db.ts";
import { config } from "../config.ts";
import { appRoutes } from "../routes/app.ts";
import { staffTaskRoutes } from "../routes/staffTasks.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

await initDb();
const app = Fastify();
await app.register(appRoutes);
await app.register(staffTaskRoutes);
const tag = newId().slice(0, 8);
const auth = (id: string) => ({ authorization: `Bearer ${jwt.sign({ sub: id }, config.jwtSecret)}` });
let seq = 0;
async function user(label: string, staffRole?: string) {
  const id = newId();
  await sql.run(`INSERT INTO users (id,email,email_verified,country,referral_code,status,created_at,kyc_status)
    VALUES (?,?,1,'Pakistan',?,'active',?,'approved')`, id, `${tag}-${label}@test.local`,
    `${tag}${seq++}`.toUpperCase().slice(0, 12), now());
  if (staffRole) await sql.run("INSERT INTO admin_users (user_id,role,created_at) VALUES (?,?,?)", id, staffRole, now());
  return id;
}
const admin = await user("admin", "admin");
const earner = await user("earner");

console.log("\n-- lifecycle, reward snapshots and earned USDT --");
const made = await app.inject({ method: "POST", url: "/staff/tasks", headers: auth(admin), payload: {
  title: "Verify an EVM wallet", rewardRoziMicro: 25_000_000, rewardType: "both", rewardUsdtMicro: 125_000,
  verifyMode: "proof", proofRequired: true, proofHeading: "Payment wallet",
  proofHelp: "Paste an address you control.", status: "active", countries: ["ALL"],
} });
check("combined-reward task creates", made.statusCode === 200, made.body);
const taskId = made.json().id as string;

await app.inject({ method: "PUT", url: `/staff/tasks/${taskId}/fields`, headers: auth(admin), payload: { fields: [{
  label: "Your EVM address", kind: "crypto_address", required: true, validation: "evm",
}] } });
const detail = await app.inject({ method: "GET", url: `/tasks/${taskId}`, headers: auth(earner) });
const fieldId = detail.json().fields[0].id as string;
check("custom proof heading reaches the earner", detail.json().task.proofHeading === "Payment wallet");

const bad = await app.inject({ method: "POST", url: `/tasks/${taskId}/proof`, headers: auth(earner), payload: {
  proof: "wallet", answers: { [fieldId]: "not-an-address" },
} });
check("invalid wallet proof is rejected server-side", bad.json().ok === false && /address/i.test(bad.json().error));

const filed = await app.inject({ method: "POST", url: `/tasks/${taskId}/proof`, headers: auth(earner), payload: {
  proof: "wallet", answers: { [fieldId]: "0x000000000000000000000000000000000000dEaD" },
} });
check("valid checksummed wallet proof is filed", filed.statusCode === 200, filed.body);
const proof = await sql.get<{ id: string; reward_rozi_micro: string | number; reward_usdt_micro: string | number }>(
  "SELECT id,reward_rozi_micro,reward_usdt_micro FROM task_proofs WHERE task_id=? AND user_id=?", taskId, earner);
check("both reward amounts are snapshotted", Number(proof?.reward_rozi_micro) === 25_000_000 && Number(proof?.reward_usdt_micro) === 125_000);

await app.inject({ method: "POST", url: `/staff/tasks/${taskId}/lifecycle`, headers: auth(admin), payload: { action: "pause" } });
const available = await app.inject({ method: "GET", url: "/tasks?view=available", headers: auth(earner) });
check("paused task leaves Available", !available.json().tasks.some((t: { id: string }) => t.id === taskId));

const approved = await app.inject({ method: "POST", url: `/staff/task-proofs/${proof?.id}/decision`, headers: auth(admin), payload: { action: "approve" } });
check("a proof filed before pause remains payable", approved.statusCode === 200 && approved.json().creditedUsdtMicro === 125_000, approved.body);
check("ROZI portion credited", Number((await sql.get<{ bal: number }>("SELECT COALESCE(SUM(amount),0)::int AS bal FROM rozi_ledger WHERE user_id=? AND source_type='task_reward'", earner))?.bal) === 25_000_000);
check("USDT portion credited to earned ledger", await earnedUsdtBalanceMicroOf(earner) === 125_000);

const history = await app.inject({ method: "GET", url: "/tasks?view=history", headers: auth(earner) });
check("completed work appears in History", history.json().tasks.some((t: { id: string }) => t.id === taskId));

// ---- GET /me/earnings: flag-gated lifetime summary (founder, 2026-09-01) ----
const earnOff = await app.inject({ method: "GET", url: "/me/earnings", headers: auth(earner) });
check("earnings: 403 while the earnings_view flag is off (its default)", earnOff.statusCode === 403, String(earnOff.statusCode));

await sql.run("INSERT INTO app_settings (key, value, updated_at) VALUES ('flag.earnings_view','1',?) ON CONFLICT (key) DO UPDATE SET value='1'", now());
const earnOn = await app.inject({ method: "GET", url: "/me/earnings", headers: auth(earner) });
check("earnings: 200 once the flag is on", earnOn.statusCode === 200, earnOn.body.slice(0, 200));
const ed = earnOn.json() as {
  roziMicro: { fromTasks: number; total: number };
  usdtMicro: { earnedUsdt: number; total: number };
};
check("earnings: the task's ROZI reward is counted (25 ROZI)", ed.roziMicro.fromTasks === 25_000_000, String(ed.roziMicro.fromTasks));
check("earnings: the task's earned USDT is counted", ed.usdtMicro.earnedUsdt === 125_000, String(ed.usdtMicro.earnedUsdt));

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
if (fail) process.exit(1);
