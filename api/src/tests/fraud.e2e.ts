// E2E for the fraud-flag resolve dropdown (founder, 2026-09-07): temporary
// vs permanent resolve, and the escalation-aware suppression this rests on.
//
// The founder's own example: a user's 3 fake accounts on one device get
// permanently forgiven, and the SAME condition must stay quiet next time — but
// a 4th account joining the same cluster (or any other flag type genuinely
// getting worse) must still fire. This file proves that mechanism directly
// against flagOnce (api/src/fraud.ts) rather than through the full
// device-fingerprint flow, plus the resolve endpoint's "clear every other
// open flag on this user" behaviour and its per-user permission gate.
//
//   npm run test:fraud
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId } from "../db.ts";
import { config } from "../config.ts";
import { flagOnce, checkGeoMismatch } from "../fraud.ts";
import { staffRoutes } from "../routes/staff.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(staffRoutes);

const TAG = newId().slice(0, 8);
let seq = 0;
async function mkUser(label: string) {
  const id = newId();
  await sql.run(
    `INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at, kyc_status)
     VALUES (?,?,1,'Pakistan',?,'active',?, 'approved')`,
    id, `${TAG}-${label}@t.test`, `${TAG}${(seq++).toString(36)}`.toUpperCase().slice(0, 12), now(),
  );
  return id;
}
async function mkStaff(label: string, role: string) {
  const id = await mkUser(label);
  await sql.run("INSERT INTO admin_users (user_id, role, created_at) VALUES (?,?,?)", id, role, now());
  return id;
}
const authOf = (id: string) => ({ authorization: `Bearer ${jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: "1h" })}` });

const manager = await mkStaff("manager", "manager");

async function openFlagId(flagType: string, scopeKey: string, userId: string): Promise<string> {
  const row = await sql.get<{ id: string }>(
    "SELECT id FROM fraud_flags WHERE flag_type = ? AND device_id = ? AND user_id = ? AND resolved_by IS NULL",
    flagType, scopeKey, userId,
  );
  if (!row) throw new Error(`no open flag ${flagType}/${scopeKey}`);
  return row.id;
}

async function resolve(id: string, resolutionType: "temporary" | "permanent") {
  return app.inject({
    method: "POST", url: `/staff/fraud/${id}/resolve`, headers: authOf(manager),
    payload: { note: "e2e", resolutionType },
  });
}

console.log("\n-- temporary resolve promises nothing about the future --");
{
  const u = await mkUser("temp");
  check("first occurrence inserts", await flagOnce("device_reuse", `dev-${u}`, u, "medium", "3 accounts", 3));
  const id = await openFlagId("device_reuse", `dev-${u}`, u);
  const res = await resolve(id, "temporary");
  check("resolve 200s", res.statusCode === 200);
  check("an IDENTICAL repeat still fires — temporary resolves nothing about the future",
    await flagOnce("device_reuse", `dev-${u}`, u, "medium", "3 accounts", 3));
}

console.log("\n-- permanent resolve suppresses a repeat at the SAME magnitude --");
{
  const u = await mkUser("perm");
  check("first occurrence inserts", await flagOnce("referral_ring", `dev-${u}`, u, "high", "shares a device", 3));
  const id = await openFlagId("referral_ring", `dev-${u}`, u);
  const res = await resolve(id, "permanent");
  check("resolve 200s", res.statusCode === 200);
  const row = await sql.get<{ resolution_type: string; magnitude: number }>(
    "SELECT resolution_type, magnitude FROM fraud_flags WHERE id = ?", id,
  );
  check("the row is stamped resolution_type='permanent'", row?.resolution_type === "permanent");
  check("...with its magnitude preserved", row?.magnitude === 3);
  check("a repeat at the SAME magnitude, same scope key, stays silent",
    (await flagOnce("referral_ring", `dev-${u}`, u, "high", "shares a device", 3)) === false);
  check("a repeat at a SMALLER magnitude also stays silent",
    (await flagOnce("referral_ring", `dev-${u}`, u, "high", "shares a device", 2)) === false);

  console.log("\n-- ...but a genuinely WORSE occurrence still fires (the founder's own 4th-account case) --");
  check("a NEW scope key at a bigger magnitude fires normally",
    await flagOnce("referral_ring", `dev-${u}-2`, u, "high", "a 4th account joined", 4));
  const escalated = await openFlagId("referral_ring", `dev-${u}-2`, u);
  check("it is a real, unresolved row", (await sql.get<{ resolved_by: string | null }>(
    "SELECT resolved_by FROM fraud_flags WHERE id = ?", escalated))?.resolved_by == null);
}

console.log("\n-- permanent resolve clears every OTHER open flag on the SAME user, across types --");
{
  const u = await mkUser("bulk");
  await flagOnce("device_reuse", `dev-${u}`, u, "medium", "3 accounts", 3);
  await flagOnce("ip_reuse", `ip:${u}`, u, "medium", "5 accounts from this ip", 5);
  const id1 = await openFlagId("device_reuse", `dev-${u}`, u);
  await resolve(id1, "permanent");
  const rows = await sql.all<{ flag_type: string; resolved_by: string | null; resolution_type: string | null }>(
    "SELECT flag_type, resolved_by, resolution_type FROM fraud_flags WHERE user_id = ?", u,
  );
  check("both flags exist", rows.length === 2);
  check("both are resolved", rows.every((r) => r.resolved_by != null));
  check("both are stamped permanent, not just the clicked one",
    rows.every((r) => r.resolution_type === "permanent"));
}

console.log("\n-- a flag type with no measurable magnitude is never silenced (never a blind spot) --");
{
  const u = await mkUser("nomag");
  check("first occurrence inserts", await flagOnce("mining_bot_pattern", `ad:${u}`, u, "medium", "exact dwell minimum"));
  const id = await openFlagId("mining_bot_pattern", `ad:${u}`, u);
  await resolve(id, "permanent");
  check("an identical repeat STILL fires — no magnitude means no promise of silence",
    await flagOnce("mining_bot_pattern", `ad:${u}`, u, "medium", "exact dwell minimum"));
}

console.log("\n-- geo_mismatch: no magnitude, so permanent resolve never silences it — even across a fixed but not-yet-caught bug shape (regression, 2026-09-07) --");
{
  // An earlier version tried a "distinct other countries" magnitude for this
  // flag type — it looked plausible in isolation, but a country A permanently
  // forgiven could spuriously RE-FIRE later purely because an unrelated
  // country B happened to get flagged in between (B inflated A's own
  // "escalation" score even though nothing about A had changed). Rather than
  // patch that interaction, this flag type dropped magnitude tracking
  // entirely — the same treatment as mining_bot_pattern below. Proven here:
  // permanent resolve genuinely resolves the row, but promises nothing about
  // the future, so a plain repeat of the SAME country fires again too — never
  // a false blind spot, whatever else happens to the user in between.
  const u = await mkUser("geo");
  await checkGeoMismatch(u, "Pakistan", "India");
  const idA = await openFlagId("geo_mismatch", `geo:${u}:india`, u);
  await resolve(idA, "permanent");
  check("country A is genuinely resolved", !!(await sql.get<{ resolved_by: string }>(
    "SELECT resolved_by FROM fraud_flags WHERE id = ?", idA))?.resolved_by);

  // An unrelated SECOND country shows up.
  await checkGeoMismatch(u, "Pakistan", "Nigeria");
  const idB = await sql.get<{ id: string }>(
    "SELECT id FROM fraud_flags WHERE flag_type = 'geo_mismatch' AND device_id = ? AND resolved_by IS NULL",
    `geo:${u}:nigeria`,
  );
  check("a genuinely new country flags normally", !!idB);

  // Country A recurring: with no magnitude, permanent resolve made no promise
  // about this, so it fires again too — deliberately, not a regression.
  await checkGeoMismatch(u, "Pakistan", "India");
  const aReopened = await sql.get<{ id: string }>(
    "SELECT id FROM fraud_flags WHERE flag_type = 'geo_mismatch' AND device_id = ? AND resolved_by IS NULL",
    `geo:${u}:india`,
  );
  check("country A re-fires on a plain repeat too — this flag type never promises silence", !!aReopened);
}

console.log("\n-- permission gate unchanged --");
{
  const outsider = await mkUser("outsider");
  const u = await mkUser("gate");
  await flagOnce("device_reuse", `dev-${u}`, u, "medium", "3 accounts", 3);
  const id = await openFlagId("device_reuse", `dev-${u}`, u);
  const res = await app.inject({
    method: "POST", url: `/staff/fraud/${id}/resolve`, headers: authOf(outsider),
    payload: { resolutionType: "temporary" },
  });
  check("a non-staff caller is refused", res.statusCode === 403);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
