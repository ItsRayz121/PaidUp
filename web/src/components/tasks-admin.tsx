"use client";

// Admin: create and manage OUR OWN tasks, and review the proofs users send for
// them. Internal tool — density over friendliness, jargon allowed (DESIGN_BRIEF).
//
// Two verification modes, chosen per task:
//   proof    — user sends evidence, staff approve here, points credited then.
//   postback — a partner's server calls our signed postback (URL + secret shown
//              on the card). Same contract as a real ad network.
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import {
  fetchCustomTasks, createCustomTask, updateCustomTask, fetchTaskPostback,
  fetchTaskProofs, decideTaskProof,
  type CustomTask, type CustomTaskInput,
} from "@/lib/api";
import { formatPoints, timeAgo } from "@/lib/format";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/+$/, "") || "http://localhost:4000";

const empty: CustomTaskInput = {
  title: "", points: 100, verifyMode: "proof",
  instructions: "", proofLabel: "", actionUrl: "", minutes: 1, country: "Pakistan", status: "active",
};

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
      title: t.title, points: t.points, verifyMode: t.verify_mode,
      instructions: t.instructions ?? "", proofLabel: t.proof_label ?? "",
      actionUrl: t.action_url ?? "", minutes: t.minutes, country: t.country,
      status: t.status as "active" | "disabled",
    });
  }

  async function toggle(t: CustomTask) {
    try {
      await updateCustomTask(t.id, { status: t.status === "active" ? "disabled" : "active" });
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
              <TaskCard key={t.id} t={t} onEdit={() => startEdit(t)} onToggle={() => toggle(t)} />
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

  return (
    <div className="mb-3 rounded-lg border border-brand/30 bg-brand-tint/30 p-3">
      <h3 className="text-sm font-bold text-brand-ink">{editing ? "Edit task" : "New task"}</h3>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <label className="sm:col-span-2"><span className={L}>Title (what the user sees)</span>
          <input className={I} value={value.title} onChange={(e) => set("title", e.target.value)} /></label>
        <label><span className={L}>Points</span>
          <input type="number" className={I} value={value.points}
            onChange={(e) => set("points", Number(e.target.value))} /></label>
        <label><span className={L}>How it&rsquo;s checked</span>
          <select className={I} value={value.verifyMode}
            onChange={(e) => set("verifyMode", e.target.value as "proof" | "postback")}>
            <option value="proof">Proof — staff approve</option>
            <option value="postback">Postback — partner server</option>
          </select></label>
        <label className="sm:col-span-2"><span className={L}>Instructions (plain English)</span>
          <textarea className={I} rows={2} value={value.instructions}
            onChange={(e) => set("instructions", e.target.value)} /></label>
        <label><span className={L}>Link / button URL (optional)</span>
          <input className={I} placeholder="https://…" value={value.actionUrl}
            onChange={(e) => set("actionUrl", e.target.value)} /></label>
        {value.verifyMode === "proof" && (
          <label><span className={L}>Proof label (what to send)</span>
            <input className={I} placeholder="e.g. Your username" value={value.proofLabel}
              onChange={(e) => set("proofLabel", e.target.value)} /></label>
        )}
        <label><span className={L}>About how many minutes</span>
          <input type="number" className={I} value={value.minutes}
            onChange={(e) => set("minutes", Number(e.target.value))} /></label>
        <label><span className={L}>Country (or ALL)</span>
          <input className={I} value={value.country}
            onChange={(e) => set("country", e.target.value)} /></label>
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

function TaskCard({ t, onEdit, onToggle }: { t: CustomTask; onEdit: () => void; onToggle: () => void }) {
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
        <div className="min-w-0">
          <p className="font-semibold text-brand-ink">{t.title}</p>
          <p className="mt-0.5 text-xs text-muted">
            <span className="num font-semibold text-brand">{formatPoints(t.points)} pts</span> ·{" "}
            {t.verify_mode === "proof" ? "staff approve proof" : "partner postback"} · {t.country} ·{" "}
            {t.credited_count} credited
            {t.pending_proofs > 0 && <span className="text-pending"> · {t.pending_proofs} proof(s) waiting</span>}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button onClick={onEdit} className="rounded bg-brand-tint px-2 py-1 text-[10px] font-semibold text-brand">Edit</button>
          <button onClick={onToggle}
            className={`rounded px-2 py-1 text-[10px] font-semibold ${
              t.status === "active" ? "bg-success-tint text-success" : "bg-danger-tint text-danger"}`}>
            {t.status}
          </button>
        </div>
      </div>

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

// ---- Proof review queue (all staff) --------------------------------------
export function ProofQueue() {
  const [status, setStatus] = useState("pending");
  const proofs = useApi(() => fetchTaskProofs(status), [status]);
  const [msg, setMsg] = useState<string | null>(null);

  async function decide(id: string, action: "approve" | "reject") {
    let note: string | undefined;
    if (action === "reject") {
      const r = window.prompt("Why are you rejecting this? The user will see it.");
      if (r === null) return;
      note = r;
    }
    try {
      const res = await decideTaskProof(id, action, note);
      if (!res.ok) { setMsg(res.error ?? "Could not save."); return; }
      setMsg(action === "approve" && res.credited ? `Approved — ${res.credited} pts credited.` : "Done.");
      proofs.reload();
    } catch (e) { setMsg((e as Error).message); }
  }

  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-bold text-brand-ink">Task proofs</h2>
        <div className="flex gap-1">
          {["pending", "approved", "rejected"].map((s) => (
            <button key={s} onClick={() => setStatus(s)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                status === s ? "bg-brand text-white" : "bg-brand-tint text-brand"}`}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {msg && <p className="mb-2 rounded-md border border-line bg-card p-2 text-xs text-brand-ink">{msg}</p>}

      {proofs.loading ? <p className="text-sm text-muted">Loading…</p>
        : (proofs.data?.proofs.length ?? 0) === 0 ? (
          <p className="rounded-lg border border-line bg-card p-4 text-sm text-muted">Nothing {status}.</p>
        ) : (
          <div className="space-y-2">
            {proofs.data!.proofs.map((p) => (
              <div key={p.id} className="rounded-lg border border-line bg-card p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-brand-ink">{p.task_title}</p>
                    <p className="text-xs text-muted">
                      {p.user_email} · <span className="num text-brand">{formatPoints(p.task_points)} pts</span> · {timeAgo(p.created_at)}
                    </p>
                    <p className="mt-2 rounded-md bg-brand-tint/40 p-2 text-sm text-brand-ink">
                      {p.proof_label && <span className="block text-[11px] font-semibold uppercase text-muted">{p.proof_label}</span>}
                      {p.proof_text}
                    </p>
                    {p.review_note && <p className="mt-1 text-xs text-muted">Note: {p.review_note}</p>}
                  </div>
                  {status === "pending" && (
                    <div className="flex shrink-0 flex-col gap-1.5">
                      <button onClick={() => decide(p.id, "approve")}
                        className="rounded-md bg-success px-2.5 py-1 text-xs font-semibold text-white">Approve</button>
                      <button onClick={() => decide(p.id, "reject")}
                        className="rounded-md bg-danger px-2.5 py-1 text-xs font-semibold text-white">Reject</button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
    </section>
  );
}
