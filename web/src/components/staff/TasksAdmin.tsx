"use client";

// Tasks & offers (admin rebuild, Phase D). The two task screens — the campaign
// list and the proof-review queue — moved onto the shared <DataTable> so they
// behave like every other staff list: server-side search, sort, pagination, a
// live refresh bar, and a row-click <DetailLayout> detail.
//
// ⚠️ THE DECISION ACTIONS ARE UNCHANGED. Creating / editing a campaign, the
// pause/resume/end lifecycle, and approve / reject / bulk-decide on a proof all
// call the exact same endpoints with the exact same prompts and wording as the
// old inline panels. This is a presentation migration, not a rewrite of any
// crediting or campaign path — the reusable pieces (TaskForm, FieldEditor,
// CampaignBudget, TargetingSummary, TaskCard, ProofBody) are imported from the
// old files, not reimplemented.
import { useState, type ReactNode } from "react";
import { useApi } from "@/lib/hooks";
import { useTableQuery, type TableApi } from "@/lib/staffTable";
import { DataTable, type Column, type FilterDef } from "./DataTable";
import { DetailLayout } from "./DetailLayout";
import { StatusBadge, TimeCell } from "./primitives";
import { useToast } from "./toast";
import { RefreshBar, QUEUE_POLL_MS } from "@/components/staff";
import {
  fetchCustomTasks, createCustomTask, updateCustomTask, updateTaskLifecycle,
  fetchTaskProofs, decideTaskProof, decideTaskProofsBulk, taskAssetUrl,
  TASK_CATEGORY_LABELS,
  type CustomTask, type CustomTaskInput, type TaskProof,
} from "@/lib/api";
import { formatPoints, formatUsdtMicro } from "@/lib/format";
import {
  TaskForm, TaskCard, EMPTY_TASK, taskToInput, ProofBody,
} from "@/components/tasks-admin";

// ---- shared bits -----------------------------------------------------------

// A status tab strip. Same shape and reasoning as the money queues' StatusTabs:
// a task/proof list is read one status at a time, so the status is a tab, not a
// "Clear filters"-able DataTable filter.
function StatusTabs({ options, value, onChange, counts }: {
  options: string[]; value: string; onChange: (s: string) => void;
  counts?: Record<string, number>;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((s) => (
        <button key={s} onClick={() => onChange(s)}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
            value === s ? "bg-brand text-white" : "bg-brand-tint text-brand"
          }`}>
          {s.replace(/_/g, " ")}
          {counts && counts[s] !== undefined && <span className="num ms-1 opacity-80">{counts[s]}</span>}
        </button>
      ))}
    </div>
  );
}

// Toolbar row: title on the left, tabs in the middle, live refresh on the right.
function QueueHeader({ title, tabs, status, setStatus, counts, refresh, right }: {
  title: string; tabs: string[]; status: string; setStatus: (s: string) => void;
  counts?: Record<string, number>;
  refresh: { updatedAt: number | null; loading: boolean; reload: () => void; auto: boolean; setAuto: (v: boolean) => void };
  right?: ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-bold text-brand-ink">{title}</h2>
      <StatusTabs options={tabs} value={status} onChange={setStatus} counts={counts} />
      <div className="flex flex-wrap items-center gap-2">
        {right}
        <RefreshBar updatedAt={refresh.updatedAt} loading={refresh.loading} onRefresh={refresh.reload}
          auto={refresh.auto} setAuto={refresh.setAuto} />
      </div>
    </div>
  );
}

// status tab + auto-refresh toggle wired to a useTableQuery so switching tabs
// resets to page 1.
function useQueueControls(q: TableApi, initialStatus: string) {
  const [status, setStatusRaw] = useState(initialStatus);
  const [auto, setAuto] = useState(true);
  const setStatus = (s: string) => { setStatusRaw(s); q.setPage(1); };
  return { status, setStatus, auto, setAuto, pollMs: auto ? QUEUE_POLL_MS : undefined };
}

function rewardLabel(roziMicro: number, usdtMicro: number): string {
  const parts: string[] = [];
  if (roziMicro > 0) parts.push(`${(roziMicro / 1_000_000).toLocaleString()} ROZI`);
  if (usdtMicro > 0) parts.push(formatUsdtMicro(usdtMicro));
  return parts.join(" + ") || "—";
}

const PAGE = { pageSize: 25, sort: "created_at", dir: "desc" as const };

// ======================================================================
// 1. Our own tasks (the campaign list + editor)
// ======================================================================
const TASK_STATUS_FILTER: FilterDef = {
  key: "status", label: "Status", type: "select",
  options: [
    { value: "active", label: "active" }, { value: "draft", label: "draft" },
    { value: "scheduled", label: "scheduled" }, { value: "paused", label: "paused" },
    { value: "ended", label: "ended" }, { value: "disabled", label: "disabled" },
    { value: "exhausted", label: "exhausted" },
  ],
};

export function TasksAdminPanel() {
  const q = useTableQuery("tasks:list", PAGE);
  const [auto, setAuto] = useState(true);
  const toast = useToast();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<"overview" | "edit">("overview");

  const data = useApi(
    () => fetchCustomTasks({
      q: q.search, status: q.filters.status || undefined,
      sort: q.sort ?? undefined, dir: q.dir, limit: q.pageSize, offset: q.offset,
    }),
    [q.search, q.filters.status, q.sort, q.dir, q.pageSize, q.offset],
    true, auto ? QUEUE_POLL_MS : undefined,
  );
  const rows = data.data?.tasks ?? [];
  const open = openId ? rows.find((t) => t.id === openId) ?? null : null;

  async function lifecycle(t: CustomTask, action: "pause" | "resume" | "end") {
    if (action === "end" && !window.confirm("End this task? Users will no longer be able to start or submit it.")) return;
    try { await updateTaskLifecycle(t.id, action); toast.ok("Done."); data.reload(); }
    catch (e) { toast.err((e as Error).message); }
  }

  const columns: Column<CustomTask>[] = [
    {
      key: "title", header: "Task", sortable: true, csv: (t) => t.title,
      render: (t) => (
        <div className="flex min-w-0 items-center gap-2">
          {t.logo_asset_id && <img src={taskAssetUrl(t.logo_asset_id)} alt=""
            className="h-8 w-8 shrink-0 rounded-md border border-line object-cover" />}
          <div className="min-w-0">
            <span className="block truncate font-medium text-brand-ink">{t.title}</span>
            <span className="block truncate text-xs text-muted">
              {t.category ? `${TASK_CATEGORY_LABELS[t.category] ?? t.category} · ` : ""}
              {t.verify_mode === "proof"
                ? t.fieldCount > 0 ? `staff approve · ${t.fieldCount} question(s)`
                  : t.proof_required === 0 ? "staff approve (no proof asked)" : "staff approve proof"
                : "partner postback"}
            </span>
          </div>
        </div>
      ),
    },
    {
      key: "reward", header: "Reward", align: "right",
      csv: (t) => rewardLabel(Number(t.reward_rozi_micro), Number(t.reward_usdt_micro)),
      render: (t) => <span className="num text-brand">{rewardLabel(Number(t.reward_rozi_micro), Number(t.reward_usdt_micro))}</span>,
    },
    {
      key: "credited", header: "Credited", align: "right", csv: (t) => t.credited_count,
      render: (t) => (
        <div>
          <div className="num font-semibold text-brand-ink">{t.credited_count}</div>
          {t.pending_proofs > 0 && <div className="text-xs text-pending">{t.pending_proofs} waiting</div>}
        </div>
      ),
    },
    { key: "status", header: "Status", sortable: true, csv: (t) => t.effectiveStatus, render: (t) => <StatusBadge status={t.effectiveStatus} /> },
    { key: "created_at", header: "Created", sortable: true, csv: (t) => t.created_at, render: (t) => <TimeCell iso={t.created_at} /> },
  ];

  if (creating) {
    return (
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-bold text-brand-ink">New task</h2>
          <button onClick={() => setCreating(false)}
            className="rounded-md bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand">Back to list</button>
        </div>
        <TaskCreator onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); data.reload(); }} />
      </section>
    );
  }

  if (open) {
    return (
      <DetailLayout
        breadcrumb={[{ label: "Our own tasks", onClick: () => { setOpenId(null); setTab("overview"); } }, { label: open.title }]}
        title={
          <span className="flex items-center gap-2">
            {open.logo_asset_id && <img src={taskAssetUrl(open.logo_asset_id)} alt=""
              className="h-8 w-8 rounded-md border border-line object-cover" />}
            {open.title}
          </span>
        }
        ids={[{ label: "task", value: open.id }]}
        badges={<StatusBadge status={open.effectiveStatus} />}
        actions={
          <button onClick={() => setTab(tab === "edit" ? "overview" : "edit")}
            className="rounded-md bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand">
            {tab === "edit" ? "View" : "Edit"}
          </button>
        }
        tabs={[
          {
            id: "overview", label: "Overview",
            content: (
              <TaskCard t={open} onEdit={() => setTab("edit")}
                onLifecycle={(action) => lifecycle(open, action)} />
            ),
          },
          {
            id: "edit", label: "Edit",
            content: (
              <TaskEditor task={open}
                onSaved={() => { setTab("overview"); data.reload(); toast.ok("Saved."); }} />
            ),
          },
        ]}
        activeTab={tab}
        onTab={(id) => setTab(id as "overview" | "edit")}
      />
    );
  }

  return (
    <section className="mb-8">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-brand-ink">Our own tasks</h2>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setCreating(true)}
            className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white">+ New task</button>
          <RefreshBar updatedAt={data.updatedAt} loading={data.loading} onRefresh={data.reload} auto={auto} setAuto={setAuto} />
        </div>
      </div>
      <p className="mb-2 text-xs text-muted">
        Tasks you write yourself — no ad network behind them. A task never pays itself: a proof task is
        credited when you approve the proof; a postback task when a partner&rsquo;s server calls the signed URL.
      </p>
      <DataTable<CustomTask>
        q={q} columns={columns} rows={rows}
        total={data.data?.total ?? 0} loading={data.loading} error={data.error} onRetry={data.reload}
        getRowId={(t) => t.id}
        onRowClick={(t) => { setOpenId(t.id); setTab("overview"); }}
        filters={[TASK_STATUS_FILTER]}
        searchPlaceholder="Search task title"
        emptyTitle="No tasks"
        emptyHint="Create one with “+ New task”."
        exportName="tasks"
      />
    </section>
  );
}

// The Edit tab of the task detail — its own form state, seeded from the row.
function TaskEditor({ task, onSaved }: { task: CustomTask; onSaved: () => void }) {
  const [form, setForm] = useState<CustomTaskInput>(() => taskToInput(task));
  const [msg, setMsg] = useState<string | null>(null);
  async function save() {
    if (form.title.trim().length < 3) { setMsg("Title is too short."); return; }
    try { await updateCustomTask(task.id, form); onSaved(); }
    catch (e) { setMsg((e as Error).message); }
  }
  return (
    <div>
      {msg && <p className="mb-2 rounded-md border border-line bg-card p-2 text-xs text-danger">{msg}</p>}
      <TaskForm value={form} editing onChange={setForm}
        onCancel={() => { setForm(taskToInput(task)); setMsg(null); }} onSave={save} />
    </div>
  );
}

function TaskCreator({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState<CustomTaskInput>(() => ({ ...EMPTY_TASK }));
  const [msg, setMsg] = useState<string | null>(null);
  async function save() {
    if (form.title.trim().length < 3) { setMsg("Title is too short."); return; }
    try { await createCustomTask(form); onCreated(); }
    catch (e) { setMsg((e as Error).message); }
  }
  return (
    <div>
      {msg && <p className="mb-2 rounded-md border border-line bg-card p-2 text-xs text-danger">{msg}</p>}
      <TaskForm value={form} editing={false} onChange={setForm} onCancel={onClose} onSave={save} />
    </div>
  );
}

// ======================================================================
// 2. Task proofs (the review queue)
// ======================================================================
const PROOF_TABS = ["pending", "approved", "rejected"];

export function ProofReviewPanel() {
  const q = useTableQuery("tasks:proofs", { pageSize: 25, sort: "created_at", dir: "asc" });
  const c = useQueueControls(q, "pending");
  const toast = useToast();
  const [open, setOpen] = useState<TaskProof | null>(null);

  const data = useApi(
    () => fetchTaskProofs({
      status: c.status, taskId: q.filters.taskId || undefined, q: q.search,
      dir: q.dir === "asc" ? "asc" : "desc", limit: q.pageSize, offset: q.offset,
    }),
    [c.status, q.filters.taskId, q.search, q.dir, q.pageSize, q.offset],
    true, c.pollMs,
  );
  const rows = data.data?.proofs ?? [];
  const counts = data.data?.counts;
  const taskOptions = data.data?.tasks ?? [];

  async function decide(p: TaskProof, action: "approve" | "reject") {
    let note: string | undefined;
    if (action === "reject") {
      const n = window.prompt("Why are you rejecting this? The user will see it.");
      if (n === null) return;
      note = n;
    }
    try {
      const res = await decideTaskProof(p.id, action, note);
      if (!res.ok) { toast.err(res.error ?? "Could not save."); return; }
      toast.ok(action === "approve"
        ? `Approved — ${res.credited ?? 0} pts${res.creditedUsdtMicro ? ` + ${formatUsdtMicro(res.creditedUsdtMicro)}` : ""} credited.`
        : "Rejected.");
      data.reload();
      setOpen(null);
    } catch (e) { toast.err((e as Error).message); }
  }

  // ⚠️ A BULK DECISION IS N SEPARATE DECISIONS — the summary reports per-row, the
  // same contract decideTaskProofsBulk enforced in the old panel. One user over a
  // velocity cap, or a campaign hitting its budget mid-list, must not read as
  // "queue cleared".
  async function bulk(ids: string[], action: "approve" | "reject") {
    let note: string | undefined;
    if (action === "reject") {
      const n = window.prompt(`Why are you rejecting these ${ids.length}? Every one of them will see this.`);
      if (n === null) return;
      note = n;
    }
    try {
      const res = await decideTaskProofsBulk(ids, action, note);
      const first = res.results.find((r) => !r.ok);
      toast.ok(
        `${res.done} done, ${res.failed} not done`
        + (res.creditedPoints ? ` — ${formatPoints(res.creditedPoints)} pts` : "")
        + (res.creditedUsdtMicro ? ` + ${formatUsdtMicro(res.creditedUsdtMicro)}` : "")
        + (first ? `. First problem: ${first.error}` : "."),
      );
      data.reload();
    } catch (e) { toast.err((e as Error).message); }
  }

  const columns: Column<TaskProof>[] = [
    {
      key: "user", header: "User", csv: (p) => p.user_email,
      render: (p) => (
        <div className="min-w-0">
          <span className="block truncate font-medium text-brand-ink">
            {p.user_handle ? `@${p.user_handle}` : p.user_email}
          </span>
          <span className="block truncate text-xs text-muted">
            {p.user_email}{p.user_country ? ` · ${p.user_country}` : ""}
          </span>
          {(p.userHistory.approved > 0 || p.userHistory.rejected > 0) && (
            <span className="block text-[11px]">
              <span className="text-success">{p.userHistory.approved} approved</span>
              {p.userHistory.rejected > 0 && <span className="text-danger"> · {p.userHistory.rejected} rejected</span>}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "task", header: "Task", csv: (p) => p.task_title,
      render: (p) => (
        <div className="flex min-w-0 items-center gap-2">
          {p.task_logo_asset_id && <img src={taskAssetUrl(p.task_logo_asset_id)} alt=""
            className="h-7 w-7 shrink-0 rounded-md border border-line object-cover" />}
          <span className="truncate text-brand-ink">{p.task_title}</span>
        </div>
      ),
    },
    {
      key: "reward", header: "Reward", align: "right",
      csv: (p) => rewardLabel(Number(p.task_rozi_micro ?? 0), Number(p.task_usdt_micro)),
      render: (p) => (
        <span className="num text-brand">
          {p.task_points > 0 ? `${formatPoints(p.task_points)} pts` : rewardLabel(Number(p.task_rozi_micro ?? 0), Number(p.task_usdt_micro))}
        </span>
      ),
    },
    { key: "status", header: "Status", csv: (p) => p.status, render: (p) => <StatusBadge status={p.status} /> },
    { key: "created_at", header: "Submitted", sortable: true, csv: (p) => p.created_at, render: (p) => <TimeCell iso={p.created_at} /> },
  ];

  const filters: FilterDef[] = taskOptions.length > 0 ? [{
    key: "taskId", label: "Task", type: "select",
    options: taskOptions.map((t) => ({ value: t.id, label: `${t.title} (${t.pending})` })),
  }] : [];

  if (open) {
    const p = open;
    return (
      <DetailLayout
        breadcrumb={[{ label: "Task proofs", onClick: () => setOpen(null) }, { label: p.task_title }]}
        title={p.user_handle ? `@${p.user_handle}` : p.user_email}
        ids={[{ label: "proof", value: p.id }, { label: "user", value: p.user_id }, { label: "task", value: p.task_id }]}
        badges={<StatusBadge status={p.status} />}
        tabs={[{
          id: "proof", label: "Proof",
          content: (
            <div className="space-y-3">
              <div className="rounded-lg border border-line bg-card p-3 text-xs text-muted">
                {p.user_email}{p.user_country ? ` · ${p.user_country}` : ""}
                {(p.userHistory.approved > 0 || p.userHistory.rejected > 0) && (
                  <> · before: <span className="text-success">{p.userHistory.approved} approved</span>
                    {p.userHistory.rejected > 0 && <span className="text-danger"> · {p.userHistory.rejected} rejected</span>}</>
                )}
                {" · reward "}
                <span className="num text-brand">
                  {p.task_points > 0 ? `${formatPoints(p.task_points)} pts` : rewardLabel(Number(p.task_rozi_micro ?? 0), Number(p.task_usdt_micro))}
                </span>
              </div>
              <ProofBody proof={p} />
              {p.review_note && <p className="text-xs text-muted">Note: {p.review_note}</p>}
              {p.reviewer_email && (
                <p className="text-[11px] text-muted">
                  Decided by {p.reviewer_email}{p.reviewed_at ? <> · <TimeCell iso={p.reviewed_at} /></> : null}
                </p>
              )}
            </div>
          ),
        }]}
        activeTab="proof"
        onTab={() => {}}
        dangerZone={p.status === "pending" ? (
          <div className="flex flex-wrap gap-2">
            <button onClick={() => decide(p, "approve")}
              className="rounded-md bg-success px-3 py-1.5 text-xs font-semibold text-white">Approve &amp; credit</button>
            <button onClick={() => decide(p, "reject")}
              className="rounded-md bg-danger px-3 py-1.5 text-xs font-semibold text-white">Reject</button>
          </div>
        ) : undefined}
      />
    );
  }

  return (
    <section className="mb-8">
      <QueueHeader title="Task proofs" tabs={PROOF_TABS} status={c.status} setStatus={c.setStatus}
        counts={counts as Record<string, number> | undefined}
        refresh={{ updatedAt: data.updatedAt, loading: data.loading, reload: data.reload, auto: c.auto, setAuto: c.setAuto }} />
      <p className="mb-2 text-xs text-muted">
        The evidence users send for our own tasks. Approving credits the reward through the same path a
        network postback uses (referral bonuses, velocity caps). Counts are over ALL proofs, never this filter.
      </p>
      <DataTable<TaskProof>
        q={q} columns={columns} rows={rows}
        total={data.data?.total ?? 0} loading={data.loading} error={data.error} onRetry={data.reload}
        getRowId={(p) => p.id}
        onRowClick={(p) => setOpen(p)}
        filters={filters}
        searchPlaceholder="Search email or @handle"
        emptyTitle={`Nothing ${c.status}`}
        exportName="task-proofs"
        bulkActions={c.status === "pending" ? [
          { label: "Approve picked", run: (ids) => bulk(ids, "approve") },
          { label: "Reject picked", tone: "danger", run: (ids) => bulk(ids, "reject") },
        ] : undefined}
      />
    </section>
  );
}
