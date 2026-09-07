"use client";

// A compact, searchable multi-select dropdown for a DataTable filter bar
// (founder, 2026-09-07: "he should be able to select two or more countries
// ... he should be able to search them ... make it as a dropdown").
//
// Value is stored as ONE comma-joined string, matching every other
// FilterDef ("filterKey -> value") — a single selection is just a
// one-element list, so nothing about GET /staff/users' existing single-value
// contract had to change beyond splitting on a comma server-side.
//
// ⚠️ A selectable option must never itself contain a comma — this component
// only ever lets a user pick from `options` (never free-typed, unlike the
// task-targeting CountryPicker), so as long as every option is comma-free the
// join/split round-trip can never corrupt a selection. Filtered defensively
// below rather than merely documented, since `options` today is
// COUNTRY_OPTIONS (a hardcoded, comma-free list) but nothing stops a future
// caller passing something else.
import { useMemo, useRef, useState } from "react";
import { useClickOutside } from "./primitives";

export function MultiSelectFilter({
  label, options, value, onChange,
}: {
  label: string;
  options: string[];
  /** Comma-joined selected values; "" = no filter ("any"). */
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const selected = useMemo(() => (value ? value.split(",").filter(Boolean) : []), [value]);
  const safeOptions = useMemo(() => options.filter((o) => !o.includes(",")), [options]);

  useClickOutside([wrapRef], () => setOpen(false), open);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? safeOptions.filter((o) => o.toLowerCase().includes(needle)) : safeOptions;
  }, [query, safeOptions]);

  function toggle(o: string) {
    const next = selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o];
    onChange(next.join(","));
  }
  function clear() { onChange(""); setQuery(""); }

  const buttonLabel = selected.length === 0
    ? `${label}: any`
    : selected.length === 1
      ? `${label}: ${selected[0]}`
      : `${label}: ${selected[0]} +${selected.length - 1}`;

  return (
    <div ref={wrapRef} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className={`whitespace-nowrap rounded-md border p-1 text-[11px] font-semibold ${
          selected.length > 0 ? "border-brand bg-brand-tint text-brand" : "border-line bg-card text-brand-ink"
        }`}>
        {buttonLabel} <span aria-hidden className="text-muted">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-56 rounded-lg border border-line bg-card p-2 shadow-lg">
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${label.toLowerCase()}…`}
            autoFocus autoCapitalize="none" autoCorrect="off" spellCheck={false}
            className="w-full rounded-md border border-line bg-card px-2 py-1 text-xs outline-none focus:border-brand"
          />
          <div className="mt-1.5 max-h-48 overflow-y-auto">
            {matches.length === 0 ? (
              <p className="p-1.5 text-xs text-muted">No match.</p>
            ) : matches.map((o) => (
              <label key={o} className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs hover:bg-brand-tint/40">
                <input type="checkbox" checked={selected.includes(o)} onChange={() => toggle(o)} />
                {o}
              </label>
            ))}
          </div>
          <div className="mt-1.5 flex items-center justify-between border-t border-line pt-1.5">
            <button type="button" onClick={clear} disabled={selected.length === 0}
              className="text-[11px] font-semibold text-brand hover:underline disabled:opacity-40">
              Clear
            </button>
            <button type="button" onClick={() => setOpen(false)}
              className="rounded bg-brand px-2 py-0.5 text-[11px] font-semibold text-white">
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
