// E2E for Support & Messages (admin console rebuild, Phase E): server-side
// sort / pagination + `total` on GET /staff/tickets, and that the per-status
// `counts` stay over ALL tickets regardless of the page or the filter.
//
// ⚠️ The Mining-admin split is a pure frontend change (each tab mounts on its
// own instead of one screen firing seven calls); nothing server-side moved, so
// it has no test here — test:mining:e2e / test:stage5 still cover the endpoints.
//
//   npm run test:messagesadmin
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId } from "../db.ts";
import { config } from "../config.ts";
import { appRoutes } from "../routes/app.ts";
import { staffRoutes } from "../routes/staff.ts";
import { staffNotifyRoutes } from "../routes/staffNotify.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(appRoutes);
await app.register(staffRoutes);
await app.register(staffNotifyRoutes);

const TAG = newId().slice(0, 8);
const authOf = (id: string) => ({ authorization: `Bearer ${jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: "1h" })}` });

let seq = 0;
async function mkUser(label: string) {
  const id = newId();
  await sql.run(
    `INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at)
     VALUES (?,?,1,'Pakistan',?,'active',?)`,
    id, `${TAG}-${label}@t.test`, `${TAG}${(seq++).toString(36)}`.toUpperCase().slice(0, 12), now(),
  );
  return id;
}
async function mkStaff(label: string, role: string) {
  const id = await mkUser(label);
  await sql.run("INSERT INTO admin_users (user_id, role, created_at) VALUES (?,?,?)", id, role, now());
  return id;
}

const admin = await mkStaff("admin", "admin");
const agent = await mkStaff("agent", "agent");
const outsider = await mkUser("outsider");

// stagger updated_at so ORDER BY is deterministic
let clock = Date.parse("2026-08-01T00:00:00Z");

// ---------------------------------------------------------------------------
console.log("\n-- GET /staff/tickets: pagination + total + counts --");
{
  // 7 open tickets from 7 users, plus 2 that get closed.
  const openIds: string[] = [];
  for (let i = 0; i < 7; i++) {
    const u = await mkUser(`t${i}`);
    const r = await app.inject({
      method: "POST", url: "/support/tickets", headers: authOf(u),
      payload: { subject: `${TAG} ticket ${String.fromCharCode(97 + i)}`, message: "help me" },
    });
    openIds.push(r.json().ticket.id as string);
    // hand-stagger updated_at for a deterministic sort
    await sql.run("UPDATE support_tickets SET updated_at = ? WHERE id = ?",
      new Date((clock += 60_000)).toISOString(), openIds[i]);
  }
  for (const id of openIds.slice(0, 2)) {
    await app.inject({ method: "PATCH", url: `/staff/tickets/${id}`, headers: authOf(agent), payload: { status: "closed" } });
  }

  const p1 = await app.inject({ method: "GET", url: `/staff/tickets?status=open&q=${TAG}&limit=3&offset=0`, headers: authOf(agent) });
  check("200", p1.statusCode === 200, p1.body.slice(0, 300));
  const d1 = p1.json() as {
    tickets: { id: string; subject: string; updatedAt: string }[];
    total: number; offset: number; limit: number; counts: Record<string, number>;
  };
  check("page 1 has 3 open tickets", d1.tickets.length === 3, String(d1.tickets.length));
  check("total is the whole OPEN filtered set (5), not the page", d1.total === 5, String(d1.total));
  check("offset / limit echoed", d1.offset === 0 && d1.limit === 3);
  check("counts report ALL tickets: 5 open, 2 closed", d1.counts.open === 5 && d1.counts.closed === 2, JSON.stringify(d1.counts));

  const p2 = await app.inject({ method: "GET", url: `/staff/tickets?status=open&q=${TAG}&limit=3&offset=3`, headers: authOf(agent) });
  check("last page has the 2 remaining open tickets", (p2.json() as { tickets: unknown[] }).tickets.length === 2);

  // default order is updated_at ASC (longest-waiting first); dir=desc flips it.
  const asc = await app.inject({ method: "GET", url: `/staff/tickets?status=open&q=${TAG}&limit=100`, headers: authOf(agent) });
  const ascT = (asc.json() as { tickets: { updatedAt: string }[] }).tickets.map((t) => t.updatedAt);
  check("default sort is updated_at ascending", ascT.join("|") === [...ascT].sort().join("|"), ascT.join("|"));
  const desc = await app.inject({ method: "GET", url: `/staff/tickets?status=open&q=${TAG}&sort=updated_at&dir=desc&limit=100`, headers: authOf(agent) });
  const descT = (desc.json() as { tickets: { updatedAt: string }[] }).tickets.map((t) => t.updatedAt);
  check("dir=desc reverses to most-recent-first", descT.join("|") === [...ascT].reverse().join("|"));

  const bogus = await app.inject({ method: "GET", url: `/staff/tickets?status=open&q=${TAG}&sort=1;DROP&limit=100`, headers: authOf(agent) });
  check("an unknown sort key is ignored, not injected", bogus.statusCode === 200);
}

// ---------------------------------------------------------------------------
console.log("\n-- search narrows rows, not counts; status=all spans everything --");
{
  const all = await app.inject({ method: "GET", url: `/staff/tickets?status=all&q=${TAG}&limit=100`, headers: authOf(agent) });
  const ad = all.json() as { tickets: unknown[]; total: number; counts: Record<string, number> };
  check("status=all returns every ticket (7)", ad.total === 7, String(ad.total));

  const one = await app.inject({ method: "GET", url: `/staff/tickets?status=all&q=${TAG}%20ticket%20a&limit=100`, headers: authOf(agent) });
  const od = one.json() as { tickets: { subject: string }[]; total: number; counts: Record<string, number> };
  check("a subject search narrows to 1 row", od.total === 1 && od.tickets[0].subject.includes("ticket a"), JSON.stringify(od.tickets.map((t) => t.subject)));
  check("...but the counts still report the whole backlog", od.counts.open === ad.counts.open && od.counts.closed === ad.counts.closed);
}

// ---------------------------------------------------------------------------
console.log("\n-- permission gate unchanged --");
{
  check("a non-staff user gets 403", (await app.inject({ method: "GET", url: "/staff/tickets", headers: authOf(outsider) })).statusCode === 403);
  check("no token -> not 200", (await app.inject({ method: "GET", url: "/staff/tickets" })).statusCode !== 200);
}

// ---------------------------------------------------------------------------
console.log("\n-- edit / pause / resume / delete an already-sent broadcast --");
{
  const recip = await mkUser("recip");
  const send = await app.inject({
    method: "POST", url: "/staff/notifications", headers: authOf(admin),
    payload: { audience: "all", title: `${TAG} original`, body: "first wording" },
  });
  check("broadcast sent", send.statusCode === 200, send.body);
  const bId = (send.json() as { id: string }).id;

  const inboxBefore = await app.inject({ method: "GET", url: "/notifications", headers: authOf(recip) });
  const before = inboxBefore.json() as { notifications: { title: string; body: string }[]; unread: number };
  check("recipient's inbox has the original wording", before.notifications.some((n) => n.title === `${TAG} original`));

  // Edit cascades onto the already-written per-recipient row.
  const edit = await app.inject({
    method: "PATCH", url: `/staff/notifications/${bId}`, headers: authOf(admin),
    payload: { title: `${TAG} corrected`, body: "fixed wording" },
  });
  check("edit accepted", edit.statusCode === 200, edit.body);
  const afterEdit = (await app.inject({ method: "GET", url: "/notifications", headers: authOf(recip) })).json() as { notifications: { title: string; body: string }[] };
  check("recipient sees the CORRECTED wording, not the original", afterEdit.notifications.some((n) => n.title === `${TAG} corrected` && n.body === "fixed wording"));
  check("the old wording is gone from their inbox", !afterEdit.notifications.some((n) => n.title === `${TAG} original`));

  // Pause hides it from the inbox and the unread count, without deleting it.
  const pause = await app.inject({ method: "POST", url: `/staff/notifications/${bId}/pause`, headers: authOf(admin) });
  check("pause accepted", pause.statusCode === 200, pause.body);
  const paused = (await app.inject({ method: "GET", url: "/notifications", headers: authOf(recip) })).json() as { notifications: { title: string }[] };
  check("paused message is hidden from the inbox", !paused.notifications.some((n) => n.title === `${TAG} corrected`));

  // Resume brings it back.
  const resume = await app.inject({ method: "POST", url: `/staff/notifications/${bId}/resume`, headers: authOf(admin) });
  check("resume accepted", resume.statusCode === 200, resume.body);
  const resumed = (await app.inject({ method: "GET", url: "/notifications", headers: authOf(recip) })).json() as { notifications: { title: string }[] };
  check("resumed message is visible again", resumed.notifications.some((n) => n.title === `${TAG} corrected`));

  // Delete hides it permanently, and the staff history keeps the row marked deleted.
  const del = await app.inject({ method: "DELETE", url: `/staff/notifications/${bId}`, headers: authOf(admin) });
  check("delete accepted", del.statusCode === 200, del.body);
  const deleted = (await app.inject({ method: "GET", url: "/notifications", headers: authOf(recip) })).json() as { notifications: { title: string }[] };
  check("deleted message is gone from the inbox", !deleted.notifications.some((n) => n.title === `${TAG} corrected`));
  const history = (await app.inject({ method: "GET", url: "/staff/notifications", headers: authOf(admin) })).json() as { history: { id: string; deleted: boolean; title: string }[] };
  const row = history.history.find((h) => h.id === bId);
  check("the audit trail still shows it, marked deleted", !!row?.deleted, JSON.stringify(row));

  const editDeleted = await app.inject({
    method: "PATCH", url: `/staff/notifications/${bId}`, headers: authOf(admin),
    payload: { title: "nope", body: "nope" },
  });
  check("editing a deleted message is refused", editDeleted.statusCode === 400);

  check("a non-staff user gets 403 on pause", (await app.inject({ method: "POST", url: `/staff/notifications/${bId}/pause`, headers: authOf(outsider) })).statusCode === 403);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
