// Staff notifications (brief part 39) and home content (part 43).
//
// Two screens that both put words in front of every user, which is why they
// share a file and a set of rules:
//
//   • Nothing here can move money, and nothing here should be able to imply it
//     has. The copy rules in CLAUDE.md apply to a staff-written announcement
//     exactly as they apply to a string in the copy deck — more so, because
//     nobody reviews this one before it ships.
//   • A link written by staff and rendered inside our own chrome is the most
//     trusted link in the app. Inbox messages are therefore internal-path only.
//   • Every send is audit-logged with what was said and how many people it
//     reached.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { sql, now, newId, logAudit } from "../db.ts";
import { requirePermission, type Role, type Permission } from "../roles.ts";
import { minWithdrawPointsNow } from "../settingsRuntime.ts";
import {
  AUDIENCES, isAudience, audienceSize, broadcast, notifyUser, isInternalPath,
  type AudienceId,
} from "../notify.ts";
import { pushEnabled } from "../push.ts";

function staffGuard(
  perm: Permission,
  handler: (ctx: { userId: string; role: Role }, req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await handler(await requirePermission(req, perm), req, reply);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Something went wrong" });
    }
  };
}

// The icons a home card may use. A CLOSED LIST, never a URL — the same rule as
// TASK_ICONS, for the same reason: these cards sit directly above a balance,
// and an admin-supplied remote image there is a third-party request on a money
// screen. The web half mirrors this list in components/icons.tsx.
export const CONTENT_ICONS = [
  "info", "gift", "rocket", "warning", "coin", "people", "star",
] as const;

export async function staffNotifyRoutes(app: FastifyInstance) {
  // ---- Notifications ------------------------------------------------------

  // The compose screen's own data: who can be reached, and how many of them.
  // Sizes are computed live so nobody sends to "everyone" without first seeing
  // what everyone currently means.
  app.get("/staff/notifications", staffGuard("notifications.send", async () => {
    const minWithdraw = await minWithdrawPointsNow();
    const ids = Object.keys(AUDIENCES) as AudienceId[];
    const sizes = await Promise.all(ids.map((a) => audienceSize(a, minWithdraw)));

    const history = await sql.all<Record<string, unknown>>(
      `SELECT b.*, u.email AS sent_by_email
       FROM notification_broadcasts b LEFT JOIN users u ON u.id = b.sent_by
       ORDER BY b.created_at DESC LIMIT 30`,
    );

    return {
      // Stated so the compose screen can be honest about what ticking "also
      // send a push" will actually do. With no VAPID keys it does nothing, and
      // a tick box that silently does nothing is worse than an absent one.
      pushAvailable: pushEnabled,
      audiences: ids.map((id, i) => ({
        id, label: AUDIENCES[id].label, note: AUDIENCES[id].note, size: sizes[i],
      })),
      history: history.map((h) => ({
        id: h.id, title: h.title, body: h.body, url: h.url, audience: h.audience,
        recipients: h.recipients, pushed: Number(h.pushed) === 1,
        sentBy: h.sent_by_email ?? h.sent_by, at: h.created_at,
      })),
    };
  }));

  const messageSchema = z.object({
    title: z.string().min(1).max(80),
    body: z.string().min(1).max(500),
    // Internal paths only — see isInternalPath's comment in notify.ts.
    url: z.string().max(200).optional().nullable(),
  });

  const broadcastSchema = messageSchema.extend({
    audience: z.string(),
    // Defaults to FALSE. The inbox is the channel; a push is an extra that
    // costs a subscription we need for money news. Opting in has to be an act.
    alsoPush: z.boolean().optional(),
  });

  app.post("/staff/notifications", staffGuard("notifications.send", async ({ userId, role }, req, reply) => {
    const parsed = broadcastSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Add a short title and a message." });
    const d = parsed.data;
    if (!isAudience(d.audience)) return reply.code(400).send({ error: "Pick who this goes to." });
    if (d.url && !isInternalPath(d.url)) {
      return reply.code(400).send({
        error: "A message can only link inside the app (a path starting with /). An outside link " +
          "inside our own screens is exactly what a scam looks like.",
      });
    }

    const res = await broadcast({
      audience: d.audience,
      message: { title: d.title, body: d.body, url: d.url ?? null },
      sentBy: userId,
      alsoPush: d.alsoPush === true,
      minWithdrawPoints: await minWithdrawPointsNow(),
    });

    await logAudit({
      actorUserId: userId, actorRole: role, action: "notification_broadcast",
      detail: `${d.audience} → ${res.recipients}: ${d.title}`,
      actorIp: req.ip,
    });
    return { ok: true, id: res.id, recipients: res.recipients };
  }));

  // One user, one message. A separate permission (`users.notify`) because it is
  // a different job — support answering a specific person, not marketing
  // reaching a crowd — and Operations holds it while Marketing does not.
  app.post("/staff/users/:id/notify", staffGuard("users.notify", async ({ userId, role }, req, reply) => {
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Add a short title and a message." });
    const target = (req.params as { id: string }).id;
    if (parsed.data.url && !isInternalPath(parsed.data.url)) {
      return reply.code(400).send({ error: "A message can only link inside the app." });
    }
    const user = await sql.get<{ id: string }>("SELECT id FROM users WHERE id = ?", target);
    if (!user) return reply.code(404).send({ error: "No such user." });

    await notifyUser(target, {
      title: parsed.data.title, body: parsed.data.body, url: parsed.data.url ?? null,
    });
    await logAudit({
      actorUserId: userId, actorRole: role, action: "notification_direct",
      targetUserId: target, detail: parsed.data.title, actorIp: req.ip,
    });
    return { ok: true };
  }));

  // ---- Home content -------------------------------------------------------

  app.get("/staff/content", staffGuard("content.manage", async () => ({
    icons: CONTENT_ICONS,
    blocks: (await sql.all<Record<string, unknown>>(
      "SELECT * FROM content_blocks ORDER BY sort, created_at DESC")).map(rowToBlock),
  })));

  const blockSchema = z.object({
    title: z.string().min(1).max(80),
    body: z.string().min(1).max(400),
    icon: z.enum(CONTENT_ICONS).default("info"),
    // Home cards MAY point outside the app (a Telegram channel is the obvious
    // case) — unlike an inbox message, a card is visibly a card, and the panel
    // marks an external link so it is a choice rather than a surprise. Still
    // scheme-checked: `javascript:` and `data:` are not links, they are code.
    linkUrl: z.string().max(300).optional().nullable(),
    linkLabel: z.string().max(40).optional().nullable(),
    tone: z.enum(["info", "good", "warn"]).default("info"),
    status: z.enum(["draft", "live"]).default("draft"),
    startsAt: z.string().max(40).optional().nullable(),
    endsAt: z.string().max(40).optional().nullable(),
    sort: z.number().int().min(0).max(999).default(0),
  });

  const linkOk = (u: string) => isInternalPath(u) || /^https:\/\/[^\s]+$/i.test(u);

  /**
   * Normalise a schedule date to a full ISO timestamp.
   *
   * ⚠️ THE WINDOW IS COMPARED AS A STRING (see GET /content/home), so an
   * un-normalised value is not a formatting nit — it silently changes when a
   * card appears. `"2026-9-1"` sorts BELOW `"2026-08-09T…"` at the second
   * character that differs, so a card scheduled for September never shows and
   * nothing anywhere says why. And a date-only `endsAt` of today sorts below
   * every time on that day, so a card set to end today is already gone this
   * morning — off by one, on the one field whose whole job is a deadline.
   *
   * So: parse it, refuse what will not parse, and read a date-only END as the
   * END of that day, which is what a person typing it means.
   */
  function normaliseWhen(v: string, endOfDay: boolean): string | { error: string } {
    const raw = v.trim();
    // Accept an unpadded date too and pad it, rather than letting `new Date()`
    // read "2026-9-1" as LOCAL midnight — which would make the same day mean
    // two different instants depending on which form was typed, and would skip
    // the end-of-day rule below entirely.
    const parts = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
    const iso = parts
      ? `${parts[1]}-${parts[2].padStart(2, "0")}-${parts[3].padStart(2, "0")}` +
        `T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
      : raw;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return { error: `"${v}" is not a date we can read. Use 2026-09-01.` };
    }
    return d.toISOString();
  }

  // Returns the two normalised values, or the first error. Shared by create and
  // update so the two cannot disagree about what a date means.
  function schedule(b: { startsAt?: string | null; endsAt?: string | null }):
    { startsAt?: string | null; endsAt?: string | null } | { error: string } {
    const out: { startsAt?: string | null; endsAt?: string | null } = {};
    for (const [key, endOfDay] of [["startsAt", false], ["endsAt", true]] as const) {
      const raw = b[key];
      if (raw === undefined) continue;
      if (raw === null || raw.trim() === "") { out[key] = null; continue; }
      const v = normaliseWhen(raw, endOfDay);
      if (typeof v !== "string") return v;
      out[key] = v;
    }
    if (out.startsAt && out.endsAt && out.startsAt >= out.endsAt) {
      return { error: "The end date has to be after the start date." };
    }
    return out;
  }

  app.post("/staff/content", staffGuard("content.manage", async ({ userId, role }, req, reply) => {
    const parsed = blockSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Add a title and a short message." });
    const b = parsed.data;
    if (b.linkUrl && !linkOk(b.linkUrl)) {
      return reply.code(400).send({ error: "A link must start with / (inside the app) or https://" });
    }
    const when = schedule(b);
    if ("error" in when) return reply.code(400).send({ error: when.error });

    const id = newId();
    await sql.run(
      `INSERT INTO content_blocks (id, title, body, icon, link_url, link_label, tone, status, starts_at, ends_at, sort, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, b.title, b.body, b.icon, b.linkUrl ?? null, b.linkLabel ?? null,
      b.tone, b.status, when.startsAt ?? null, when.endsAt ?? null, b.sort, now(), now(),
    );
    await logAudit({
      actorUserId: userId, actorRole: role, action: "content_create",
      detail: `${b.status}: ${b.title}`, actorIp: req.ip,
    });
    return { ok: true, id };
  }));

  app.patch("/staff/content/:id", staffGuard("content.manage", async ({ userId, role }, req, reply) => {
    const parsed = blockSchema.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Nothing valid to change." });
    const b = parsed.data;
    if (b.linkUrl && !linkOk(b.linkUrl)) {
      return reply.code(400).send({ error: "A link must start with / (inside the app) or https://" });
    }
    const id = (req.params as { id: string }).id;
    // ⚠️ A PARTIAL UPDATE CANNOT CHECK "end after start" ON ITS OWN — editing
    // only the end date leaves the start out of the request. Read the row and
    // compare against what is actually stored, or an edit can put a card's
    // window in the wrong order one field at a time.
    const cur = await sql.get<{ starts_at: string | null; ends_at: string | null }>(
      "SELECT starts_at, ends_at FROM content_blocks WHERE id = ?", id);
    if (!cur) return reply.code(404).send({ error: "No such card." });
    const when = schedule({
      startsAt: b.startsAt === undefined ? cur.starts_at : b.startsAt,
      endsAt: b.endsAt === undefined ? cur.ends_at : b.endsAt,
    });
    if ("error" in when) return reply.code(400).send({ error: when.error });

    const cols: Record<string, unknown> = {
      title: b.title, body: b.body, icon: b.icon, link_url: b.linkUrl,
      link_label: b.linkLabel, tone: b.tone, status: b.status,
      // Only written when the request actually mentioned them — `schedule()`
      // above re-normalises the stored value too, and writing that back on
      // every edit would be a silent rewrite of a field nobody touched.
      starts_at: b.startsAt === undefined ? undefined : when.startsAt,
      ends_at: b.endsAt === undefined ? undefined : when.endsAt,
      sort: b.sort,
    };
    const sets = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (!sets.length) return reply.code(400).send({ error: "Nothing to change." });
    sets.push(["updated_at", now()]);

    const res = await sql.run(
      `UPDATE content_blocks SET ${sets.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`,
      ...sets.map(([, v]) => (v === null ? null : v)), id,
    );
    if (!res.rowCount) return reply.code(404).send({ error: "No such card." });
    await logAudit({
      actorUserId: userId, actorRole: role, action: "content_update",
      detail: `${id}: ${sets.map(([k]) => k).join(", ")}`, actorIp: req.ip,
    });
    return { ok: true };
  }));

  app.delete("/staff/content/:id", staffGuard("content.manage", async ({ userId, role }, req, reply) => {
    const id = (req.params as { id: string }).id;
    const res = await sql.run("DELETE FROM content_blocks WHERE id = ?", id);
    if (!res.rowCount) return reply.code(404).send({ error: "No such card." });
    await logAudit({
      actorUserId: userId, actorRole: role, action: "content_delete",
      detail: id, actorIp: req.ip,
    });
    return { ok: true };
  }));
}

function rowToBlock(r: Record<string, unknown>) {
  return {
    id: r.id, title: r.title, body: r.body, icon: r.icon,
    linkUrl: r.link_url, linkLabel: r.link_label, tone: r.tone, status: r.status,
    startsAt: r.starts_at, endsAt: r.ends_at, sort: r.sort, updatedAt: r.updated_at,
  };
}
