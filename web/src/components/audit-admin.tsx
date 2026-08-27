"use client";

// The audit log, readable in the panel (brief part 46).
//
// Internal tool: density over friendliness, jargon allowed (DESIGN_BRIEF).
//
// The whole value of this screen is answering "who changed that, and what was
// it before?" — so `previous → new` is a first-class column, not something
// buried in a detail string. An audit log you have to grep a CSV to read is one
// nobody reads.

import { useState } from "react";
import { useApi } from "@/lib/hooks";
import { fetchAudit, fetchAuditActions, type AuditEntry } from "@/lib/api";
import { timeAgo } from "@/lib/format";

// Actions worth showing in red. Money and access — the two things you would
// want to notice while scrolling. Everything else is routine queue work.
const LOUD = /adjust|suspend|role|staff_removed|treasury|payout|refund|settle|rate|flag/i;

export function AuditPanel() {
  const [actor, setActor] = useState("");
  const [target, setTarget] = useState("");
  const [action, setAction] = useState("");
  // Applied on submit rather than on every keystroke: this table is unbounded
  // and a query per character would hammer the API for no benefit.
  const [q, setQ] = useState<{ actor?: string; target?: string; action?: string }>({});
  const [extra, setExtra] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Ten at a time (founder, 2026-08-27): the panel used to open with up to 100
  // rows loaded. "Load older" below fetches the next ten.
  const PAGE = "10";
  const log = useApi(() => fetchAudit({ ...q, limit: PAGE }), [q.actor, q.target, q.action]);
  const actions = useApi(fetchAuditActions, []);

  function apply() {
    setExtra([]); setCursor(null);
    setQ({ actor: actor.trim(), target: target.trim(), action });
  }

  async function more() {
    const from = cursor ?? log.data?.nextCursor;
    if (!from) return;
    setLoadingMore(true);
    try {
      const page = await fetchAudit({ ...q, cursor: from, limit: PAGE });
      setExtra((rows) => [...rows, ...page.entries]);
      setCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  const rows = [...(log.data?.entries ?? []), ...extra];
  // `cursor` is null until the first "load more"; before that the first page's
  // own nextCursor is what says whether there is anything left.
  const hasMore = extra.length ? Boolean(cursor) : Boolean(log.data?.nextCursor);

  return (
    <section className="mb-8">
      <div className="mb-2">
        <h2 className="font-bold text-brand-ink">Audit log</h2>
        <p className="text-xs text-muted">
          Every privileged action, append-only. Nothing here can be edited or deleted.
        </p>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <input value={actor} onChange={(e) => setActor(e.target.value)}
          placeholder="who did it (email)"
          className="min-w-[160px] flex-1 rounded-md border border-line bg-card p-2 text-sm outline-none" />
        <input value={target} onChange={(e) => setTarget(e.target.value)}
          placeholder="who it was done to (email)"
          className="min-w-[160px] flex-1 rounded-md border border-line bg-card p-2 text-sm outline-none" />
        <select value={action} onChange={(e) => setAction(e.target.value)}
          className="rounded-md border border-line bg-card p-2 text-sm outline-none">
          <option value="">every action</option>
          {(actions.data?.actions ?? []).map((a) => (
            <option key={a.action} value={a.action}>{a.action} ({a.count})</option>
          ))}
        </select>
        <button onClick={apply}
          className="rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white">Search</button>
      </div>

      {log.loading ? (
        <p className="p-4 text-sm text-muted">Loading…</p>
      ) : log.error ? (
        <p className="p-4 text-sm text-danger">{log.error}</p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-line bg-card p-4 text-sm text-muted">
          Nothing matches.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-brand-tint text-left text-xs uppercase text-brand">
                <tr>
                  <th className="p-2.5">When</th>
                  <th className="p-2.5">Who</th>
                  <th className="p-2.5">Action</th>
                  <th className="p-2.5">To</th>
                  <th className="p-2.5">Changed</th>
                  <th className="p-2.5">Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="border-t border-line align-top">
                    <td className="whitespace-nowrap p-2.5 text-muted" title={e.at}>{timeAgo(e.at)}</td>
                    <td className="p-2.5">
                      <div className="break-all text-brand-ink">{e.actorEmail}</div>
                      <div className="text-xs text-muted">
                        {e.actorRole}{e.ip ? ` · ${e.ip}` : ""}
                      </div>
                    </td>
                    <td className={`p-2.5 font-semibold ${LOUD.test(e.action) ? "text-danger" : "text-brand-ink"}`}>
                      {e.action}
                    </td>
                    <td className="break-all p-2.5 text-muted">{e.targetEmail ?? "—"}</td>
                    <td className="p-2.5">
                      {/* The column this whole screen exists for. Blank, not a
                          dash-pair, when the action has no before/after — an
                          approval did not change a value, and rendering
                          "— → —" would imply it did. */}
                      {e.previousValue !== null || e.newValue !== null ? (
                        <span className="num text-xs">
                          <span className="text-muted line-through">{e.previousValue ?? "(none)"}</span>
                          {" → "}
                          <span className="font-semibold text-brand-ink">{e.newValue ?? "(none)"}</span>
                        </span>
                      ) : <span className="text-xs text-muted">—</span>}
                    </td>
                    <td className="max-w-[280px] break-words p-2.5 text-xs text-muted">{e.detail ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasMore && (
            <button onClick={more} disabled={loadingMore}
              className="mt-3 rounded-md border border-line px-3 py-2 text-sm font-semibold text-brand disabled:opacity-50">
              {loadingMore ? "Loading…" : "Load older"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
