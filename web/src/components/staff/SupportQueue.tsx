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

// Two views over the same endpoint (founder, 2026-09-03). INBOX is for
// answering — people on the left, the open conversation on the right, the way
// the founder's reference screenshot works. TABLE is for auditing — search,
// counts over ALL tickets, sort, pagination, CSV. Neither replaces the other,
// so both stay.
export function SupportQueuePanel() {
  const [view, setView] = useState<"inbox" | "table">("inbox");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {(["inbox", "table"] as const).map((v) => (
          <button key={v} onClick={() => setView(v)}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              view === v ? "bg-brand text-white" : "bg-brand-tint text-brand"
            }`}>
            {v === "inbox" ? "Inbox" : "All tickets (table)"}
          </button>
        ))}
      </div>
      {view === "inbox" ? <SupportInbox /> : <SupportTable />}
    </div>
  );
}

// ---- Inbox: conversations left, thread right ---------------------------
// One screen, two panes on a desktop; on a narrow screen picking a person
// replaces the list and a back arrow returns to it. The thread pane is the
// SAME <TicketThread> the table view opens — reply, internal note, take / hand
// back, reopen and close are untouched by this.
const INBOX_LIMIT = 40;

function SupportInbox() {
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);

  const data = useApi(
    () => fetchStaffTickets({
      status, q: search, sort: "updated_at", dir: "desc", limit: INBOX_LIMIT, offset: 0,
    }),
    [status, search],
    true, auto ? QUEUE_POLL_MS : undefined,
  );
  const rows = data.data?.tickets ?? [];
  const counts = data.data?.counts ?? {};
  // The list can move under the open conversation on a poll; keep showing the
  // one that is actually open by matching on id, not by holding a stale row.
  const open = rows.find((r) => r.id === openId) ?? null;

  return (
    <section className="mb-8">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-brand-ink">Support chat</h2>
        <StatusTabs options={TICKET_STATUSES} value={status} onChange={setStatus} counts={counts} />
        <RefreshBar updatedAt={data.updatedAt} loading={data.loading} onRefresh={data.reload}
          auto={auto} setAuto={setAuto} />
      </div>

      <div className="grid gap-3 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        {/* On a phone the list is hidden once a conversation is open — two
            panes at 360px wide is two unreadable panes. */}
        <div className={`${openId ? "hidden md:block" : ""} rounded-lg border-2 border-line-strong bg-card`}>
          <div className="border-b border-line p-2">
            <input
              value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search a person or a subject"
              className="w-full rounded-md border border-line bg-bg px-2 py-1.5 text-xs outline-none"
            />
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {data.loading && rows.length === 0 && <p className="p-3 text-sm text-muted">Loading…</p>}
            {data.error && <p className="p-3 text-sm text-danger">{data.error}</p>}
            {!data.loading && rows.length === 0 && !data.error && (
              <p className="p-3 text-sm text-muted">No conversations yet.</p>
            )}
            {rows.map((t) => {
              const identity = displayIdentity({
                email: t.userEmail, username: t.userUsername, displayName: t.userDisplayName,
                telegramUsername: t.userTelegramUsername, telegramName: t.userTelegramName,
              });
              const selected = t.id === openId;
              return (
                <button key={t.id} onClick={() => setOpenId(t.id)}
                  className={`flex w-full items-start gap-2 border-b border-line p-2.5 text-left last:border-b-0 ${
                    selected ? "bg-brand-tint" : "hover:bg-brand-tint/40"
                  } ${t.status === "closed" ? "opacity-60" : ""}`}>
                  <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-tint text-xs font-bold text-brand">
                    {identity.replace(/^@/, "").slice(0, 2).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-brand-ink">{identity}</span>
                      <span className="shrink-0 text-[10px] text-muted"><TimeCell iso={t.updatedAt} /></span>
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {t.lastMessage || t.subject}
                    </span>
                  </span>
                  {/* "open" means it is waiting on us — the only state that
                      needs a mark in a list you are working down. */}
                  {t.status === "open" && (
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-brand" aria-label="waiting for a reply" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className={`${openId ? "" : "hidden md:block"} rounded-lg border-2 border-line-strong bg-card`}>
          {open ? (
            <div>
              <div className="flex items-center gap-2 border-b border-line p-2.5">
                <button onClick={() => setOpenId(null)}
                  className="rounded bg-brand-tint px-2 py-1 text-xs font-semibold text-brand md:hidden">
                  ← Back
                </button>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-brand-ink">
                    {displayIdentity({
                      email: open.userEmail, username: open.userUsername, displayName: open.userDisplayName,
                      telegramUsername: open.userTelegramUsername, telegramName: open.userTelegramName,
                    }, { full: true })}
                  </p>
                  <p className="truncate text-xs text-muted">{open.userEmail}</p>
                </div>
                <span className="ms-auto"><StatusBadge status={open.status} /></span>
              </div>
              <TicketThread t={open} onChange={data.reload} />
            </div>
          ) : (
            <p className="p-6 text-center text-sm text-muted">
              Pick someone on the left to read and answer their chat.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

// ---- Table: the auditing view (unchanged behaviour) --------------------

function SupportTable() {
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
        // Open vs. closed at a glance regardless of which status tab is
        // active (founder, 2026-09-02) — "open" needs a staff reply, so it
        // gets a left accent; "closed" is done, so it's muted; "answered" is
        // neutral (staff already replied, waiting on the user).
        rowClassName={(t) => t.status === "open" ? "border-l-4 border-l-brand"
          : t.status === "closed" ? "opacity-60" : ""}
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
