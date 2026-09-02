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
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApi } from "@/lib/hooks";
import { useTableQuery, type TableApi } from "@/lib/staffTable";
import { DataTable, type Column, type FilterDef } from "./DataTable";
import { DetailLayout } from "./DetailLayout";
import { StatusBadge, TimeCell } from "./primitives";
import { useToast } from "./toast";
import { RefreshBar, QUEUE_POLL_MS } from "@/components/staff";
import {
  fetchCustomTasks, createCustomTask, updateCustomTask, updateTaskLifecycle,
  deleteCustomTask, fetchTaskMetrics, fetchTasksOverview,
  fetchTaskProofs, decideTaskProof, releaseTaskProof, decideTaskProofsBulk, taskAssetUrl,
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

// The synthetic display status: the DB `status` is 'approved' for BOTH
// "reward on the way" and "paid", so split it on `reward_status`.
function proofState(p: TaskProof): string {
  if (p.status === "approved") return p.reward_status === "sent" ? "paid" : "reward_pending";
  return p.status;
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
// ⚠️ These values are matched against the EFFECTIVE status server-side (the one
// the badge shows), not the stored column — so filtering by "ended" returns
// every task the badge calls "ended", including one whose ends_at just passed.
const TASK_STATUS_FILTER: FilterDef = {
  key: "status", label: "Status", type: "select",
  options: [
    { value: "active", label: "active" }, { value: "draft", label: "draft" },
    { value: "scheduled", label: "scheduled" }, { value: "paused", label: "paused" },
    { value: "ended", label: "ended" }, { value: "disabled", label: "disabled" },
    { value: "exhausted", label: "exhausted" }, { value: "deleted", label: "deleted" },
  ],
};

export function TasksAdminPanel() {
  const q = useTableQuery("tasks:list", PAGE);
  const [auto, setAuto] = useState(true);
  const toast = useToast();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<TaskDetailTab>("overview");

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

  // The open task detail participates in browser history so the Back button
  // CLOSES it instead of leaving /staff. (The old "Back logs me out" bug is
  // fixed in lib/api.ts; this is the "Back should do the obvious thing" half.)
  const pushedRef = useRef(false);
  function openDetail(id: string) {
    setOpenId(id); setTab("overview");
    window.history.pushState({ staffTaskDetail: id }, "");
    pushedRef.current = true;
  }
  function closeDetail() {
    setOpenId(null); setTab("overview");
    if (pushedRef.current) { pushedRef.current = false; window.history.back(); }
  }
  useEffect(() => {
    const onPop = () => {
      if (pushedRef.current) { pushedRef.current = false; setOpenId(null); setTab("overview"); }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  async function removeOne(t: CustomTask) {
    if (!window.confirm(`Delete "${t.title}"? It disappears from the app and from this list. History is kept.`)) return;
    try {
      await deleteCustomTask(t.id);
      toast.ok("Task deleted.");
      closeDetail();
      data.reload();
    } catch (e) { toast.err((e as Error).message); }
  }
  async function removeMany(ids: string[]) {
    if (!window.confirm(`Delete ${ids.length} task(s)? They disappear from the app and from this list. History is kept.`)) return;
    // A bulk delete is N separate decisions — one task with paid completions
    // fails on its own row (409) without stopping the rest.
    let done = 0; const errs: string[] = [];
    for (const id of ids) {
      try { await deleteCustomTask(id); done++; }
      catch (e) { errs.push((e as Error).message); }
    }
    if (errs.length === 0) toast.ok(`${done} task(s) deleted.`);
    else toast.err(`${done} deleted, ${errs.length} skipped — ${[...new Set(errs)].join("; ")}`);
    data.reload();
  }

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
        breadcrumb={[{ label: "Our own tasks", onClick: closeDetail }, { label: open.title }]}
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
            id: "metrics", label: "Metrics",
            content: <TaskMetricsTab taskId={open.id} />,
          },
          {
            id: "proofs", label: "Proofs",
            content: <TaskProofsTab taskId={open.id} onDecided={() => data.reload()} />,
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
        onTab={(id) => setTab(id as TaskDetailTab)}
        dangerZone={
          open.effectiveStatus === "deleted" ? (
            <p className="text-xs text-muted">This task is deleted. History still points at it.</p>
          ) : (
            <button onClick={() => removeOne(open)}
              className="rounded-md bg-danger px-3 py-1.5 text-xs font-semibold text-white">
              Delete this task
            </button>
          )
        }
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
      <TasksOverviewCard />
      <DataTable<CustomTask>
        q={q} columns={columns} rows={rows}
        total={data.data?.total ?? 0} loading={data.loading} error={data.error} onRetry={data.reload}
        getRowId={(t) => t.id}
        onRowClick={(t) => openDetail(t.id)}
        filters={[TASK_STATUS_FILTER]}
        bulkActions={[{ label: "Delete selected", tone: "danger", run: removeMany }]}
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
  const [busy, setBusy] = useState(false);
  async function save() {
    if (busy) return;
    if (form.title.trim().length < 3) { setMsg("Title is too short."); return; }
    setBusy(true); setMsg(null);
    try { await updateCustomTask(task.id, form); onSaved(); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <div>
      {msg && <p className="mb-2 rounded-md border border-line bg-card p-2 text-xs text-danger">{msg}</p>}
      <TaskForm value={form} editing onChange={setForm} busy={busy}
        onCancel={() => { setForm(taskToInput(task)); setMsg(null); }} onSave={save} />
    </div>
  );
}

function TaskCreator({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState<CustomTaskInput>(() => ({ ...EMPTY_TASK }));
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    // The guard is what stops a second click firing a second POST — the bug
    // where one "Create task" produced two tasks.
    if (busy) return;
    if (form.title.trim().length < 3) { setMsg("Title is too short."); return; }
    setBusy(true); setMsg(null);
    try { await createCustomTask(form); onCreated(); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <div>
      {msg && <p className="mb-2 rounded-md border border-line bg-card p-2 text-xs text-danger">{msg}</p>}
      <TaskForm value={form} editing={false} onChange={setForm} busy={busy} onCancel={onClose} onSave={save} />
    </div>
  );
}

type TaskDetailTab = "overview" | "metrics" | "proofs" | "edit";

// A compact "all our campaigns" funnel above the list — the overall counterpart
// to the per-task Metrics tab.
function TasksOverviewCard() {
  const o = useApi(fetchTasksOverview, []);
  if (!o.data) return null;
  const w = o.data.window30d;
  const step = (label: string, value: number, sub?: string) => (
    <div key={label} className="min-w-[84px] rounded-md border border-line bg-card px-2.5 py-1.5">
      <div className="text-[10px] font-semibold uppercase text-muted">{label}</div>
      <div className="num text-sm font-bold text-brand-ink">{value.toLocaleString()}</div>
      {sub && <div className="text-[10px] text-muted">{sub}</div>}
    </div>
  );
  return (
    <div className="mb-3 rounded-lg border border-line bg-brand-tint/20 p-3">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-bold uppercase text-brand-ink">All tasks · last 30 days</span>
        <span className="text-[11px] text-muted">
          {o.data.campaigns.active} active of {o.data.campaigns.total} campaigns ·
          {" "}opened → completed {w.openedToCompleted == null ? "—" : `${w.openedToCompleted}%`}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {step("Opened", w.opened)}
        {step("Started", w.started)}
        {step("Proof sent", w.submitted)}
        {step("Approved", w.approved, w.approvalRate == null ? undefined : `${w.approvalRate}% approved`)}
        {step("Rejected", w.rejected)}
        {step("Waiting", w.pending)}
        {step("Completed", w.completed)}
      </div>
    </div>
  );
}

// ---- Metrics tab: one campaign's funnel + money -------------------------
function pctLabel(n: number | null): string {
  return n == null ? "—" : `${n}%`;
}
function MetricCell({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-md border border-line bg-card p-3">
      <div className="text-[11px] font-semibold uppercase text-muted">{label}</div>
      <div className="num text-lg font-bold text-brand-ink">{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}
function TaskMetricsTab({ taskId }: { taskId: string }) {
  const m = useApi(() => fetchTaskMetrics(taskId), [taskId]);
  if (m.loading && !m.data) return <p className="text-sm text-muted">Loading…</p>;
  if (m.error) return <p className="text-sm text-danger">{m.error}</p>;
  if (!m.data) return null;
  const f = m.data.funnel;
  const c = m.data.conversion;
  const money = m.data.money;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricCell label="Opened" value={f.opened} sub={`${m.data.totalOpens} total opens`} />
        <MetricCell label="Started" value={f.started} sub={`${pctLabel(c.openedToStarted)} of opened`} />
        <MetricCell label="Proof sent" value={f.submitted} sub={`${pctLabel(c.startedToSubmitted)} of started`} />
        <MetricCell label="Approved" value={f.approved} sub={`${pctLabel(c.submittedToApproved)} of sent`} />
        <MetricCell label="Rejected" value={f.rejected} />
        <MetricCell label="Waiting" value={f.pending} />
        <MetricCell label="Completed" value={f.completed} sub={`${pctLabel(c.approvedToCompleted)} of approved`} />
        <MetricCell label="Opened → completed" value={pctLabel(c.openedToCompleted)} />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricCell label="Conversions" value={money.conversions}
          sub={money.budgetUsedPct != null ? `${money.budgetUsedPct}% of budget` : "no cap"} />
        <MetricCell label="ROZI paid" value={money.pointsPaid.toLocaleString()} />
        <MetricCell label="Referral ROZI" value={money.referralPointsPaid.toLocaleString()} />
        <MetricCell label="Margin" value={formatUsdtMicro(money.marginMicro)}
          sub={`rev ${formatUsdtMicro(money.revenueMicro)}`} />
      </div>
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase text-muted">Last 30 days</div>
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full min-w-[420px] text-xs">
            <thead className="bg-brand-tint text-left uppercase text-brand">
              <tr><th className="p-2">Day</th><th className="p-2 text-right">Opens</th>
                <th className="p-2 text-right">Proofs</th><th className="p-2 text-right">Approved</th>
                <th className="p-2 text-right">Credited</th></tr>
            </thead>
            <tbody>
              {m.data.series.filter((d) => d.opens || d.submitted || d.approved || d.credited).map((d) => (
                <tr key={d.day} className="border-t border-line">
                  <td className="p-2">{d.day}</td>
                  <td className="num p-2 text-right">{d.opens}</td>
                  <td className="num p-2 text-right">{d.submitted}</td>
                  <td className="num p-2 text-right">{d.approved}</td>
                  <td className="num p-2 text-right">{d.credited}</td>
                </tr>
              ))}
              {m.data.series.every((d) => !d.opens && !d.submitted && !d.approved && !d.credited) && (
                <tr><td colSpan={5} className="p-3 text-center text-muted">No activity yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---- Proofs tab: this task's proofs, scoped ---------------------------
function TaskProofsTab({ taskId, onDecided }: { taskId: string; onDecided: () => void }) {
  const [status, setStatus] = useState("pending");
  const toast = useToast();
  const data = useApi(
    () => fetchTaskProofs({ taskId, status, limit: 50, dir: "asc" }),
    [taskId, status], true, QUEUE_POLL_MS,
  );
  const rows = data.data?.proofs ?? [];
  async function decide(p: TaskProof, action: "approve" | "reject") {
    let opts: { note?: string; roziMicro?: number; usdtMicro?: number } = {};
    if (action === "reject") {
      const n = window.prompt("Why are you rejecting this? The user will see it.");
      if (n === null) return;
      opts = { note: n };
    } else {
      const a = askApproveAmounts(p);
      if (a === null) return;
      opts = a;
    }
    try {
      const res = await decideTaskProof(p.id, action, opts);
      if (!res.ok) { toast.err(res.error ?? "Could not save."); return; }
      toast.ok(action === "approve" ? "Approved — reward on the way." : "Rejected.");
      data.reload(); onDecided();
    } catch (e) { toast.err((e as Error).message); }
  }
  async function release(p: TaskProof) {
    try {
      const res = await releaseTaskProof(p.id);
      if (!res.ok) { toast.err(res.error ?? "Could not release."); return; }
      toast.ok(`Reward sent — ${rewardLabel(res.creditedRoziMicro ?? 0, res.creditedUsdtMicro ?? 0)}.`);
      data.reload(); onDecided();
    } catch (e) { toast.err((e as Error).message); }
  }
  return (
    <div className="space-y-3">
      <StatusTabs options={PROOF_TABS} value={status} onChange={setStatus} counts={data.data?.counts} />
      {data.loading && !data.data ? <p className="text-sm text-muted">Loading…</p>
        : rows.length === 0 ? <p className="text-sm text-muted">No {status.replace(/_/g, " ")} proofs for this task.</p>
        : rows.map((p) => (
          <div key={p.id} className="rounded-md border border-line bg-card p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold text-brand-ink">
                {p.user_handle ? `@${p.user_handle}` : p.user_email}
                <span className="ms-2 text-xs font-normal text-muted">{p.user_email}</span>
              </span>
              <TimeCell iso={p.created_at} />
            </div>
            <ProofBody proof={p} />
            {status === "pending" && (
              <div className="mt-2 flex gap-2">
                <button onClick={() => decide(p, "approve")}
                  className="rounded-md bg-success px-3 py-1 text-xs font-semibold text-white">Approve</button>
                <button onClick={() => decide(p, "reject")}
                  className="rounded-md bg-danger px-3 py-1 text-xs font-semibold text-white">Reject</button>
              </div>
            )}
            {status === "reward_pending" && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">
                  Will send {rewardLabel(Number(p.task_rozi_micro ?? 0), Number(p.task_usdt_micro))}
                </span>
                <button onClick={() => release(p)}
                  className="rounded-md bg-brand px-3 py-1 text-xs font-semibold text-white">Send reward</button>
                <button onClick={() => decide(p, "reject")}
                  className="rounded-md bg-danger px-3 py-1 text-xs font-semibold text-white">Reject instead</button>
              </div>
            )}
          </div>
        ))}
    </div>
  );
}

// ======================================================================
// 2. Task proofs (the review queue)
// ======================================================================
// Two-step release (2026-09-01): "reward pending" = an Agent accepted the
// evidence but the reward has not been sent; "paid" = the reward was released
// through creditCompletion().
const PROOF_TABS = ["pending", "reward_pending", "paid", "rejected"];

// Approve dialog — the Agent confirms (and may trim) the reward before it is
// locked onto the proof. Cannot exceed what the user was promised.
function askApproveAmounts(p: TaskProof): { roziMicro?: number; usdtMicro?: number; note?: string } | null {
  const roziCeil = Number(p.task_rozi_micro ?? 0);
  const usdtCeil = Number(p.task_usdt_micro ?? 0);
  let roziMicro = roziCeil;
  let usdtMicro = usdtCeil;
  if (roziCeil > 0) {
    const raw = window.prompt(
      `ROZI to give (max ${(roziCeil / 1_000_000).toLocaleString()}). Enter 0 to skip it.`,
      String(roziCeil / 1_000_000),
    );
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) { window.alert("Not a number."); return null; }
    roziMicro = Math.min(roziCeil, Math.round(n * 1_000_000));
  }
  if (usdtCeil > 0) {
    const raw = window.prompt(
      `USDT to give (max ${(usdtCeil / 1_000_000).toFixed(3)}). Enter 0 to skip it.`,
      String(usdtCeil / 1_000_000),
    );
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) { window.alert("Not a number."); return null; }
    usdtMicro = Math.min(usdtCeil, Math.round(n * 1_000_000));
  }
  return { roziMicro, usdtMicro };
}

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
    let opts: { note?: string; roziMicro?: number; usdtMicro?: number } = {};
    if (action === "reject") {
      const n = window.prompt("Why are you rejecting this? The user will see it.");
      if (n === null) return;
      opts = { note: n };
    } else {
      const a = askApproveAmounts(p);
      if (a === null) return;
      opts = a;
    }
    try {
      const res = await decideTaskProof(p.id, action, opts);
      if (!res.ok) { toast.err(res.error ?? "Could not save."); return; }
      toast.ok(action === "approve" ? "Approved — reward on the way." : "Rejected.");
      data.reload();
      setOpen(null);
    } catch (e) { toast.err((e as Error).message); }
  }

  // STEP 2 — pay the reward. This is the one that touches the ledger.
  async function release(p: TaskProof) {
    try {
      const res = await releaseTaskProof(p.id);
      if (!res.ok) { toast.err(res.error ?? "Could not release."); return; }
      toast.ok(`Reward sent — ${rewardLabel(res.creditedRoziMicro ?? 0, res.creditedUsdtMicro ?? 0)}.`);
      data.reload();
      setOpen(null);
    } catch (e) { toast.err((e as Error).message); }
  }

  // ⚠️ A BULK DECISION IS N SEPARATE DECISIONS — the summary reports per-row, the
  // same contract decideTaskProofsBulk enforced in the old panel. One user over a
  // velocity cap, or a campaign hitting its budget mid-list, must not read as
  // "queue cleared". Bulk approve pays the FULL promised amount (no per-row
  // trimming) — trim from the single-row detail.
  async function bulk(ids: string[], action: "approve" | "reject" | "release") {
    let note: string | undefined;
    if (action === "reject") {
      const n = window.prompt(`Why are you rejecting these ${ids.length}? Every one of them will see this.`);
      if (n === null) return;
      note = n;
    }
    try {
      const res = await decideTaskProofsBulk(ids, action, note);
      const first = res.results.find((r) => !r.ok);
      const paid = res.creditedRoziMicro || res.creditedUsdtMicro
        ? ` — ${rewardLabel(res.creditedRoziMicro, res.creditedUsdtMicro)}` : "";
      toast.ok(
        `${res.done} done, ${res.failed} not done${paid}`
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
    { key: "status", header: "Status", csv: (p) => proofState(p), render: (p) => <StatusBadge status={proofState(p)} /> },
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
        badges={<StatusBadge status={proofState(p)} />}
        tabs={[{
          id: "proof", label: "Proof",
          content: (
            <div className="space-y-3">
              {/* Who this is — comprehensive, so a reviewer never leaves this
                  screen to answer "who / where does their money go". */}
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-line bg-card p-3 text-xs">
                <dt className="text-muted">Name</dt>
                <dd className="text-brand-ink">{p.user_display_name || "—"}</dd>
                <dt className="text-muted">Handle</dt>
                <dd className="text-brand-ink">{p.user_handle ? `@${p.user_handle}` : "—"}</dd>
                <dt className="text-muted">Email</dt>
                <dd className="break-all text-brand-ink">{p.user_email}</dd>
                <dt className="text-muted">Country</dt>
                <dd className="text-brand-ink">{p.user_country || "—"}</dd>
                <dt className="text-muted">Joined</dt>
                <dd className="text-brand-ink">{p.user_joined ? <TimeCell iso={p.user_joined} /> : "—"}</dd>
                <dt className="text-muted">Cash-out wallet</dt>
                <dd className="break-all font-mono text-brand-ink">
                  {p.user_payout_address
                    ? <>{p.user_payout_address}{p.user_payout_verified_at
                        ? <span className="ms-1 font-sans text-success">· signed</span>
                        : <span className="ms-1 font-sans text-muted">· typed in</span>}</>
                    : <span className="font-sans text-muted">not set yet</span>}
                </dd>
                <dt className="text-muted">Reward</dt>
                <dd className="num text-brand">
                  {p.task_points > 0 ? `${formatPoints(p.task_points)} pts` : rewardLabel(Number(p.task_rozi_micro ?? 0), Number(p.task_usdt_micro))}
                </dd>
                {(p.userHistory.approved > 0 || p.userHistory.rejected > 0) && (
                  <>
                    <dt className="text-muted">Before</dt>
                    <dd>
                      <span className="text-success">{p.userHistory.approved} approved</span>
                      {p.userHistory.rejected > 0 && <span className="text-danger"> · {p.userHistory.rejected} rejected</span>}
                    </dd>
                  </>
                )}
              </dl>
              <ProofBody proof={p} />
              {p.review_note && <p className="text-xs text-muted">Note: {p.review_note}</p>}
              {p.reviewer_email && (
                <p className="text-[11px] text-muted">
                  Accepted by {p.reviewer_email}{p.reviewed_at ? <> · <TimeCell iso={p.reviewed_at} /></> : null}
                </p>
              )}
              {p.releaser_email && (
                <p className="text-[11px] text-muted">
                  Reward sent by {p.releaser_email}{p.released_at ? <> · <TimeCell iso={p.released_at} /></> : null}
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
              className="rounded-md bg-success px-3 py-1.5 text-xs font-semibold text-white">Approve (reward not sent yet)</button>
            <button onClick={() => decide(p, "reject")}
              className="rounded-md bg-danger px-3 py-1.5 text-xs font-semibold text-white">Reject</button>
          </div>
        ) : p.status === "approved" && p.reward_status === "pending" ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">
              Will send {rewardLabel(Number(p.task_rozi_micro ?? 0), Number(p.task_usdt_micro))} to {p.user_handle ? `@${p.user_handle}` : p.user_email}
            </span>
            <button onClick={() => release(p)}
              className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white">Send reward</button>
            <button onClick={() => decide(p, "reject")}
              className="rounded-md bg-danger px-3 py-1.5 text-xs font-semibold text-white">Reject instead</button>
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
        The evidence users send for our own tasks. <b>Two steps:</b> Approve accepts the answer and puts the
        reward &ldquo;on the way&rdquo; (no money moves yet); <b>Send reward</b> then pays it through the same
        path a network postback uses (referral bonuses, velocity caps). Counts are over ALL proofs, never this filter.
      </p>
      <DataTable<TaskProof>
        q={q} columns={columns} rows={rows}
        total={data.data?.total ?? 0} loading={data.loading} error={data.error} onRetry={data.reload}
        getRowId={(p) => p.id}
        onRowClick={(p) => setOpen(p)}
        filters={filters}
        searchPlaceholder="Search email or @handle"
        emptyTitle={`Nothing ${c.status.replace(/_/g, " ")}`}
        exportName="task-proofs"
        bulkActions={c.status === "pending" ? [
          { label: "Approve picked", run: (ids) => bulk(ids, "approve") },
          { label: "Reject picked", tone: "danger", run: (ids) => bulk(ids, "reject") },
        ] : c.status === "reward_pending" ? [
          { label: "Send reward to picked", run: (ids) => bulk(ids, "release") },
          { label: "Reject picked", tone: "danger", run: (ids) => bulk(ids, "reject") },
        ] : undefined}
      />
    </section>
  );
}
