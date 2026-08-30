"use client";

// Money & payouts (admin rebuild, Phase C). The five money queues — withdrawals,
// USDT deposits, USDT refunds, BNB withdrawals, payout relay jobs — plus the
// reconciliation history, all on the one shared <DataTable> so they behave
// identically: server-side search, sort, pagination, live refresh, and a
// row-click detail view.
//
// ⚠️ THE DECISION ACTIONS ARE UNCHANGED. Approve / reject / mark-paid / confirm
// still call the exact same endpoints, with the same prompts and the same
// "net is what gets sent, gross is what was debited" wording the old inline
// panels carried. This is a presentation migration, not a rewrite of any
// money path.
import { useState, type ReactNode } from "react";
import { useApi } from "@/lib/hooks";
import { useTableQuery, type TableApi } from "@/lib/staffTable";
import { DataTable, type Column } from "./DataTable";
import { DetailLayout } from "./DetailLayout";
import { StatusBadge, TimeCell, CopyId, Addr, ErrText } from "./primitives";
import { useToast } from "./toast";
import { useStaffNav } from "@/lib/staffNav";
import { RefreshBar, QUEUE_POLL_MS } from "@/components/staff";
import {
  fetchStaffQueue, decideWithdrawal, fetchAdminTopups, confirmTopup, rejectTopup,
  fetchAdminRefunds, payRefund, rejectRefund, fetchStaffBnbWithdrawals, fetchRelayJobs,
  fetchReconciliation,
  type StaffWithdrawal, type AdminTopup, type AdminRefund,
  type StaffBnbWithdrawalRow, type RelayJobRow,
} from "@/lib/api";
import { formatPoints, formatMoney, formatUsdtMicro, formatBnbWei } from "@/lib/format";

// ---- shared bits --------------------------------------------------------

// A status tab strip. Kept separate from the DataTable filter bar on purpose:
// a money queue is read one status at a time (the old panels were tabbed), and
// a "Clear filters" that could wipe the status back to a surprising default is
// the wrong affordance here.
function StatusTabs({ options, value, onChange }: {
  options: string[]; value: string; onChange: (s: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((s) => (
        <button key={s} onClick={() => onChange(s)}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
            value === s ? "bg-brand text-white" : "bg-brand-tint text-brand"
          }`}>
          {s.replace(/_/g, " ")}
        </button>
      ))}
    </div>
  );
}

// The toolbar row every money queue shares: status tabs on the left, the live
// refresh bar on the right.
function QueueHeader({ title, tabs, status, setStatus, refresh }: {
  title: string; tabs: string[]; status: string; setStatus: (s: string) => void;
  refresh: { updatedAt: number | null; loading: boolean; reload: () => void; auto: boolean; setAuto: (v: boolean) => void };
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-bold text-brand-ink">{title}</h2>
      <StatusTabs options={tabs} value={status} onChange={setStatus} />
      <RefreshBar updatedAt={refresh.updatedAt} loading={refresh.loading} onRefresh={refresh.reload}
        auto={refresh.auto} setAuto={refresh.setAuto} />
    </div>
  );
}

// Small hook: status tab + auto-refresh toggle, wired to a useTableQuery so
// switching tabs resets to page 1.
function useQueueControls(q: TableApi, initialStatus: string) {
  const [status, setStatusRaw] = useState(initialStatus);
  const [auto, setAuto] = useState(true);
  const setStatus = (s: string) => { setStatusRaw(s); q.setPage(1); };
  return { status, setStatus, auto, setAuto, pollMs: auto ? QUEUE_POLL_MS : undefined };
}

// A label/value pair for the detail field grid. Built with F() rather than a
// bare tuple so the value JSX is a function argument, not an array element —
// which keeps react/jsx-key quiet without a `key` on every field.
type Field = { label: string; value: ReactNode };
const F = (label: string, value: ReactNode): Field => ({ label, value });

function Fields({ rows }: { rows: Field[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 rounded-lg border border-line bg-card p-4 sm:grid-cols-2">
      {rows.map((f, i) => (
        <div key={i}>
          <p className="text-[10px] uppercase tracking-wide text-muted">{f.label}</p>
          <div className="break-all text-sm text-brand-ink">{f.value}</div>
        </div>
      ))}
    </div>
  );
}

// One detail shell for every money request. Built from the row already in hand
// — no extra endpoint — plus a "Open this user" jump and an optional Danger
// zone hosting the same decision buttons the list row shows.
function MoneyDetail({ backLabel, onBack, title, idChips, badges, userId, fields, extra, danger }: {
  backLabel: string; onBack: () => void; title: string;
  idChips: { label: string; value: string }[]; badges: ReactNode;
  userId?: string; fields: Field[]; extra?: ReactNode; danger?: ReactNode;
}) {
  const { openUser } = useStaffNav();
  return (
    <DetailLayout
      breadcrumb={[{ label: backLabel, onClick: onBack }, { label: title }]}
      title={title}
      ids={idChips}
      badges={badges}
      actions={userId ? (
        <button onClick={() => openUser(userId)}
          className="rounded-md bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand">
          Open this user
        </button>
      ) : undefined}
      tabs={[{ id: "details", label: "Details", content: <div className="space-y-4"><Fields rows={fields} />{extra}</div> }]}
      activeTab="details"
      onTab={() => {}}
      dangerZone={danger}
    />
  );
}

// Renders a relay job's phase + the three tx hashes, when a queue row carries
// one. Same information the old inline panels tucked under the row.
function RelaySummary({ r }: { r: NonNullable<StaffWithdrawal["relay"]> }) {
  return (
    <div className="rounded-lg border border-line bg-card p-4">
      <p className="mb-2 text-xs font-semibold uppercase text-muted">On-chain relay job</p>
      <Fields rows={[
        F("Phase", <StatusBadge status={r.phase} />),
        F("From address", <span className="num">{r.fromAddress ?? "—"}</span>),
        F("Gas tx", r.gasTxHash ? <CopyId value={r.gasTxHash} /> : "—"),
        F("Prefund tx", r.prefundTxHash ? <CopyId value={r.prefundTxHash} /> : "—"),
        F("Forward tx", r.forwardTxHash ? <CopyId value={r.forwardTxHash} /> : "—"),
        F("Last error", <span className="text-danger">{r.lastError ?? "—"}</span>),
      ]} />
    </div>
  );
}

const PAGE = { pageSize: 25, sort: "created_at", dir: "desc" as const };

// ======================================================================
// 1. Withdrawals
// ======================================================================
const WITHDRAWAL_TABS = ["pending", "agent_approved", "manager_approved", "sending", "paid", "rejected"];

export function WithdrawalsPanel({ canOpenLedger }: { canOpenLedger: boolean }) {
  const q = useTableQuery("money:withdrawals", PAGE);
  const c = useQueueControls(q, "pending");
  const toast = useToast();
  const [open, setOpen] = useState<StaffWithdrawal | null>(null);

  const data = useApi(
    () => fetchStaffQueue({
      status: c.status, q: q.search, sort: q.sort ?? undefined, dir: q.dir,
      limit: q.pageSize, offset: q.offset,
    }),
    [c.status, q.search, q.sort, q.dir, q.pageSize, q.offset],
    true, c.pollMs,
  );
  const rows = data.data?.requests ?? [];
  const treasury = data.data?.treasury;
  const pendingTotal = data.data?.pendingTotal;

  async function act(r: StaffWithdrawal, action: "approve" | "reject" | "pay") {
    let note: string | undefined;
    let txHash: string | undefined;
    if (action === "reject") {
      const reason = window.prompt("Reason for rejecting (the user will see this):");
      if (reason === null) return;
      note = reason;
    }
    if (action === "pay") {
      // Manual payout: send the USDT from the treasury wallet, then paste the
      // on-chain hash. The prompt names the NET (never fall back to the gross —
      // that recreates the "platform eats the fee" bug on any build missing the
      // field).
      const amount = r.netUsdt ? `${r.netUsdt} USDT` : "the NET amount shown on the row";
      const hash = window.prompt(
        `Send ${amount} to:\n\n${r.address ?? "(no address on this request)"}\n\n` +
        "Send the payment FIRST, then paste the transaction hash (0x…) here.",
      );
      if (hash === null) return;
      txHash = hash.trim();
    }
    try {
      await decideWithdrawal(r.id, action, note, txHash);
      toast.ok(action === "pay" ? "Recorded as paid." : action === "approve" ? "Approved." : "Rejected.");
      data.reload();
      setOpen(null);
    } catch (e) { toast.err((e as Error).message); }
  }

  const actionsFor = (r: StaffWithdrawal) => {
    const ready = r.status === "agent_approved" || r.status === "manager_approved";
    if (r.status === "paid" || r.status === "rejected" || r.status === "sending") {
      return <span className="text-xs text-muted">—</span>;
    }
    return (
      <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
        {r.status === "pending" && (
          <button onClick={() => act(r, "approve")} className="rounded-md bg-success px-2.5 py-1 text-xs font-semibold text-white">Approve</button>
        )}
        {ready && (
          <button onClick={() => act(r, "pay")} className="rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white">Mark paid</button>
        )}
        <button onClick={() => act(r, "reject")} className="rounded-md bg-danger px-2.5 py-1 text-xs font-semibold text-white">Reject</button>
      </div>
    );
  };

  const columns: Column<StaffWithdrawal>[] = [
    {
      key: "user", header: "User", csv: (r) => r.userEmail,
      render: (r) => (
        <div className="min-w-0">
          <span className="block truncate font-medium text-brand-ink">{r.userEmail}</span>
          <span className="block truncate text-xs text-muted">{r.userId}</span>
        </div>
      ),
    },
    {
      key: "amount", header: "Amount", align: "right", sortable: true, csv: (r) => r.amount,
      render: (r) => (
        <div>
          <div className="num font-semibold text-brand-ink">{formatPoints(r.amount)}</div>
          {r.feePoints ? (
            <>
              <div className="text-xs text-muted">− {formatPoints(r.feePoints)} fee</div>
              <div className="num text-xs font-semibold text-brand">send {r.netUsdt} USDT</div>
            </>
          ) : (
            <div className="text-xs text-muted">{formatMoney(r.amount)}</div>
          )}
        </div>
      ),
    },
    { key: "chain", header: "Network", csv: (r) => r.chain, render: (r) => <span className="uppercase">{r.chain}</span> },
    {
      key: "address", header: "Send to", csv: (r) => r.address ?? "",
      render: (r) => r.address ? (
        <div>
          <Addr value={r.address} />
          <div className={`mt-0.5 text-xs font-semibold ${r.addressVerified ? "text-success" : "text-pending"}`}>
            {r.addressVerified ? "✓ signed by the user's wallet" : "not checked — typed in"}
          </div>
        </div>
      ) : <span className="text-xs text-muted">—</span>,
    },
    { key: "status", header: "Status", sortable: true, csv: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    { key: "created_at", header: "Requested", sortable: true, csv: (r) => r.at, render: (r) => <TimeCell iso={r.at} /> },
    { key: "actions", header: "", render: actionsFor },
  ];

  if (open) {
    return (
      <MoneyDetail
        backLabel="Withdrawals" onBack={() => setOpen(null)}
        title={open.userEmail}
        idChips={[{ label: "request", value: open.id }, { label: "user", value: open.userId }]}
        badges={<StatusBadge status={open.status} />}
        userId={canOpenLedger ? open.userId : undefined}
        fields={[
          F("Amount", <span className="num">{formatPoints(open.amount)} pts</span>),
          F("Fee", open.feePoints ? <span className="num">− {formatPoints(open.feePoints)} pts</span> : "—"),
          F("Net to send", <span className="num font-semibold text-brand">{open.netUsdt ?? "—"} USDT</span>),
          F("Source", String(open.sourceKind ?? "points")),
          F("Network", <span className="uppercase">{open.chain}</span>),
          F("Address", open.address ? <CopyId value={open.address} /> : "—"),
          F("Address checked", open.addressVerified ? "✓ signed by the user's wallet" : "not checked — typed in"),
          F("Requested", <TimeCell iso={open.at} />),
        ]}
        extra={open.relay ? <RelaySummary r={open.relay} /> : undefined}
        danger={actionsFor(open)}
      />
    );
  }

  return (
    <section className="mb-8">
      <QueueHeader title="Withdrawals" tabs={WITHDRAWAL_TABS} status={c.status} setStatus={c.setStatus}
        refresh={{ updatedAt: data.updatedAt, loading: data.loading, reload: data.reload, auto: c.auto, setAuto: c.setAuto }} />

      {pendingTotal && pendingTotal.count > 0 && (
        <p className="mb-2 rounded-lg border border-line bg-card p-2 text-xs text-muted">
          <span className="num font-semibold text-brand-ink">{pendingTotal.count}</span> request{pendingTotal.count === 1 ? "" : "s"} ·{" "}
          <span className="num font-semibold text-brand-ink">{formatPoints(pendingTotal.points)}</span> pts ·{" "}
          to send <span className="num font-semibold text-brand">{pendingTotal.usdt} USDT</span>
        </p>
      )}
      {treasury && (treasury.bep20 || treasury.base || treasury.aptos) && (
        <p className="mb-2 rounded-lg border border-line bg-brand-tint/40 p-2 text-xs text-muted">
          Pay from the treasury wallet:{" "}
          {(["bep20", "base", "aptos"] as const).filter((k) => treasury[k]).map((k) => (
            <span key={k} className="me-2">
              <span className="font-semibold uppercase">{k}</span>{" "}
              <span className="num">{treasury[k].slice(0, 10)}…{treasury[k].slice(-6)}</span>
            </span>
          ))}
        </p>
      )}

      <DataTable<StaffWithdrawal>
        q={q} columns={columns} rows={rows}
        total={data.data?.total ?? 0} loading={data.loading} error={data.error} onRetry={data.reload}
        getRowId={(r) => r.id}
        onRowClick={(r) => setOpen(r)}
        searchPlaceholder="Search email, user id, address or tx hash"
        emptyTitle={`No ${c.status.replace(/_/g, " ")} withdrawals`}
        exportName="withdrawals"
      />
    </section>
  );
}

// ======================================================================
// 2. USDT deposits (top-ups)
// ======================================================================
const TOPUP_TABS = ["pending", "confirmed", "rejected"];

export function DepositsPanel({ canDecide }: { canDecide: boolean }) {
  const q = useTableQuery("money:deposits", PAGE);
  const c = useQueueControls(q, "pending");
  const toast = useToast();
  const [open, setOpen] = useState<AdminTopup | null>(null);

  const data = useApi(
    () => fetchAdminTopups({
      status: c.status, q: q.search, sort: q.sort ?? undefined, dir: q.dir,
      limit: q.pageSize, offset: q.offset,
    }),
    [c.status, q.search, q.sort, q.dir, q.pageSize, q.offset],
    true, c.pollMs,
  );
  const rows = data.data?.topups ?? [];
  const treasuryAddress = data.data?.treasuryAddress;
  const treasuryChain = data.data?.treasuryChain;

  async function confirm(r: AdminTopup) {
    const raw = window.prompt(
      "How much USDT did you actually SEE on the chain?\n\n" +
      `The user claimed ${r.amount}. Type what the block explorer shows — that is what will be credited.`,
      String(r.amount),
    );
    if (raw === null) return;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) { toast.err("That is not an amount."); return; }
    try { await confirmTopup(r.id, amount); toast.ok(`Credited ${amount} USDT.`); data.reload(); setOpen(null); }
    catch (e) { toast.err((e as Error).message); }
  }
  async function reject(r: AdminTopup) {
    const reason = window.prompt("Why is this being rejected? The user will see this.");
    if (!reason) return;
    try { await rejectTopup(r.id, reason); toast.ok("Rejected."); data.reload(); setOpen(null); }
    catch (e) { toast.err((e as Error).message); }
  }

  const actionsFor = (r: AdminTopup) => {
    if (r.status !== "pending") return <span className="text-xs text-muted">{r.reject_reason ?? "—"}</span>;
    if (!canDecide) return <span className="text-xs text-muted">view only</span>;
    return (
      <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => confirm(r)} className="rounded-md bg-success px-2.5 py-1 text-xs font-semibold text-white">Confirm</button>
        <button onClick={() => reject(r)} className="rounded-md bg-danger px-2.5 py-1 text-xs font-semibold text-white">Reject</button>
      </div>
    );
  };

  const columns: Column<AdminTopup>[] = [
    {
      key: "user", header: "User", csv: (r) => r.email,
      render: (r) => (
        <div className="min-w-0">
          <span className="block truncate font-medium text-brand-ink">{r.username ? `@${r.username}` : r.email}</span>
          <span className="block truncate text-xs text-muted">{r.user_id}</span>
        </div>
      ),
    },
    { key: "amount", header: "Claimed", align: "right", sortable: true, csv: (r) => r.amount, render: (r) => <span className="num">{r.amount} USDT</span> },
    { key: "chain", header: "Chain", csv: (r) => r.chain, render: (r) => <span className="uppercase">{r.chain}</span> },
    { key: "tx", header: "Transaction", csv: (r) => r.tx_hash, render: (r) => <Addr value={r.tx_hash} /> },
    { key: "status", header: "Status", sortable: true, csv: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    { key: "created_at", header: "When", sortable: true, csv: (r) => r.created_at, render: (r) => <TimeCell iso={r.created_at} /> },
    { key: "actions", header: "", render: actionsFor },
  ];

  if (open) {
    return (
      <MoneyDetail
        backLabel="USDT deposits" onBack={() => setOpen(null)}
        title={open.username ? `@${open.username}` : open.email}
        idChips={[{ label: "topup", value: open.id }, { label: "user", value: open.user_id }, { label: "tx", value: open.tx_hash }]}
        badges={<StatusBadge status={open.status} />}
        userId={open.user_id}
        fields={[
          F("Claimed amount", <span className="num">{open.amount} USDT</span>),
          F("Chain", <span className="uppercase">{open.chain}</span>),
          F("Transaction", <CopyId value={open.tx_hash} />),
          F("Status", <StatusBadge status={open.status} />),
          F("Reject reason", open.reject_reason ?? "—"),
          F("Created", <TimeCell iso={open.created_at} />),
        ]}
        danger={actionsFor(open)}
      />
    );
  }

  return (
    <section className="mb-8">
      <QueueHeader title="USDT deposits" tabs={TOPUP_TABS} status={c.status} setStatus={c.setStatus}
        refresh={{ updatedAt: data.updatedAt, loading: data.loading, reload: data.reload, auto: c.auto, setAuto: c.setAuto }} />
      {treasuryAddress ? (
        <p className="mb-2 text-xs text-muted">
          Deposits should land at <span className="num text-brand-ink">{treasuryAddress}</span> on{" "}
          <strong>{treasuryChain}</strong>. Open the block explorer, confirm the transaction exists AND
          landed at that address, then type the amount you saw.
        </p>
      ) : (
        <p className="mb-2 rounded bg-pending-tint p-1.5 text-xs text-pending">
          No treasury address is set, so top-ups are off. An admin sets it under{" "}
          <strong>Mining (ROZI) → settings</strong>.
        </p>
      )}
      <DataTable<AdminTopup>
        q={q} columns={columns} rows={rows}
        total={data.data?.total ?? 0} loading={data.loading} error={data.error} onRetry={data.reload}
        getRowId={(r) => r.id}
        onRowClick={(r) => setOpen(r)}
        searchPlaceholder="Search email, @handle, id or tx hash"
        emptyTitle={`No ${c.status} deposits`}
        exportName="usdt-deposits"
      />
    </section>
  );
}

// ======================================================================
// 3. USDT refunds
// ======================================================================
const REFUND_TABS = ["pending", "sending", "paid", "rejected"];

export function RefundsPanel({ canDecide }: { canDecide: boolean }) {
  const q = useTableQuery("money:refunds", PAGE);
  const c = useQueueControls(q, "pending");
  const toast = useToast();
  const [open, setOpen] = useState<AdminRefund | null>(null);

  const data = useApi(
    () => fetchAdminRefunds({
      status: c.status, q: q.search, sort: q.sort ?? undefined, dir: q.dir,
      limit: q.pageSize, offset: q.offset,
    }),
    [c.status, q.search, q.sort, q.dir, q.pageSize, q.offset],
    true, c.pollMs,
  );
  const rows = data.data?.refunds ?? [];

  async function pay(r: AdminRefund) {
    // ⚠️ SENDS netAmount, NOT amount — the gas fee comes out of what is sent.
    const txHash = window.prompt(
      `Send ${r.netAmount} USDT to:\n\n${r.address}\n\n` +
      "Do that FIRST, from the treasury wallet. Then paste the transaction hash here as proof — the user will see it.",
    );
    if (!txHash) return;
    try { await payRefund(r.id, txHash.trim()); toast.ok(`Recorded ${r.netAmount} USDT as sent.`); data.reload(); setOpen(null); }
    catch (e) { toast.err((e as Error).message); }
  }
  async function decline(r: AdminRefund) {
    const reason = window.prompt("Why is this being rejected? The user will see this, and their USDT credit goes back.");
    if (!reason) return;
    try { await rejectRefund(r.id, reason); toast.ok("Rejected — the money went back to their balance."); data.reload(); setOpen(null); }
    catch (e) { toast.err((e as Error).message); }
  }

  const actionsFor = (r: AdminRefund) => {
    if (r.status !== "pending") {
      return <span className="text-xs text-muted">{r.status === "paid" ? r.tx_hash ?? "—" : r.reject_reason ?? "—"}</span>;
    }
    if (!canDecide) return <span className="text-xs text-muted">view only</span>;
    return (
      <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => pay(r)} className="rounded-md bg-success px-2.5 py-1 text-xs font-semibold text-white">Sent</button>
        <button onClick={() => decline(r)} className="rounded-md bg-danger px-2.5 py-1 text-xs font-semibold text-white">Reject</button>
      </div>
    );
  };

  const columns: Column<AdminRefund>[] = [
    {
      key: "user", header: "User", csv: (r) => r.email,
      render: (r) => (
        <div className="min-w-0">
          <span className="block truncate font-medium text-brand-ink">{r.username ? `@${r.username}` : r.email}</span>
          <span className="block truncate text-xs text-muted">{r.user_id}</span>
        </div>
      ),
    },
    { key: "amount", header: "Requested", align: "right", sortable: true, csv: (r) => r.amount, render: (r) => <span className="num">{r.amount} USDT</span> },
    {
      key: "net", header: "Send", align: "right", csv: (r) => r.netAmount,
      render: (r) => (
        <div>
          <span className="num font-semibold text-brand-ink">{r.netAmount} USDT</span>
          {r.feeAmount > 0 && <div className="text-[10px] text-muted">− {r.feeAmount} gas fee</div>}
        </div>
      ),
    },
    {
      key: "address", header: "Send to", csv: (r) => r.address,
      render: (r) => (
        <div>
          <Addr value={r.address} />
          <div className={`mt-0.5 text-xs font-semibold ${r.addressVerified ? "text-success" : "text-pending"}`}>
            {r.addressVerified ? "signed by the user's wallet" : "not checked — typed in"}
          </div>
        </div>
      ),
    },
    { key: "status", header: "Status", sortable: true, csv: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    { key: "created_at", header: "When", sortable: true, csv: (r) => r.created_at, render: (r) => <TimeCell iso={r.created_at} /> },
    { key: "actions", header: "", render: actionsFor },
  ];

  if (open) {
    return (
      <MoneyDetail
        backLabel="USDT refunds" onBack={() => setOpen(null)}
        title={open.username ? `@${open.username}` : open.email}
        idChips={[{ label: "refund", value: open.id }, { label: "user", value: open.user_id }]}
        badges={<StatusBadge status={open.status} />}
        userId={open.user_id}
        fields={[
          F("Requested", <span className="num">{open.amount} USDT</span>),
          F("Gas fee", open.feeAmount > 0 ? <span className="num">− {open.feeAmount} USDT</span> : "—"),
          F("Net to send", <span className="num font-semibold text-brand">{open.netAmount} USDT</span>),
          F("Chain", open.chainLabel || open.chain),
          F("Address", <CopyId value={open.address} />),
          F("Address checked", open.addressVerified ? "signed by the user's wallet" : "not checked — typed in"),
          F("Tx hash", open.tx_hash ? <CopyId value={open.tx_hash} /> : "—"),
          F("Reject reason", open.reject_reason ?? "—"),
          F("Created", <TimeCell iso={open.created_at} />),
        ]}
        danger={actionsFor(open)}
      />
    );
  }

  return (
    <section className="mb-8">
      <QueueHeader title="USDT refunds" tabs={REFUND_TABS} status={c.status} setStatus={c.setStatus}
        refresh={{ updatedAt: data.updatedAt, loading: data.loading, reload: data.reload, auto: c.auto, setAuto: c.setAuto }} />
      <p className="mb-2 text-xs text-muted">
        A user asking for the deposit they have not spent — their own money coming back, not their task
        earnings (those go out through the withdrawal queue). The amount was already taken off their credit.
      </p>
      <DataTable<AdminRefund>
        q={q} columns={columns} rows={rows}
        total={data.data?.total ?? 0} loading={data.loading} error={data.error} onRetry={data.reload}
        getRowId={(r) => r.id}
        onRowClick={(r) => setOpen(r)}
        searchPlaceholder="Search email, @handle, id, address or tx hash"
        emptyTitle={`No ${c.status} refunds`}
        exportName="usdt-refunds"
      />
    </section>
  );
}

// ======================================================================
// 4. BNB withdrawals (read-only)
// ======================================================================
const BNB_TABS = ["failed", "pending", "sending", "paid"];

export function BnbWithdrawalsPanel() {
  const q = useTableQuery("money:bnb", PAGE);
  const c = useQueueControls(q, "failed");
  const [open, setOpen] = useState<StaffBnbWithdrawalRow | null>(null);

  const data = useApi(
    () => fetchStaffBnbWithdrawals({
      status: c.status, q: q.search, sort: q.sort ?? undefined, dir: q.dir,
      limit: q.pageSize, offset: q.offset,
    }),
    [c.status, q.search, q.sort, q.dir, q.pageSize, q.offset],
    true, c.pollMs,
  );
  const rows = data.data?.rows ?? [];

  const columns: Column<StaffBnbWithdrawalRow>[] = [
    {
      key: "user", header: "User", csv: (r) => r.userEmail,
      render: (r) => (
        <div className="min-w-0">
          <span className="block truncate font-medium text-brand-ink">{r.userEmail}</span>
          <span className="block truncate text-xs text-muted">{r.userId}</span>
        </div>
      ),
    },
    { key: "amount", header: "Amount", align: "right", csv: (r) => r.amountWei, render: (r) => <span className="num">{formatBnbWei(r.amountWei)} BNB</span> },
    { key: "address", header: "To", csv: (r) => r.address, render: (r) => <Addr value={r.address} /> },
    { key: "status", header: "Status", sortable: true, csv: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    { key: "attempts", header: "Tries", align: "right", csv: (r) => r.attempts, render: (r) => <span className="num">{r.attempts}</span> },
    { key: "error", header: "Last error", csv: (r) => r.lastError ?? "", render: (r) => <ErrText value={r.lastError} /> },
    { key: "created_at", header: "When", sortable: true, csv: (r) => r.at, render: (r) => <TimeCell iso={r.at} /> },
  ];

  if (open) {
    return (
      <MoneyDetail
        backLabel="BNB withdrawals" onBack={() => setOpen(null)}
        title={open.userEmail}
        idChips={[{ label: "request", value: open.id }, { label: "user", value: open.userId }]}
        badges={<StatusBadge status={open.status} />}
        userId={open.userId}
        fields={[
          F("Amount", <span className="num">{formatBnbWei(open.amountWei)} BNB</span>),
          F("Chain", <span className="uppercase">{open.chain}</span>),
          F("To address", <CopyId value={open.address} />),
          F("Status", <StatusBadge status={open.status} />),
          F("Attempts", <span className="num">{open.attempts}</span>),
          F("Tx hash", open.txHash ? <CopyId value={open.txHash} /> : "—"),
          F("Last error", <span className="text-danger">{open.lastError ?? "—"}</span>),
          F("Requested", <TimeCell iso={open.at} />),
          F("Completed", open.completedAt ? <TimeCell iso={open.completedAt} /> : "—"),
        ]}
        extra={
          <p className="rounded-lg border border-line bg-card p-3 text-xs text-muted">
            Read-only. A failed native BNB send is terminal — it needs a human to check the chain, not a
            retry (the balance is a live on-chain read, so a resend could double-spend). Nothing was
            debited from an internal balance, so a failed job needs no compensating credit.
          </p>
        }
      />
    );
  }

  return (
    <section className="mb-8">
      <QueueHeader title="BNB withdrawals" tabs={BNB_TABS} status={c.status} setStatus={c.setStatus}
        refresh={{ updatedAt: data.updatedAt, loading: data.loading, reload: data.reload, auto: c.auto, setAuto: c.setAuto }} />
      <DataTable<StaffBnbWithdrawalRow>
        q={q} columns={columns} rows={rows}
        total={data.data?.total ?? 0} loading={data.loading} error={data.error} onRetry={data.reload}
        getRowId={(r) => r.id}
        onRowClick={(r) => setOpen(r)}
        searchPlaceholder="Search email, user id, address or tx hash"
        emptyTitle={`No ${c.status} BNB withdrawals`}
        exportName="bnb-withdrawals"
      />
    </section>
  );
}

// ======================================================================
// 5. Payout relay jobs (read-only)
// ======================================================================
const RELAY_TABS = ["failed", "active", "pending", "gas_sent", "prefund_sent", "forward_sent", "forward_confirmed"];

export function RelayJobsPanel() {
  const q = useTableQuery("money:relay", PAGE);
  const c = useQueueControls(q, "failed");
  const [open, setOpen] = useState<RelayJobRow | null>(null);

  const data = useApi(
    () => fetchRelayJobs({
      status: c.status, q: q.search, sort: q.sort ?? undefined, dir: q.dir,
      limit: q.pageSize, offset: q.offset, purpose: q.filters.purpose || undefined,
    }),
    [c.status, q.search, q.sort, q.dir, q.pageSize, q.offset, q.filters.purpose],
    true, c.pollMs,
  );
  const rows = data.data?.rows ?? [];

  const columns: Column<RelayJobRow>[] = [
    { key: "purpose", header: "For", csv: (r) => r.purpose, render: (r) => <span className="capitalize">{r.purpose}</span> },
    {
      key: "user", header: "User", csv: (r) => r.userEmail,
      render: (r) => (
        <div className="min-w-0">
          <span className="block truncate font-medium text-brand-ink">{r.userEmail}</span>
          <span className="block truncate text-xs text-muted">req {r.requestId}</span>
        </div>
      ),
    },
    { key: "amount", header: "Amount", align: "right", csv: (r) => r.amountMicro, render: (r) => <span className="num">{formatUsdtMicro(r.amountMicro)}</span> },
    { key: "to", header: "To", csv: (r) => r.toAddress, render: (r) => <Addr value={r.toAddress} /> },
    { key: "status", header: "Phase", sortable: true, csv: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    { key: "attempts", header: "Tries", align: "right", csv: (r) => r.attempts, render: (r) => <span className="num">{r.attempts}</span> },
    { key: "error", header: "Last error", csv: (r) => r.lastError ?? "", render: (r) => <ErrText value={r.lastError} /> },
    { key: "created_at", header: "When", sortable: true, csv: (r) => r.at, render: (r) => <TimeCell iso={r.at} /> },
  ];

  if (open) {
    return (
      <MoneyDetail
        backLabel="Payout relay jobs" onBack={() => setOpen(null)}
        title={`${open.purpose} · ${open.userEmail}`}
        idChips={[{ label: "job", value: open.id }, { label: "request", value: open.requestId }, { label: "user", value: open.userId }]}
        badges={<StatusBadge status={open.status} />}
        userId={open.userId}
        fields={[
          F("Purpose", <span className="capitalize">{open.purpose}</span>),
          F("Amount", <span className="num">{formatUsdtMicro(open.amountMicro)}</span>),
          F("Chain", <span className="uppercase">{open.chain}</span>),
          F("Needs prefund", open.needsPrefund ? "yes (withdrawal pass-through)" : "no (refund from own address)"),
          F("From address", <CopyId value={open.fromAddress} />),
          F("To address", <CopyId value={open.toAddress} />),
          F("Phase", <StatusBadge status={open.status} />),
          F("Attempts", <span className="num">{open.attempts}</span>),
          F("Gas tx", open.gasTxHash ? <CopyId value={open.gasTxHash} /> : "—"),
          F("Prefund tx", open.prefundTxHash ? <CopyId value={open.prefundTxHash} /> : "—"),
          F("Forward tx", open.forwardTxHash ? <CopyId value={open.forwardTxHash} /> : "—"),
          F("Last error", <span className="text-danger">{open.lastError ?? "—"}</span>),
          F("Created", <TimeCell iso={open.at} />),
          F("Completed", open.completedAt ? <TimeCell iso={open.completedAt} /> : "—"),
        ]}
        extra={
          <p className="rounded-lg border border-line bg-card p-3 text-xs text-muted">
            Read-only. A failed relay job is terminal — the compensating action (return the held money,
            re-check the chain) is decided per case. For a refund job that gave up before any value moved,
            the background tick auto-credits the balance back; a withdrawal whose prefund leg already
            confirmed is left for a human to reconcile against the chain.
          </p>
        }
      />
    );
  }

  return (
    <section className="mb-8">
      <QueueHeader title="Payout relay jobs" tabs={RELAY_TABS} status={c.status} setStatus={c.setStatus}
        refresh={{ updatedAt: data.updatedAt, loading: data.loading, reload: data.reload, auto: c.auto, setAuto: c.setAuto }} />
      <DataTable<RelayJobRow>
        q={q} columns={columns} rows={rows}
        total={data.data?.total ?? 0} loading={data.loading} error={data.error} onRetry={data.reload}
        getRowId={(r) => r.id}
        onRowClick={(r) => setOpen(r)}
        searchPlaceholder="Search email, job id, request id or address"
        emptyTitle={`No ${c.status} relay jobs`}
        exportName="relay-jobs"
        filters={[
          { key: "purpose", label: "For", type: "select", options: [
            { value: "withdrawal", label: "withdrawal" }, { value: "refund", label: "refund" },
          ] },
        ]}
      />
    </section>
  );
}

// ======================================================================
// 6. Reconciliation history
// ======================================================================
const RECON_PREVIEW = 6;

export function ReconciliationPanel() {
  const [auto, setAuto] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const data = useApi(() => fetchReconciliation("bep20", 60), [], true, auto ? QUEUE_POLL_MS : undefined);
  const snaps = data.data?.snapshots ?? [];
  const shortfalls = snaps.filter((s) => s.delta < 0).length;
  // Show the newest handful and hide the rest behind "See more" — the check
  // runs hourly, so 60 rows is a full-height wall nobody reads past row 6. The
  // shortfall summary below still counts the whole window.
  const shown = showAll ? snaps : snaps.slice(0, RECON_PREVIEW);
  const hiddenCount = snaps.length - shown.length;

  return (
    <section className="mb-8">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-brand-ink">Reconciliation history</h2>
        <RefreshBar updatedAt={data.updatedAt} loading={data.loading} onRefresh={data.reload} auto={auto} setAuto={setAuto} />
      </div>
      <p className="mb-2 text-xs text-muted">
        Treasury + known-unswept on-chain balance vs. what the ledger says we owe, on BNB Smart Chain —
        one row per scheduled check. A negative delta is a shortfall: the treasury holds less than we owe.
        A shortfall also pages staff on Telegram the moment it is first raised.
      </p>
      {data.error ? (
        <p className="rounded-lg border border-danger/30 bg-danger-tint/40 p-3 text-sm text-danger">{data.error}</p>
      ) : snaps.length === 0 ? (
        <p className="rounded-lg border border-line bg-card p-4 text-sm text-muted">
          No reconciliation snapshots yet. The hourly check writes one row each time it runs.
        </p>
      ) : (
        <>
          {shortfalls > 0 && (
            <p className="mb-2 rounded-lg border border-danger/40 bg-danger-tint/40 p-2 text-xs font-semibold text-danger">
              {shortfalls} of the last {snaps.length} checks showed a shortfall.
            </p>
          )}
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-brand-tint text-left text-xs uppercase text-brand">
                <tr>
                  <th className="p-2.5">Checked</th>
                  <th className="p-2.5 text-right">On-chain balance</th>
                  <th className="p-2.5 text-right">Ledger owes</th>
                  <th className="p-2.5 text-right">Delta</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="p-2.5"><TimeCell iso={s.checked_at} /></td>
                    <td className="num p-2.5 text-right">{s.onchainBalance} USDT</td>
                    <td className="num p-2.5 text-right">{s.ledgerTotal} USDT</td>
                    <td className={`num p-2.5 text-right font-semibold ${s.delta < 0 ? "text-danger" : "text-success"}`}>
                      {s.delta > 0 ? "+" : ""}{s.delta} USDT
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(hiddenCount > 0 || showAll) && (
            <button onClick={() => setShowAll(!showAll)}
              className="mt-2 text-xs font-semibold text-brand hover:underline">
              {showAll ? "Show less" : `See more (${hiddenCount})`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
