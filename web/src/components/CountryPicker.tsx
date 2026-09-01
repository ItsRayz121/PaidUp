"use client";

// A searchable multi-select for countries. Replaces the free-text "one per line"
// box on the task form and the free-text country filter on the users list.
//
// value is the list of country names, or ["ALL"] / [] for "everywhere". Emits
// the same display strings the API stores (see lib/countries.ts).
import { useMemo, useState } from "react";
import { ALL_COUNTRY, COUNTRY_OPTIONS } from "@/lib/countries";

function selectedFrom(value: string[]): string[] {
  return value.filter((c) => c.trim() !== "" && c.trim().toUpperCase() !== ALL_COUNTRY);
}

export function CountryPicker({
  value, onChange, className,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  className?: string;
}) {
  const [q, setQ] = useState("");
  const selected = selectedFrom(value);
  // "Specific" mode is entered by choosing it or by already having picks. Kept
  // in local state so a user can open the search box before adding anything.
  const [specific, setSpecific] = useState(selected.length > 0);
  const showList = specific || selected.length > 0;

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return COUNTRY_OPTIONS.filter((c) =>
      (!needle || c.toLowerCase().includes(needle)) && !selected.includes(c),
    ).slice(0, 40);
  }, [q, selected]);

  function goAll() { setSpecific(false); onChange([ALL_COUNTRY]); }
  function add(c: string) {
    const name = c.trim();
    if (!name || selected.includes(name)) { setQ(""); return; }
    setSpecific(true); onChange([...selected, name]); setQ("");
  }
  function onEnter() {
    const exact = COUNTRY_OPTIONS.find((c) => c.toLowerCase() === q.trim().toLowerCase());
    if (exact) add(exact);
    else if (matches.length === 1) add(matches[0]);
    else if (q.trim()) add(q.trim());
  }
  function remove(c: string) {
    const next = selected.filter((x) => x !== c);
    if (next.length === 0) { setSpecific(false); onChange([ALL_COUNTRY]); }
    else onChange(next);
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={goAll}
          className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
            !showList ? "bg-brand text-white" : "bg-brand-tint text-brand"
          }`}>
          All countries
        </button>
        {selected.map((c) => (
          <span key={c} className="flex items-center gap-1 rounded-md bg-brand-tint px-2 py-0.5 text-xs text-brand">
            {c}
            <button type="button" aria-label={`Remove ${c}`} onClick={() => remove(c)}
              className="font-bold text-brand/70 hover:text-brand">×</button>
          </span>
        ))}
        {!showList && (
          <button type="button" onClick={() => setSpecific(true)}
            className="text-xs font-semibold text-brand hover:underline">
            Choose specific countries
          </button>
        )}
      </div>

      {showList && (
        <>
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onEnter(); } }}
            placeholder="Type a country, then Enter"
            autoCapitalize="none" autoCorrect="off" spellCheck={false}
            className="mt-2 w-full rounded-md border border-line bg-card px-2 py-1.5 text-sm outline-none focus:border-brand"
          />
          {q.trim() !== "" && (
            <div className="mt-1 max-h-44 overflow-y-auto rounded-md border border-line bg-card">
              {matches.length === 0 ? (
                <p className="p-2 text-xs text-muted">No match. You can still type it and it will be saved.</p>
              ) : matches.map((c) => (
                <button key={c} type="button" onClick={() => add(c)}
                  className="block w-full px-2 py-1.5 text-left text-sm hover:bg-brand-tint">
                  {c}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
