"use client";

// The one list component for the staff console (admin rebuild, Phase A).
//
// CONTROLLED, not self-fetching: the parent owns a useTableQuery() and turns it
// into a request, then hands `rows` + `total` back here. This component draws
// everything around the rows — search box, filter bar, sortable headers,
// pagination, the row count, CSV export, row selection + a bulk-action bar —
// and the four states every list must have (loading, empty, error,
// no-permission). Every staff list uses this, so they all behave identically.
import { useMemo, useState, type ReactNode } from "react";
import type { TableApi } from "@/lib/staffTable";
import { EmptyState, ErrorRow, NoPermission, Spinner } from "./primitives";

export type Column<Row> = {
  key: string;
  header: string;
  sortable?: boolean;
  align?: "left" | "right";
  className?: string;
  render: (row: Row) => ReactNode;
  /** Value for CSV export. Omit to use a best-effort of render(). */
  csv?: (row: Row) => string | number;
};

export type FilterDef =
  | { key: string; label: string; type: "select"; options: { value: string; label: string }[] }
  | { key: string; label: string; type: "text"; placeholder?: string };

export type BulkAction = {
  label: string;
  tone?: "default" | "danger";
  run: (ids: string[]) => Promise<void> | void;
};

type Props<Row> = {
  q: TableApi;
  columns: Column<Row>[];
  rows: Row[];
  total: number;
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
  getRowId: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  filters?: FilterDef[];
  bulkActions?: BulkAction[];
  searchPlaceholder?: string;
  emptyTitle?: string;
  emptyHint?: string;
  noPermission?: boolean;
  /** Basename for the exported file. Omit to hide the export button. */
  exportName?: string;
  /** Extra controls rendered on the toolbar's right side. */
  toolbarRight?: ReactNode;
};

const PAGE_SIZES = [10, 25, 50, 100];

export function DataTable<Row>(p: Props<Row>) {
  const { q, columns, rows, total, loading, error } = p;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const ids = useMemo(() => rows.map(p.getRowId), [rows, p]);
  const allOnPage = ids.length > 0 && ids.every((id) => selected.has(id));
  const pages = Math.max(1, Math.ceil(total / q.pageSize));

  function toggleAll() {
    setSelected(allOnPage ? new Set() : new Set(ids));
  }
  function toggleOne(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  async function runBulk(a: BulkAction) {
    const chosen = [...selected];
    if (chosen.length === 0) return;
    setBulkBusy(true);
    try {
      await a.run(chosen);
      setSelected(new Set());
    } finally {
      setBulkBusy(false);
    }
  }

  function exportCsv() {
    const cols = columns.filter((c) => c.csv || c.key);
    const head = cols.map((c) => c.header);
    const lines = rows.map((r) =>
      cols.map((c) => {
        const v = c.csv ? c.csv(r) : "";
        const s = String(v ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(","),
    );
    const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${p.exportName}-page${q.page}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (p.noPermission) return <NoPermission what="this list" />;

  const activeFilterCount = Object.values(q.filters).filter(Boolean).length;

  return (
    <div className="space-y-3">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q.search}
          onChange={(e) => q.setSearch(e.target.value)}
          placeholder={p.searchPlaceholder ?? "Search…"}
          autoCapitalize="none" autoCorrect="off" spellCheck={false}
          className="min-w-[12rem] flex-1 rounded-md border border-line bg-card p-2 text-sm outline-none focus:border-brand"
        />
        {p.toolbarRight}
        {p.exportName && (
          <button onClick={exportCsv} disabled={rows.length === 0}
            className="rounded-md bg-brand-tint px-2.5 py-1.5 text-xs font-semibold text-brand disabled:opacity-50">
            Export page (CSV)
          </button>
        )}
      </div>

      {/* filter bar */}
      {p.filters && p.filters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {p.filters.map((f) =>
            f.type === "select" ? (
              <select key={f.key} value={q.filters[f.key] ?? ""}
                onChange={(e) => q.setFilter(f.key, e.target.value)}
                className="rounded-md border border-line bg-card p-1.5 text-xs outline-none">
                <option value="">{f.label}: any</option>
                {f.options.map((o) => <option key={o.value} value={o.value}>{f.label}: {o.label}</option>)}
              </select>
            ) : (
              <input key={f.key} value={q.filters[f.key] ?? ""}
                onChange={(e) => q.setFilter(f.key, e.target.value)}
                placeholder={f.placeholder ?? f.label}
                className="w-36 rounded-md border border-line bg-card p-1.5 text-xs outline-none focus:border-brand" />
            ),
          )}
          {activeFilterCount > 0 && (
            <button onClick={q.resetFilters} className="text-xs font-semibold text-brand hover:underline">
              Clear filters ({activeFilterCount})
            </button>
          )}
        </div>
      )}

      {/* bulk-action bar */}
      {selected.size > 0 && p.bulkActions && p.bulkActions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand/30 bg-brand-tint/40 p-2">
          <span className="text-xs font-semibold text-brand-ink">{selected.size} selected</span>
          {p.bulkActions.map((a) => (
            <button key={a.label} disabled={bulkBusy} onClick={() => runBulk(a)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50 ${
                a.tone === "danger" ? "bg-danger" : "bg-brand"
              }`}>
              {a.label}
            </button>
          ))}
          <button onClick={() => setSelected(new Set())}
            className="rounded-md bg-card px-2.5 py-1 text-xs font-semibold text-muted">Clear</button>
        </div>
      )}

      {/* body */}
      {loading && rows.length === 0 ? (
        <Spinner />
      ) : error ? (
        <ErrorRow message={error} onRetry={p.onRetry} />
      ) : rows.length === 0 ? (
        <EmptyState title={p.emptyTitle ?? "Nothing here"} hint={p.emptyHint ?? (q.search || activeFilterCount ? "Try a different search or clearing filters." : undefined)} />
      ) : (
        <div className="overflow-x-auto rounded-lg border-2 border-line-strong">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-brand-tint text-left text-xs uppercase text-brand">
              <tr>
                {p.bulkActions && p.bulkActions.length > 0 && (
                  <th className="w-8 p-2.5">
                    <input type="checkbox" checked={allOnPage} onChange={toggleAll} aria-label="Select all on this page" />
                  </th>
                )}
                {columns.map((c) => (
                  <th key={c.key} className={`p-2.5 ${c.align === "right" ? "text-right" : ""} ${c.className ?? ""}`}>
                    {c.sortable ? (
                      <button onClick={() => q.setSort(c.key)} className="inline-flex items-center gap-1 font-semibold uppercase hover:text-brand-ink">
                        {c.header}
                        <span className="text-[10px]">{q.sort === c.key ? (q.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                      </button>
                    ) : c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const id = p.getRowId(r);
                return (
                  <tr key={id}
                    onClick={p.onRowClick ? () => p.onRowClick!(r) : undefined}
                    className={`border-t border-line ${p.onRowClick ? "cursor-pointer hover:bg-brand-tint/30" : ""}`}>
                    {p.bulkActions && p.bulkActions.length > 0 && (
                      <td className="p-2.5" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selected.has(id)} onChange={() => toggleOne(id)} aria-label="Select row" />
                      </td>
                    )}
                    {columns.map((c) => (
                      <td key={c.key} className={`p-2.5 ${c.align === "right" ? "text-right" : ""} ${c.className ?? ""}`}>
                        {c.render(r)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* footer: count + pagination */}
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>
            {q.offset + 1}–{Math.min(q.offset + rows.length, total)} of {total}
            {loading && " · refreshing…"}
          </span>
          <div className="flex items-center gap-2">
            <select value={q.pageSize} onChange={(e) => q.setPageSize(Number(e.target.value))}
              className="rounded border border-line bg-card p-1 text-xs outline-none">
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} / page</option>)}
            </select>
            <button disabled={q.page <= 1} onClick={() => q.setPage(q.page - 1)}
              className="rounded border border-line bg-card px-2 py-1 font-semibold disabled:opacity-40">Prev</button>
            <span>Page {q.page} / {pages}</span>
            <button disabled={q.page >= pages} onClick={() => q.setPage(q.page + 1)}
              className="rounded border border-line bg-card px-2 py-1 font-semibold disabled:opacity-40">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
