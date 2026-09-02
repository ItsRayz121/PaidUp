// Admin: create and manage OUR OWN tasks, and review the proofs users submit
// for them. Ad-network tasks come from an adapter; these we write by hand.
//
// The two verification modes (guardrail #1 — a task can never credit itself):
//   'proof'    — user submits evidence; a STAFF MEMBER approves; the credit is
//                that audit-logged human decision.
//   'postback' — a partner's server calls /webhooks/custom/postback with this
//                task's own secret. Same contract as a real ad network.
//
// Crediting always goes through creditCompletion() (../credit.ts), the SAME path
// the network postbacks use, so a custom task pays referral bonuses and respects
// velocity caps identically. This file never writes to the ledger directly.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { sql, now, newId, logAudit } from "../db.ts";
import { config } from "../config.ts";
import { requirePermission, type Role, type Permission } from "../roles.ts";
import { creditCompletion, type NetworkRow } from "../credit.ts";
import { campaignMoney, EXHAUSTED } from "../taskBudget.ts";
import {
  FIELD_KINDS, MAX_FIELDS_PER_TASK, fieldsForTask, publicField, parseAnswers,
} from "../taskFields.ts";
import { packCountries, unpackCountries } from "../taskTargeting.ts";
import { campaignState } from "../taskLifecycle.ts";

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

const CUSTOM_NETWORK = "custom";

function imageMime(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// The one-line form of a country list, written to the older `tasks.country`
// column so the staff panel and every query that predates targeting still have
// something readable. It is a LABEL, never the thing that is matched against —
// taskTargeting.ts reads target_countries.
function summariseCountries(list: string[]): string {
  const parts = [...new Set(list.map((s) => s.trim()).filter(Boolean))];
  if (parts.length === 0 || parts.some((p) => p.toLowerCase() === "all")) return "ALL";
  if (parts.length === 1) return parts[0].slice(0, 60);
  return `${parts[0]} +${parts.length - 1}`.slice(0, 60);
}

// The logos a task card can show. A CLOSED LIST, not a free-text field and not a
// URL: the icon name is looked up against a map of inline SVGs in the web app
// (components/icons.tsx `taskIcon`), so an Admin can never point a task card at
// an off-site image. Task cards sit next to balances, and a remote image there
// is a third-party request on a money screen — a tracking pixel at best.
//
// Adding one = a line here and a matching entry in `taskIcon`. An unknown value
// is refused at this boundary, so the two lists cannot drift apart silently.
export const TASK_ICONS = ["whatsapp", "telegram", "twitter", "youtube", "facebook", "instagram", "star"] as const;

// The categories a task can sit in (Stage 7). A CLOSED LIST for the same reason
// the icon list is: the category is rendered as a filter chip in the earner app
// with its own wording and colour, so free text would put whatever an Admin
// typed — including a blank, or a paragraph — into the app's own navigation.
//
// Adding one = a line here and a matching label in the web app's
// TASK_CATEGORY_LABELS. An unknown value is refused at this boundary, so the
// two lists cannot drift apart silently.
export const TASK_CATEGORIES = ["social", "signup", "app", "survey", "video", "shopping", "other"] as const;

const upsertSchema = z.object({
  title: z.string().min(3).max(120),
  // Custom/RoziPay tasks are set in ROZI and/or USDT now (founder,
  // 2026-08-29) — the word "points" is gone from the earner app. `points` is
  // kept only so an older client that still sends it does not 400; a custom
  // task always stores points = 0.
  points: z.number().int().min(0).max(1_000_000).default(0),
  rewardRoziMicro: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  // "points" is accepted for back-compat and normalised to a ROZI reward
  // (whole points -> whole ROZI, 1:1) by normalizeReward() below.
  rewardType: z.enum(["points", "rozi", "usdt", "both"]).default("rozi"),
  rewardUsdtMicro: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  verifyMode: z.enum(["proof", "postback"]),
  instructions: z.string().max(2000).optional(),
  proofLabel: z.string().max(120).optional(),
  proofHeading: z.string().max(120).optional(),
  proofHelp: z.string().max(500).optional(),
  // Ask the user to type evidence? Only meaningful for verifyMode 'proof'.
  // False still routes the claim through the staff queue — see the column note
  // in db.ts. Defaults to true so an older client that never sends it keeps the
  // behaviour it was written against.
  proofRequired: z.boolean().optional(),
  // ⚠️ http/https ONLY, AND THE SCHEME CHECK IS THE POINT — `.url()` alone is not
  // enough. Zod's `.url()` is `new URL()`, which happily accepts
  // `javascript:alert(1)` and `data:text/html,…`. This value is rendered as the
  // href of the task card's button in the earner app (components/TaskFlow.tsx)
  // and of the Open link in the staff panel, so anything but http(s) here is
  // stored XSS on a screen that sits next to a balance — reachable by whoever
  // holds an admin session, which is exactly the session worth stealing.
  //
  // Checked at this boundary, not at render: there are two render sites already
  // and the next one will not remember.
  // The try/catch is load-bearing: zod v3 still runs a refinement after the
  // inner `.url()` has already failed, so a bare `new URL("")` in here THROWS
  // out of safeParse instead of producing a validation error — and "" is the
  // legal value that clears the link.
  actionUrl: z.string().url().max(500)
    .refine((u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } },
      { message: "The link must start with http:// or https://" })
    .optional().or(z.literal("")),
  buttonLabel: z.string().trim().max(40).optional(),
  minutes: z.number().int().min(0).max(600).default(1),
  country: z.string().max(60).default("Pakistan"),
  // ⚠️ 'exhausted' IS ACCEPTED SO AN ADMIN CAN SEE IT, BUT ONLY THE CREDIT PATH
  // SETS IT. An Admin picking it by hand would be claiming a campaign ran out
  // when it did not; the two states an Admin owns are active and disabled.
  // Reactivating an exhausted campaign whose budget was not raised simply
  // exhausts it again on the next completion, which is the correct outcome.
  // Older API clients created immediately-live campaigns and never sent a
  // status. Keep that contract; the new staff form explicitly sends `draft`.
  status: z.enum(["draft", "scheduled", "active", "paused", "disabled", "ended"]).default("active"),
  icon: z.enum(TASK_ICONS).optional().or(z.literal("")),
  logoAssetId: z.string().max(64).nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  featured: z.boolean().optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  // ---- Campaign budget + revenue (brief parts 15 + 16) --------------------
  // null clears a cap back to unlimited; undefined leaves it alone. Both are
  // needed: "no budget" is a real, common state and has to be settable.
  // ⚠️ z.coerce here on purpose: these map to BIGINT columns, and pg returns
  // BIGINT as a STRING. The staff form loads a row and can POST it straight
  // back, so a schema of plain z.number() rejected an untouched "0" with
  // "expected number, received string". The union keeps null (= clear the cap)
  // meaningful — z.coerce.number() alone would turn null into 0.
  budgetConversions: z.union([z.null(), z.coerce.number().int().positive().max(10_000_000)]).optional(),
  budgetPoints: z.union([z.null(), z.coerce.number().int().positive().max(1_000_000_000)]).optional(),
  budgetUsdtMicro: z.union([z.null(), z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)]).optional(),
  // What the partner pays US per conversion, in micro-USD. Entered as dollars
  // in the panel and converted there; stored as an integer so no campaign's
  // margin is computed from a float.
  revenuePerConversionMicro: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
  // ---- Category + targeting (Stage 7) -------------------------------------
  // "" clears the category back to uncategorised. An unknown value is refused
  // here rather than stored, so the earner app's chip list can never be handed
  // a category it has no label for.
  category: z.enum(TASK_CATEGORIES).optional().or(z.literal("")),
  // The countries this task is offered in. ["ALL"] = everywhere. An empty list
  // is read as ALL by packCountries() — a task targeted at nothing would be a
  // campaign that silently shows to nobody, which is indistinguishable from a
  // broken feed.
  countries: z.array(z.string().min(1).max(60)).max(40).optional(),
  // ⚠️ EVERY RULE BELOW IS ENFORCED IN taskTargeting.ts, on the FEED AND THE
  // SUBMIT PATH BOTH. null clears it back to no limit; undefined leaves it.
  targetMinAccountDays: z.number().int().min(0).max(3650).nullable().optional(),
  targetMaxAccountDays: z.number().int().min(0).max(3650).nullable().optional(),
  targetMinCompleted: z.number().int().min(0).max(10_000).nullable().optional(),
});

// A task's input fields, sent as a WHOLE LIST (see the PUT route below).
const fieldSchema = z.object({
  // Present = keep this existing field row and its id, so answers already
  // stored still point at something. Absent = a new question.
  id: z.string().max(64).optional(),
  label: z.string().trim().min(1).max(120),
  kind: z.enum(FIELD_KINDS).default("text"),
  required: z.boolean().default(true),
  placeholder: z.string().max(120).optional(),
  help: z.string().max(300).optional(),
  // One choice per line. Only meaningful for kind 'choice'.
  options: z.string().max(2000).optional(),
  validation: z.enum(["evm", "tron", "solana", "generic"]).optional(),
  maxLen: z.number().int().min(1).max(4000).nullable().optional(),
});

// Fold a legacy "points" reward into the ROZI model (founder, 2026-08-29 — the
// word "points" is gone from the earner app). Whole points become whole ROZI,
// 1:1. `rozi`/`usdt`/`both` pass straight through.
function normalizeReward(
  rewardType: "points" | "rozi" | "usdt" | "both",
  points: number,
  roziMicro: number,
  usdtMicro: number,
): { rewardType: "rozi" | "usdt" | "both"; rewardRoziMicro: number } {
  // Legacy: a caller that sent whole `points` and no ROZI amount — those
  // points are whole ROZI, 1:1. (Also covers rewardType left at its default.)
  if (points > 0 && roziMicro === 0) {
    return { rewardType: usdtMicro > 0 ? "both" : "rozi", rewardRoziMicro: points * 1_000_000 };
  }
  if (rewardType === "points") {
    return { rewardType: usdtMicro > 0 ? "both" : "rozi", rewardRoziMicro: roziMicro };
  }
  return { rewardType, rewardRoziMicro: roziMicro };
}

function validateReward(rewardType: "rozi" | "usdt" | "both", roziMicro: number, usdtMicro: number) {
  const ok = rewardType === "rozi" ? roziMicro > 0 && usdtMicro === 0
    : rewardType === "usdt" ? roziMicro === 0 && usdtMicro > 0
      : roziMicro > 0 && usdtMicro > 0;
  if (!ok) throw Object.assign(new Error(
    rewardType === "rozi" ? "A ROZI reward needs a ROZI amount and no USDT."
      : rewardType === "usdt" ? "A USDT reward needs USDT and no ROZI."
        : "A combined reward needs both ROZI and USDT.",
  ), { statusCode: 400 });
}

function validateSchedule(startsAt?: string | null, endsAt?: string | null) {
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw Object.assign(new Error("The end time must be after the start time."), { statusCode: 400 });
  }
}

// Is there already a LIVE custom task with this wording? Normalised the same way
// on both sides (trim, collapse inner whitespace, lowercase). `exceptId` skips
// the task being renamed. Deleted/ended tasks do not count — their title is free
// to reuse.
async function duplicateTitle(title: string, exceptId?: string): Promise<boolean> {
  const norm = title.trim().replace(/\s+/g, " ").toLowerCase();
  const row = await sql.get<{ id: string }>(
    `SELECT id FROM tasks
      WHERE source = 'custom' AND status NOT IN ('deleted','ended')
        AND lower(regexp_replace(btrim(title), '\\s+', ' ', 'g')) = ?
        ${exceptId ? "AND id <> ?" : ""}
      LIMIT 1`,
    ...(exceptId ? [norm, exceptId] : [norm]),
  );
  return !!row;
}

export async function staffTaskRoutes(app: FastifyInstance) {
  // Owned, immutable task asset. Public because <img> cannot attach the app's
  // bearer token; ids are opaque and the bytes are validated at upload.
  app.get("/task-assets/:id", async (req, reply) => {
    const id = z.string().max(64).parse((req.params as { id: string }).id);
    const asset = await sql.get<{ mime_type: string; bytes: Buffer | Uint8Array }>(
      "SELECT mime_type, bytes FROM task_assets WHERE id = ?", id,
    );
    if (!asset) return reply.code(404).send({ error: "not found" });
    return reply.header("content-type", asset.mime_type)
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(Buffer.from(asset.bytes));
  });

  app.post("/staff/task-assets", staffGuard("tasks.manage", async ({ userId, role }, req) => {
    const { data } = z.object({ data: z.string().max(720_000) }).parse(req.body ?? {});
    const match = /^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/.exec(data);
    if (!match) return { ok: false, error: "Choose a PNG, JPEG or WebP image." };
    const source = Buffer.from(match[2], "base64");
    if (source.length === 0 || source.length > 524_288) {
      return { ok: false, error: "The logo must be 512 KB or smaller." };
    }
    const mime = imageMime(source);
    if (!mime || mime !== match[1]) return { ok: false, error: "The file contents do not match a supported image type." };
    let bytes: Buffer;
    try {
      // Decoding is the second signature check. Re-encoding to WebP strips EXIF,
      // ICC and other metadata and produces a predictable square card asset.
      bytes = await sharp(source, { failOn: "warning" }).rotate()
        .resize(256, 256, { fit: "cover", position: "centre" })
        .webp({ quality: 84 }).toBuffer();
    } catch {
      return { ok: false, error: "That image could not be decoded safely." };
    }
    const id = newId();
    await sql.run(
      "INSERT INTO task_assets (id, mime_type, bytes, byte_size, created_by, created_at) VALUES (?,?,?,?,?,?)",
      id, "image/webp", bytes, bytes.length, userId, now(),
    );
    await logAudit({ actorUserId: userId, actorRole: role, action: "custom_task_logo_upload", detail: `asset ${id} (${bytes.length} bytes)` });
    return { ok: true, id, url: `/task-assets/${id}` };
  }));

  // ---- List every custom task (admin) -------------------------------------
  // ⚠️ SERVER-SIDE SEARCH / SORT / PAGINATION (admin rebuild, Phase D). Same
  // idiom as GET /staff/withdrawals and GET /staff/users: `sort`/`dir` map
  // through a fixed whitelist to a column literal (never interpolated), and one
  // WHERE clause drives the row page and the COUNT so `total` always matches the
  // filter. `campaignMoney()` stays a single all-campaigns pass — it returns a
  // Map keyed by task id, so a page row just looks itself up. Every existing
  // field on each row is unchanged; `total`/`offset`/`limit` are additive.
  app.get("/staff/tasks", staffGuard("tasks.view", async (_ctx, req) => {
    const query = req.query as Record<string, string | undefined>;
    const search = (query.q ?? "").trim().toLowerCase();
    const statusF = (query.status ?? "").trim();
    const limit = Math.min(Number(query.limit ?? 25) || 25, 200);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);

    const where: string[] = ["t.source = 'custom'"];
    const wp: unknown[] = [];
    if (search) { where.push("LOWER(t.title) LIKE ?"); wp.push(`%${search}%`); }
    // ⚠️ FILTER ON THE *EFFECTIVE* STATUS, NOT THE STORED COLUMN. This mirrors
    // campaignState() in taskLifecycle.ts: a task stored as 'active' whose
    // ends_at has passed READS as 'ended' in the badge. The old `t.status = ?`
    // did not — so an expired campaign appeared under the "active" filter and
    // never under "ended", which is the "ended task still showing / active not
    // showing" bug. The 15-min sweep in server.ts also writes the stored
    // column, so this stays exact AND self-heals.
    const nowIso = now();
    const EFFECTIVE = `
      CASE
        WHEN t.status = 'disabled' THEN 'paused'
        WHEN t.status IN ('draft','paused','exhausted','ended','deleted') THEN t.status
        WHEN t.ends_at IS NOT NULL AND t.ends_at <= ? THEN 'ended'
        WHEN t.starts_at IS NOT NULL AND t.starts_at > ? THEN 'scheduled'
        ELSE 'active'
      END`;
    if (statusF) {
      where.push(`(${EFFECTIVE}) = ?`);
      wp.push(nowIso, nowIso, statusF);
    } else {
      // A soft-deleted task is hidden from the default list; filter by
      // status=deleted to review them.
      where.push("t.status <> 'deleted'");
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const SORTS: Record<string, string> = {
      created_at: "t.created_at", title: "LOWER(t.title)", status: "t.status",
      priority: "t.priority",
    };
    const sortCol = SORTS[query.sort ?? ""] ?? "t.created_at";
    const dir = query.dir === "asc" ? "ASC" : "DESC";

    const [tasks, totalRow] = await Promise.all([
      sql.all<Record<string, unknown>>(
        `SELECT t.id, t.title, t.points, t.reward_type, t.reward_usdt_micro, t.reward_rozi_micro, t.type,
              t.verify_mode, t.instructions, t.proof_label, t.proof_heading, t.proof_help,
              t.proof_required, t.action_url, t.icon, t.minutes, t.country, t.status, t.created_at,
              t.button_label, t.logo_asset_id, t.starts_at, t.ends_at, t.featured, t.priority,
              t.budget_conversions, t.budget_points, t.budget_usdt_micro, t.revenue_per_conversion_micro,
              t.budget_exhausted_at,
              t.category, t.target_countries, t.target_min_account_days,
              t.target_max_account_days, t.target_min_completed,
              (SELECT COUNT(*) FROM task_fields f WHERE f.task_id = t.id) AS field_count,
              (t.postback_secret IS NOT NULL) AS has_secret,
              (SELECT COUNT(*) FROM task_completions c WHERE c.task_id = t.id AND c.status = 'credited') AS credited_count,
              (SELECT COUNT(*) FROM task_proofs p WHERE p.task_id = t.id AND p.status = 'pending') AS pending_proofs
       FROM tasks t ${whereSql} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`,
        ...wp, limit, offset,
      ),
      sql.get<{ n: string | number }>(`SELECT COUNT(*) AS n FROM tasks t ${whereSql}`, ...wp),
    ]);

    // Part 15 — what each campaign earned against what it paid. DERIVED from the
    // completions and the ledger (taskBudget.ts), never a stored counter, so it
    // cannot drift away from the rows it is summarising.
    const money = await campaignMoney(config.pointsPerUsdt);
    return {
      total: Number(totalRow?.n ?? tasks.length),
      offset,
      limit,
      tasks: tasks.map((t) => {
        const m = money.get(t.id as string);
        const cap = t.budget_conversions as number | null;
        const used = m?.conversions ?? 0;
        return {
          ...t,
          effectiveStatus: campaignState(t as { status: string; starts_at?: string | null; ends_at?: string | null }),
          // The Admin-facing form of the stored comma-wrapped list. Served
          // unpacked so the panel never has to know the storage shape — the
          // one place that does is taskTargeting.ts.
          countries: unpackCountries(t.target_countries as string | null, String(t.country ?? "")),
          fieldCount: Number(t.field_count ?? 0),
          // Everything below is money, and it is served pre-computed for the
          // same reason `netUsdt` is on the withdrawal queue: a figure the panel
          // works out for itself is a second definition waiting to disagree.
          spentConversions: used,
          spentPoints: m?.points ?? 0,
          spentUsdtMicro: m?.usdtMicro ?? 0,
          referralPointsPaid: m?.referralPoints ?? 0,
          revenueMicro: m?.revenueMicro ?? 0,
          marginMicro: m?.marginMicro ?? 0,
          // null when there is no cap — NOT 0 and NOT 100. A campaign with no
          // budget is not "0% used", and a progress bar reading 0% forever is
          // how an unbudgeted campaign gets mistaken for a budgeted one.
          budgetUsedPct: cap && cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : null,
        };
      }),
    };
  }));

  // ---- Create a custom task -----------------------------------------------
  app.post("/staff/tasks", staffGuard("tasks.manage", async ({ userId, role }, req) => {
    const b = upsertSchema.parse(req.body ?? {});
    // No two LIVE tasks with the same wording (founder, 2026-09-01). Normalised
    // — trim, collapse inner whitespace, lowercase — so "Join  our channel " and
    // "join our channel" collide. This also makes a double-submit safe: the
    // second POST is a 409, not a second row. A deleted or ended task never
    // blocks reusing its title.
    if (await duplicateTitle(b.title)) {
      throw Object.assign(
        new Error("A task with this name already exists. Rename it, or edit the one you already have."),
        { statusCode: 409 },
      );
    }
    const reward = normalizeReward(b.rewardType, b.points, b.rewardRoziMicro, b.rewardUsdtMicro);
    validateReward(reward.rewardType, reward.rewardRoziMicro, b.rewardUsdtMicro);
    validateSchedule(b.startsAt, b.endsAt);
    if (b.logoAssetId) {
      const asset = await sql.get<{ id: string }>("SELECT id FROM task_assets WHERE id = ?", b.logoAssetId);
      if (!asset) return { ok: false, error: "The uploaded logo could not be found." };
    }
    const id = newId();
    // A postback task needs a secret so a partner can sign; a proof task never
    // has one (there is no server to hand it to), which also means it can't be
    // credited through the postback route even by mistake.
    const secret = b.verifyMode === "postback" ? randomBytes(24).toString("hex") : null;

    // ⚠️ `country` AND `target_countries` ARE WRITTEN TOGETHER, ALWAYS.
    // target_countries is what the feed and the eligibility gate read;
    // `country` is the older single-value column the staff panel, analytics and
    // every pre-Stage-7 query still read, kept as a human-readable summary. A
    // save that touched only one of them would give a task that reads
    // "Pakistan" in the panel and shows in India.
    const countries = b.countries ?? (b.country ? [b.country] : ["ALL"]);
    const packed = packCountries(countries);
    const countryLabel = summariseCountries(countries);

    await sql.run(
      `INSERT INTO tasks
        (id, type, title, points, network, advertiser, minutes, requirement, country, status,
         source, verify_mode, instructions, proof_label, proof_required, action_url, icon,
         postback_secret, budget_conversions, budget_points, revenue_per_conversion_micro,
         category, target_countries, target_min_account_days, target_max_account_days,
         target_min_completed, reward_type, reward_usdt_micro, reward_rozi_micro, budget_usdt_micro,
         proof_heading, proof_help, button_label, logo_asset_id, starts_at, ends_at,
         featured, priority, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'custom', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, "custom", b.title, 0, CUSTOM_NETWORK, "RoziPay", b.minutes,
      b.instructions ?? null, countryLabel, b.status,
      b.verifyMode, b.instructions ?? null, b.proofLabel ?? null,
      b.proofRequired === false ? 0 : 1,
      b.actionUrl && b.actionUrl.length > 0 ? b.actionUrl : null,
      b.icon && b.icon.length > 0 ? b.icon : null, secret,
      b.budgetConversions ?? null, b.budgetPoints ?? null,
      b.revenuePerConversionMicro ?? 0,
      b.category && b.category.length > 0 ? b.category : null,
      packed, b.targetMinAccountDays ?? null, b.targetMaxAccountDays ?? null,
      b.targetMinCompleted ?? null, reward.rewardType, b.rewardUsdtMicro, reward.rewardRoziMicro,
      b.budgetUsdtMicro ?? null, b.proofHeading || null, b.proofHelp || null,
      b.buttonLabel || null, b.logoAssetId ?? null, b.startsAt ?? null, b.endsAt ?? null,
      b.featured ? 1 : 0, b.priority ?? 0, now(),
    );

    await logAudit({
      actorUserId: userId, actorRole: role, action: "custom_task_create",
      detail: `${b.title} (${b.verifyMode}, ${reward.rewardRoziMicro} micro-ROZI, ${b.rewardUsdtMicro} micro-USDT)`,
    });
    return { ok: true, id };
  }));

  // ---- Edit a custom task -------------------------------------------------
  app.patch("/staff/tasks/:id", staffGuard("tasks.manage", async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    const b = upsertSchema.partial().parse(req.body ?? {});

    const existing = await sql.get<{
      verify_mode: string; postback_secret: string | null;
      reward_type: "points" | "rozi" | "usdt" | "both";
      points: number; reward_rozi_micro: string | number; reward_usdt_micro: string | number;
      starts_at: string | null; ends_at: string | null;
    }>(
      `SELECT verify_mode, postback_secret, reward_type, points, reward_rozi_micro, reward_usdt_micro, starts_at, ends_at
       FROM tasks WHERE id = ? AND source = 'custom'`, id,
    );
    if (!existing) return { ok: false, error: "not found" };
    if (b.title !== undefined && await duplicateTitle(b.title, id)) {
      throw Object.assign(
        new Error("Another task already uses this name. Pick a different one."),
        { statusCode: 409 },
      );
    }

    // Only touch/validate the reward when the request actually changes one —
    // an existing row is already valid, and a plain budget PATCH must not have
    // to re-satisfy the reward rules.
    const rewardTouched = b.rewardType !== undefined || b.rewardRoziMicro !== undefined
      || b.rewardUsdtMicro !== undefined || (b.points !== undefined && b.points > 0);
    let reward: { rewardType: "rozi" | "usdt" | "both"; rewardRoziMicro: number } | null = null;
    if (rewardTouched) {
      const nextUsdt = b.rewardUsdtMicro ?? Number(existing.reward_usdt_micro);
      reward = normalizeReward(
        b.rewardType ?? existing.reward_type,
        b.points ?? existing.points ?? 0,
        b.rewardRoziMicro ?? Number(existing.reward_rozi_micro),
        nextUsdt,
      );
      validateReward(reward.rewardType, reward.rewardRoziMicro, nextUsdt);
    }
    validateSchedule(b.startsAt === undefined ? existing.starts_at : b.startsAt,
      b.endsAt === undefined ? existing.ends_at : b.endsAt);
    if (b.logoAssetId) {
      const asset = await sql.get<{ id: string }>("SELECT id FROM task_assets WHERE id = ?", b.logoAssetId);
      if (!asset) return { ok: false, error: "The uploaded logo could not be found." };
    }

    const nextMode = b.verifyMode ?? existing.verify_mode;
    // Switching TO postback mints a secret if there wasn't one; switching to
    // proof drops it (the postback URL stops working, which is correct).
    let secret = existing.postback_secret;
    if (nextMode === "postback" && !secret) secret = randomBytes(24).toString("hex");
    if (nextMode === "proof") secret = null;

    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
    if (b.title !== undefined) set("title", b.title);
    if (reward) {
      set("reward_type", reward.rewardType);
      set("reward_rozi_micro", reward.rewardRoziMicro);
      set("reward_usdt_micro", b.rewardUsdtMicro ?? Number(existing.reward_usdt_micro));
      set("points", 0);
    }
    if (b.minutes !== undefined) set("minutes", b.minutes);
    if (b.status !== undefined) set("status", b.status);
    // ⚠️ THE TWO COUNTRY COLUMNS MOVE TOGETHER OR NOT AT ALL — see the note on
    // the create path. `countries` is the real control; a bare `country` from an
    // older client is accepted and treated as a one-country list, so it still
    // changes what the feed does rather than only what the panel says.
    if (b.countries !== undefined || b.country !== undefined) {
      const list = b.countries ?? [b.country as string];
      set("target_countries", packCountries(list));
      set("country", summariseCountries(list));
    }
    if (b.category !== undefined) set("category", b.category && b.category.length > 0 ? b.category : null);
    if (b.targetMinAccountDays !== undefined) set("target_min_account_days", b.targetMinAccountDays);
    if (b.targetMaxAccountDays !== undefined) set("target_max_account_days", b.targetMaxAccountDays);
    if (b.targetMinCompleted !== undefined) set("target_min_completed", b.targetMinCompleted);
    if (b.instructions !== undefined) { set("instructions", b.instructions); set("requirement", b.instructions); }
    if (b.proofLabel !== undefined) set("proof_label", b.proofLabel);
    if (b.proofHeading !== undefined) set("proof_heading", b.proofHeading || null);
    if (b.proofHelp !== undefined) set("proof_help", b.proofHelp || null);
    if (b.proofRequired !== undefined) set("proof_required", b.proofRequired ? 1 : 0);
    if (b.actionUrl !== undefined) set("action_url", b.actionUrl && b.actionUrl.length > 0 ? b.actionUrl : null);
    if (b.icon !== undefined) set("icon", b.icon && b.icon.length > 0 ? b.icon : null);
    if (b.logoAssetId !== undefined) set("logo_asset_id", b.logoAssetId);
    if (b.buttonLabel !== undefined) set("button_label", b.buttonLabel || null);
    if (b.startsAt !== undefined) set("starts_at", b.startsAt);
    if (b.endsAt !== undefined) set("ends_at", b.endsAt);
    if (b.featured !== undefined) set("featured", b.featured ? 1 : 0);
    if (b.priority !== undefined) set("priority", b.priority);
    // Budgets: `null` clears the cap, a number sets it, absent leaves it.
    if (b.budgetConversions !== undefined) set("budget_conversions", b.budgetConversions);
    if (b.budgetPoints !== undefined) set("budget_points", b.budgetPoints);
    if (b.budgetUsdtMicro !== undefined) set("budget_usdt_micro", b.budgetUsdtMicro);
    if (b.revenuePerConversionMicro !== undefined) {
      set("revenue_per_conversion_micro", b.revenuePerConversionMicro);
    }
    // ⚠️ RAISING A BUDGET ON AN EXHAUSTED CAMPAIGN REOPENS IT. Otherwise the one
    // action that fixes the problem — giving the campaign more room — leaves it
    // paused, and the Admin has to know to also flip the status back. The stamp
    // stays, so the record that it ran out once is not erased. If the new budget
    // is still under what has been spent, the next completion pauses it again.
    if (b.status === undefined && (b.budgetConversions !== undefined || b.budgetPoints !== undefined
        || b.budgetUsdtMicro !== undefined)) {
      const cur = await sql.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", id);
      if (cur?.status === EXHAUSTED) set("status", "active");
    }
    set("verify_mode", nextMode);
    set("postback_secret", secret);

    vals.push(id);
    await sql.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...vals);

    await logAudit({
      actorUserId: userId, actorRole: role, action: "custom_task_update",
      detail: `task ${id}: ${sets.map((s) => s.split(" = ")[0]).join(", ")}`,
    });
    return { ok: true };
  }));

  app.post("/staff/tasks/:id/lifecycle", staffGuard("tasks.manage", async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    const { action } = z.object({ action: z.enum(["pause", "resume", "end"]) }).parse(req.body ?? {});
    const task = await sql.get<{ status: string; starts_at: string | null; ends_at: string | null }>(
      "SELECT status, starts_at, ends_at FROM tasks WHERE id = ? AND source = 'custom'", id,
    );
    if (!task) return { ok: false, error: "not found" };
    let status: string;
    if (action === "pause") status = "paused";
    else if (action === "end") status = "ended";
    else if (task.ends_at && Date.parse(task.ends_at) <= Date.now()) {
      return { ok: false, error: "This task has already reached its end time. Change the schedule before resuming it." };
    } else status = task.starts_at && Date.parse(task.starts_at) > Date.now() ? "scheduled" : "active";
    await sql.run("UPDATE tasks SET status = ? WHERE id = ?", status, id);
    await logAudit({ actorUserId: userId, actorRole: role, action: `custom_task_${action}`, detail: `task ${id}: ${task.status} -> ${status}` });
    return { ok: true, status };
  }));

  // ---- Delete a custom task (soft) -------------------------------------------
  // Sets status='deleted'. The row stays so historical task_completions /
  // task_proofs still join; it is hidden from the earner feed and from the
  // default admin list. A task that has PAID OUT must be ended first — deleting
  // one that users are mid-flight on would strand their proofs with nothing to
  // point at in the panel.
  app.delete("/staff/tasks/:id", staffGuard("tasks.manage", async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    const task = await sql.get<{ status: string; title: string }>(
      "SELECT status, title FROM tasks WHERE id = ? AND source = 'custom'", id,
    );
    if (!task) throw Object.assign(new Error("Task not found."), { statusCode: 404 });
    if (task.status === "deleted") return { ok: true };
    const credited = await sql.get<{ n: string | number }>(
      "SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ? AND status = 'credited'", id,
    );
    if (Number(credited?.n ?? 0) > 0 && task.status !== "ended") {
      throw Object.assign(
        new Error("This task has already paid out to users. End it first, then delete it."),
        { statusCode: 409 },
      );
    }
    await sql.run("UPDATE tasks SET status = 'deleted' WHERE id = ?", id);
    await logAudit({ actorUserId: userId, actorRole: role, action: "custom_task_delete", detail: `task ${id}: ${task.title}` });
    return { ok: true };
  }));

  // ---- Overall task funnel (all our campaigns, last 30 days + all-time) ----
  app.get("/staff/tasks/overview", staffGuard("tasks.view", async () => {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const g = async (sql30: string, sqlAll: string): Promise<{ d30: number; all: number }> => {
      const [a, b] = await Promise.all([
        sql.get<{ n: number }>(sql30, since), sql.get<{ n: number }>(sqlAll),
      ]);
      return { d30: Number(a?.n ?? 0), all: Number(b?.n ?? 0) };
    };
    // Only OUR OWN tasks (source='custom') — network offerwall funnels are a
    // different shape and live on the networks screen.
    const own = "AND task_id IN (SELECT id FROM tasks WHERE source = 'custom')";
    const [opened, started, submitted, approved, rejected, pending, completed, campaigns] = await Promise.all([
      g(`SELECT COUNT(DISTINCT user_id)::int AS n FROM task_opens WHERE last_at >= ? ${own}`,
        `SELECT COUNT(DISTINCT user_id)::int AS n FROM task_opens WHERE 1=1 ${own}`),
      g(`SELECT COUNT(*)::int AS n FROM task_participation WHERE started_at >= ? ${own}`,
        `SELECT COUNT(*)::int AS n FROM task_participation WHERE 1=1 ${own}`),
      g(`SELECT COUNT(*)::int AS n FROM task_proofs WHERE created_at >= ? ${own}`,
        `SELECT COUNT(*)::int AS n FROM task_proofs WHERE 1=1 ${own}`),
      g(`SELECT COUNT(*)::int AS n FROM task_proofs WHERE status='approved' AND created_at >= ? ${own}`,
        `SELECT COUNT(*)::int AS n FROM task_proofs WHERE status='approved' ${own}`),
      g(`SELECT COUNT(*)::int AS n FROM task_proofs WHERE status='rejected' AND created_at >= ? ${own}`,
        `SELECT COUNT(*)::int AS n FROM task_proofs WHERE status='rejected' ${own}`),
      g(`SELECT COUNT(*)::int AS n FROM task_proofs WHERE status='pending' AND created_at >= ? ${own}`,
        `SELECT COUNT(*)::int AS n FROM task_proofs WHERE status='pending' ${own}`),
      g(`SELECT COUNT(*)::int AS n FROM task_completions WHERE status='credited' AND created_at >= ? ${own}`,
        `SELECT COUNT(*)::int AS n FROM task_completions WHERE status='credited' ${own}`),
      sql.get<{ active: number; total: number }>(
        `SELECT COUNT(*) FILTER (WHERE status IN ('active','scheduled'))::int AS active,
                COUNT(*) FILTER (WHERE status <> 'deleted')::int AS total
           FROM tasks WHERE source = 'custom'`),
    ]);
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);
    return {
      window30d: { opened: opened.d30, started: started.d30, submitted: submitted.d30,
        approved: approved.d30, rejected: rejected.d30, pending: pending.d30, completed: completed.d30,
        openedToCompleted: pct(completed.d30, opened.d30),
        approvalRate: pct(approved.d30, submitted.d30) },
      allTime: { opened: opened.all, started: started.all, submitted: submitted.all,
        approved: approved.all, rejected: rejected.all, pending: pending.all, completed: completed.all },
      campaigns: { active: Number(campaigns?.active ?? 0), total: Number(campaigns?.total ?? 0) },
    };
  }));

  // ---- Per-task metrics (the funnel + money for ONE campaign) --------------
  // opened -> started -> proof submitted -> approved -> credited, each an
  // absolute count plus the step-to-step conversion %, plus this campaign's
  // revenue/margin (reusing campaignMoney) and a 30-day daily series. Every
  // number is DERIVED from a table that already exists — no counter to drift.
  app.get("/staff/tasks/:id/metrics", staffGuard("tasks.view", async (_ctx, req) => {
    const id = (req.params as { id: string }).id;
    const task = await sql.get<{ id: string; title: string; budget_conversions: number | null }>(
      "SELECT id, title, budget_conversions FROM tasks WHERE id = ? AND source = 'custom'", id,
    );
    if (!task) throw Object.assign(new Error("Task not found."), { statusCode: 404 });

    const num = (v: unknown) => Number(v ?? 0);
    const [opensRow, startedRow, proofRow, creditedRow, money, series] = await Promise.all([
      sql.get<{ users: number; opens: number }>(
        "SELECT COUNT(*)::int AS users, COALESCE(SUM(opens),0)::int AS opens FROM task_opens WHERE task_id = ?", id),
      sql.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM task_participation WHERE task_id = ?", id),
      sql.get<{ submitted: number; approved: number; rejected: number; pending: number }>(
        `SELECT COUNT(*)::int AS submitted,
                COUNT(*) FILTER (WHERE status='approved')::int AS approved,
                COUNT(*) FILTER (WHERE status='rejected')::int AS rejected,
                COUNT(*) FILTER (WHERE status='pending')::int  AS pending
           FROM task_proofs WHERE task_id = ?`, id),
      sql.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM task_completions WHERE task_id = ? AND status = 'credited'", id),
      campaignMoney(config.pointsPerUsdt),
      sql.all<{ day: string; opens: number; submitted: number; approved: number; credited: number }>(
        `SELECT d.day,
                COALESCE(o.opens,0)::int      AS opens,
                COALESCE(p.submitted,0)::int  AS submitted,
                COALESCE(p.approved,0)::int   AS approved,
                COALESCE(c.credited,0)::int   AS credited
           FROM (
             SELECT to_char(gs::date,'YYYY-MM-DD') AS day
               FROM generate_series(now() - interval '29 days', now(), interval '1 day') gs
           ) d
           LEFT JOIN (SELECT substr(last_at,1,10) AS day, SUM(opens) AS opens
                        FROM task_opens WHERE task_id = ? GROUP BY 1) o ON o.day = d.day
           LEFT JOIN (SELECT substr(created_at,1,10) AS day,
                             COUNT(*) AS submitted,
                             COUNT(*) FILTER (WHERE status='approved') AS approved
                        FROM task_proofs WHERE task_id = ? GROUP BY 1) p ON p.day = d.day
           LEFT JOIN (SELECT substr(COALESCE(verified_at, created_at),1,10) AS day, COUNT(*) AS credited
                        FROM task_completions WHERE task_id = ? AND status='credited' GROUP BY 1) c ON c.day = d.day
          ORDER BY d.day`,
        id, id, id),
    ]);

    const opened = num(opensRow?.users);
    const started = num(startedRow?.n);
    const submitted = num(proofRow?.submitted);
    const approved = num(proofRow?.approved);
    const rejected = num(proofRow?.rejected);
    const pending = num(proofRow?.pending);
    const completed = num(creditedRow?.n);
    const m = money.get(id);
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);

    return {
      taskId: id,
      title: task.title,
      funnel: {
        opened, started, submitted, approved, rejected, pending, completed,
      },
      conversion: {
        // Each step relative to the one before it — where users drop off.
        openedToStarted: pct(started, opened),
        startedToSubmitted: pct(submitted, started),
        submittedToApproved: pct(approved, submitted),
        approvedToCompleted: pct(completed, approved),
        // And the whole thing end to end.
        openedToCompleted: pct(completed, opened),
      },
      money: {
        conversions: m?.conversions ?? completed,
        pointsPaid: m?.points ?? 0,
        usdtPaidMicro: m?.usdtMicro ?? 0,
        referralPointsPaid: m?.referralPoints ?? 0,
        revenueMicro: m?.revenueMicro ?? 0,
        marginMicro: m?.marginMicro ?? 0,
        budgetConversions: task.budget_conversions,
        budgetUsedPct: task.budget_conversions && task.budget_conversions > 0
          ? Math.min(100, Math.round((completed / task.budget_conversions) * 100)) : null,
      },
      totalOpens: num(opensRow?.opens),
      series,
    };
  }));

  // ---- A task's input fields (Stage 7) ------------------------------------
  app.get("/staff/tasks/:id/fields", staffGuard("tasks.view", async (_ctx, req) => {
    const id = (req.params as { id: string }).id;
    return { fields: (await fieldsForTask(id)).map(publicField) };
  }));

  // Replace the WHOLE list in one call, rather than a route per field.
  //
  // Why a whole-list PUT: the fields of a form are ordered, and order is a
  // property of the list, not of any one row. Per-field POST/DELETE/reorder
  // endpoints would let the panel get halfway through a rewrite and leave a
  // form with two "Your username" boxes and a gap in the sort order. One call,
  // one transaction, one valid state.
  app.put("/staff/tasks/:id/fields", staffGuard("tasks.manage", async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    const { fields } = z.object({ fields: z.array(fieldSchema).max(MAX_FIELDS_PER_TASK) })
      .parse(req.body ?? {});

    const task = await sql.get<{ id: string }>(
      "SELECT id FROM tasks WHERE id = ? AND source = 'custom'", id,
    );
    if (!task) return { ok: false, error: "not found" };

    // A 'choice' field with no choices renders as a question that cannot be
    // answered — validateAnswers() refuses those answers, so the user would meet
    // a dead form. Caught here, where an Admin can still fix it.
    for (const f of fields) {
      if (f.kind === "choice" && (f.options ?? "").split("\n").filter((s) => s.trim()).length === 0) {
        return { ok: false, error: `“${f.label}” is a choice question with no choices. Add one per line.` };
      }
      if (f.kind === "crypto_address" && !f.validation) {
        return { ok: false, error: `Choose a wallet network for “${f.label}”.` };
      }
    }

    const existing = await fieldsForTask(id);
    const keep = new Set(fields.map((f) => f.id).filter(Boolean) as string[]);

    await sql.tx(async (tx) => {
      // Rows the Admin removed. Answers already submitted keep their own
      // snapshotted label and kind (db.ts), so deleting the question never
      // blanks evidence a reviewer has read.
      for (const e of existing) {
        if (!keep.has(e.id)) await tx.run("DELETE FROM task_fields WHERE id = ?", e.id);
      }
      for (const [i, f] of fields.entries()) {
        const opts = f.kind === "choice" ? (f.options ?? "") : null;
        if (f.id && existing.some((e) => e.id === f.id)) {
          await tx.run(
            `UPDATE task_fields SET label = ?, kind = ?, required = ?, placeholder = ?, help = ?,
                                    options = ?, validation = ?, max_len = ?, sort_order = ? WHERE id = ?`,
            f.label, f.kind, f.required ? 1 : 0, f.placeholder ?? null, f.help ?? null,
            opts, f.kind === "crypto_address" ? f.validation ?? "generic" : null,
            f.maxLen ?? null, i, f.id,
          );
        } else {
          await tx.run(
            `INSERT INTO task_fields (id, task_id, label, kind, required, placeholder, help,
                                      options, validation, max_len, sort_order, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            newId(), id, f.label, f.kind, f.required ? 1 : 0, f.placeholder ?? null,
            f.help ?? null, opts, f.kind === "crypto_address" ? f.validation ?? "generic" : null,
            f.maxLen ?? null, i, now(),
          );
        }
      }
    });

    await logAudit({
      actorUserId: userId, actorRole: role, action: "custom_task_fields_update",
      detail: `task ${id}: ${fields.length} field(s)`,
    });
    return { ok: true, fields: (await fieldsForTask(id)).map(publicField) };
  }));

  // ---- Reveal the postback URL + secret for a task ------------------------
  // Separate endpoint (not in the list) so the secret is fetched deliberately,
  // and every reveal is audit-logged.
  app.get("/staff/tasks/:id/postback", staffGuard("tasks.manage", async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    const t = await sql.get<{ postback_secret: string | null; verify_mode: string }>(
      "SELECT postback_secret, verify_mode FROM tasks WHERE id = ? AND source = 'custom'", id,
    );
    if (!t) return { ok: false, error: "not found" };
    if (t.verify_mode !== "postback" || !t.postback_secret) {
      return { ok: false, error: "this task is verified by staff approval, not a postback" };
    }
    await logAudit({
      actorUserId: userId, actorRole: role, action: "custom_task_secret_view", detail: `task ${id}`,
    });
    return {
      ok: true,
      taskId: id,
      secret: t.postback_secret,
      path: "/webhooks/custom/postback",
      // The signed string a partner must reproduce. Spelled out so it can be
      // copy-pasted into their integration without reading our source.
      signature: "hex(HMAC_SHA256(secret, `${task_id}.${user_id}.${txn_id}`))",
      params: ["task_id", "user_id", "txn_id", "sig"],
    };
  }));

  // ---- Proof review dashboard (Stage 7) -----------------------------------
  //
  // The old queue was a status filter and a list. It could not answer the two
  // questions a reviewer actually has — "how much is waiting?" and "is this
  // person a repeat offender?" — and with one task's proofs mixed into every
  // other task's, reviewing a single campaign meant reading past everything
  // else.
  app.get("/staff/task-proofs", staffGuard("tasks.review", async (_ctx, req) => {
    const q = req.query as { status?: string; taskId?: string; q?: string; sort?: string; dir?: string; limit?: string; offset?: string };
    // Two-step release (2026-09-01) split the old "approved" bucket in two:
    //   reward_pending — an Agent accepted the evidence, reward not sent yet
    //   paid           — creditCompletion() has run, reward on the user's balance
    // `approved` is still accepted from an older client and means `paid`.
    const rawStatus = z.enum(["pending", "reward_pending", "paid", "approved", "rejected"]).catch("pending").parse(q.status);
    const status = rawStatus === "approved" ? "paid" : rawStatus;
    const taskId = (q.taskId ?? "").trim();
    const search = (q.q ?? "").trim().toLowerCase();
    // Pagination (admin rebuild, Phase D). The queue used to hand back up to 200
    // rows in one screen; `offset` + `total` let the shared <DataTable> page it.
    const limit = Math.min(Number(q.limit ?? 25) || 25, 200);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    // Oldest-waiting-first is the review default; a whitelisted toggle only.
    const dir = q.dir === "desc" ? "DESC" : "ASC";

    const statusWhere =
      status === "pending" ? "p.status = 'pending'"
      : status === "reward_pending" ? "p.status = 'approved' AND p.reward_status = 'pending'"
      : status === "paid" ? "p.status = 'approved' AND p.reward_status = 'sent'"
      : "p.status = 'rejected'";
    const where: string[] = [`(${statusWhere})`];
    const args: unknown[] = [];
    if (taskId) { where.push("p.task_id = ?"); args.push(taskId); }
    if (search) {
      // Email or @handle. LOWER on both sides rather than ILIKE so PGlite and
      // Postgres behave identically.
      where.push("(LOWER(u.email) LIKE ? OR LOWER(COALESCE(u.username,'')) LIKE ?)");
      args.push(`%${search}%`, `%${search}%`);
    }

    const proofs = await sql.all<Record<string, unknown>>(
      `SELECT p.id, p.task_id, p.user_id, p.proof_text, p.answers, p.status, p.review_note,
              p.created_at, p.reviewed_at, p.reward_status, p.released_at,
              u.email AS user_email, u.username AS user_handle, u.country AS user_country,
              u.display_name AS user_display_name,
              u.created_at AS user_joined,
              COALESCE(p.task_title_snapshot, t.title) AS task_title,
              COALESCE(p.reward_points, t.points) AS task_points,
              COALESCE(p.reward_rozi_micro, t.reward_rozi_micro) AS task_rozi_micro,
              COALESCE(p.reward_usdt_micro, t.reward_usdt_micro) AS task_usdt_micro,
              t.reward_rozi_micro AS task_defined_rozi_micro,
              t.reward_usdt_micro AS task_defined_usdt_micro,
              t.proof_label, t.category,
              COALESCE(p.task_logo_asset_snapshot, t.logo_asset_id) AS task_logo_asset_id,
              r.email AS reviewer_email,
              rl.email AS releaser_email,
              -- The user's saved cash-out wallet, so a reviewer can see where
              -- their eventual USDT withdrawal will land. One chain is offered
              -- (BEP20), so this join is one row.
              pa.address AS user_payout_address, pa.verified_at AS user_payout_verified_at
       FROM task_proofs p
       JOIN users u ON u.id = p.user_id
       JOIN tasks t ON t.id = p.task_id
       LEFT JOIN users r ON r.id = p.reviewed_by
       LEFT JOIN users rl ON rl.id = p.released_by
       LEFT JOIN payout_addresses pa ON pa.user_id = p.user_id AND pa.chain = 'bep20'
       WHERE ${where.join(" AND ")}
       ORDER BY p.created_at ${dir} LIMIT ? OFFSET ?`,
      ...args, limit, offset,
    );
    // Row count for THIS filter (status + task + search) — drives the pager.
    const totalRow = await sql.get<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM task_proofs p JOIN users u ON u.id = p.user_id WHERE ${where.join(" AND ")}`,
      ...args,
    );

    // ⚠️ THE COUNTS ARE OVER ALL PROOFS, NEVER THE CURRENT FILTER — the same
    // rule the support queue follows (stage 6). A "pending" number that shrank
    // because someone typed a search would be read as the backlog clearing.
    const countRow = await sql.get<Record<string, string | number>>(
      `SELECT
         SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status='approved' AND reward_status='pending' THEN 1 ELSE 0 END) AS reward_pending,
         SUM(CASE WHEN status='approved' AND reward_status='sent' THEN 1 ELSE 0 END) AS paid,
         SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected
       FROM task_proofs`,
    );
    const counts = {
      pending: Number(countRow?.pending ?? 0),
      reward_pending: Number(countRow?.reward_pending ?? 0),
      paid: Number(countRow?.paid ?? 0),
      rejected: Number(countRow?.rejected ?? 0),
    } as Record<string, number>;

    // The user's own record, so a reviewer can see a repeat rejection without
    // opening another screen. One grouped query for the whole page rather than
    // two correlated subqueries per row.
    const userIds = [...new Set(proofs.map((p) => p.user_id as string))];
    const history = new Map<string, { approved: number; rejected: number }>();
    if (userIds.length > 0) {
      const rows = await sql.all<{ user_id: string; status: string; n: string | number }>(
        `SELECT user_id, status, COUNT(*) AS n FROM task_proofs
         WHERE user_id IN (${userIds.map(() => "?").join(",")}) AND status <> 'pending'
         GROUP BY user_id, status`,
        ...userIds,
      );
      for (const r of rows) {
        const h = history.get(r.user_id) ?? { approved: 0, rejected: 0 };
        if (r.status === "approved") h.approved = Number(r.n);
        if (r.status === "rejected") h.rejected = Number(r.n);
        history.set(r.user_id, h);
      }
    }

    // Tasks that have ever produced a proof — the filter's option list. Built
    // from proofs rather than from all tasks so it never offers a filter that
    // would return nothing.
    const tasks = await sql.all<{ id: string; title: string; n: string | number }>(
      `SELECT t.id, t.title, COUNT(*) AS n FROM task_proofs p JOIN tasks t ON t.id = p.task_id
       WHERE p.status = 'pending' GROUP BY t.id, t.title ORDER BY COUNT(*) DESC`,
    );

    return {
      counts,
      total: Number(totalRow?.n ?? proofs.length),
      offset,
      limit,
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, pending: Number(t.n) })),
      proofs: proofs.map((p) => ({
        ...p,
        // The structured answers, when the task has fields. Older rows have
        // none and fall back to proof_text, which is what the queue always
        // showed — so nothing needs a "structured or not" branch downstream.
        answers: parseAnswers(p.answers as string | null),
        userHistory: history.get(p.user_id as string) ?? { approved: 0, rejected: 0 },
      })),
    };
  }));

  // ---- Approve / reject a proof (STEP 1 — no credit) --------------------
  //
  // TWO-STEP RELEASE (founder, 2026-09-01). Approving a proof no longer pays
  // it. It records the human decision on the EVIDENCE and locks in the reward
  // amounts (the Agent may reduce either currency here — skip the USDT, zero
  // the ROZI — but never raise it above what the user was promised). The
  // reward lands only when `/release` runs creditCompletion(). So a user's
  // journey reads: Under review -> Approved, reward on the way -> Reward sent.
  app.post("/staff/task-proofs/:id/decision", staffGuard("tasks.review", async ({ userId, role }, req) => {
    const proofId = (req.params as { id: string }).id;
    const b = z.object({
      action: z.enum(["approve", "reject"]),
      note: z.string().max(500).optional(),
      // Agent-adjusted reward, in micro. Absent => the full promised amount.
      roziMicro: z.number().int().nonnegative().optional(),
      usdtMicro: z.number().int().nonnegative().optional(),
    }).parse(req.body ?? {});
    return decideProof({ userId, role }, proofId, b.action, b.note, {
      roziMicro: b.roziMicro, usdtMicro: b.usdtMicro,
    });
  }));

  // ---- Release the reward (STEP 2 — the credit) ------------------------
  // Runs the SAME creditCompletion() path a network postback uses (referral
  // bonuses, velocity caps, campaign budget, mining boost). Idempotent: the
  // completion is keyed on `proof:<id>`, so a double-release is a no-op.
  app.post("/staff/task-proofs/:id/release", staffGuard("tasks.review", async ({ userId, role }, req) => {
    const proofId = (req.params as { id: string }).id;
    return releaseProof(app, { userId, role }, proofId);
  }));

  // ---- Decide several at once ---------------------------------------------
  //
  // ⚠️ A BULK DECISION IS N SEPARATE DECISIONS, NOT ONE. Each row goes through
  // exactly the same path as a single click, and each gets its own outcome
  // back — because the interesting cases are per-row: one user is over a
  // velocity cap, the campaign runs out of budget halfway down the list, a row
  // was already reviewed in another tab. Wrapping the lot in one transaction
  // would mean one blocked user silently undoing forty good approvals, and
  // reporting a single ok/error would mean a reviewer believing they had
  // cleared a queue they had not.
  app.post("/staff/task-proofs/bulk", staffGuard("tasks.review", async ({ userId, role }, req) => {
    const b = z.object({
      ids: z.array(z.string().max(64)).min(1).max(50),
      action: z.enum(["approve", "reject", "release"]),
      note: z.string().max(500).optional(),
    }).parse(req.body ?? {});

    const results: { id: string; ok: boolean; error?: string; credited?: number; creditedRoziMicro?: number; creditedUsdtMicro?: number }[] = [];
    for (const id of [...new Set(b.ids)]) {
      const r = b.action === "release"
        ? await releaseProof(app, { userId, role }, id)
        : await decideProof({ userId, role }, id, b.action, b.note, {});
      results.push({
        id, ok: r.ok, error: r.error,
        credited: r.credited, creditedRoziMicro: r.creditedRoziMicro, creditedUsdtMicro: r.creditedUsdtMicro,
      });
    }
    return {
      ok: true,
      done: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      creditedPoints: results.reduce((s, r) => s + (r.credited ?? 0), 0),
      creditedRoziMicro: results.reduce((s, r) => s + (r.creditedRoziMicro ?? 0), 0),
      creditedUsdtMicro: results.reduce((s, r) => s + (r.creditedUsdtMicro ?? 0), 0),
      results,
    };
  }));
}

type ProofOutcome = {
  ok: boolean; error?: string; status?: string; duplicate?: boolean;
  rewardStatus?: "pending" | "sent"; roziMicro?: number; usdtMicro?: number;
  credited?: number; creditedRoziMicro?: number; creditedUsdtMicro?: number;
};

// STEP 1. Accept or reject the evidence. NO ledger write happens here.
// Shared by the single-click and bulk routes so the two can never drift.
async function decideProof(
  ctx: { userId: string; role: Role },
  proofId: string,
  action: "approve" | "reject",
  note: string | undefined,
  amounts: { roziMicro?: number; usdtMicro?: number },
): Promise<ProofOutcome> {
  const { userId, role } = ctx;

  const proof = await sql.get<{
    id: string; task_id: string; user_id: string; status: string; reward_status: string | null;
    reward_points: number | null; reward_rozi_micro: string | number | null; reward_usdt_micro: string | number | null;
  }>(`SELECT id, task_id, user_id, status, reward_status, reward_points, reward_rozi_micro, reward_usdt_micro
       FROM task_proofs WHERE id = ?`, proofId);
  if (!proof) return { ok: false, error: "not found" };

  // Reject is allowed while still pending AND on a proof an Agent approved but
  // has NOT released — nothing has been credited, so this is safe Agent-error
  // recovery. Once the reward is sent, the decision is final.
  const approvedUnreleased = proof.status === "approved" && proof.reward_status === "pending";

  if (action === "reject") {
    if (proof.status !== "pending" && !approvedUnreleased) return { ok: false, error: "already reviewed" };
    await sql.run(
      "UPDATE task_proofs SET status = 'rejected', reward_status = NULL, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
      note ?? null, userId, now(), proofId,
    );
    await logAudit({
      actorUserId: userId, actorRole: role, action: "task_proof_reject",
      targetUserId: proof.user_id, detail: `proof ${proofId}${note ? `: ${note}` : ""}`,
    });
    return { ok: true, status: "rejected" };
  }

  // APPROVE.
  if (proof.status !== "pending") return { ok: false, error: "already reviewed" };
  const task = await sql.get<{ points: number; reward_rozi_micro: string | number; reward_usdt_micro: string | number }>(
    "SELECT points, reward_rozi_micro, reward_usdt_micro FROM tasks WHERE id = ? AND source = 'custom'",
    proof.task_id,
  );
  if (!task) return { ok: false, error: "task missing" };

  // Ceiling = what the user was promised: the proof snapshot if set, else the
  // task's value (same COALESCE the old one-step path used). The Agent's number
  // is clamped into [0, ceiling] — an Agent can withhold a currency, never
  // inflate a payout.
  const roziCeil = Number(proof.reward_rozi_micro ?? task.reward_rozi_micro ?? 0);
  const usdtCeil = Number(proof.reward_usdt_micro ?? task.reward_usdt_micro ?? 0);
  const roziMicro = Math.min(roziCeil, Math.max(0, Math.trunc(amounts.roziMicro ?? roziCeil)));
  const usdtMicro = Math.min(usdtCeil, Math.max(0, Math.trunc(amounts.usdtMicro ?? usdtCeil)));

  await sql.run(
    `UPDATE task_proofs SET status = 'approved', reward_status = 'pending',
       reward_rozi_micro = ?, reward_usdt_micro = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?
     WHERE id = ?`,
    roziMicro, usdtMicro, note ?? null, userId, now(), proofId,
  );
  await logAudit({
    actorUserId: userId, actorRole: role, action: "task_proof_approve",
    targetUserId: proof.user_id,
    detail: `proof ${proofId} accepted -> reward on the way (${roziMicro} micro-ROZI + ${usdtMicro} micro-USDT)`,
  });
  return { ok: true, status: "approved", rewardStatus: "pending", roziMicro, usdtMicro };
}

// STEP 2. Pay the (possibly Agent-adjusted) reward through the shared credit
// path. Only an approved, not-yet-released proof is eligible.
async function releaseProof(
  app: FastifyInstance,
  ctx: { userId: string; role: Role },
  proofId: string,
): Promise<ProofOutcome> {
  const { userId, role } = ctx;

  const proof = await sql.get<{
    id: string; task_id: string; user_id: string; status: string; reward_status: string | null;
    reward_points: number | null; reward_rozi_micro: string | number | null; reward_usdt_micro: string | number | null;
  }>(`SELECT id, task_id, user_id, status, reward_status, reward_points, reward_rozi_micro, reward_usdt_micro
       FROM task_proofs WHERE id = ?`, proofId);
  if (!proof) return { ok: false, error: "not found" };
  if (proof.status !== "approved" || proof.reward_status !== "pending") {
    return { ok: false, error: proof.reward_status === "sent" ? "reward already sent" : "approve it first" };
  }

  const task = await sql.get<{ points: number; reward_rozi_micro: string | number; reward_usdt_micro: string | number }>(
    "SELECT points, reward_rozi_micro, reward_usdt_micro FROM tasks WHERE id = ? AND source = 'custom'",
    proof.task_id,
  );
  if (!task) return { ok: false, error: "task missing" };

  // The snapshot on the proof is authoritative — it already holds the
  // Agent-adjusted amounts written at approve time.
  const rewardPoints = proof.reward_points ?? task.points ?? 0;
  const rewardRoziMicro = Number(proof.reward_rozi_micro ?? task.reward_rozi_micro ?? 0);
  const rewardUsdtMicro = Number(proof.reward_usdt_micro ?? task.reward_usdt_micro ?? 0);
  const rewardType = rewardRoziMicro > 0 && rewardUsdtMicro > 0 ? "both"
    : rewardUsdtMicro > 0 ? "usdt"
    : rewardRoziMicro > 0 ? "rozi"
    : "points";

  const net = await sql.get<NetworkRow>(
    `SELECT status, referral_bonus_pct, referral_bonus_pct_l2, referral_first_task_bonus, referral_bonus_days
     FROM networks WHERE id = ?`, CUSTOM_NETWORK,
  );

  const outcome = await creditCompletion({
    userId: proof.user_id, network: CUSTOM_NETWORK, externalId: `proof:${proofId}`,
    taskId: proof.task_id, points: rewardPoints, usdtMicro: rewardUsdtMicro, roziMicro: rewardRoziMicro,
    rewardType, offerType: "custom",
    payload: { proofId, releasedBy: userId },
    net,
    // A blocked release must NOT burn the external_id — the proof stays
    // 'reward pending' and can be released again once the block clears.
    recordRejection: false,
  }, app.log);

  if (outcome.status === "velocity_blocked") {
    return { ok: false, error: `Blocked by a fraud cap (${outcome.detail}). The user is over their daily limit — try again later.` };
  }
  if (outcome.status === "budget_exhausted") {
    return {
      ok: false,
      error: `This campaign's budget is used up (${outcome.used} of ${outcome.cap} `
        + `${outcome.reason === "points" ? "points" : outcome.reason === "usdt" ? "micro-USDT" : "conversions"}), so it has paused itself. `
        + "Raise its budget in Our own tasks to release this.",
    };
  }
  if (outcome.status === "unknown_user") return { ok: false, error: "user not found" };

  // credited OR duplicate (a double-release / earlier double-click) — either
  // way the reward is now on the user's balance, so mark it sent.
  await sql.run(
    "UPDATE task_proofs SET reward_status = 'sent', released_by = ?, released_at = ? WHERE id = ?",
    userId, now(), proofId,
  );
  if (outcome.status === "duplicate") return { ok: true, status: "paid", duplicate: true };

  await logAudit({
    actorUserId: userId, actorRole: role, action: "task_proof_release",
    targetUserId: proof.user_id,
    detail: `proof ${proofId} -> ${outcome.roziMicro} micro-ROZI + ${outcome.usdtMicro} micro-USDT`,
  });
  return {
    ok: true, status: "paid",
    credited: outcome.points, creditedRoziMicro: outcome.roziMicro, creditedUsdtMicro: outcome.usdtMicro,
  };
}
