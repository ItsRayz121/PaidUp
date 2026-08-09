// E2E for the admin operations rebuild, stage 6 — notifications, support and
// home content (brief parts 39/40/43).
//
// WHY THIS FILE EXISTS
// --------------------
// Partly the reason stage4/stage5 do — SQL that typechecks is not SQL that
// runs, and this stage adds three tables and rewrites the ticket queries. But
// mostly for ONE check, which is the only genuinely dangerous thing in the
// stage:
//
//   ⚠️ AN INTERNAL NOTE MUST NEVER REACH THE PERSON IT IS ABOUT.
//   An internal note is where an agent writes "third refund this week, check
//   the device list before paying". The CHECK constraint in db.ts *permits*
//   the value; it does nothing to hide it. One filter in ONE query
//   (`author_role <> 'internal'` in GET /support/tickets) is the entire
//   defence, and it is the kind of clause a later refactor drops without
//   noticing. So: this suite writes a real internal note and then reads the
//   ticket back as the user.
//
// The other two properties worth pinning:
//
//   • A BROADCAST'S AUDIENCE IS MATERIALISED AT SEND TIME. A user who signs up
//     tomorrow must not receive yesterday's announcement — otherwise "everyone
//     with a balance on Tuesday" quietly becomes a message that keeps finding
//     new recipients forever.
//   • AN INBOX MESSAGE CANNOT LINK OUTSIDE THE APP. It is written by staff and
//     rendered inside our own chrome, which makes it the most trusted link in
//     the product.
//
//   npm run test:stage6
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId, postLedger, postRozi } from "../db.ts";
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
const tok = (id: string) => jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: "1h" });
const authOf = (id: string) => ({ authorization: `Bearer ${tok(id)}` });

let seq = 0;
async function mkUser(label: string, extra: Record<string, string | number> = {}) {
  const id = newId();
  await sql.run(
    `INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at)
     VALUES (?,?,1,'Pakistan',?,'active',?)`,
    id, `${TAG}-${label}@t.test`, `${TAG}${(seq++).toString(36)}`.toUpperCase().slice(0, 12), now(),
  );
  for (const [k, v] of Object.entries(extra)) {
    await sql.run(`UPDATE users SET ${k} = ? WHERE id = ?`, v, id);
  }
  return id;
}
async function mkStaff(label: string, role: string) {
  const id = await mkUser(label);
  await sql.run("INSERT INTO admin_users (user_id, role, created_at) VALUES (?,?,?)", id, role, now());
  return id;
}

const admin = await mkStaff("admin", "admin");
const agent = await mkStaff("agent", "agent");
const agent2 = await mkStaff("agent2", "agent");
const marketing = await mkStaff("marketing", "marketing");
const analyst = await mkStaff("analyst", "analyst");

// ---------------------------------------------------------------------------
console.log("\n-- part 39: the compose screen knows who it can reach --");
const rich = await mkUser("rich");
const quiet = await mkUser("quiet");
const miner = await mkUser("miner");
{
  // A user who can cash out, a user who has never opened the app, and a miner.
  await postLedger({ userId: rich, points: 50_000, direction: "credit", sourceType: "task_completion", note: "t" });
  await postRozi({ userId: miner, micro: 5_000_000, direction: "credit", sourceType: "mining" });
  const today = new Date().toISOString().slice(0, 10);
  await sql.run("INSERT INTO user_activity_days (user_id, day) VALUES (?,?) ON CONFLICT DO NOTHING", rich, today);
  // `quiet` gets an activity day 60 days back, so they are genuinely inactive
  // rather than merely unseen.
  const old = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
  await sql.run("INSERT INTO user_activity_days (user_id, day) VALUES (?,?) ON CONFLICT DO NOTHING", quiet, old);

  const r = await app.inject({ method: "GET", url: "/staff/notifications", headers: authOf(admin) });
  check("200, not a 500 from a mistyped column", r.statusCode === 200, r.body.slice(0, 300));
  const d = r.json();
  const size = (id: string) => (d.audiences as { id: string; size: number }[]).find((a) => a.id === id)?.size ?? -1;
  check("every audience reports a live size", (d.audiences as unknown[]).length === 6
    && (d.audiences as { size: number }[]).every((a) => typeof a.size === "number"));
  check("'everyone' is the largest audience",
    size("all") >= size("active_7d") && size("all") >= size("miners"), JSON.stringify(d.audiences));
  check("the active audience counts someone who used the app today", size("active_7d") >= 1);
  check("the gone-quiet audience counts someone who has not, and not the one who has",
    size("inactive_30d") >= 1 && size("inactive_30d") < size("all"), String(size("inactive_30d")));
  check("the can-cash-out audience finds the user with a balance", size("withdrawable") >= 1);
  check("the miner audience finds the miner", size("miners") >= 1);
  check("whether a push can even be sent is stated, not assumed", typeof d.pushAvailable === "boolean");
}

console.log("\n-- part 39: a broadcast lands in inboxes, and pushes NOTHING by default --");
let broadcastId = "";
{
  const r = await app.inject({
    method: "POST", url: "/staff/notifications", headers: authOf(admin),
    payload: { audience: "withdrawable", title: "You can cash out", body: "Your money is ready to send.", url: "/wallet" },
  });
  check("sending works", r.statusCode === 200, r.body);
  broadcastId = r.json().id;
  check("it reports how many inboxes it reached", r.json().recipients >= 1, r.body);

  const inbox = (await app.inject({ method: "GET", url: "/notifications", headers: authOf(rich) })).json();
  check("the message is in the right user's inbox",
    (inbox.notifications as { title: string }[]).some((x) => x.title === "You can cash out"),
    JSON.stringify(inbox.notifications));
  check("and it counts as unread", inbox.unread >= 1, String(inbox.unread));

  const other = (await app.inject({ method: "GET", url: "/notifications", headers: authOf(quiet) })).json();
  check("a user outside the audience gets nothing", other.notifications.length === 0);

  const hist = (await app.inject({ method: "GET", url: "/staff/notifications", headers: authOf(admin) })).json();
  const h = (hist.history as { id: string; recipients: number; pushed: boolean }[]).find((x) => x.id === broadcastId);
  check("the send is recorded with its audience and reach", h?.recipients === r.json().recipients, JSON.stringify(h));
  check("and it did NOT push — the inbox is the channel, a push is an opt-in", h?.pushed === false);
}

console.log("\n-- part 39: the audience is fixed at SEND time, not re-evaluated on read --");
{
  // Somebody who qualifies for the audience but signed up afterwards. If the
  // rule were re-run at read time they would receive a message about a moment
  // they were not part of.
  const latecomer = await mkUser("latecomer");
  await postLedger({ userId: latecomer, points: 50_000, direction: "credit", sourceType: "task_completion", note: "t" });
  const inbox = (await app.inject({ method: "GET", url: "/notifications", headers: authOf(latecomer) })).json();
  check("a user who qualifies AFTER the send does not receive it", inbox.notifications.length === 0,
    JSON.stringify(inbox.notifications));
}

console.log("\n-- part 39: read state, and what a message may link to --");
{
  await app.inject({ method: "POST", url: "/notifications/read", headers: authOf(rich), payload: {} });
  const inbox = (await app.inject({ method: "GET", url: "/notifications", headers: authOf(rich) })).json();
  check("marking all read clears the badge", inbox.unread === 0, String(inbox.unread));
  check("but the messages are still there to read", inbox.notifications.length >= 1);

  // ⚠️ The link rule. A staff-written link rendered inside our own chrome is
  // the most trusted link in the app; an external one there is phishing with
  // our branding on it.
  check("an external link is refused", (await app.inject({
    method: "POST", url: "/staff/notifications", headers: authOf(admin),
    payload: { audience: "all", title: "hi", body: "b", url: "https://evil.example/login" },
  })).statusCode === 400);
  check("a protocol-relative link is refused too", (await app.inject({
    method: "POST", url: "/staff/notifications", headers: authOf(admin),
    payload: { audience: "all", title: "hi", body: "b", url: "//evil.example" },
  })).statusCode === 400);
  check("an internal path is fine", (await app.inject({
    method: "POST", url: "/staff/notifications", headers: authOf(admin),
    payload: { audience: "miners", title: "Mining update", body: "Your speed went up.", url: "/mine" },
  })).statusCode === 200);
  check("an unknown audience is refused rather than silently reaching nobody", (await app.inject({
    method: "POST", url: "/staff/notifications", headers: authOf(admin),
    payload: { audience: "everyone-ever", title: "hi", body: "b" },
  })).statusCode === 400);
}

console.log("\n-- part 39: one user, one message --");
{
  const r = await app.inject({
    method: "POST", url: `/staff/users/${quiet}/notify`, headers: authOf(admin),
    payload: { title: "About your ticket", body: "We need one more detail.", url: "/help" },
  });
  check("messaging one user works", r.statusCode === 200, r.body);
  const inbox = (await app.inject({ method: "GET", url: "/notifications", headers: authOf(quiet) })).json();
  check("it lands in exactly that inbox", inbox.notifications.length === 1 && inbox.unread === 1,
    JSON.stringify(inbox));
  check("an unknown user is 404", (await app.inject({
    method: "POST", url: "/staff/users/nope/notify", headers: authOf(admin),
    payload: { title: "t", body: "b" },
  })).statusCode === 404);
  // Reading someone else's notification id does nothing — the update is scoped.
  const mine = (await app.inject({ method: "GET", url: "/notifications", headers: authOf(quiet) })).json();
  const id = mine.notifications[0].id;
  await app.inject({ method: "POST", url: "/notifications/read", headers: authOf(miner), payload: { id } });
  const still = (await app.inject({ method: "GET", url: "/notifications", headers: authOf(quiet) })).json();
  check("another user cannot mark my notification read", still.unread === 1, String(still.unread));
}

// ---------------------------------------------------------------------------
console.log("\n-- part 40: AN INTERNAL NOTE MUST NEVER REACH THE USER --");
let ticketId = "";
{
  const created = await app.inject({
    method: "POST", url: "/support/tickets", headers: authOf(rich),
    payload: { subject: "Where is my money", message: "I asked three days ago." },
  });
  ticketId = created.json().ticket.id;

  await app.inject({
    method: "POST", url: `/staff/tickets/${ticketId}/reply`, headers: authOf(agent),
    payload: { message: "Third refund this week — check the device list before paying.", internal: true },
  });

  // THE check. If this ever fails, a user is reading what staff said about them.
  const asUser = (await app.inject({ method: "GET", url: "/support/tickets", headers: authOf(rich) })).json();
  const thread = (asUser.tickets as { id: string; messages: { body: string; author_role: string }[] }[])
    .find((t) => t.id === ticketId)!.messages;
  check("⚠️ the user does NOT see the internal note",
    !thread.some((m) => m.body.includes("device list")), JSON.stringify(thread));
  check("⚠️ and no message of role 'internal' reaches them at all",
    !thread.some((m) => m.author_role === "internal"), JSON.stringify(thread));
  check("the user still sees their own message", thread.some((m) => m.author_role === "user"));

  // Staff DO see it — hiding it from the people who wrote it defeats the point.
  const asStaff = (await app.inject({ method: "GET", url: `/staff/tickets/${ticketId}`, headers: authOf(agent) })).json();
  check("staff see the internal note",
    (asStaff.messages as { author_role: string }[]).some((m) => m.author_role === "internal"));

  // And a note must not move the ticket out of the open queue.
  check("an internal note leaves the status alone — the user is still waiting",
    asStaff.ticket.status === "open", asStaff.ticket.status);
}

console.log("\n-- part 40: a reply still answers, and the queue can be narrowed --");
{
  await app.inject({
    method: "POST", url: `/staff/tickets/${ticketId}/reply`, headers: authOf(agent),
    payload: { message: "Sorry for the wait — it is on its way." },
  });
  const asStaff = (await app.inject({ method: "GET", url: `/staff/tickets/${ticketId}`, headers: authOf(agent) })).json();
  check("a real reply moves it to answered", asStaff.ticket.status === "answered", asStaff.ticket.status);
  const asUser = (await app.inject({ method: "GET", url: "/support/tickets", headers: authOf(rich) })).json();
  check("and the user sees the reply",
    (asUser.tickets as { id: string; messages: { body: string }[] }[])
      .find((t) => t.id === ticketId)!.messages.some((m) => m.body.includes("on its way")));

  const q = (await app.inject({ method: "GET", url: "/staff/tickets?status=all", headers: authOf(agent) })).json();
  check("counts are served per status, over ALL tickets not the current filter",
    typeof q.counts === "object" && (q.counts.answered ?? 0) >= 1, JSON.stringify(q.counts));
  const search = (await app.inject({
    method: "GET", url: `/staff/tickets?status=all&q=${encodeURIComponent("WHERE IS MY")}`, headers: authOf(agent),
  })).json();
  check("search is case-insensitive on the subject",
    (search.tickets as { id: string }[]).some((t) => t.id === ticketId), JSON.stringify(search.tickets));
  const byEmail = (await app.inject({
    method: "GET", url: `/staff/tickets?status=all&q=${encodeURIComponent(TAG)}`, headers: authOf(agent),
  })).json();
  check("and on the user's email", (byEmail.tickets as unknown[]).length >= 1);
  check("the staff message count ignores internal notes — it is what the USER can see",
    (byEmail.tickets as { id: string; messageCount: number }[]).find((t) => t.id === ticketId)?.messageCount === 2,
    JSON.stringify((byEmail.tickets as { id: string; messageCount: number }[]).find((t) => t.id === ticketId)));
}

console.log("\n-- part 40: assignment, so two agents stop answering the same person --");
{
  const r = await app.inject({
    method: "PATCH", url: `/staff/tickets/${ticketId}`, headers: authOf(agent),
    payload: { assignedTo: "me" },
  });
  check("an agent can pick a ticket up", r.statusCode === 200, r.body);
  const d = (await app.inject({ method: "GET", url: `/staff/tickets/${ticketId}`, headers: authOf(agent2) })).json();
  check("'me' resolves server-side to the caller, not to whatever the client sent",
    d.ticket.assignedTo === agent, JSON.stringify(d.ticket));
  check("and the other agent can see who owns it", typeof d.ticket.assigneeEmail === "string");

  const mine = (await app.inject({
    method: "GET", url: `/staff/tickets?status=all&mine=${agent}`, headers: authOf(agent),
  })).json();
  check("the queue can be filtered to one person's tickets",
    (mine.tickets as { id: string }[]).some((t) => t.id === ticketId));

  check("a non-staff account cannot be assigned a ticket", (await app.inject({
    method: "PATCH", url: `/staff/tickets/${ticketId}`, headers: authOf(agent),
    payload: { assignedTo: rich },
  })).statusCode === 400);

  await app.inject({
    method: "PATCH", url: `/staff/tickets/${ticketId}`, headers: authOf(agent),
    payload: { assignedTo: null },
  });
  const back = (await app.inject({ method: "GET", url: `/staff/tickets/${ticketId}`, headers: authOf(agent) })).json();
  check("and handed back to the pool", back.ticket.assignedTo === null, JSON.stringify(back.ticket));

  // Reopening. A ticket closed by mistake is invisible under every single
  // status view, which is when people decide the panel is broken.
  await app.inject({
    method: "PATCH", url: `/staff/tickets/${ticketId}`, headers: authOf(agent), payload: { status: "closed" },
  });
  await app.inject({
    method: "PATCH", url: `/staff/tickets/${ticketId}`, headers: authOf(agent), payload: { status: "open" },
  });
  const reopened = (await app.inject({ method: "GET", url: `/staff/tickets/${ticketId}`, headers: authOf(agent) })).json();
  check("a closed ticket can be reopened", reopened.ticket.status === "open");
}

// ---------------------------------------------------------------------------
console.log("\n-- part 43: home content, and the window it lives in --");
let blockId = "";
{
  const r = await app.inject({
    method: "POST", url: "/staff/content", headers: authOf(admin),
    payload: { title: "Mining is live", body: "Open the app every day to keep your streak.", icon: "rocket", linkUrl: "/mine", linkLabel: "Start mining", status: "live" },
  });
  check("creating a card works", r.statusCode === 200, r.body);
  blockId = r.json().id;

  const home = (await app.inject({ method: "GET", url: "/content/home", headers: authOf(rich) })).json();
  check("a live card reaches the home screen",
    (home.blocks as { id: string }[]).some((b) => b.id === blockId), JSON.stringify(home.blocks));
  check("an internal link is not marked as leaving the app",
    (home.blocks as { id: string; external: boolean }[]).find((b) => b.id === blockId)?.external === false);

  // A draft must not.
  const draft = await app.inject({
    method: "POST", url: "/staff/content", headers: authOf(admin),
    payload: { title: "Not ready", body: "Do not show me.", status: "draft" },
  });
  const home2 = (await app.inject({ method: "GET", url: "/content/home", headers: authOf(rich) })).json();
  check("a draft card does not", !(home2.blocks as { id: string }[]).some((b) => b.id === draft.json().id));

  // A window that has already closed.
  const past = new Date(Date.now() - 2 * 86400_000).toISOString();
  const expired = await app.inject({
    method: "POST", url: "/staff/content", headers: authOf(admin),
    payload: { title: "Eid offer", body: "Ended.", status: "live", endsAt: past },
  });
  const future = new Date(Date.now() + 2 * 86400_000).toISOString();
  const notYet = await app.inject({
    method: "POST", url: "/staff/content", headers: authOf(admin),
    payload: { title: "Next week", body: "Not yet.", status: "live", startsAt: future },
  });
  const home3 = (await app.inject({ method: "GET", url: "/content/home", headers: authOf(rich) })).json();
  const ids = (home3.blocks as { id: string }[]).map((b) => b.id);
  check("an expired card stops showing with nothing having to run on a timer",
    !ids.includes(expired.json().id));
  check("and one scheduled for next week does not show yet", !ids.includes(notYet.json().id));
}

console.log("\n-- part 43: what a card is allowed to be --");
{
  check("an https link is allowed on a card — a Telegram channel is a real case", (await app.inject({
    method: "POST", url: "/staff/content", headers: authOf(admin),
    payload: { title: "Join us", body: "Say hello.", linkUrl: "https://t.me/rozipay", status: "draft" },
  })).statusCode === 200);
  // ⚠️ `javascript:` is not a link, it is code, and this card renders inside a
  // screen showing a balance.
  check("a javascript: link is refused", (await app.inject({
    method: "POST", url: "/staff/content", headers: authOf(admin),
    payload: { title: "x", body: "y", linkUrl: "javascript:alert(1)", status: "draft" },
  })).statusCode === 400);
  check("a plain http link is refused", (await app.inject({
    method: "POST", url: "/staff/content", headers: authOf(admin),
    payload: { title: "x", body: "y", linkUrl: "http://example.com", status: "draft" },
  })).statusCode === 400);
  // The icon is a CLOSED LIST — never a URL. These cards sit above a balance.
  check("an icon outside the closed list is refused", (await app.inject({
    method: "POST", url: "/staff/content", headers: authOf(admin),
    payload: { title: "x", body: "y", icon: "https://evil.example/pixel.gif", status: "draft" },
  })).statusCode === 400);

  // ⚠️ THE SCHEDULE IS COMPARED AS A STRING, so an un-normalised date silently
  // changes when a card appears rather than failing loudly. "2026-9-1" sorts
  // BELOW "2026-08-09T…" and a card scheduled for September would simply never
  // show, with nothing anywhere saying why.
  {
    const r = await app.inject({
      method: "POST", url: "/staff/content", headers: authOf(admin),
      payload: { title: "x", body: "y", status: "live", startsAt: "2026-9-1", endsAt: "2026-9-30" },
    });
    check("an unpadded date is accepted and PADDED, not left to sort wrongly",
      r.statusCode === 200, r.body);
    const stored = (await app.inject({ method: "GET", url: "/staff/content", headers: authOf(admin) })).json();
    const padded = (stored.blocks as { id: string; startsAt: string }[]).find((b) => b.id === r.json().id);
    check("it is stored as a full ISO timestamp the string comparison can order",
      padded?.startsAt === "2026-09-01T00:00:00.000Z", JSON.stringify(padded));
    check("something that is not a date at all is refused", (await app.inject({
      method: "POST", url: "/staff/content", headers: authOf(admin),
      payload: { title: "x", body: "y", status: "live", startsAt: "next tuesday" },
    })).statusCode === 400);
    check("an end before the start is refused", (await app.inject({
      method: "POST", url: "/staff/content", headers: authOf(admin),
      payload: { title: "x", body: "y", status: "live", startsAt: "2026-09-10", endsAt: "2026-09-01" },
    })).statusCode === 400);

    // A date-only END means the END of that day. Written the naive way, a card
    // set to end today is already gone by one minute past midnight.
    const today = new Date().toISOString().slice(0, 10);
    const endsToday = await app.inject({
      method: "POST", url: "/staff/content", headers: authOf(admin),
      payload: { title: "Ends today", body: "Still up.", status: "live", endsAt: today },
    });
    const home = (await app.inject({ method: "GET", url: "/content/home", headers: authOf(rich) })).json();
    check("a card ending today is still showing today, not gone this morning",
      (home.blocks as { id: string }[]).some((b) => b.id === endsToday.json().id),
      JSON.stringify(home.blocks));

    // And a partial edit cannot invert the window one field at a time.
    check("editing only the end date is still checked against the stored start", (await app.inject({
      method: "PATCH", url: `/staff/content/${endsToday.json().id}`, headers: authOf(admin),
      payload: { startsAt: "2026-09-10" },
    })).statusCode === 400);
  }

  const patched = await app.inject({
    method: "PATCH", url: `/staff/content/${blockId}`, headers: authOf(admin),
    payload: { status: "draft" },
  });
  check("a card can be switched off", patched.statusCode === 200, patched.body);
  const home = (await app.inject({ method: "GET", url: "/content/home", headers: authOf(rich) })).json();
  check("and it leaves the home screen at once",
    !(home.blocks as { id: string }[]).some((b) => b.id === blockId));

  check("deleting works", (await app.inject({
    method: "DELETE", url: `/staff/content/${blockId}`, headers: authOf(admin),
  })).statusCode === 200);
  check("deleting a card that is gone is 404", (await app.inject({
    method: "DELETE", url: `/staff/content/${blockId}`, headers: authOf(admin),
  })).statusCode === 404);
}

// ---------------------------------------------------------------------------
console.log("\n-- the permissions these screens are gated on --");
{
  check("marketing can send a broadcast — that is the role's whole job",
    (await app.inject({ method: "GET", url: "/staff/notifications", headers: authOf(marketing) })).statusCode === 200);
  check("marketing can write home content",
    (await app.inject({ method: "GET", url: "/staff/content", headers: authOf(marketing) })).statusCode === 200);
  // ⚠️ Marketing must NOT be able to message one user directly: `users.notify`
  // is a support action, and permissions.ts gives it to Operations, not here.
  check("marketing cannot message one user directly", (await app.inject({
    method: "POST", url: `/staff/users/${rich}/notify`, headers: authOf(marketing),
    payload: { title: "t", body: "b" },
  })).statusCode === 403);
  check("an agent cannot broadcast to everyone",
    (await app.inject({ method: "GET", url: "/staff/notifications", headers: authOf(agent) })).statusCode === 403);
  check("an analyst can write nothing here", (await app.inject({
    method: "POST", url: "/staff/content", headers: authOf(analyst),
    payload: { title: "x", body: "y" },
  })).statusCode === 403);
  check("an agent still owns the ticket queue",
    (await app.inject({ method: "GET", url: "/staff/tickets", headers: authOf(agent) })).statusCode === 200);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
