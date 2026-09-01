"use client";

// Admin: create and manage OUR OWN tasks — the campaign editor. Internal tool —
// density over friendliness, jargon allowed (DESIGN_BRIEF).
//
// Reviewing the proofs users send lives next door in `proof-queue.tsx`: it is a
// different job done by a different role (an Agent reviews, an Admin writes
// campaigns) and it grew its own filters, selection state and bulk actions.
//
// Two verification modes, chosen per task:
//   proof    — user sends evidence, staff approve it next door, credited then.
//   postback — a partner's server calls our signed postback (URL + secret shown
//              on the card). Same contract as a real ad network.
import { useState } from "react";
import {
  fetchTaskPostback,
  fetchTaskFields, saveTaskFields, uploadTaskLogo, taskAssetUrl,
  TASK_ICON_CHOICES, TASK_CATEGORY_CHOICES, TASK_CATEGORY_LABELS,
  type CustomTask, type CustomTaskInput, type StaffTaskFieldInput, type TaskFieldKind,
  type TaskProof,
} from "@/lib/api";
import { formatPoints, formatUsdtMicro, timeAgo } from "@/lib/format";
import { CountryPicker } from "@/components/CountryPicker";

// Per-field checks, MIRRORING api/src/routes/staffTasks.ts `upsertSchema`. This
// is entry-point feedback (a red box the moment a value is out of range), not
// the gate — the server still refuses a bad payload. Keep the numbers in step
// with the schema.
export type TaskFieldErrors = Partial<Record<keyof CustomTaskInput | "schedule", string>>;
export function validateTask(v: CustomTaskInput): TaskFieldErrors {
  const e: TaskFieldErrors = {};
  const t = v.title.trim();
  if (t.length < 3) e.title = "At least 3 characters.";
  else if (t.length > 120) e.title = "120 characters max.";

  if (v.minutes != null && (!Number.isInteger(v.minutes) || v.minutes < 0 || v.minutes > 600)) {
    e.minutes = "A whole number from 0 to 600.";
  }
  if (v.priority != null && (!Number.isInteger(v.priority) || v.priority < -1000 || v.priority > 1000)) {
    e.priority = "A whole number from -1000 to 1000.";
  }
  if (v.rewardType !== "usdt" && !(v.rewardRoziMicro > 0)) e.rewardRoziMicro = "Set a ROZI amount above 0.";
  if (v.rewardType !== "rozi" && !(v.rewardUsdtMicro > 0)) e.rewardUsdtMicro = "Set a USDT amount above 0.";

  const dayRange = (n: number | null | undefined) =>
    n != null && (!Number.isInteger(n) || n < 0 || n > 3650);
  if (dayRange(v.targetMinAccountDays)) e.targetMinAccountDays = "0 to 3650 days.";
  if (dayRange(v.targetMaxAccountDays)) e.targetMaxAccountDays = "0 to 3650 days.";
  if (v.targetMinAccountDays != null && v.targetMaxAccountDays != null
      && v.targetMaxAccountDays <= v.targetMinAccountDays) {
    e.targetMaxAccountDays = "Must be more than the 'at least' age, or nobody qualifies.";
  }
  if (v.targetMinCompleted != null && (!Number.isInteger(v.targetMinCompleted)
      || v.targetMinCompleted < 0 || v.targetMinCompleted > 10_000)) {
    e.targetMinCompleted = "0 to 10,000 tasks.";
  }

  const pos = (n: number | null | undefined) => n != null && (!Number.isInteger(n) || n <= 0);
  if (pos(v.budgetConversions) || (v.budgetConversions != null && v.budgetConversions > 10_000_000)) {
    e.budgetConversions = "A whole number from 1 to 10,000,000, or blank for no limit.";
  }
  if (pos(v.budgetPoints) || (v.budgetPoints != null && v.budgetPoints > 1_000_000_000)) {
    e.budgetPoints = "A whole number from 1 to 1,000,000,000, or blank for no limit.";
  }
  if (v.budgetUsdtMicro != null && v.budgetUsdtMicro <= 0) {
    e.budgetUsdtMicro = "Above 0, or blank for no limit.";
  }
  if (v.revenuePerConversionMicro != null
      && (v.revenuePerConversionMicro < 0 || v.revenuePerConversionMicro > 1_000_000_000)) {
    e.revenuePerConversionMicro = "From $0 to $1,000.";
  }

  if (v.actionUrl && v.actionUrl.trim() !== "") {
    try {
      if (!/^https?:$/.test(new URL(v.actionUrl).protocol)) throw new Error();
    } catch { e.actionUrl = "Must start with http:// or https://"; }
  }
  if (v.buttonLabel && v.buttonLabel.length > 40) e.buttonLabel = "40 characters max.";

  if (v.startsAt && v.endsAt && Date.parse(v.endsAt) <= Date.parse(v.startsAt)) {
    e.schedule = "The end time must be after the start time.";
  }
  return e;
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/+$/, "") || "http://localhost:4000";

export const EMPTY_TASK: CustomTaskInput = {
  title: "", rewardType: "rozi", rewardRoziMicro: 50_000_000, rewardUsdtMicro: 0, verifyMode: "proof",
  instructions: "", proofLabel: "", proofHeading: "Submit your proof", proofHelp: "", proofRequired: true,
  actionUrl: "", buttonLabel: "Open task", icon: "", logoAssetId: null,
  minutes: 1, country: "Pakistan", status: "draft", startsAt: null, endsAt: null,
  featured: false, priority: 0,
  // null = no cap. A new campaign is uncapped unless somebody says otherwise —
  // the same default every existing task row has, so adding the feature changed
  // nothing about what is already running.
  budgetConversions: null, budgetPoints: null, budgetUsdtMicro: null, revenuePerConversionMicro: 0,
  // Uncategorised, offered everywhere, no targeting — the state every task row
  // that predates Stage 7 is in, so a new task behaves like the existing ones
  // until someone deliberately narrows it.
  category: "", countries: ["ALL"],
  targetMinAccountDays: null, targetMaxAccountDays: null, targetMinCompleted: null,
};

export function toLocalInput(value?: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export const fromLocalInput = (value: string): string | null => value ? new Date(value).toISOString() : null;

// BIGINT columns arrive as strings from pg; keep null as null, coerce the rest.
const numOrNull = (v: number | string | null | undefined): number | null =>
  v == null ? null : Number(v);

// Map a stored CustomTask row onto the editable CustomTaskInput the form takes.
// Split out of the old inline TasksPanel so the Phase D detail view can reuse it.
export function taskToInput(t: CustomTask): CustomTaskInput {
  return {
    // Legacy custom rows migrate to reward_type 'rozi'; anything still
    // reading 'points'/'both' with only points is shown as ROZI.
    title: t.title,
    rewardType: (t.reward_type === "usdt" ? "usdt" : t.reward_type === "both" ? "both" : "rozi"),
    rewardRoziMicro: Number(t.reward_rozi_micro ?? 0),
    rewardUsdtMicro: Number(t.reward_usdt_micro), verifyMode: t.verify_mode,
    instructions: t.instructions ?? "", proofLabel: t.proof_label ?? "",
    proofHeading: t.proof_heading ?? "Submit your proof", proofHelp: t.proof_help ?? "",
    proofRequired: t.proof_required !== 0,
    actionUrl: t.action_url ?? "", buttonLabel: t.button_label ?? "Open task",
    icon: t.icon ?? "", logoAssetId: t.logo_asset_id,
    minutes: t.minutes, country: t.country, startsAt: t.starts_at, endsAt: t.ends_at,
    featured: t.featured !== 0, priority: t.priority,
    // ⚠️ AN EXHAUSTED CAMPAIGN EDITS AS 'active'. `status` on the input is the
    // two states an Admin owns, and sending 'exhausted' back would be the
    // panel asserting a budget verdict it does not compute. Saving a raised
    // budget reopens it server-side; saving without one exhausts it again on
    // the next completion, which is correct either way.
    status: t.status === "exhausted" ? "active" : t.status as CustomTaskInput["status"],
    // ⚠️ budget_points, budget_usdt_micro and revenue_per_conversion_micro are
    // BIGINT columns — the pg driver hands them back as STRINGS. Saving the form
    // without retyping these fields sent the raw "0" straight back and the API's
    // z.number() schema rejected it ("expected number, received string"). Coerce
    // on load, the same way the reward_* fields above already do.
    budgetConversions: t.budget_conversions,
    budgetPoints: numOrNull(t.budget_points),
    budgetUsdtMicro: numOrNull(t.budget_usdt_micro),
    revenuePerConversionMicro: Number(t.revenue_per_conversion_micro ?? 0),
    category: t.category ?? "",
    countries: t.countries.length > 0 ? t.countries : ["ALL"],
    targetMinAccountDays: t.target_min_account_days,
    targetMaxAccountDays: t.target_max_account_days,
    targetMinCompleted: t.target_min_completed,
  };
}

export function TaskForm({ value, editing, onChange, onCancel, onSave, busy }: {
  value: CustomTaskInput; editing: boolean;
  onChange: (v: CustomTaskInput) => void; onCancel: () => void; onSave: () => void;
  // Disables Save while a create/update request is in flight, so a second click
  // cannot fire a second POST (which is how a task got created twice).
  busy?: boolean;
}) {
  const set = <K extends keyof CustomTaskInput>(k: K, v: CustomTaskInput[K]) => onChange({ ...value, [k]: v });
  const L = "block text-[11px] font-semibold uppercase text-muted";
  const I = "mt-1 w-full rounded-md border border-line bg-card px-2 py-1.5 text-sm outline-none";
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  // Live per-field validation — a value out of range turns its box red at the
  // point of entry, and Save is blocked until every box is valid. The server
  // still re-checks (validateTask mirrors its schema).
  const errors = validateTask(value);
  const hasErrors = Object.keys(errors).length > 0;
  const ec = (k: keyof TaskFieldErrors) => (errors[k] ? " border-danger bg-danger-tint/20" : "");
  // A render helper, not a component — it must not be defined as a component in
  // render (react-hooks/static-components).
  const err = (k: keyof TaskFieldErrors) =>
    errors[k] ? <span className="mt-1 block text-[11px] font-semibold text-danger">{errors[k]}</span> : null;

  async function chooseLogo(file?: File) {
    if (!file) return;
    setLogoError(null);
    if (file.size > 524_288) { setLogoError("Logo must be 512 KB or smaller."); return; }
    setLogoBusy(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read that image."));
        reader.readAsDataURL(file);
      });
      const uploaded = await uploadTaskLogo(data);
      if (!uploaded.ok || !uploaded.id) throw new Error(uploaded.error ?? "Could not upload the logo.");
      set("logoAssetId", uploaded.id);
    } catch (e) { setLogoError((e as Error).message); }
    finally { setLogoBusy(false); }
  }

  return (
    <div className="mb-3 rounded-lg border border-brand/30 bg-brand-tint/30 p-3">
      <h3 className="text-sm font-bold text-brand-ink">{editing ? "Edit task" : "New task"}</h3>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <label className="sm:col-span-2"><span className={L}>Title (what the user sees)</span>
          <input className={I + ec("title")} value={value.title} onChange={(e) => set("title", e.target.value)} />
          {err("title")}</label>
        <div className="sm:col-span-2 rounded-md border border-line bg-card p-3">
          <p className="text-[11px] font-semibold uppercase text-muted">Reward</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            <label><span className={L}>Reward type</span>
              <select className={I} value={value.rewardType} onChange={(e) => {
                const kind = e.target.value as CustomTaskInput["rewardType"];
                onChange({ ...value, rewardType: kind,
                  rewardRoziMicro: kind === "usdt" ? 0 : Math.max(1_000_000, value.rewardRoziMicro),
                  rewardUsdtMicro: kind === "rozi" ? 0 : Math.max(1, value.rewardUsdtMicro) });
              }}>
                <option value="rozi">ROZI only</option><option value="usdt">USDT only</option>
                <option value="both">ROZI + USDT</option>
              </select></label>
            {value.rewardType !== "usdt" && <label><span className={L}>ROZI</span>
              <input type="number" min={1} step="1" className={I + ec("rewardRoziMicro")}
                value={(value.rewardRoziMicro / 1_000_000).toString()}
                onChange={(e) => set("rewardRoziMicro", Math.round(Number(e.target.value) * 1_000_000))} />
              {err("rewardRoziMicro")}</label>}
            {value.rewardType !== "rozi" && <label><span className={L}>USDT</span>
              <input type="number" min="0.000001" step="0.000001" className={I + ec("rewardUsdtMicro")}
                value={(value.rewardUsdtMicro / 1_000_000).toString()}
                onChange={(e) => set("rewardUsdtMicro", Math.round(Number(e.target.value) * 1_000_000))} />
              {err("rewardUsdtMicro")}</label>}
          </div>
          <p className="mt-2 text-xs font-semibold text-brand-ink">
            User receives {value.rewardRoziMicro > 0 ? `${(value.rewardRoziMicro / 1_000_000).toLocaleString()} ROZI` : ""}
            {value.rewardRoziMicro > 0 && value.rewardUsdtMicro > 0 ? " + " : ""}
            {value.rewardUsdtMicro > 0 ? formatUsdtMicro(value.rewardUsdtMicro) : ""}
          </p>
        </div>
        <label><span className={L}>How it&rsquo;s checked</span>
          <select className={I} value={value.verifyMode}
            onChange={(e) => set("verifyMode", e.target.value as "proof" | "postback")}>
            <option value="proof">Proof — staff approve</option>
            <option value="postback">Postback — partner server</option>
          </select></label>
        <label className="sm:col-span-2"><span className={L}>Instructions (plain English)</span>
          <textarea className={I} rows={2} value={value.instructions}
            onChange={(e) => set("instructions", e.target.value)} /></label>
        {/* The URL behind the task card's button — the WhatsApp / Telegram / X
            link a user is sent to. Full width: a link is long, and a half-width
            box hides the end of it, which is exactly where a typo lives. */}
        <label className="sm:col-span-2"><span className={L}>Link / button URL (optional)</span>
          <input className={I + ec("actionUrl")} placeholder="https://…" value={value.actionUrl}
            onChange={(e) => set("actionUrl", e.target.value)} />
          {err("actionUrl")}</label>
        <label><span className={L}>Button label</span>
          <input className={I + ec("buttonLabel")} maxLength={40} value={value.buttonLabel ?? ""}
            onChange={(e) => set("buttonLabel", e.target.value)} />
          {err("buttonLabel")}</label>
        <div className="sm:col-span-2 rounded-md border border-line bg-card p-3">
          <p className={L}>Task logo</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {value.logoAssetId && <img src={taskAssetUrl(value.logoAssetId)} alt="Task logo preview"
              className="h-14 w-14 rounded-xl border border-line object-cover" />}
            <label className="cursor-pointer rounded-md bg-brand px-3 py-2 text-xs font-semibold text-white">
              {logoBusy ? "Uploading…" : "Upload PNG, JPEG or WebP"}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only"
                disabled={logoBusy} onChange={(e) => chooseLogo(e.target.files?.[0])} />
            </label>
            {value.logoAssetId && <button type="button" onClick={() => set("logoAssetId", null)}
              className="rounded-md bg-brand-tint px-3 py-2 text-xs font-semibold text-brand">Remove upload</button>}
          </div>
          {logoError && <p className="mt-2 text-xs text-danger">{logoError}</p>}
          <label className="mt-3 block"><span className={L}>Built-in fallback</span>
            <select className={I} value={value.icon ?? ""} onChange={(e) => set("icon", e.target.value)}>
              {TASK_ICON_CHOICES.map((c) => (
                <option key={c} value={c}>{c === "" ? "Default (by task type)" : c}</option>
              ))}
            </select>
          </label>
        </div>
        {/* ASKING FOR PROOF IS OPTIONAL (founder, 2026-08-01). "Send us your
            username" is worth typing; "join our WhatsApp channel" is not, and
            demanding a sentence there loses people at the last step.

            ⚠️ OFF DOES NOT MEAN SELF-CREDIT. Both settings file a PENDING row in
            the queue below and you still approve it before any points move. The
            only difference is whether the user types anything. */}
        {value.verifyMode === "proof" && (
          <label className="sm:col-span-2 flex items-start gap-2 rounded-md border border-line bg-card p-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={value.proofRequired !== false}
              onChange={(e) => set("proofRequired", e.target.checked)}
            />
            <span>
              <span className="block text-sm font-semibold text-brand-ink">Ask the user for proof</span>
              <span className="block text-[11px] text-muted">
                On: they type evidence (username, screenshot description). Off: they just tap
                &ldquo;I did it&rdquo;. Either way it comes to you for approval — nothing credits itself.
              </span>
            </span>
          </label>
        )}
        {value.verifyMode === "proof" && value.proofRequired !== false && (
          <div className="sm:col-span-2 rounded-md border border-line bg-card p-3">
            <p className={L}>Proof collection</p>
            <label className="mt-2 block"><span className={L}>Section heading</span>
              <input className={I} placeholder="Submit your proof" value={value.proofHeading ?? ""}
                onChange={(e) => set("proofHeading", e.target.value)} /></label>
            <label className="mt-2 block"><span className={L}>Help text</span>
              <textarea className={I} rows={2} value={value.proofHelp ?? ""}
                onChange={(e) => set("proofHelp", e.target.value)} /></label>
            <label className="mt-2 block"><span className={L}>Fallback single-question label</span>
              <input className={I} placeholder="e.g. Your username" value={value.proofLabel}
                onChange={(e) => set("proofLabel", e.target.value)} /></label>
          </div>
        )}
        <label><span className={L}>About how many minutes</span>
          <input type="number" min={0} max={600} className={I + ec("minutes")} value={value.minutes}
            onChange={(e) => set("minutes", Number(e.target.value))} />
          {err("minutes")}</label>
        <label><span className={L}>Category (earner app filter)</span>
          <select className={I} value={value.category ?? ""}
            onChange={(e) => set("category", e.target.value)}>
            {TASK_CATEGORY_CHOICES.map((c) => (
              <option key={c} value={c}>{c === "" ? "None" : TASK_CATEGORY_LABELS[c] ?? c}</option>
            ))}
          </select></label>

        <div className="sm:col-span-2 rounded-md border border-line bg-card p-3">
          <p className={L}>Schedule and status</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            <label><span className={L}>Initial status</span><select className={I} value={value.status}
              onChange={(e) => set("status", e.target.value as CustomTaskInput["status"])}>
              <option value="draft">Draft</option><option value="scheduled">Scheduled</option>
              <option value="active">Active</option><option value="paused">Paused</option>
              <option value="ended">Ended</option>
            </select></label>
            <label><span className={L}>Starts at</span><input type="datetime-local" className={I + ec("schedule")}
              value={toLocalInput(value.startsAt)} onChange={(e) => set("startsAt", fromLocalInput(e.target.value))} /></label>
            <label><span className={L}>Ends at</span><input type="datetime-local" className={I + ec("schedule")}
              value={toLocalInput(value.endsAt)} onChange={(e) => set("endsAt", fromLocalInput(e.target.value))} /></label>
          </div>
          {err("schedule")}
          <div className="mt-3 flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={value.featured ?? false}
              onChange={(e) => set("featured", e.target.checked)} /> Featured</label>
            <label className="flex items-center gap-2 text-xs">Priority
              <input type="number" className={`w-24 rounded-md border px-2 py-1${errors.priority ? " border-danger" : " border-line"}`} value={value.priority ?? 0}
                onChange={(e) => set("priority", Number(e.target.value))} /></label>
          </div>
          {err("priority")}
        </div>

        {/* ---- Targeting (Stage 7) ----------------------------------------
            ⚠️ EVERY RULE HERE IS ENFORCED ON THE SUBMIT PATH TOO, not only on
            what the feed shows (api/src/taskTargeting.ts). Hiding a task from
            the list would never have stopped a user who had its id. */}
        <div className="sm:col-span-2 mt-1 rounded-md border border-line bg-card p-2.5">
          <p className="text-[11px] font-semibold uppercase text-muted">Who sees this task</p>
          <p className="mt-0.5 text-[11px] text-muted">
            Leave a box empty for no limit. Wrong-country users never see the task at all;
            the two rules below show it locked, with the reason, because they can still get there.
          </p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><span className={L}>Countries</span>
              <CountryPicker className="mt-1" value={value.countries ?? ["ALL"]}
                onChange={(list) => set("countries", list)} /></div>
            <label><span className={L}>Account at least N days old</span>
              <input type="number" min={0} max={3650} className={I + ec("targetMinAccountDays")} placeholder="no limit"
                value={value.targetMinAccountDays ?? ""}
                onChange={(e) => set("targetMinAccountDays",
                  e.target.value === "" ? null : Number(e.target.value))} />
              {err("targetMinAccountDays")}</label>
            <label><span className={L}>Only accounts under N days old</span>
              <input type="number" min={0} max={3650} className={I + ec("targetMaxAccountDays")} placeholder="no limit"
                value={value.targetMaxAccountDays ?? ""}
                onChange={(e) => set("targetMaxAccountDays",
                  e.target.value === "" ? null : Number(e.target.value))} />
              {err("targetMaxAccountDays")}</label>
            <label className="sm:col-span-2"><span className={L}>Must have finished N tasks already</span>
              <input type="number" min={0} max={10000} className={I + ec("targetMinCompleted")} placeholder="no limit"
                value={value.targetMinCompleted ?? ""}
                onChange={(e) => set("targetMinCompleted",
                  e.target.value === "" ? null : Number(e.target.value))} />
              {err("targetMinCompleted")}</label>
          </div>
        </div>

        {/* ---- Campaign budget + revenue (brief parts 15 + 16) -------------
            ⚠️ BLANK MEANS UNLIMITED, AND THE HINT SAYS SO ON EVERY FIELD. A
            budget box that is empty because nobody filled it in looks identical
            to one that is empty on purpose, and the difference is whether a
            partner who bought 2,000 conversions can be given 20,000. */}
        <div className="sm:col-span-2 mt-1 rounded-md border border-line bg-card p-2.5">
          <p className="text-[11px] font-semibold uppercase text-muted">Budget &amp; revenue</p>
          <p className="mt-0.5 text-[11px] text-muted">
            When a cap is reached the campaign pauses itself — it stops showing to users and
            stops paying out. Leave a box empty for no limit.
          </p>
          <div className="mt-2 grid gap-3 sm:grid-cols-4">
            <label><span className={L}>Max conversions</span>
              <input type="number" min={1} className={I + ec("budgetConversions")} placeholder="no limit"
                value={value.budgetConversions ?? ""}
                onChange={(e) => set("budgetConversions",
                  e.target.value === "" ? null : Number(e.target.value))} />
              {err("budgetConversions")}</label>
            <label><span className={L}>Max ROZI to pay</span>
              <input type="number" min={1} className={I + ec("budgetPoints")} placeholder="no limit"
                value={value.budgetPoints ?? ""}
                onChange={(e) => set("budgetPoints",
                  e.target.value === "" ? null : Number(e.target.value))} />
              {err("budgetPoints")}</label>
            <label><span className={L}>Max USDT to pay</span>
              <input type="number" min="0.000001" step="0.000001" className={I + ec("budgetUsdtMicro")} placeholder="no limit"
                value={value.budgetUsdtMicro ? value.budgetUsdtMicro / 1e6 : ""}
                onChange={(e) => set("budgetUsdtMicro",
                  e.target.value === "" ? null : Math.round(Number(e.target.value) * 1e6))} />
              {err("budgetUsdtMicro")}</label>
            {/* Entered in dollars, stored in micro-USD — an integer, so no
                campaign's margin is ever computed from a float. */}
            <label><span className={L}>They pay us / conversion ($)</span>
              <input type="number" min={0} step="0.001" className={I + ec("revenuePerConversionMicro")} placeholder="0.00"
                value={value.revenuePerConversionMicro
                  ? value.revenuePerConversionMicro / 1e6 : ""}
                onChange={(e) => set("revenuePerConversionMicro",
                  e.target.value === "" ? 0 : Math.round(Number(e.target.value) * 1e6))} />
              {err("revenuePerConversionMicro")}</label>
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button onClick={onSave} disabled={busy || hasErrors}
          className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {busy ? "Saving…" : editing ? "Save changes" : "Create task"}
        </button>
        {hasErrors && <span className="text-[11px] font-semibold text-danger">Fix the red fields first.</span>}
        <button onClick={onCancel} disabled={busy}
          className="rounded-md bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand disabled:opacity-50">
          Cancel
        </button>
      </div>
    </div>
  );
}

// Brief part 15: what this campaign earned against what it paid, and part 16:
// how much of its budget is gone. Every figure comes from the API already
// computed (api/src/taskBudget.ts) — this component formats, it never derives.
export function CampaignBudget({ t }: { t: CustomTask }) {
  const capped = t.budget_conversions !== null || t.budget_points !== null || t.budget_usdt_micro !== null;
  const hasRevenue = t.revenue_per_conversion_micro > 0;
  if (!capped && !hasRevenue && t.spentConversions === 0) return null;

  const usd = (micro: number) => `${micro < 0 ? "−" : ""}$${(Math.abs(micro) / 1e6).toFixed(2)}`;
  const pct = t.budgetUsedPct;
  // Amber from 80%: the point of a budget is to be seen approaching, not to be
  // discovered after it stopped a live campaign overnight.
  const bar = pct === null ? "bg-brand" : pct >= 100 ? "bg-pending" : pct >= 80 ? "bg-pending" : "bg-success";

  return (
    <div className="mt-2 rounded-md border border-line p-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        {t.budget_conversions !== null ? (
          <span>
            <span className="num font-semibold text-brand-ink">{t.spentConversions}</span>
            {" / "}<span className="num">{t.budget_conversions}</span> conversions
          </span>
        ) : (
          <span><span className="num font-semibold text-brand-ink">{t.spentConversions}</span> conversions · no cap</span>
        )}
        {t.budget_points !== null && (
          <span>
            <span className="num font-semibold text-brand-ink">{formatPoints(t.spentPoints)}</span>
            {" / "}<span className="num">{formatPoints(t.budget_points)}</span> ROZI
          </span>
        )}
        {t.budget_usdt_micro !== null && (
          <span><span className="num font-semibold text-brand-ink">{formatUsdtMicro(t.spentUsdtMicro)}</span>
            {" / "}<span className="num">{formatUsdtMicro(t.budget_usdt_micro)}</span></span>
        )}
        {hasRevenue && (
          <>
            <span>in <span className="num font-semibold text-brand-ink">{usd(t.revenueMicro)}</span></span>
            {/* Margin is revenue minus task points AND the referral commission
                those completions paid — referral bonuses come out of margin, so
                a margin that ignored them would flatter every campaign that has
                referred users on it. */}
            <span>
              margin{" "}
              <span className={`num font-semibold ${t.marginMicro < 0 ? "text-danger" : "text-success"}`}>
                {usd(t.marginMicro)}
              </span>
            </span>
            {t.referralPointsPaid > 0 && (
              <span className="text-[10px]">(incl. {formatPoints(t.referralPointsPaid)} pts referral)</span>
            )}
          </>
        )}
      </div>

      {pct !== null && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
          <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
        </div>
      )}

      {t.status === "exhausted" && (
        <p className="mt-1.5 text-[11px] text-pending">
          Paused automatically {t.budget_exhausted_at ? timeAgo(t.budget_exhausted_at) : ""} — it hit its
          budget. Raise a cap in Edit to start it again.
        </p>
      )}
      {/* A campaign that costs more than it earns, stated plainly. It is the one
          thing this whole screen exists to surface, and it is easy to miss in a
          row of numbers. */}
      {hasRevenue && t.marginMicro < 0 && t.status !== "exhausted" && (
        <p className="mt-1.5 text-[11px] text-danger">
          This campaign is paying out more than it brings in.
        </p>
      )}
    </div>
  );
}

export function TaskCard({ t, onEdit, onLifecycle }: {
  t: CustomTask; onEdit: () => void;
  onLifecycle: (action: "pause" | "resume" | "end") => void;
}) {
  const [pb, setPb] = useState<{ url: string; secret: string; signature: string } | null>(null);
  const [pbErr, setPbErr] = useState<string | null>(null);

  async function reveal() {
    setPbErr(null);
    try {
      const r = await fetchTaskPostback(t.id);
      if (r.ok && r.secret) {
        setPb({ url: `${API_BASE}${r.path}`, secret: r.secret, signature: r.signature ?? "" });
      } else setPbErr(r.error ?? "No postback for this task.");
    } catch (e) { setPbErr((e as Error).message); }
  }

  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-2.5">
          {t.logo_asset_id && <img src={taskAssetUrl(t.logo_asset_id)} alt=""
            className="h-10 w-10 shrink-0 rounded-lg border border-line object-cover" />}
          <div className="min-w-0">
          <p className="font-semibold text-brand-ink">{t.title}</p>
          <p className="mt-0.5 text-xs text-muted">
            <span className="num font-semibold text-brand">
              {Number(t.reward_rozi_micro) > 0 ? `${(Number(t.reward_rozi_micro) / 1_000_000).toLocaleString()} ROZI` : ""}
              {Number(t.reward_rozi_micro) > 0 && Number(t.reward_usdt_micro) > 0 ? " + " : ""}
              {Number(t.reward_usdt_micro) > 0 ? formatUsdtMicro(Number(t.reward_usdt_micro)) : ""}
            </span> ·{" "}
            {t.verify_mode === "proof"
              ? t.fieldCount > 0 ? `staff approve · ${t.fieldCount} question(s)`
                : t.proof_required === 0 ? "staff approve (no proof asked)" : "staff approve proof"
              : "partner postback"} · {t.country} ·{" "}
            {t.category ? `${TASK_CATEGORY_LABELS[t.category] ?? t.category} · ` : ""}
            {t.credited_count} credited
            {t.pending_proofs > 0 && <span className="text-pending"> · {t.pending_proofs} proof(s) waiting</span>}
          </p>
          {t.ends_at && <p className="mt-0.5 text-[11px] text-muted">Ends {new Date(t.ends_at).toLocaleString()}</p>}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button onClick={onEdit} className="rounded bg-brand-tint px-2 py-1 text-[10px] font-semibold text-brand">Edit</button>
          {/* ⚠️ 'exhausted' GETS ITS OWN COLOUR AND IS NOT A BUTTON. It is not a
              state an Admin sets, and clicking it would read as "un-exhaust
              this" — which is not what it would do. Raising the budget in Edit
              is what reopens the campaign. */}
          {t.effectiveStatus === "exhausted" ? (
            <span className="rounded bg-pending-tint px-2 py-1 text-[10px] font-semibold text-pending">
              budget used up
            </span>
          ) : (
            <>
              <span className={`rounded px-2 py-1 text-[10px] font-semibold ${
                t.effectiveStatus === "active" ? "bg-success-tint text-success" : "bg-pending-tint text-pending"}`}>
                {t.effectiveStatus}
              </span>
              {t.effectiveStatus === "active" ? <button onClick={() => onLifecycle("pause")}
                className="rounded bg-pending-tint px-2 py-1 text-[10px] font-semibold text-pending">Pause</button>
                : t.effectiveStatus !== "ended" && <button onClick={() => onLifecycle("resume")}
                  className="rounded bg-success-tint px-2 py-1 text-[10px] font-semibold text-success">Resume</button>}
              {t.effectiveStatus !== "ended" && <button onClick={() => {
                if (window.confirm("End this task? Users will no longer be able to start or submit it.")) onLifecycle("end");
              }} className="rounded bg-danger-tint px-2 py-1 text-[10px] font-semibold text-danger">End</button>}
            </>
          )}
        </div>
      </div>

      <CampaignBudget t={t} />

      <TargetingSummary t={t} />

      {t.verify_mode === "proof" && <FieldEditor task={t} />}

      {/* The three seeded social tasks ship switched off with no link, because a
          guessed URL would send users to a 404 and then ask them to prove they
          followed it. Say so here rather than letting an Admin flip one on and
          wonder why the card has no button. */}
      {t.verify_mode === "proof" && !t.action_url && (
        <p className="mt-2 rounded-md bg-pending-tint p-2 text-[11px] text-pending">
          No link yet — the task card will have no button. Add the URL, then set it active.
        </p>
      )}

      {/* The link the task's button points at, readable and copyable WITHOUT
          opening the edit form (founder, 2026-08-01). The Telegram/WhatsApp/X
          links are the thing most often checked and pasted elsewhere, and until
          now the only way to see one was to click Edit — which puts the card
          into a state you then have to cancel out of.

          Two separate controls on purpose: Copy hands it to the clipboard, Open
          loads it. rel="noreferrer" because the URL is Admin-supplied and this
          page is behind a staff session. */}
      {t.action_url && (
        <div className="mt-2 flex items-center gap-2 border-t border-line pt-2 text-[11px]">
          <span className="w-20 shrink-0 uppercase text-muted">Link</span>
          <button
            onClick={() => navigator.clipboard?.writeText(t.action_url!)}
            title="Click to copy"
            className="min-w-0 flex-1 truncate rounded bg-brand-tint px-1.5 py-0.5 text-left font-mono text-brand"
          >
            {t.action_url}
          </button>
          <a href={t.action_url} target="_blank" rel="noreferrer noopener"
            className="shrink-0 font-semibold text-brand">Open</a>
        </div>
      )}

      {t.verify_mode === "postback" && (
        <div className="mt-2 border-t border-line pt-2">
          {!pb ? (
            <button onClick={reveal} className="text-xs font-semibold text-brand">Show postback URL &amp; secret</button>
          ) : (
            <div className="space-y-1 text-[11px]">
              <Field label="POST/GET URL" value={pb.url} />
              <Field label="Secret" value={pb.secret} />
              <Field label="task_id" value={t.id} />
              <p className="text-muted">sig = {pb.signature}</p>
              <p className="text-muted">Params the partner sends: task_id, user_id, txn_id, sig</p>
            </div>
          )}
          {pbErr && <p className="text-[11px] text-danger">{pbErr}</p>}
        </div>
      )}
    </div>
  );
}

// What targeting is actually in force, stated on the card rather than only
// inside the edit form. A campaign that shows to nobody looks exactly like a
// campaign nobody has done yet, and the only way to tell them apart used to be
// opening Edit — which puts the card into a state you then have to cancel out of.
export function TargetingSummary({ t }: { t: CustomTask }) {
  const rules: string[] = [];
  const countries = t.countries.length > 0 ? t.countries : ["ALL"];
  if (!countries.some((c) => c.toLowerCase() === "all")) rules.push(countries.join(", "));
  if (t.target_min_account_days != null) rules.push(`account ${t.target_min_account_days}+ days old`);
  if (t.target_max_account_days != null) rules.push(`under ${t.target_max_account_days} days old`);
  if (t.target_min_completed != null) rules.push(`${t.target_min_completed}+ tasks finished`);
  if (rules.length === 0) return null;
  return (
    <p className="mt-2 rounded-md border border-line p-2 text-[11px] text-muted">
      <span className="font-semibold uppercase">Shown to</span> {rules.join(" · ")}
    </p>
  );
}

// ---- The questions a task asks (Stage 7) ---------------------------------
//
// Saved as a WHOLE LIST in one call, matching the API. Order is a property of
// the list, so per-field save buttons would let a half-finished rewrite become
// the live form — two "Your username" boxes and a hole in the order.
//
// A field with no `id` is new. Keeping the id on the others is what stops a
// re-save from orphaning answers that were already submitted against them.
const KIND_LABELS: Record<TaskFieldKind, string> = {
  text: "Short text", longtext: "Long text", number: "Number",
  email: "Email", url: "Link", phone: "Phone", choice: "Pick one",
  username: "Username", crypto_address: "Crypto wallet address",
};

export function FieldEditor({ task }: { task: CustomTask }) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<StaffTaskFieldInput[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setOpen(true); setMsg(null);
    try {
      const r = await fetchTaskFields(task.id);
      setFields(r.fields.map((f) => ({
        id: f.id, label: f.label, kind: f.kind, required: f.required,
        placeholder: f.placeholder ?? "", help: f.help ?? "",
        options: (f.options ?? []).join("\n"), validation: f.validation, maxLen: null,
      })));
    } catch (e) { setMsg((e as Error).message); }
  }

  async function save() {
    if (!fields) return;
    setBusy(true); setMsg(null);
    try {
      const r = await saveTaskFields(task.id, fields);
      if (!r.ok) { setMsg(r.error ?? "Could not save."); return; }
      setMsg(`Saved — ${fields.length} question(s).`);
      // Re-seat the list from the server so newly created rows pick up their
      // real ids; without this a second save would insert duplicates.
      if (r.fields) {
        setFields(r.fields.map((f) => ({
          id: f.id, label: f.label, kind: f.kind, required: f.required,
          placeholder: f.placeholder ?? "", help: f.help ?? "",
          options: (f.options ?? []).join("\n"), validation: f.validation, maxLen: null,
        })));
      }
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  }

  const upd = (i: number, patch: Partial<StaffTaskFieldInput>) =>
    setFields((s) => s!.map((f, n) => (n === i ? { ...f, ...patch } : f)));
  const move = (i: number, by: number) => setFields((s) => {
    const next = [...s!];
    const j = i + by;
    if (j < 0 || j >= next.length) return next;
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const L = "block text-[10px] font-semibold uppercase text-muted";
  const I = "mt-0.5 w-full rounded-md border border-line bg-card px-2 py-1 text-xs outline-none";

  if (!open) {
    return (
      <div className="mt-2 border-t border-line pt-2">
        <button onClick={load} className="text-xs font-semibold text-brand">
          {task.fieldCount > 0
            ? `Edit the ${task.fieldCount} question(s) this task asks`
            : "Add questions to this task"}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase text-muted">Questions the user answers</p>
        <button onClick={() => setOpen(false)} className="text-[11px] font-semibold text-muted">Close</button>
      </div>
      <p className="mt-0.5 text-[11px] text-muted">
        With no questions here the task falls back to one free-text proof box. Answers are
        checked again on the server, and a link answer must start with http(s).
      </p>

      {msg && <p className="mt-1 text-[11px] text-brand-ink">{msg}</p>}
      {!fields ? <p className="mt-2 text-xs text-muted">Loading…</p> : (
        <>
          <div className="mt-2 space-y-2">
            {fields.map((f, i) => (
              <div key={f.id ?? `new-${i}`} className="rounded-md border border-line p-2">
                <div className="grid gap-2 sm:grid-cols-4">
                  <label className="sm:col-span-2"><span className={L}>Question</span>
                    <input className={I} value={f.label}
                      onChange={(e) => upd(i, { label: e.target.value })} /></label>
                  <label><span className={L}>Answer type</span>
                    <select className={I} value={f.kind}
                      onChange={(e) => upd(i, { kind: e.target.value as TaskFieldKind })}>
                      {(Object.keys(KIND_LABELS) as TaskFieldKind[]).map((k) => (
                        <option key={k} value={k}>{KIND_LABELS[k]}</option>
                      ))}
                    </select></label>
                  <label className="flex items-end gap-1.5 pb-1 text-xs">
                    <input type="checkbox" checked={f.required}
                      onChange={(e) => upd(i, { required: e.target.checked })} />
                    Must answer
                  </label>
                  <label className="sm:col-span-2"><span className={L}>Hint under the question</span>
                    <input className={I} value={f.help ?? ""}
                      onChange={(e) => upd(i, { help: e.target.value })} /></label>
                  <label className="sm:col-span-2"><span className={L}>Grey placeholder text</span>
                    <input className={I} value={f.placeholder ?? ""}
                      onChange={(e) => upd(i, { placeholder: e.target.value })} /></label>
                  {f.kind === "choice" && (
                    <label className="sm:col-span-4"><span className={L}>Choices — one per line</span>
                      <textarea className={I} rows={3} value={f.options ?? ""}
                        onChange={(e) => upd(i, { options: e.target.value })} /></label>
                  )}
                  {f.kind === "crypto_address" && (
                    <label className="sm:col-span-2"><span className={L}>Wallet network</span>
                      <select className={I} value={f.validation ?? ""}
                        onChange={(e) => upd(i, { validation: e.target.value as StaffTaskFieldInput["validation"] })}>
                        <option value="">Choose network</option><option value="evm">BNB Smart Chain / Ethereum (EVM)</option>
                        <option value="tron">TRON</option><option value="solana">Solana</option>
                        <option value="generic">Generic (basic validation only)</option>
                      </select></label>
                  )}
                </div>
                <div className="mt-1.5 flex gap-1.5">
                  <button onClick={() => move(i, -1)} disabled={i === 0}
                    className="rounded bg-brand-tint px-2 py-0.5 text-[10px] font-semibold text-brand disabled:opacity-40">↑</button>
                  <button onClick={() => move(i, 1)} disabled={i === fields.length - 1}
                    className="rounded bg-brand-tint px-2 py-0.5 text-[10px] font-semibold text-brand disabled:opacity-40">↓</button>
                  <button onClick={() => setFields((s) => s!.filter((_, n) => n !== i))}
                    className="rounded bg-danger-tint px-2 py-0.5 text-[10px] font-semibold text-danger">Remove</button>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-2 flex gap-2">
            {/* 8 is the API's own cap (MAX_FIELDS_PER_TASK). A twelve-question
                form on a phone is a task that gets started and abandoned. */}
            <button
              disabled={fields.length >= 8}
              onClick={() => setFields((s) => [...s!, {
                label: "", kind: "text", required: true, placeholder: "", help: "", options: "",
              }])}
              className="rounded-md bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand disabled:opacity-40">
              + Question
            </button>
            <button onClick={save} disabled={busy}
              className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60">
              {busy ? "Saving…" : "Save questions"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function Field({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex items-center gap-2">
      <span className="w-20 shrink-0 uppercase text-muted">{label}</span>
      <button onClick={() => navigator.clipboard?.writeText(value)} title="Click to copy"
        className="min-w-0 flex-1 truncate rounded bg-brand-tint px-1.5 py-0.5 text-left font-mono text-brand">
        {value}
      </button>
    </p>
  );
}

// The evidence a user submitted. Structured answers when the task asks
// questions; the original single box when it does not — every row still carries
// proof_text, so this never renders empty. (Moved here from the retired
// proof-queue.tsx so the Phase D review detail can reuse it.)
export function ProofBody({ proof }: { proof: TaskProof }) {
  if (proof.answers.length === 0) {
    return (
      <p className="mt-2 whitespace-pre-line rounded-md bg-brand-tint/40 p-2 text-sm text-brand-ink">
        {proof.proof_label && (
          <span className="block text-[11px] font-semibold uppercase text-muted">{proof.proof_label}</span>
        )}
        {proof.proof_text}
      </p>
    );
  }
  return (
    <dl className="mt-2 space-y-1.5 rounded-md bg-brand-tint/40 p-2">
      {proof.answers.map((a, i) => (
        <div key={`${a.fieldId}-${i}`}>
          <dt className="text-[11px] font-semibold uppercase text-muted">{a.label}</dt>
          <dd className="text-sm text-brand-ink">
            {a.kind === "url" ? (
              // ⚠️ USER-SUPPLIED. The scheme was forced to http(s) server-side
              // (api/src/taskFields.ts), so this href cannot be javascript: —
              // but the whole URL is shown, not a friendly word, because a staff
              // session is the one worth stealing and a reviewer should read
              // where a link goes before clicking it.
              <a href={a.value} target="_blank" rel="noreferrer noopener"
                className="break-all font-mono text-xs text-brand underline">{a.value}</a>
            ) : a.kind === "crypto_address" ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold uppercase text-muted">{a.validation ?? "wallet"}</span>
                <code className="break-all text-xs">{a.value}</code>
                <button onClick={() => navigator.clipboard?.writeText(a.value)}
                  className="rounded bg-card px-2 py-1 text-[10px] font-semibold text-brand">Copy</button>
              </span>
            ) : (
              <span className="whitespace-pre-line break-words">{a.value}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

