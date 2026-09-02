"use client";

// Support tickets (admin rebuild, Phase E). The ticket LIST moved onto the
// shared <DataTable> — server-side status tabs + counts + search + pagination —
// and a row opens the ticket in a <DetailLayout>. The thread panel itself
// (TicketThread, in components/staff.tsx) is unchanged: reply, internal note,
// take / hand back, reopen all call the same endpoints with the same wording.
//
// ⚠️ COUNTS STAY OVER ALL TICKETS, NEVER THE FILTER (brief part 40). A "closed
// by mistake" ticket is invisible under any single-status view, which is when
// people decide the panel is broken — so "all" is a real tab.
import { useState } from "react";
import { useApi, useStaffSession } from "@/lib/hooks";
import { useTableQuery } from "@/lib/staffTable";
import { DataTable, type Column } from "./DataTable";
import { DetailLayout } from "./DetailLayout";
import { StatusBadge, TimeCell, StatusTabs } from "./primitives";
import { RefreshBar, QUEUE_POLL_MS, TicketThread, TICKET_STATUSES } from "@/components/staff";
import { fetchStaffTickets, type StaffTicket } from "@/lib/api";
import { displayIdentity } from "@/lib/format";

export function SupportQueuePanel() {
  const q = useTableQuery("support:tickets", { pageSize: 25, sort: "updated_at", dir: "asc" });
  const [status, setStatusRaw] = useState("all");
  const [mineOnly, setMineOnly] = useState(false);
  const [auto, setAuto] = useState(true);
  const [open, setOpen] = useState<StaffTicket | null>(null);
  const me = useStaffSession().user;
  const setStatus = (s: string) => { setStatusRaw(s); q.setPage(1); };

  const data = useApi(
    () => fetchStaffTickets({
      status, q: q.search, mine: mineOnly ? (me?.id ?? "") : "",
      sort: q.sort ?? undefined, dir: q.dir, limit: q.pageSize, offset: q.offset,
    }),
    [status, q.search, mineOnly, me?.id, q.sort, q.dir, q.pageSize, q.offset],
    true, auto ? QUEUE_POLL_MS : undefined,
  );
  const rows = data.data?.tickets ?? [];
  const counts = data.data?.counts ?? {};

  const columns: Column<StaffTicket>[] = [
    {
      key: "subject", header: "Subject", csv: (t) => t.subject,
      render: (t) => (
        <div className="min-w-0">
          <span className="block truncate font-medium text-brand-ink">{t.subject}</span>
          {/* A real inbox shows what was last said, not just the subject line
              (founder, 2026-09-02). */}
          {t.lastMessage && <span className="block truncate text-xs text-muted">{t.lastMessage}</span>}
          {status === "all" && <StatusBadge status={t.status} />}
        </div>
      ),
    },
    {
      key: "user", header: "User", csv: (t) => t.userEmail,
      render: (t) => <span className="truncate text-muted">
        {displayIdentity({
          email: t.userEmail, username: t.userUsername, displayName: t.userDisplayName,
          telegramUsername: t.userTelegramUsername, telegramName: t.userTelegramName,
        })}
      </span>,
    },
    { key: "messageCount", header: "Msgs", align: "right", csv: (t) => t.messageCount, render: (t) => <span className="num">{t.messageCount}</span> },
    {
      key: "assignee", header: "Owner", csv: (t) => t.assigneeEmail ?? "",
      render: (t) => t.assigneeEmail
        ? <span className="font-semibold text-brand">{t.assigneeEmail}</span>
        : <span className="text-pending">unassigned</span>,
    },
    { key: "updated_at", header: "Updated", sortable: true, csv: (t) => t.updatedAt, render: (t) => <TimeCell iso={t.updatedAt} /> },
  ];

  if (open) {
    // The person asking, not the ticket id, is the headline (founder,
    // 2026-09-02: "show the user name of the person instead of ticket"). The
    // subject stays visible as a subline, and the ticket/user ids are still a
    // tap away as CopyId chips.
    const identity = displayIdentity({
      email: open.userEmail, username: open.userUsername, displayName: open.userDisplayName,
      telegramUsername: open.userTelegramUsername, telegramName: open.userTelegramName,
    });
    return (
      <DetailLayout
        breadcrumb={[{ label: "Support tickets", onClick: () => setOpen(null) }, { label: identity }]}
        title={<>
          {identity}
          <span className="mt-0.5 block text-sm font-normal text-muted">{open.subject}</span>
        </>}
        ids={[{ label: "ticket", value: open.id }, { label: "user", value: open.userId }]}
        badges={<StatusBadge status={open.status} />}
        tabs={[{
          id: "thread", label: "Conversation",
          content: <TicketThread t={open} onChange={data.reload} />,
        }]}
        activeTab="thread"
        onTab={() => {}}
      />
    );
  }

  return (
    <section className="mb-8">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-brand-ink">Support tickets</h2>
        {/* Counts are over EVERY ticket, never this filter — a per-filter count
            would always equal the list length and say nothing. */}
        <StatusTabs options={TICKET_STATUSES} value={status} onChange={setStatus} counts={counts} />
        <RefreshBar updatedAt={data.updatedAt} loading={data.loading} onRefresh={data.reload} auto={auto} setAuto={setAuto} />
      </div>
      <DataTable<StaffTicket>
        q={q} columns={columns} rows={rows}
        total={data.data?.total ?? 0} loading={data.loading} error={data.error} onRetry={data.reload}
        getRowId={(t) => t.id}
        onRowClick={(t) => setOpen(t)}
        searchPlaceholder="Search subject or email"
        emptyTitle={`No ${status === "all" ? "" : status} tickets`}
        exportName="support-tickets"
        toolbarRight={
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={mineOnly} onChange={(e) => { setMineOnly(e.target.checked); q.setPage(1); }} />
            Mine only
          </label>
        }
      />
    </section>
  );
}
