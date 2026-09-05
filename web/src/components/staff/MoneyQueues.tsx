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
import { StatusBadge, TimeCell, CopyId, Addr, ErrText, StatusTabs, TxHash, statusLabel } from "./primitives";
import { useToast } from "./toast";
import { useStaffNav } from "@/lib/staffNav";
import { RefreshBar, QUEUE_POLL_MS, TreasuryPanel } from "@/components/staff";
import { UsdtTopupConfigPanel } from "@/components/mining-admin";
import type { UiPermission } from "@/lib/permissions";
import {
  fetchStaffQueue, decideWithdrawal, fetchAdminTopups, confirmTopup, rejectTopup,
  fetchAdminRefunds, payRefund, rejectRefund, fetchStaffBnbWithdrawals, fetchRelayJobs,
  fetchReconciliation, resolveRelayJob, resolveBnbWithdrawal, recheckReconciliation,
  fetchTreasuryLedger, type TreasuryLedgerRow,
  type StaffWithdrawal, type AdminTopup, type AdminRefund,
  type StaffBnbWithdrawalRow, type RelayJobRow,
} from "@/lib/api";
import { formatPoints, formatMoney, formatUsdtMicro, formatBnbWei, displayIdentity } from "@/lib/format";
import { ArrowUpIcon, ArrowDownIcon, BoltIcon, ChartIcon } from "@/components/icons";

// ---- shared bits --------------------------------------------------------

// Each money queue gets its own colour so the screens stop looking identical
// (founder, 2026-09-01: "give separate colour to each box … right now they are
// totally similar with just headings"). One hue per stream, drawn as a thick
// left border on the panel + a dot by the title. Tokens only — both themes
// define brand / success / accent / pending / danger.
type Accent = "brand" | "success" | "accent" | "pending" | "danger" | "neutral";
const ACCENT_BAR: Record<Accent, string> = {
  brand: "border-l-brand", success: "border-l-success", accent: "border-l-accent",
  pending: "border-l-pending", danger: "border-l-danger", neutral: "border-l-line",
};
const ACCENT_DOT: Record<Accent, string> = {
  brand: "bg-brand", success: "bg-success", accent: "bg-accent",
  pending: "bg-pending", danger: "bg-danger", neutral: "bg-muted",
};

// Status tabs are now the shared `StatusTabs` primitive (./primitives) — kept
// separate from the DataTable filter bar on purpose: a money queue is read
// one status at a time (the old panels were tabbed), and a "Clear filters"
// that could wipe the status back to a surprising default is the wrong
// affordance here.

// The toolbar row every money queue shares: status tabs on the left, the live
// refresh bar on the right. `accent` draws a coloured dot by the title so each
// queue is recognisable at a glance.
function QueueHeader({ title, tabs, status, setStatus, refresh, accent = "neutral", icon: Icon }: {
  title: string; tabs: string[]; status: string; setStatus: (s: string) => void;
  refresh: { updatedAt: number | null; loading: boolean; reload: () => void; auto: boolean; setAuto: (v: boolean) => void };
  accent?: Accent;
  // The founder's own example was "money in / money out" icons (2026-09-02)
  // — one per queue title, next to the accent dot that already tells them
  // apart by colour.
  icon?: (p: { size?: number }) => ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 font-bold text-brand-ink">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${ACCENT_DOT[accent]}`} aria-hidden />
        {Icon && <Icon size={16} />}
        {title}
      </h2>
      <StatusTabs options={tabs} value={status} onChange={setStatus} />
      <RefreshBar updatedAt={refresh.updatedAt} loading={refresh.loading} onRefresh={refresh.reload}
        auto={refresh.auto} setAuto={refresh.setAuto} />
    </div>
  );
}

// The root <section> className for a money queue — the accent's left border.
const shellCls = (accent: Accent) => `mb-8 border-l-4 pl-4 ${ACCENT_BAR[accent]}`;

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
    <div className="grid grid-cols-1 gap-3 rounded-lg border-2 border-line-strong bg-card p-4 sm:grid-cols-2">
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
function RelaySummary({ r, chain = "bep20" }: {
  r: NonNullable<StaffWithdrawal["relay"]>;
  chain?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-card p-4">
      <p className="mb-2 text-xs font-semibold uppercase text-muted">On-chain relay job</p>
      <Fields rows={[
        F("Phase", <StatusBadge status={r.phase} />),
        F("From address", <span className="num">{r.fromAddress ?? "—"}</span>),
        F("Gas tx", <TxHash value={r.gasTxHash} chain={chain} />),
        F("Prefund tx", <TxHash value={r.prefundTxHash} chain={chain} />),
        F("Forward tx", <TxHash value={r.forwardTxHash} chain={chain} />),
        F("Last error", <span className="text-danger">{r.lastError ?? "—"}</span>),
      ]} />
    </div>
  );
}

// Resolve a FAILED relay job / BNB withdrawal (founder, 2026-09-01: "there must
// be a button that actually clears it"). Three real outcomes:
//   • Acknowledge     — a human checked the chain; nothing moves. Always shown.
//   • Credit money back — the money is still owed and safe to return (relay
//                         only, `owedBack`). Rejects the request + returns the
//                         balance in one step, server-side.
//   • Retry now        — re-queue the on-chain send (`retryable`), behind a
//                        confirm — only when nothing has left treasury yet.
// Rendered as a popover on the list row AND (expanded) in the detail danger
// zone, so it is never "buried".
type ResolveRow = {
  id: string; status: string; handledAt: string | null; handledNote: string | null;
  owedBack: boolean; retryable: boolean;
};
function ResolveControls({ kind, row, canDo, compact, onDone }: {
  kind: "relay" | "bnb"; row: ResolveRow; canDo: boolean; compact?: boolean; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  if (row.handledAt) {
    return (
      <span className="text-xs text-success">
        ✓ resolved{compact ? "" : <> <TimeCell iso={row.handledAt} /></>}{row.handledNote ? ` — ${row.handledNote}` : ""}
      </span>
    );
  }
  if (row.status !== "failed" || !canDo) return <span className="text-xs text-muted">—</span>;

  async function run(action: "acknowledge" | "credit_back" | "retry") {
    if (action === "retry" && !window.confirm(
      "Re-queue this on-chain send? Do this ONLY if you have checked the chain and nothing was actually sent — a resend that lands twice is a double payment.",
    )) return;
    const note = window.prompt(
      action === "acknowledge" ? "What did you check? (required — goes in the audit log)"
      : action === "credit_back" ? "Why is the money going back? (required)"
      : "Why is it safe to retry? (required)",
    );
    if (!note || !note.trim()) return;
    setBusy(true);
    try {
      if (kind === "relay") await resolveRelayJob(row.id, action, note.trim());
      else await resolveBnbWithdrawal(row.id, action === "credit_back" ? "acknowledge" : action, note.trim());
      toast.ok(action === "retry" ? "Re-queued." : action === "credit_back" ? "Money returned." : "Marked handled.");
      onDone();
    } catch (e) { toast.err((e as Error).message); }
    finally { setBusy(false); }
  }

  // Compact = pills in the list cell; full = stacked buttons in the detail
  // danger zone. Both offer the same set, gated the same way.
  const btn = compact
    ? "rounded-md px-2 py-1 text-xs font-semibold"
    : "block w-full rounded px-2 py-1.5 text-left text-xs font-semibold";
  const acts = (
    <>
      <button disabled={busy} onClick={() => run("acknowledge")}
        className={`${btn} bg-brand-tint text-brand hover:brightness-95`}>
        {compact ? "Acknowledge" : "Acknowledge (no money moves)"}
      </button>
      {kind === "relay" && row.owedBack && (
        <button disabled={busy} onClick={() => run("credit_back")}
          className={`${btn} bg-success text-white hover:brightness-95`}>
          {compact ? "Credit back" : "Credit the money back"}
        </button>
      )}
      {row.retryable && (
        <button disabled={busy} onClick={() => run("retry")}
          className={`${btn} bg-danger text-white hover:brightness-95`}>
          Retry now
        </button>
      )}
    </>
  );

  if (compact) {
    return <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>{acts}</div>;
  }

  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <p className="mb-2 text-xs text-muted">
        Check the chain and the user&rsquo;s balance first. Then pick one — every option is written to
        the audit log.
        {row.owedBack && " The money for this one is still owed and safe to return."}
      </p>
      <div className="space-y-1">{acts}</div>
    </div>
  );
}

const PAGE = { pageSize: 25, sort: "created_at", dir: "desc" as const };

// Real @handle / Telegram name instead of a raw email — and for a
// Telegram-only account, instead of `tg…@telegram.local` (founder,
// 2026-09-02). Every money-queue row carries these camelCase `user*` fields
// from the backend now; this just points displayIdentity at them.
function identityOf(r: {
  userEmail: string; userUsername?: string | null; userDisplayName?: string | null;
  userTelegramUsername?: string | null; userTelegramName?: string | null;
}): string {
  return displayIdentity({
    email: r.userEmail, username: r.userUsername,
    displayName: r.userDisplayName, telegramUsername: r.userTelegramUsername,
    telegramName: r.userTelegramName,
  });
}

// ======================================================================
// 1. Withdrawals
// ======================================================================
const WITHDRAWAL_TABS = ["all", "pending", "agent_approved", "manager_approved", "sending", "paid", "rejected"];

export function WithdrawalsPanel({ canOpenLedger }: { canOpenLedger: boolean }) {
  const q = useTableQuery("money:withdrawals", PAGE);
  const c = useQueueControls(q, "all");
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
          <span className="block truncate font-medium text-brand-ink">{identityOf(r)}</span>
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
    // The chain's own receipt for a paid row — clickable through to BscScan.
    { key: "tx", header: "Transaction", csv: (r) => r.txHash ?? "", render: (r) => <TxHash value={r.txHash} chain={r.chain} /> },
    { key: "created_at", header: "Requested", sortable: true, csv: (r) => r.at, render: (r) => <TimeCell iso={r.at} /> },
    { key: "actions", header: "", render: actionsFor },
  ];

  if (open) {
    return (
      <MoneyDetail
        backLabel="Withdrawals" onBack={() => setOpen(null)}
        title={identityOf(open)}
        idChips={[{ label: "request", value: open.id }, { label: "user", value: open.userId }]}
        badges={<StatusBadge status={open.status} />}
        userId={canOpenLedger ? open.userId : undefined}
        fields={[
          F("Amount", <span className="num">{formatPoints(open.amount)} pts</span>),
          F("Fee", open.feePoints ? <span className="num">− {formatPoints(open.feePoints)} pts</span> : "—"),
          F("Net to send", <span className="num font-semibold text-brand">{open.netUsdt ?? "—"} USDT</span>),
          F("Source", open.sourceKind === "mixed" ? "Deposit + task USDT (one combined payout)"
            : open.sourceKind === "earned_usdt" ? "Task USDT" : "Points"),
          ...(open.sourceKind === "mixed" ? [
            F("— from deposit", <span className="num">{((open.depositComponentMicro ?? 0) / 1_000_000).toFixed(2)} USDT</span>),
            F("— from task earnings", <span className="num">{((open.earnedUsdtMicro ?? 0) / 1_000_000).toFixed(2)} USDT</span>),
          ] : []),
          F("Network", <span className="uppercase">{open.chain}</span>),
          F("Address", open.address ? <CopyId value={open.address} /> : "—"),
          F("Address checked", open.addressVerified ? "✓ signed by the user's wallet" : "not checked — typed in"),
          F("Transaction", <TxHash value={open.txHash} chain={open.chain} />),
          F("Requested", <TimeCell iso={open.at} />),
        ]}
        extra={open.relay ? <RelaySummary r={open.relay} chain={open.chain} /> : undefined}
        danger={actionsFor(open)}
      />
    );
  }

  return (
    <section className={shellCls("brand")}>
      <QueueHeader title="Withdrawals" accent="brand" icon={ArrowUpIcon} tabs={WITHDRAWAL_TABS} status={c.status} setStatus={c.setStatus}
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
        // "No all withdrawals" was wrong English on the All tab, and on every
        // other tab it stopped at "nothing here" without saying that money-out
        // lives in three separate tables (founder, 2026-09-03, on an empty
        // queue that should not have looked empty).
        emptyTitle={c.status === "all" ? "No withdrawals yet" : `No ${statusLabel(c.status).toLowerCase()} withdrawals`}
        // ⚠️ ONLY WHEN NOTHING IS BEING SEARCHED FOR. DataTable falls back to
        // "try a different search" when this is undefined, and telling someone
        // whose search matched nothing to go look in another tab is a wrong
        // answer to a different question.
        emptyHint={q.search ? undefined :
          "This queue is only task/referral cash-outs. Deposit refunds and BNB sends are their " +
          "own tabs — check All money out to see every outgoing transaction in one list."}
        exportName="withdrawals"
      />
    </section>
  );
}

// ======================================================================
// 2. USDT deposits (top-ups)
// ======================================================================
const TOPUP_TABS = ["all", "pending", "confirmed", "rejected"];

export function DepositsPanel({ canDecide }: { canDecide: boolean }) {
  const q = useTableQuery("money:deposits", PAGE);
  const c = useQueueControls(q, "all");
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
          <span className="block truncate font-medium text-brand-ink">{displayIdentity(r)}</span>
          <span className="block truncate text-xs text-muted">{r.user_id}</span>
        </div>
      ),
    },
    { key: "amount", header: "Claimed", align: "right", sortable: true, csv: (r) => r.amount, render: (r) => <span className="num">{r.amount} USDT</span> },
    { key: "chain", header: "Chain", csv: (r) => r.chain, render: (r) => <span className="uppercase">{r.chain}</span> },
    { key: "tx", header: "Transaction", csv: (r) => r.tx_hash, render: (r) => <TxHash value={r.tx_hash} chain={r.chain} /> },
    { key: "status", header: "Status", sortable: true, csv: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    { key: "created_at", header: "When", sortable: true, csv: (r) => r.created_at, render: (r) => <TimeCell iso={r.created_at} /> },
    { key: "actions", header: "", render: actionsFor },
  ];

  if (open) {
    return (
      <MoneyDetail
        backLabel="USDT deposits" onBack={() => setOpen(null)}
        title={displayIdentity(open)}
        idChips={[{ label: "topup", value: open.id }, { label: "user", value: open.user_id }, { label: "tx", value: open.tx_hash }]}
        badges={<StatusBadge status={open.status} />}
        userId={open.user_id}
        fields={[
          F("Claimed amount", <span className="num">{open.amount} USDT</span>),
          F("Chain", <span className="uppercase">{open.chain}</span>),
          F("Transaction", <TxHash value={open.tx_hash} chain={open.chain} />),
          F("Status", <StatusBadge status={open.status} />),
          F("Reject reason", open.reject_reason ?? "—"),
          F("Created", <TimeCell iso={open.created_at} />),
        ]}
        danger={actionsFor(open)}
      />
    );
  }

  return (
    <section className={shellCls("success")}>
      <QueueHeader title="USDT deposits" accent="success" icon={ArrowDownIcon} tabs={TOPUP_TABS} status={c.status} setStatus={c.setStatus}
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
const REFUND_TABS = ["all", "pending", "sending", "paid", "rejected"];

export function RefundsPanel({ canDecide }: { canDecide: boolean }) {
  const q = useTableQuery("money:refunds", PAGE);
  const c = useQueueControls(q, "all");
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
      return r.status === "paid"
        ? <TxHash value={r.tx_hash} chain={r.chain} />
        : <span className="text-xs text-muted">{r.reject_reason ?? "—"}</span>;
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
          <span className="block truncate font-medium text-brand-ink">{displayIdentity(r)}</span>
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
        title={displayIdentity(open)}
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
          F("Tx hash", <TxHash value={open.tx_hash} chain={open.chain} />),
          F("Reject reason", open.reject_reason ?? "—"),
          F("Created", <TimeCell iso={open.created_at} />),
        ]}
        danger={actionsFor(open)}
      />
    );
  }

  return (
    <section className={shellCls("accent")}>
      <QueueHeader title="USDT refunds" accent="accent" icon={ArrowUpIcon} tabs={REFUND_TABS} status={c.status} setStatus={c.setStatus}
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
const BNB_TABS = ["all", "failed", "pending", "sending", "paid"];

export function BnbWithdrawalsPanel({ canHandle = false }: { canHandle?: boolean }) {
  const q = useTableQuery("money:bnb", PAGE);
  const c = useQueueControls(q, "all");
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
          <span className="block truncate font-medium text-brand-ink">{identityOf(r)}</span>
          <span className="block truncate text-xs text-muted">{r.userId}</span>
        </div>
      ),
    },
    { key: "amount", header: "Amount", align: "right", csv: (r) => r.amountWei, render: (r) => <span className="num">{formatBnbWei(r.amountWei)}</span> },
    { key: "address", header: "To", csv: (r) => r.address, render: (r) => <Addr value={r.address} /> },
    { key: "status", header: "Status", sortable: true, csv: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    { key: "attempts", header: "Tries", align: "right", csv: (r) => r.attempts, render: (r) => <span className="num">{r.attempts}</span> },
    { key: "error", header: "Last error", csv: (r) => r.lastError ?? "", render: (r) => <ErrText value={r.lastError} /> },
    { key: "created_at", header: "When", sortable: true, csv: (r) => r.at, render: (r) => <TimeCell iso={r.at} /> },
    {
      key: "actions", header: "",
      render: (r) => <ResolveControls kind="bnb" row={r} canDo={canHandle} compact onDone={() => data.reload()} />,
    },
  ];

  if (open) {
    return (
      <MoneyDetail
        backLabel="BNB withdrawals" onBack={() => setOpen(null)}
        title={identityOf(open)}
        idChips={[{ label: "request", value: open.id }, { label: "user", value: open.userId }]}
        badges={<StatusBadge status={open.status} />}
        userId={open.userId}
        fields={[
          F("Amount", <span className="num">{formatBnbWei(open.amountWei)}</span>),
          F("Chain", <span className="uppercase">{open.chain}</span>),
          F("To address", <CopyId value={open.address} />),
          F("Status", <StatusBadge status={open.status} />),
          F("Attempts", <span className="num">{open.attempts}</span>),
          F("Tx hash", <TxHash value={open.txHash} chain={open.chain} />),
          F("Last error", <span className="text-danger">{open.lastError ?? "—"}</span>),
          F("Requested", <TimeCell iso={open.at} />),
          F("Completed", open.completedAt ? <TimeCell iso={open.completedAt} /> : "—"),
        ]}
        extra={
          <p className="rounded-lg border border-line bg-card p-3 text-xs text-muted">
            A failed native BNB send never debited an internal balance, so there is nothing to credit
            back. It can be re-queued only while nothing was broadcast (no tx hash) — otherwise check
            the chain and Acknowledge.
          </p>
        }
        danger={open.status === "failed" ? (
          <ResolveControls kind="bnb" row={open} canDo={canHandle} onDone={() => { setOpen(null); data.reload(); }} />
        ) : undefined}
      />
    );
  }

  return (
    <section className={shellCls("pending")}>
      <QueueHeader title="BNB withdrawals" accent="pending" icon={ArrowUpIcon} tabs={BNB_TABS} status={c.status} setStatus={c.setStatus}
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
const RELAY_TABS = ["all", "failed", "active", "pending", "gas_sent", "prefund_sent", "forward_sent", "forward_confirmed"];

export function RelayJobsPanel({ canHandle = false }: { canHandle?: boolean }) {
  const q = useTableQuery("money:relay", PAGE);
  const c = useQueueControls(q, "all");
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
          <span className="block truncate font-medium text-brand-ink">{identityOf(r)}</span>
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
    {
      key: "actions", header: "",
      render: (r) => <ResolveControls kind="relay" row={r} canDo={canHandle} compact onDone={() => data.reload()} />,
    },
  ];

  if (open) {
    return (
      <MoneyDetail
        backLabel="Payout relay jobs" onBack={() => setOpen(null)}
        title={`${open.purpose} · ${identityOf(open)}`}
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
          F("Gas tx", <TxHash value={open.gasTxHash} chain={open.chain} />),
          F("Prefund tx", <TxHash value={open.prefundTxHash} chain={open.chain} />),
          F("Forward tx", <TxHash value={open.forwardTxHash} chain={open.chain} />),
          F("Last error", <span className="text-danger">{open.lastError ?? "—"}</span>),
          F("Created", <TimeCell iso={open.at} />),
          F("Completed", open.completedAt ? <TimeCell iso={open.completedAt} /> : "—"),
        ]}
        extra={
          <p className="rounded-lg border border-line bg-card p-3 text-xs text-muted">
            {open.owedBack
              ? "The money for this job is still owed and nothing has left treasury — you can credit it straight back, or retry the send."
              : "This job already moved value on-chain, or the request was already resolved — check the chain, then Acknowledge."}
          </p>
        }
        danger={open.status === "failed" ? (
          <ResolveControls kind="relay" row={open} canDo={canHandle} onDone={() => { setOpen(null); data.reload(); }} />
        ) : undefined}
      />
    );
  }

  return (
    <section className={shellCls("danger")}>
      <QueueHeader title="Payout relay jobs" accent="danger" icon={BoltIcon} tabs={RELAY_TABS} status={c.status} setStatus={c.setStatus}
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
// 5a. All money out (founder, 2026-09-03)
// ======================================================================
// "There is no transaction of the withdrawals showing up there while we have
// already made up a lot of transactions."
//
// Both things were true. `GET /staff/withdrawals?status=all` really does drop
// every filter — but it only ever reads `withdrawal_requests`, and money leaves
// this platform on THREE rails: a task/referral cash-out, a deposit refund, and
// a BNB gas-out. Each has its own table, its own queue and its own tab, so a
// quiet withdrawals tab said nothing about whether money had moved.
//
// This view merges all three, newest first, each row labelled with the rail it
// came from. It is READ-ONLY: deciding on a row still happens in that rail's
// own tab, which is one click away along the top.
//
// It calls the three EXISTING endpoints rather than adding a fourth. This
// codebase has shipped two "clean typecheck, 500 on open" bugs from hand-written
// SQL over these tables (CLAUDE.md: `networks.label`, then the withdrawal-history
// column names) — a merge in TypeScript over three tested reads cannot repeat
// that, and the rails are small enough that one page each is the whole picture.
type OutRow = {
  key: string;
  rail: "Withdrawal" | "Refund" | "BNB";
  at: string;
  who: string;
  userId: string;
  amount: string;
  status: string;
  txHash: string | null;
  address: string | null;
  // The chain the hash belongs to. Carried per row so the explorer link is
  // never guessed — historical rows on base/aptos still exist (KNOWN_CHAINS).
  chain: string;
};

const OUT_LIMIT = 50;

export function AllMoneyOutPanel({ has, canOpenLedger = false }: {
  has: (p: UiPermission) => boolean;
  canOpenLedger?: boolean;
}) {
  const [auto, setAuto] = useState(true);
  const { openUser } = useStaffNav();
  // ⚠️ THE THREE RAILS HAVE THREE DIFFERENT PERMISSIONS, AND ONE Promise.all
  // WOULD MAKE THAT ONE FAILURE. This tab lives under Withdrawals, which is
  // gated on `withdrawals.view` (agent tier) — but refunds need `refunds.view`
  // (manager tier). A legacy `agent` therefore 403s on the refunds call, and a
  // rejected Promise.all would throw away the withdrawal and BNB rows they ARE
  // allowed to see, on the exact screen built to answer "did anything leave?".
  // Same defect class CLAUDE.md already records for Finance in Stage 4: a
  // screen a role can open but cannot use.
  const canRefunds = has("refunds.view");
  const data = useApi(
    async () => {
      const [w, r, b] = await Promise.all([
        fetchStaffQueue({ status: "all", limit: OUT_LIMIT }),
        canRefunds
          ? fetchAdminRefunds({ status: "all", limit: OUT_LIMIT })
          : Promise.resolve({ refunds: [], total: 0, offset: 0, limit: 0 }),
        fetchStaffBnbWithdrawals({ status: "all", limit: OUT_LIMIT }),
      ]);
      const rows: OutRow[] = [
        ...w.requests.map((x) => ({
          key: `w:${x.id}`, rail: "Withdrawal" as const, at: x.at,
          who: identityOf(x), userId: x.userId,
          // ⚠️ NO " USDT" SUFFIX ON netUsdt EITHER — it is a bare number string
          // from pointsToUsdt, so the unit is added once, here, and the two
          // formatters below add their own.
          amount: `${x.netUsdt ?? formatMoney(x.amount)} USDT`,
          status: x.status, txHash: x.txHash ?? null, address: x.address ?? null,
          chain: x.chain,
        })),
        ...r.refunds.map((x) => ({
          key: `r:${x.id}`, rail: "Refund" as const, at: x.created_at,
          who: displayIdentity(x), userId: x.user_id,
          amount: `${x.netAmount} USDT`,
          status: x.status, txHash: x.tx_hash, address: x.address,
          chain: x.chain,
        })),
        ...b.rows.map((x) => ({
          key: `b:${x.id}`, rail: "BNB" as const, at: x.at,
          who: identityOf(x), userId: x.userId,
          amount: formatBnbWei(x.amountWei),
          status: x.status, txHash: x.txHash, address: x.address,
          chain: x.chain,
        })),
      ];
      // Newest first across all three rails — the only ordering that answers
      // "did anything leave, and when".
      rows.sort((a, z) => (a.at < z.at ? 1 : a.at > z.at ? -1 : 0));
      return { rows, counts: { w: w.total, r: r.total, b: b.total } };
    },
    [canRefunds], true, auto ? QUEUE_POLL_MS : undefined,
  );
  const rows = data.data?.rows ?? [];
  const counts = data.data?.counts;

  const railCls: Record<OutRow["rail"], string> = {
    Withdrawal: "bg-brand-tint text-brand",
    Refund: "bg-accent/15 text-accent",
    BNB: "bg-pending-tint text-pending",
  };

  return (
    <section className={shellCls("danger")}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-bold text-brand-ink">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${ACCENT_DOT.danger}`} aria-hidden />
          <ArrowUpIcon size={16} />
          All money out
        </h2>
        <RefreshBar updatedAt={data.updatedAt} loading={data.loading} onRefresh={data.reload}
          auto={auto} setAuto={setAuto} />
      </div>

      <p className="mb-2 rounded-lg border-2 border-line-strong bg-brand-tint/30 p-2.5 text-xs text-muted">
        Every outgoing transaction, on all three rails, newest first
        {counts && (
          <>
            {" "}— <b>{counts.w}</b> withdrawal(s), <b>{counts.r}</b> refund(s), <b>{counts.b}</b> BNB send(s).
          </>
        )}{" "}
        Each rail keeps its own tab for deciding; this one is only for seeing.
        {!canRefunds && " Refunds are not shown — your role cannot view them."}
      </p>

      {data.error && <p className="mb-2 text-sm text-danger">{data.error}</p>}

      <div className="overflow-x-auto rounded-lg border-2 border-line-strong bg-card">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="p-2">When</th>
              <th className="p-2">Rail</th>
              <th className="p-2">User</th>
              <th className="p-2 text-right">Amount</th>
              <th className="p-2">Status</th>
              <th className="p-2">To</th>
              <th className="p-2">Transaction</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-line/60">
                <td className="p-2"><TimeCell iso={r.at} /></td>
                <td className="p-2">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${railCls[r.rail]}`}>{r.rail}</span>
                </td>
                <td className="p-2">
                  {canOpenLedger
                    ? <button onClick={() => openUser(r.userId)} className="text-brand hover:underline">{r.who}</button>
                    : <span>{r.who}</span>}
                </td>
                <td className="p-2 text-right num">{r.amount}</td>
                <td className="p-2"><StatusBadge status={r.status} /></td>
                <td className="p-2"><Addr value={r.address} chain={r.chain} /></td>
                <td className="p-2"><TxHash value={r.txHash} chain={r.chain} /></td>
              </tr>
            ))}
            {rows.length === 0 && !data.loading && (
              <tr><td colSpan={7} className="p-6 text-center text-sm text-muted">
                No money has left the platform yet.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ======================================================================
// 5b. Treasury wallet - every in and out (founder, 2026-09-03)
// ======================================================================
// "Show me all the in and out of this particular wallet ... all kind of
// transaction with a clickable transaction hash, so that we can see either
// everything is going on smooth or not."
//
// WARNING: NO AUTO-REFRESH ON THIS PANEL, ON PURPOSE. Every other money queue
// polls a cheap database read; this one reaches a block explorer. CLAUDE.md
// records two real billing incidents caused by chain reads that ran with nobody
// watching - so this is a manual Refresh only, backed by a 60s cache on the API.
export function TreasuryWalletPanel() {
  const data = useApi(() => fetchTreasuryLedger(50), []);
  const d = data.data;

  // ⚠️ NO UNIT SUFFIX HERE. formatUsdtMicro returns "12.00 USDT" and
  // formatBnbWei returns "0.0500 BNB" — both already carry it, and appending
  // a second one renders "12.00 USDT USDT". MoneyOverview.tsx carries the same
  // warning for the same reason.
  const amount = (r: TreasuryLedgerRow) =>
    r.asset === "USDT" ? formatUsdtMicro(r.micro ?? 0) : formatBnbWei(r.value);

  return (
    <section className={shellCls("accent")}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-bold text-brand-ink">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${ACCENT_DOT.accent}`} aria-hidden />
          <ChartIcon size={16} />
          Treasury wallet - money in and out
        </h2>
        <button onClick={data.reload} disabled={data.loading}
          className="rounded-md bg-brand-tint px-2.5 py-1.5 text-xs font-semibold text-brand disabled:opacity-50">
          {data.loading ? "Reading the chain..." : "Refresh"}
        </button>
      </div>

      <p className="mb-2 rounded-lg border-2 border-line-strong bg-brand-tint/30 p-2.5 text-xs text-muted">
        Read straight from the BNB Chain, not from our own records - so anything that moved
        without us starting it shows up here too. A row with no description underneath is
        exactly that. Read only when you open or refresh this tab.
      </p>

      {data.error && <p className="mb-2 text-sm text-danger">{data.error}</p>}
      {d && !d.address && (
        <p className="rounded-lg border-2 border-line-strong bg-card p-4 text-sm text-muted">
          No treasury address is set yet. Add it on the <b>Treasury</b> tab.
        </p>
      )}
      {d && d.address && !d.explorerReady && (
        <p className="rounded-lg border-2 border-line-strong bg-card p-4 text-sm text-muted">
          Set <span className="num">BSCSCAN_API_KEY</span> on the API to read this
          wallet&apos;s history. It is a free key, and nothing else on this screen needs it.
        </p>
      )}

      {d?.explorerReady && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-3 rounded-lg border-2 border-line-strong bg-card p-3 text-xs">
            <span><span className="text-muted">Wallet:</span> <Addr value={d.address} /></span>
            {d.totals && (
              <>
                <span className="text-success">
                  in <span className="num font-semibold">{formatUsdtMicro(d.totals.inMicro)}</span>
                </span>
                <span className="text-danger">
                  out <span className="num font-semibold">{formatUsdtMicro(d.totals.outMicro)}</span>
                </span>
                <span className="text-muted">over the last {d.totals.rows} transaction(s) shown</span>
              </>
            )}
          </div>

          <div className="overflow-x-auto rounded-lg border-2 border-line-strong bg-card">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="p-2">When</th>
                  <th className="p-2">In / out</th>
                  <th className="p-2 text-right">Amount</th>
                  <th className="p-2">Other side</th>
                  <th className="p-2">Transaction</th>
                </tr>
              </thead>
              <tbody>
                {/* The index is part of the key on purpose: one transaction can
                    carry two USDT transfers in the same direction (a batch
                    send, a router hop), so hash+asset+direction is not unique. */}
                {d.rows.map((r, i) => (
                  <tr key={`${r.hash}:${r.asset}:${r.direction}:${i}`} className="border-b border-line/60">
                    <td className="p-2"><TimeCell iso={r.at} /></td>
                    <td className="p-2">
                      <span className={`inline-flex items-center gap-1 text-xs font-semibold ${
                        r.direction === "in" ? "text-success" : "text-danger"
                      }`}>
                        {r.direction === "in" ? <ArrowDownIcon size={13} /> : <ArrowUpIcon size={13} />}
                        {r.direction === "in" ? "In" : "Out"}
                      </span>
                    </td>
                    <td className="p-2 text-right num">{amount(r)}</td>
                    <td className="p-2"><Addr value={r.counterparty} /></td>
                    <td className="p-2">
                      <TxHash value={r.hash} />
                      {/* Blank on purpose when we do not recognise the hash -
                          that is the row worth looking at. */}
                      <span className="mt-0.5 block text-[11px] text-muted">{r.label ?? "not one of ours"}</span>
                    </td>
                  </tr>
                ))}
                {d.rows.length === 0 && (
                  <tr><td colSpan={5} className="p-6 text-center text-sm text-muted">
                    Nothing has moved through this wallet yet.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

// ======================================================================
// 6. Reconciliation history
// ======================================================================
const RECON_PREVIEW = 6;

export function ReconciliationPanel({ canRecheck = false }: { canRecheck?: boolean }) {
  const [auto, setAuto] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const data = useApi(() => fetchReconciliation("bep20", 60), [], true, auto ? QUEUE_POLL_MS : undefined);
  const snaps = data.data?.snapshots ?? [];
  const shortfalls = snaps.filter((s) => s.delta < 0).length;

  async function recheck() {
    setBusy(true);
    try {
      const r = await recheckReconciliation("bep20");
      const d = r.snapshot?.delta ?? 0;
      toast.ok(d < 0 ? `Still short by ${Math.abs(d)} USDT.` : "Checked — no shortfall.");
      data.reload();
    } catch (e) { toast.err((e as Error).message); }
    finally { setBusy(false); }
  }
  // Show the newest handful and hide the rest behind "See more" — the check
  // runs hourly, so 60 rows is a full-height wall nobody reads past row 6. The
  // shortfall summary below still counts the whole window.
  const shown = showAll ? snaps : snaps.slice(0, RECON_PREVIEW);
  const hiddenCount = snaps.length - shown.length;

  return (
    <section className={shellCls("danger")}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-bold text-brand-ink">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${ACCENT_DOT.danger}`} aria-hidden />
          <ChartIcon size={16} />
          Reconciliation history
        </h2>
        <div className="flex items-center gap-2">
          {canRecheck && (
            <button onClick={recheck} disabled={busy}
              className="rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
              {busy ? "Checking…" : "Re-check now"}
            </button>
          )}
          <RefreshBar updatedAt={data.updatedAt} loading={data.loading} onRefresh={data.reload} auto={auto} setAuto={setAuto} />
        </div>
      </div>
      <p className="mb-2 text-xs text-muted">
        Treasury + known-unswept on-chain balance vs. what the ledger says we owe, on BNB Smart Chain —
        one row per scheduled check. A negative delta is a shortfall: the treasury holds less than we owe.
        A shortfall also pages staff on Telegram the moment it is first raised. After you post a correcting
        USDT adjustment on the affected user, hit <strong>Re-check now</strong> so the dashboard clears
        without waiting the hour.
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
          <div className="overflow-x-auto rounded-lg border-2 border-line-strong">
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

// ---- Grouped sub-tab wrappers (founder, 2026-09-02 phone review) ----------
//
// Money & payouts had grown to 11 flat sub-tabs. These three wrappers fold
// related ones under one tab each, using the same pattern MiningAdminSection
// already established (mining-admin.tsx): one PanelDef entry that owns its
// own local tab state and its own small tab bar, rather than teaching the
// top-level SubTabs/SECTION_PANELS mechanism to nest. Every child panel below
// keeps the exact same props, permission checks and data-fetching it had as
// its own flat tab — this only changes which parent mounts it.
function GroupTabs({ items }: { items: { id: string; label: string; node: ReactNode }[] }) {
  const [tab, setTab] = useState(items[0]?.id ?? "");
  const active = items.find((t) => t.id === tab) ?? items[0];
  if (!active) return <p className="text-sm text-muted">You don&apos;t have permission to view any of this.</p>;
  return (
    <div>
      {items.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1 border-b border-line pb-px">
          {items.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                t.id === active.id ? "bg-brand text-white" : "text-brand hover:bg-brand-tint"
              }`}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      {active.node}
    </div>
  );
}

// "Money going out" — USDT withdrawals sit next to BNB withdrawals and the
// relay jobs that actually settle both, since all three share one permission
// (withdrawals.view) and one job.
export function WithdrawalsGroupPanel({ has }: { has: (p: UiPermission) => boolean }) {
  return (
    <GroupTabs items={[
      { id: "usdt", label: "USDT", node: <WithdrawalsPanel canOpenLedger={has("users.view")} /> },
      { id: "bnb", label: "BNB", node: <BnbWithdrawalsPanel canHandle={has("withdrawals.decide")} /> },
      { id: "relay", label: "Relay jobs", node: <RelayJobsPanel canHandle={has("withdrawals.decide")} /> },
      // Read-only, and last on purpose: the first three tabs are where a
      // decision gets made, this one only answers "did anything leave".
      { id: "all", label: "All money out", node: <AllMoneyOutPanel has={has} canOpenLedger={has("users.view")} /> },
    ]} />
  );
}

// "Money coming in" — a review queue (real user deposits to confirm/reject)
// next to a settings panel (whether the deposit-funded "buy a rig with USDT"
// feature is on). Different data, different permissions, same money-in group
// — the intro line below states the distinction once, since it's what the
// founder asked to have explained.
export function DepositsGroupPanel({ has, canDecideDeposits, canDecideRefunds }: {
  has: (p: UiPermission) => boolean;
  canDecideDeposits: boolean;
  canDecideRefunds: boolean;
}) {
  const items = [
    has("deposits.view") && { id: "deposits", label: "USDT deposits", node: <DepositsPanel canDecide={canDecideDeposits} /> },
    has("refunds.view") && { id: "refunds", label: "USDT refunds", node: <RefundsPanel canDecide={canDecideRefunds} /> },
    has("mining.manage") && {
      id: "topup", label: "Top-up settings",
      node: (
        <div className="space-y-3">
          <p className="rounded-lg border-2 border-line-strong bg-brand-tint/30 p-2.5 text-xs text-muted">
            <b>USDT deposits</b> reviews real deposits users have already sent — confirm or reject each one.{" "}
            <b>Top-up settings</b> is different: it configures whether the feature that lets a user buy a mining
            machine with that deposited USDT is turned on at all. Same money-in group, different job.
          </p>
          <UsdtTopupConfigPanel />
        </div>
      ),
    },
  ].filter(Boolean) as { id: string; label: string; node: ReactNode }[];
  return <GroupTabs items={items} />;
}

// Treasury balance and the automated hourly check that compares it against
// what the ledger says we owe — one screen for "do we actually have the
// money, and does the chain agree with our books".
export function TreasuryGroupPanel({ has, canRecheck }: {
  has: (p: UiPermission) => boolean;
  canRecheck: boolean;
}) {
  const items = [
    has("treasury.view") && { id: "treasury", label: "Treasury", node: <TreasuryPanel /> },
    // "Wallet" - the real in/out of the treasury address, read from the chain
    // (founder, 2026-09-03). Next to the address it belongs to, and before the
    // reconciliation history, which answers a different question (do our books
    // agree) than this one (what actually moved).
    has("treasury.view") && { id: "wallet", label: "Wallet", node: <TreasuryWalletPanel /> },
    has("analytics.view") && { id: "reconciliation", label: "Reconciliation", node: <ReconciliationPanel canRecheck={canRecheck} /> },
  ].filter(Boolean) as { id: string; label: string; node: ReactNode }[];
  return <GroupTabs items={items} />;
}
