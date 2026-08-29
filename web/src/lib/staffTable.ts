"use client";

// Shared list-view state for the staff console (admin rebuild, Phase A).
//
// Every list screen — users, withdrawals, deposits, tasks, tickets — drives the
// same <DataTable> with one of these. It holds the page, page size, sort, free
// text and per-column filters; the parent turns that into a fetch and hands the
// rows back. Sort / page size / filters persist per browser under `storageKey`
// so a staff member's working view survives a reload; the page number and the
// search box do not (a stale "page 7" or a half-typed query is noise, not state
// worth keeping).
import { useCallback, useEffect, useRef, useState } from "react";

export type SortDir = "asc" | "desc";

export type TableState = {
  page: number;        // 1-based
  pageSize: number;
  sort: string | null; // column key
  dir: SortDir;
  search: string;
  filters: Record<string, string>; // filterKey -> value ("" = not applied)
};

export type TableApi = TableState & {
  setPage: (p: number) => void;
  setPageSize: (n: number) => void;
  setSort: (key: string) => void;        // toggles dir / clears on 3rd click
  setSearch: (q: string) => void;        // resets to page 1
  setFilter: (key: string, value: string) => void; // resets to page 1
  resetFilters: () => void;
  offset: number;                        // (page - 1) * pageSize, for the API
};

const PERSISTED: (keyof TableState)[] = ["pageSize", "sort", "dir", "filters"];

export function useTableQuery(
  storageKey: string,
  defaults: Partial<TableState> = {},
): TableApi {
  const base: TableState = {
    page: 1,
    pageSize: defaults.pageSize ?? 25,
    sort: defaults.sort ?? null,
    dir: defaults.dir ?? "desc",
    search: "",
    filters: defaults.filters ?? {},
  };

  const [state, setState] = useState<TableState>(() => {
    if (typeof window === "undefined") return base;
    try {
      const raw = window.localStorage.getItem(`staffTable:${storageKey}`);
      if (!raw) return base;
      const saved = JSON.parse(raw) as Partial<TableState>;
      const merged = { ...base };
      for (const k of PERSISTED) {
        if (saved[k] !== undefined) (merged as Record<string, unknown>)[k] = saved[k];
      }
      return merged;
    } catch {
      return base;
    }
  });

  // Persist only the durable slice, debounced past the initial mount.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    try {
      const slice: Record<string, unknown> = {};
      for (const k of PERSISTED) slice[k] = state[k];
      window.localStorage.setItem(`staffTable:${storageKey}`, JSON.stringify(slice));
    } catch { /* private mode / quota — the view still works, it just won't stick */ }
  }, [state, storageKey]);

  const setPage = useCallback((p: number) => setState((s) => ({ ...s, page: Math.max(1, p) })), []);
  const setPageSize = useCallback((n: number) => setState((s) => ({ ...s, pageSize: n, page: 1 })), []);
  const setSearch = useCallback((q: string) => setState((s) => ({ ...s, search: q, page: 1 })), []);
  const resetFilters = useCallback(() => setState((s) => ({ ...s, filters: {}, page: 1 })), []);
  const setFilter = useCallback((key: string, value: string) => setState((s) => ({
    ...s, page: 1, filters: { ...s.filters, [key]: value },
  })), []);
  const setSort = useCallback((key: string) => setState((s) => {
    if (s.sort !== key) return { ...s, sort: key, dir: "asc", page: 1 };
    if (s.dir === "asc") return { ...s, dir: "desc", page: 1 };
    return { ...s, sort: null, dir: "desc", page: 1 }; // third click clears sort
  }), []);

  return {
    ...state,
    setPage, setPageSize, setSort, setSearch, setFilter, resetFilters,
    offset: (state.page - 1) * state.pageSize,
  };
}
