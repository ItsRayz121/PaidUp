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
import { useApi } from "@/lib/hooks";
import {
  fetchCustomTasks, createCustomTask, updateCustomTask, fetchTaskPostback,
  fetchTaskFields, saveTaskFields, uploadTaskLogo, updateTaskLifecycle, taskAssetUrl,
  TASK_ICON_CHOICES, TASK_CATEGORY_CHOICES, TASK_CATEGORY_LABELS,
  type CustomTask, type CustomTaskInput, type StaffTaskFieldInput, type TaskFieldKind,
} from "@/lib/api";
import { formatPoints, formatUsdtMicro, timeAgo } from "@/lib/format";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/+$/, "") || "http://localhost:4000";

const empty: CustomTaskInput = {
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

function toLocalInput(value?: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

const fromLocalInput = (value: string): string | null => value ? new Date(value).toISOString() : null;

export function TasksPanel() {
  const tasks = useApi(fetchCustomTasks, []);
  const [form, setForm] = useState<CustomTaskInput | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    if (!form) return;
    if (form.title.trim().length < 3) { setMsg("Title is too short."); return; }
    try {
      if (editId) await updateCustomTask(editId, form);
      else await createCustomTask(form);
      setForm(null); setEditId(null); setMsg(null);
      tasks.reload();
    } catch (e) { setMsg((e as Error).message); }
  }

  function startEdit(t: CustomTask) {
    setEditId(t.id);
    setForm({
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
      budgetConversions: t.budget_conversions,
      budgetPoints: t.budget_points,
      budgetUsdtMicro: t.budget_usdt_micro,
      revenuePerConversionMicro: t.revenue_per_conversion_micro,
      category: t.category ?? "",
      countries: t.countries.length > 0 ? t.countries : ["ALL"],
      targetMinAccountDays: t.target_min_account_days,
      targetMaxAccountDays: t.target_max_account_days,
      targetMinCompleted: t.target_min_completed,
    });
  }

  async function lifecycle(t: CustomTask, action: "pause" | "resume" | "end") {
    try {
      await updateTaskLifecycle(t.id, action);
      tasks.reload();
    } catch (e) { setMsg((e as Error).message); }
  }

  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-bold text-brand-ink">Our own tasks</h2>
        {!form && (
          <button onClick={() => { setEditId(null); setForm({ ...empty }); }}
            className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white">
            + New task
          </button>
        )}
      </div>
      <p className="mb-2 text-xs text-muted">
        Tasks you write yourself — no ad network behind them. Points come off your margin.
        A task never pays itself: a proof task is credited when you approve the proof; a
        postback task is credited when a partner&rsquo;s server calls the signed URL.
      </p>

      {msg && <p className="mb-2 rounded-md border border-line bg-card p-2 text-xs text-danger">{msg}</p>}

      {form && (
        <TaskForm
          value={form} editing={!!editId}
          onChange={setForm}
          onCancel={() => { setForm(null); setEditId(null); setMsg(null); }}
          onSave={save}
        />
      )}

      {tasks.loading ? <p className="text-sm text-muted">Loading…</p>
        : (tasks.data?.tasks.length ?? 0) === 0 ? (
          <p className="rounded-lg border border-line bg-card p-4 text-sm text-muted">No custom tasks yet.</p>
        ) : (
          <div className="space-y-2">
            {tasks.data!.tasks.map((t) => (
              <TaskCard key={t.id} t={t} onEdit={() => startEdit(t)}
                onLifecycle={(action) => lifecycle(t, action)} />
            ))}
          </div>
        )}
    </section>
  );
}

function TaskForm({ value, editing, onChange, onCancel, onSave }: {
  value: CustomTaskInput; editing: boolean;
  onChange: (v: CustomTaskInput) => void; onCancel: () => void; onSave: () => void;
}) {
  const set = <K extends keyof CustomTaskInput>(k: K, v: CustomTaskInput[K]) => onChange({ ...value, [k]: v });
  const L = "block text-[11px] font-semibold uppercase text-muted";
  const I = "mt-1 w-full rounded-md border border-line bg-card px-2 py-1.5 text-sm outline-none";
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

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
          <input className={I} value={value.title} onChange={(e) => set("title", e.target.value)} /></label>
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
              <input type="number" min={1} step="1" className={I}
                value={(value.rewardRoziMicro / 1_000_000).toString()}
                onChange={(e) => set("rewardRoziMicro", Math.round(Number(e.target.value) * 1_000_000))} /></label>}
            {value.rewardType !== "rozi" && <label><span className={L}>USDT</span>
              <input type="number" min="0.000001" step="0.000001" className={I}
                value={(value.rewardUsdtMicro / 1_000_000).toString()}
                onChange={(e) => set("rewardUsdtMicro", Math.round(Number(e.target.value) * 1_000_000))} /></label>}
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
          <input className={I} placeholder="https://…" value={value.actionUrl}
            onChange={(e) => set("actionUrl", e.target.value)} /></label>
        <label><span className={L}>Button label</span>
          <input className={I} maxLength={40} value={value.buttonLabel ?? ""}
            onChange={(e) => set("buttonLabel", e.target.value)} /></label>
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
          <input type="number" className={I} value={value.minutes}
            onChange={(e) => set("minutes", Number(e.target.value))} /></label>
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
            <label><span className={L}>Starts at</span><input type="datetime-local" className={I}
              value={toLocalInput(value.startsAt)} onChange={(e) => set("startsAt", fromLocalInput(e.target.value))} /></label>
            <label><span className={L}>Ends at</span><input type="datetime-local" className={I}
              value={toLocalInput(value.endsAt)} onChange={(e) => set("endsAt", fromLocalInput(e.target.value))} /></label>
          </div>
          <div className="mt-3 flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={value.featured ?? false}
              onChange={(e) => set("featured", e.target.checked)} /> Featured</label>
            <label className="flex items-center gap-2 text-xs">Priority
              <input type="number" className="w-24 rounded-md border border-line px-2 py-1" value={value.priority ?? 0}
                onChange={(e) => set("priority", Number(e.target.value))} /></label>
          </div>
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
            <label className="sm:col-span-2"><span className={L}>Countries — one per line, or ALL</span>
              <textarea className={I} rows={2} placeholder="ALL"
                value={(value.countries ?? ["ALL"]).join("\n")}
                onChange={(e) => set("countries",
                  e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))} /></label>
            <label><span className={L}>Account at least N days old</span>
              <input type="number" min={0} className={I} placeholder="no limit"
                value={value.targetMinAccountDays ?? ""}
                onChange={(e) => set("targetMinAccountDays",
                  e.target.value === "" ? null : Number(e.target.value))} /></label>
            <label><span className={L}>Only accounts under N days old</span>
              <input type="number" min={0} className={I} placeholder="no limit"
                value={value.targetMaxAccountDays ?? ""}
                onChange={(e) => set("targetMaxAccountDays",
                  e.target.value === "" ? null : Number(e.target.value))} /></label>
            <label className="sm:col-span-2"><span className={L}>Must have finished N tasks already</span>
              <input type="number" min={0} className={I} placeholder="no limit"
                value={value.targetMinCompleted ?? ""}
                onChange={(e) => set("targetMinCompleted",
                  e.target.value === "" ? null : Number(e.target.value))} /></label>
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
              <input type="number" min={1} className={I} placeholder="no limit"
                value={value.budgetConversions ?? ""}
                onChange={(e) => set("budgetConversions",
                  e.target.value === "" ? null : Number(e.target.value))} /></label>
            <label><span className={L}>Max ROZI to pay</span>
              <input type="number" min={1} className={I} placeholder="no limit"
                value={value.budgetPoints ?? ""}
                onChange={(e) => set("budgetPoints",
                  e.target.value === "" ? null : Number(e.target.value))} /></label>
            <label><span className={L}>Max USDT to pay</span>
              <input type="number" min="0.000001" step="0.000001" className={I} placeholder="no limit"
                value={value.budgetUsdtMicro ? value.budgetUsdtMicro / 1e6 : ""}
                onChange={(e) => set("budgetUsdtMicro",
                  e.target.value === "" ? null : Math.round(Number(e.target.value) * 1e6))} /></label>
            {/* Entered in dollars, stored in micro-USD — an integer, so no
                campaign's margin is ever computed from a float. */}
            <label><span className={L}>They pay us / conversion ($)</span>
              <input type="number" min={0} step="0.001" className={I} placeholder="0.00"
                value={value.revenuePerConversionMicro
                  ? value.revenuePerConversionMicro / 1e6 : ""}
                onChange={(e) => set("revenuePerConversionMicro",
                  e.target.value === "" ? 0 : Math.round(Number(e.target.value) * 1e6))} /></label>
          </div>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button onClick={onSave} className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white">
          {editing ? "Save changes" : "Create task"}
        </button>
        <button onClick={onCancel} className="rounded-md bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand">
          Cancel
        </button>
      </div>
    </div>
  );
}

// Brief part 15: what this campaign earned against what it paid, and part 16:
// how much of its budget is gone. Every figure comes from the API already
// computed (api/src/taskBudget.ts) — this component formats, it never derives.
function CampaignBudget({ t }: { t: CustomTask }) {
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

function TaskCard({ t, onEdit, onLifecycle }: {
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
function TargetingSummary({ t }: { t: CustomTask }) {
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

function FieldEditor({ task }: { task: CustomTask }) {
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

function Field({ label, value }: { label: string; value: string }) {
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

