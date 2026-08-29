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
  budgetConversions: z.number().int().positive().max(10_000_000).nullable().optional(),
  budgetPoints: z.number().int().positive().max(1_000_000_000).nullable().optional(),
  budgetUsdtMicro: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  // What the partner pays US per conversion, in micro-USD. Entered as dollars
  // in the panel and converted there; stored as an integer so no campaign's
  // margin is computed from a float.
  revenuePerConversionMicro: z.number().int().min(0).max(1_000_000_000).optional(),
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
  app.get("/staff/tasks", staffGuard("tasks.view", async () => {
    const tasks = await sql.all<Record<string, unknown>>(
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
       FROM tasks t WHERE t.source = 'custom' ORDER BY t.created_at DESC`,
    );

    // Part 15 — what each campaign earned against what it paid. DERIVED from the
    // completions and the ledger (taskBudget.ts), never a stored counter, so it
    // cannot drift away from the rows it is summarising.
    const money = await campaignMoney(config.pointsPerUsdt);
    return {
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
    const q = req.query as { status?: string; taskId?: string; q?: string };
    const status = z.enum(["pending", "approved", "rejected"]).catch("pending").parse(q.status);
    const taskId = (q.taskId ?? "").trim();
    const search = (q.q ?? "").trim().toLowerCase();

    const where: string[] = ["p.status = ?"];
    const args: unknown[] = [status];
    if (taskId) { where.push("p.task_id = ?"); args.push(taskId); }
    if (search) {
      // Email or @handle. LOWER on both sides rather than ILIKE so PGlite and
      // Postgres behave identically.
      where.push("(LOWER(u.email) LIKE ? OR LOWER(COALESCE(u.username,'')) LIKE ?)");
      args.push(`%${search}%`, `%${search}%`);
    }

    const proofs = await sql.all<Record<string, unknown>>(
      `SELECT p.id, p.task_id, p.user_id, p.proof_text, p.answers, p.status, p.review_note,
              p.created_at, p.reviewed_at,
              u.email AS user_email, u.username AS user_handle, u.country AS user_country,
              u.created_at AS user_joined,
              COALESCE(p.task_title_snapshot, t.title) AS task_title,
              COALESCE(p.reward_points, t.points) AS task_points,
              COALESCE(p.reward_rozi_micro, t.reward_rozi_micro) AS task_rozi_micro,
              COALESCE(p.reward_usdt_micro, t.reward_usdt_micro) AS task_usdt_micro,
              t.proof_label, t.category,
              COALESCE(p.task_logo_asset_snapshot, t.logo_asset_id) AS task_logo_asset_id,
              r.email AS reviewer_email
       FROM task_proofs p
       JOIN users u ON u.id = p.user_id
       JOIN tasks t ON t.id = p.task_id
       LEFT JOIN users r ON r.id = p.reviewed_by
       WHERE ${where.join(" AND ")}
       ORDER BY p.created_at ASC LIMIT 200`,
      ...args,
    );

    // ⚠️ THE COUNTS ARE OVER ALL PROOFS, NEVER THE CURRENT FILTER — the same
    // rule the support queue follows (stage 6). A "pending" number that shrank
    // because someone typed a search would be read as the backlog clearing.
    const countRows = await sql.all<{ status: string; n: string | number }>(
      "SELECT status, COUNT(*) AS n FROM task_proofs GROUP BY status",
    );
    const counts = { pending: 0, approved: 0, rejected: 0 } as Record<string, number>;
    for (const c of countRows) counts[c.status] = Number(c.n);

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

  // ---- Approve / reject a proof -------------------------------------------
  app.post("/staff/task-proofs/:id/decision", staffGuard("tasks.review", async ({ userId, role }, req) => {
    const proofId = (req.params as { id: string }).id;
    const b = z.object({
      action: z.enum(["approve", "reject"]),
      note: z.string().max(500).optional(),
    }).parse(req.body ?? {});
    return decideProof(app, { userId, role }, proofId, b.action, b.note);
  }));

  // ---- Decide several at once ---------------------------------------------
  //
  // ⚠️ A BULK DECISION IS N SEPARATE DECISIONS, NOT ONE. Each row goes through
  // exactly the same creditCompletion() path as a single click, and each gets
  // its own outcome back — because the interesting cases are per-row: one user
  // is over a velocity cap, the campaign runs out of budget halfway down the
  // list, a row was already reviewed in another tab. Wrapping the lot in one
  // transaction would mean one blocked user silently undoing forty good
  // approvals, and reporting a single ok/error would mean a reviewer believing
  // they had cleared a queue they had not.
  app.post("/staff/task-proofs/bulk", staffGuard("tasks.review", async ({ userId, role }, req) => {
    const b = z.object({
      ids: z.array(z.string().max(64)).min(1).max(50),
      action: z.enum(["approve", "reject"]),
      note: z.string().max(500).optional(),
    }).parse(req.body ?? {});

    const results: { id: string; ok: boolean; error?: string; credited?: number; creditedRoziMicro?: number; creditedUsdtMicro?: number }[] = [];
    for (const id of [...new Set(b.ids)]) {
      const r = await decideProof(app, { userId, role }, id, b.action, b.note) as
        { ok: boolean; error?: string; credited?: number; creditedRoziMicro?: number; creditedUsdtMicro?: number };
      results.push({ id, ok: r.ok, error: r.error, credited: r.credited, creditedRoziMicro: r.creditedRoziMicro, creditedUsdtMicro: r.creditedUsdtMicro });
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

// One decision, shared by the single-click route and the bulk route so the two
// can never drift into different rules about what an approval means.
async function decideProof(
  app: FastifyInstance,
  ctx: { userId: string; role: Role },
  proofId: string,
  action: "approve" | "reject",
  note: string | undefined,
) {
  {
    const { userId, role } = ctx;
    const b = { action, note };

    const proof = await sql.get<{
      id: string; task_id: string; user_id: string; status: string;
      reward_points: number | null; reward_rozi_micro: string | number | null; reward_usdt_micro: string | number | null;
    }>(`SELECT id, task_id, user_id, status, reward_points, reward_rozi_micro, reward_usdt_micro
         FROM task_proofs WHERE id = ?`, proofId);
    if (!proof) return { ok: false, error: "not found" };
    if (proof.status !== "pending") return { ok: false, error: "already reviewed" };

    if (b.action === "reject") {
      await sql.run(
        "UPDATE task_proofs SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
        b.note ?? null, userId, now(), proofId,
      );
      await logAudit({
        actorUserId: userId, actorRole: role, action: "task_proof_reject",
        targetUserId: proof.user_id, detail: `proof ${proofId}${b.note ? `: ${b.note}` : ""}`,
      });
      return { ok: true, status: "rejected" };
    }

    // APPROVE. Read the task's reward + this source's referral config, then run
    // the SHARED credit path. externalId ties the credit to the proof, so a
    // re-submission after this can't double-pay (idempotency on network+external_id).
    const task = await sql.get<{
      points: number; reward_rozi_micro: string | number; reward_usdt_micro: string | number;
      reward_type: "points" | "rozi" | "usdt" | "both";
    }>(
      "SELECT points, reward_rozi_micro, reward_usdt_micro, reward_type FROM tasks WHERE id = ? AND source = 'custom'",
      proof.task_id,
    );
    if (!task) return { ok: false, error: "task missing" };
    // Snapshot on the proof wins — an edit after submission must not change
    // what a waiting user was promised (same rule as fee_points on a
    // withdrawal). Custom tasks pay real mined-token ROZI now (founder,
    // 2026-08-29); `points` stays 0 for them.
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
      taskId: proof.task_id, points: rewardPoints, usdtMicro: rewardUsdtMicro,
      roziMicro: rewardRoziMicro,
      rewardType, offerType: "custom",
      payload: { proofId, approvedBy: userId },
      net,
      // A proof must NOT burn the external_id on a velocity block — see the field
      // doc on CreditRequest. The proof simply stays pending and can be approved
      // again once the user is back under their cap.
      recordRejection: false,
    }, app.log);

    if (outcome.status === "velocity_blocked") {
      // Leave the proof pending; tell the reviewer why nothing was credited.
      return { ok: false, error: `Blocked by a fraud cap (${outcome.detail}). The user is over their daily limit — try again later.` };
    }
    // The campaign ran out mid-queue. The proof stays PENDING (recordRejection
    // is false above, so nothing burned its external_id) — but unlike a velocity
    // block, waiting will not fix this one, so the message says so. Raising the
    // budget in the task editor makes the same proof approvable again.
    if (outcome.status === "budget_exhausted") {
      return {
        ok: false,
        error: `This campaign's budget is used up (${outcome.used} of ${outcome.cap} `
          + `${outcome.reason === "points" ? "points" : outcome.reason === "usdt" ? "micro-USDT" : "conversions"}), so it has paused itself. `
          + "Raise its budget in Our own tasks to approve this.",
      };
    }
    if (outcome.status === "unknown_user") return { ok: false, error: "user not found" };
    if (outcome.status === "duplicate") {
      // Already credited (e.g. a double-click). Mark the proof approved to match.
      await sql.run(
        "UPDATE task_proofs SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
        b.note ?? "already credited", userId, now(), proofId,
      );
      return { ok: true, status: "approved", duplicate: true };
    }

    // Credited. Record the human decision on the proof.
    await sql.run(
      "UPDATE task_proofs SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
      b.note ?? null, userId, now(), proofId,
    );
    await logAudit({
      actorUserId: userId, actorRole: role, action: "task_proof_approve",
      targetUserId: proof.user_id,
      detail: `proof ${proofId} -> ${outcome.roziMicro} micro-ROZI + ${outcome.usdtMicro} micro-USDT`,
    });
    return {
      ok: true, status: "approved",
      credited: outcome.points, creditedRoziMicro: outcome.roziMicro, creditedUsdtMicro: outcome.usdtMicro,
    };
  }
}
