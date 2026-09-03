"use client";

// Admin-driven reward disbursement (founder, 2026-09-02).
//
// Two views behind one panel:
//   • "Waiting to be paid" — the eligible pool: approved custom-task rewards
//     that have NOT been released yet. Select some, choose a mode, create a
//     batch.
//   • "Batches" — every batch, with a detail view: run it, watch per-recipient
//     status, export a CSV to pay externally, upload the tx-hash CSV back, or
//     mark a row paid by hand.
//
// 'balance' mode credits the in-app balance (the default, safe path). The other
// three also create a payout to the user's SAVED address — a recipient with
// none shows as "needs address" and is skipped, never blocking the batch.
import { useMemo, useRef, useState } from "react";
import { useApi } from "@/lib/hooks";
import { useTableQuery } from "@/lib/staffTable";
import { DataTable, type Column } from "./DataTable";
import { DetailLayout } from "./DetailLayout";
import { StatusBadge, TimeCell, Addr, TxHash } from "./primitives";
import { useToast } from "./toast";
import { useStaffNav } from "@/lib/staffNav";
import { RefreshBar, QUEUE_POLL_MS } from "@/components/staff";
import { formatUsdtMicro } from "@/lib/format";
import { reconcileRowsFromCsv } from "@/lib/csv";
import {
  fetchEligibleRewards, fetchDisbursementBatches, fetchDisbursementBatch,
  createDisbursementBatch, runDisbursementBatch, cancelDisbursementBatch, renameDisbursementBatch,
  markDisbursementRowPaid, reconcileDisbursement, downloadDisbursementCsv,
  type DisbursementMode, type EligibleReward, type DisbursementBatch, type DisbursementRow,
} from "@/lib/api";

const MODE_LABEL: Record<DisbursementMode, string> = {
  balance: "Credit balance",
  onchain: "Send on-chain",
  manual: "Send by hand + tx hash",
  csv: "CSV round-trip",
};
const MODE_HELP: Record<DisbursementMode, string> = {
  balance: "Puts the reward on the user's in-app balance. No address, no gas. The safe default.",
  onchain: "Credits the balance, then sends USDT to the user's saved address automatically.",
  manual: "Credits the balance, then queues a payout you send by hand and mark paid with the tx hash.",
  csv: "Like 'by hand', but export the list, pay externally, and upload a tx-hash file to reconcile.",
};
const usdt = (micro: number) => (micro > 0 ? formatUsdtMicro(micro) : "—");

// What a batch is CALLED. Every batch made from 2026-09-03 on is auto-named at
// creation from the campaign it pays; older ones have no name and fall back to
// the id prefix, which is what the whole list used to show.
const batchLabel = (b: DisbursementBatch) => b.name?.trim() || `Batch ${b.id.slice(0, 8)}`;

// ---------------------------------------------------------------------------

// ⚠️ ONE COMPONENT, THREE MOUNT POINTS (founder, 2026-09-03: "clone it ...
// inside tasks and networks"). Money & payouts mounts it unscoped; Tasks &
// networks mounts it unscoped as its own sub-tab; a task detail mounts it with
// that task's id. A literal second copy would have drifted from this one within
// a week — every rule about modes, eligibility and running a batch lives here.
//
// `taskId` is a SCOPE, not a filter chip: it narrows the eligible pool AND the
// batch list AND what "Batch everything eligible" sweeps in, all server-side.
export function DisbursementsPanel({ canManage, taskId }: { canManage: boolean; taskId?: string }) {
  const [view, setView] = useState<"pool" | "batches">(taskId ? "pool" : "batches");
  const [openId, setOpenId] = useState<string | null>(null);

  if (openId) {
    return <BatchDetail id={openId} canManage={canManage} onBack={() => setOpenId(null)} />;
  }

  return (
    <div className="space-y-4">
      {taskId && (
        <p className="rounded-lg border-2 border-line-strong bg-brand-tint/30 p-2.5 text-xs text-muted">
          Only this campaign&apos;s rewards. Everything here works exactly as it does under{" "}
          <b>Money &amp; payouts → Disbursements</b> — this view is scoped to the task so paying
          it out never sweeps in another campaign&apos;s rewards by accident.
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        {(["batches", "pool"] as const).map((v) => (
          <button key={v} onClick={() => setView(v)}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              view === v ? "bg-brand text-white" : "bg-brand-tint text-brand"
            }`}>
            {v === "batches" ? "Batches" : "Waiting to be paid"}
          </button>
        ))}
      </div>
      {view === "batches"
        ? <BatchList onOpen={setOpenId} taskId={taskId} />
        : <EligiblePool canManage={canManage} taskId={taskId} onCreated={(id) => { setOpenId(id); setView("batches"); }} />}
    </div>
  );
}

// ---- The eligible pool -------------------------------------------------

function EligiblePool({ canManage, taskId, onCreated }: {
  canManage: boolean; taskId?: string; onCreated: (batchId: string) => void;
}) {
  // Per-mount storage key: a search or page size set on a task's own screen
  // must not silently apply to the global pool, and vice versa.
  const q = useTableQuery(`disb:pool:${taskId ?? "all"}`, { pageSize: 25 });
  const toast = useToast();
  const [draft, setDraft] = useState<{ proofIds: string[] } | null>(null);
  const [mode, setMode] = useState<DisbursementMode>("balance");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(true);

  const data = useApi(
    () => fetchEligibleRewards({ q: q.search, taskId, limit: q.pageSize, offset: q.offset }),
    [q.search, taskId, q.pageSize, q.offset], true, auto ? QUEUE_POLL_MS : undefined,
  );
  const items = data.data?.items ?? [];

  async function create(proofIds: string[], allEligible = false) {
    if (!canManage) return;
    setBusy(true);
    try {
      const res = await createDisbursementBatch({
        mode, note: note.trim() || undefined, taskId,
        ...(allEligible ? { allEligible: true, q: q.search } : { proofIds }),
      });
      const msg = res.skipped.length
        ? `Batch created — ${res.added} added, ${res.skipped.length} skipped.`
        : `Batch created with ${res.added} recipient${res.added === 1 ? "" : "s"}.`;
      toast.ok(msg);
      setDraft(null); setNote("");
      onCreated(res.batchId);
    } catch (e) { toast.err((e as Error).message); }
    finally { setBusy(false); }
  }

  const columns: Column<EligibleReward>[] = [
    {
      key: "user", header: "User", csv: (r) => r.userEmail,
      render: (r) => (
        <div className="min-w-0">
          <span className="block truncate font-medium text-brand-ink">{r.userEmail}</span>
          <span className="block truncate text-xs text-muted">{r.userId}</span>
        </div>
      ),
    },
    { key: "task", header: "Task", csv: (r) => r.taskTitle, render: (r) => <span className="truncate">{r.taskTitle}</span> },
    { key: "usdt", header: "USDT", align: "right", csv: (r) => r.usdtMicro, render: (r) => <span className="num">{usdt(r.usdtMicro)}</span> },
    { key: "rozi", header: "ROZI", align: "right", csv: (r) => r.roziMicro, render: (r) => <span className="num">{r.roziMicro > 0 ? (r.roziMicro / 1e6).toFixed(2) : "—"}</span> },
    { key: "approvedAt", header: "Approved", csv: (r) => r.approvedAt ?? "", render: (r) => <TimeCell iso={r.approvedAt} /> },
  ];

  return (
    <div className="space-y-3">
      <RefreshBar updatedAt={data.updatedAt} loading={data.loading} onRefresh={data.reload} auto={auto} setAuto={setAuto} />

      {canManage && (
        <div className="rounded-lg border-2 border-line-strong bg-card p-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs font-semibold text-muted">
              Mode
              <select value={mode} onChange={(e) => setMode(e.target.value as DisbursementMode)}
                className="mt-1 block rounded-md border border-line bg-bg px-2 py-1.5 text-sm text-brand-ink">
                {(Object.keys(MODE_LABEL) as DisbursementMode[]).map((m) => (
                  <option key={m} value={m}>{MODE_LABEL[m]}</option>
                ))}
              </select>
            </label>
            <label className="min-w-[12rem] flex-1 text-xs font-semibold text-muted">
              Note (optional)
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300}
                placeholder="e.g. August rewards"
                className="mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1.5 text-sm text-brand-ink" />
            </label>
            <button disabled={busy || items.length === 0} onClick={() => create([], true)}
              className="rounded-md bg-brand px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
              Batch everything eligible
            </button>
          </div>
          <p className="mt-2 text-xs text-muted">{MODE_HELP[mode]}</p>
        </div>
      )}

      {draft && canManage && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/40 bg-brand-tint/30 p-3">
          <span className="text-sm font-semibold text-brand-ink">
            {draft.proofIds.length} selected — {MODE_LABEL[mode]}
          </span>
          <button disabled={busy} onClick={() => create(draft.proofIds)}
            className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            Create batch
          </button>
          <button onClick={() => setDraft(null)} className="rounded-md bg-line px-3 py-1.5 text-xs font-semibold text-brand-ink">
            Cancel
          </button>
        </div>
      )}

      <DataTable<EligibleReward>
        q={q} columns={columns} rows={items} total={data.data?.total ?? 0}
        loading={data.loading} error={data.error} onRetry={data.reload}
        getRowId={(r) => r.proofId}
        searchPlaceholder="Search email or task…"
        emptyTitle="Nothing is waiting to be paid"
        emptyHint="Approved rewards that have not been released yet show up here."
        noPermission={false}
        bulkActions={canManage ? [{
          label: "Add to a new batch",
          run: (ids) => setDraft({ proofIds: ids }),
        }] : undefined}
      />
    </div>
  );
}

// ---- The batch list --------------------------------------------------

function BatchList({ onOpen, taskId }: { onOpen: (id: string) => void; taskId?: string }) {
  const q = useTableQuery(`disb:batches:${taskId ?? "all"}`, { pageSize: 25 });
  const [auto, setAuto] = useState(true);
  const data = useApi(
    () => fetchDisbursementBatches({ q: q.search, taskId, limit: q.pageSize, offset: q.offset }),
    [q.search, taskId, q.pageSize, q.offset], true, auto ? QUEUE_POLL_MS : undefined,
  );
  const batches = data.data?.batches ?? [];

  const columns: Column<DisbursementBatch>[] = [
    {
      // The NAME leads, not the uuid (founder, 2026-09-03). The id is still
      // right there as the second line — it is what support and the audit log
      // quote — it just is not the thing you read first.
      key: "id", header: "Batch", csv: (b) => b.name ?? b.id,
      render: (b) => (
        <div className="min-w-0">
          <span className="block truncate font-semibold text-brand-ink">{batchLabel(b)}</span>
          <span className="block truncate font-mono text-[11px] text-muted">{b.id.slice(0, 8)}</span>
          {b.note && <span className="block truncate text-xs text-muted">{b.note}</span>}
        </div>
      ),
    },
    { key: "mode", header: "Mode", csv: (b) => b.mode, render: (b) => <span className="text-xs">{MODE_LABEL[b.mode]}</span> },
    { key: "status", header: "Status", csv: (b) => b.status, render: (b) => <StatusBadge status={b.status} /> },
    {
      key: "progress", header: "Recipients", align: "right", csv: (b) => b.countTotal,
      render: (b) => {
        const done = b.tally.released + b.tally.paid;
        const bad = b.tally.failed + b.tally.needs_address;
        return (
          <span className="num text-xs">
            {done}/{b.countTotal} done{bad > 0 && <span className="text-danger"> · {bad} need attention</span>}
          </span>
        );
      },
    },
    { key: "usdt", header: "USDT", align: "right", csv: (b) => b.usdtMicroTotal, render: (b) => <span className="num">{usdt(b.usdtMicroTotal)}</span> },
    { key: "createdAt", header: "Created", sortable: false, csv: (b) => b.createdAt, render: (b) => <TimeCell iso={b.createdAt} /> },
  ];

  return (
    <div className="space-y-3">
      <RefreshBar updatedAt={data.updatedAt} loading={data.loading} onRefresh={data.reload} auto={auto} setAuto={setAuto} />
      <DataTable<DisbursementBatch>
        q={q} columns={columns} rows={batches} total={data.data?.total ?? 0}
        loading={data.loading} error={data.error} onRetry={data.reload}
        getRowId={(b) => b.id} onRowClick={(b) => onOpen(b.id)}
        searchPlaceholder="Search batch name, id or note…"
        emptyTitle="No batches yet"
        emptyHint="Create one from the 'Waiting to be paid' tab."
      />
    </div>
  );
}

// ---- One batch --------------------------------------------------------

function BatchDetail({ id, canManage, onBack }: { id: string; canManage: boolean; onBack: () => void }) {
  const toast = useToast();
  const { openUser } = useStaffNav();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(true);
  const data = useApi(() => fetchDisbursementBatch(id), [id], true, auto ? QUEUE_POLL_MS : undefined);
  const batch = data.data?.batch;
  const rows = useMemo(() => data.data?.rows ?? [], [data.data]);

  const canRun = !!batch && ["draft", "processing", "partly_failed"].includes(batch.status);
  const canCancel = !!batch && rows.every((r) => !["released", "paid", "sending"].includes(r.status)) && batch.status !== "cancelled";

  async function run() {
    setBusy(true);
    try {
      const res = await runDisbursementBatch(id);
      toast.ok(`Run done — ${res.released} released, ${res.failed} failed of ${res.processed}.`);
      data.reload();
    } catch (e) { toast.err((e as Error).message); }
    finally { setBusy(false); }
  }
  // Renaming changes nothing but the label — the id stays the join key and is
  // still on screen as a copyable chip.
  async function rename() {
    if (!batch) return;
    const next = window.prompt("What should this batch be called?", batchLabel(batch));
    if (next === null) return;
    if (!next.trim()) { toast.err("Give the batch a name."); return; }
    try { await renameDisbursementBatch(id, next.trim()); toast.ok("Renamed."); data.reload(); }
    catch (e) { toast.err((e as Error).message); }
  }
  async function cancel() {
    if (!window.confirm("Cancel this batch? Its rewards go back to the waiting list.")) return;
    setBusy(true);
    try { await cancelDisbursementBatch(id); toast.ok("Batch cancelled."); data.reload(); }
    catch (e) { toast.err((e as Error).message); }
    finally { setBusy(false); }
  }
  async function markPaid(r: DisbursementRow) {
    const hash = window.prompt(
      `Send ${usdt(r.usdtMicro)} to:\n\n${r.destAddress}\n\nDo that first, then paste the transaction hash here.`,
    );
    if (!hash) return;
    try { await markDisbursementRowPaid(id, r.id, hash.trim()); toast.ok("Recorded as paid."); data.reload(); }
    catch (e) { toast.err((e as Error).message); }
  }
  async function onReconcileFile(file: File) {
    const text = await file.text();
    const parsed = reconcileRowsFromCsv(text);
    if (parsed.length === 0) { toast.err("No usable rows found — need a disbursement id and a tx hash per line."); return; }
    setBusy(true);
    try {
      const rep = await reconcileDisbursement(id, parsed);
      const bits = [`${rep.paid.length} paid`];
      if (rep.unknown.length) bits.push(`${rep.unknown.length} unknown id`);
      if (rep.notPayable.length) bits.push(`${rep.notPayable.length} not payable`);
      if (rep.badHash.length) bits.push(`${rep.badHash.length} bad hash`);
      toast.ok(bits.join(" · "));
      data.reload();
    } catch (e) { toast.err((e as Error).message); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  const rowTable = (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="py-2 pr-3">User</th>
            <th className="py-2 pr-3">USDT</th>
            <th className="py-2 pr-3">Address</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Detail</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-line/60 align-top">
              <td className="py-2 pr-3">
                <button className="text-left" onClick={() => openUser(r.userId)}>
                  <span className="block truncate text-brand hover:underline">{r.userEmail}</span>
                  <span className="block truncate text-xs text-muted">{r.taskTitle}</span>
                </button>
              </td>
              <td className="py-2 pr-3 num">{usdt(r.usdtMicro)}</td>
              <td className="py-2 pr-3">
                {r.destAddress ? <Addr value={r.destAddress} chain={r.destChain ?? undefined} />
                  : batch?.mode === "balance"
                    ? <span className="text-xs text-muted">In-app balance</span>
                    : <span className="text-xs text-muted">—</span>}
              </td>
              <td className="py-2 pr-3"><StatusBadge status={r.status} /></td>
              <td className="py-2 pr-3 text-xs text-muted">
                {r.txHash ? <TxHash value={r.txHash} chain={r.destChain ?? undefined} />
                  : r.error ?? (batch?.mode === "balance" && r.status === "released"
                    ? "No transfer — credited to balance only"
                    : "—")}
              </td>
              <td className="py-2 text-right">
                {canManage && r.status === "sending" && r.withdrawalRequestId && r.destAddress && (
                  <button onClick={() => markPaid(r)}
                    className="rounded-md bg-success px-2.5 py-1 text-xs font-semibold text-white">
                    Mark paid
                  </button>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={6} className="py-6 text-center text-sm text-muted">No recipients.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      <div className="mb-3"><RefreshBar updatedAt={data.updatedAt} loading={data.loading} onRefresh={data.reload} auto={auto} setAuto={setAuto} /></div>
      <input ref={fileRef} type="file" accept=".csv,text/csv" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onReconcileFile(f); }} />
      <DetailLayout
        breadcrumb={[{ label: "Disbursements", onClick: onBack }, { label: batch ? batchLabel(batch) : "…" }]}
        title={batch ? (
          <>
            {batchLabel(batch)}
            <span className="mt-0.5 block text-sm font-normal text-muted">
              {MODE_LABEL[batch.mode]}
              {batch.mode === "balance" && " — added to the user's balance, no address or transaction"}
              {canManage && (
                <button onClick={rename} className="ms-2 text-xs font-semibold text-brand underline">
                  Rename
                </button>
              )}
            </span>
          </>
        ) : "Batch"}
        ids={batch ? [{ label: "batch", value: batch.id }] : []}
        badges={batch && <StatusBadge status={batch.status} />}
        actions={canManage && batch && (
          <div className="flex flex-wrap gap-1.5">
            <button disabled={busy || !canRun} onClick={run}
              className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              Run
            </button>
            {batch.mode === "csv" && (
              <>
                <button disabled={busy} onClick={() => downloadDisbursementCsv(id).catch((e) => toast.err((e as Error).message))}
                  className="rounded-md bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand">
                  Export CSV
                </button>
                <button disabled={busy} onClick={() => fileRef.current?.click()}
                  className="rounded-md bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand">
                  Upload tx hashes
                </button>
              </>
            )}
          </div>
        )}
        tabs={[{ id: "recipients", label: `Recipients (${rows.length})`, content: rowTable }]}
        activeTab="recipients"
        onTab={() => {}}
        dangerZone={canManage && canCancel ? (
          <button disabled={busy} onClick={cancel}
            className="rounded-md bg-danger px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            Cancel this batch
          </button>
        ) : undefined}
      />
      {data.error && <p className="mt-3 text-sm text-danger">{data.error}</p>}
    </div>
  );
}
