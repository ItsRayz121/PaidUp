"use client";

// Staff-panel search box (founder request, 2026-08-29: "the admin panel is
// confusing — a search button so I can go straight to the thing I want").
//
// The panel is one hash-routed page with ~11 sections and ~30 sub-panels
// inside them. This is a flat index of every place worth jumping to; typing
// filters it and picking a result switches to that section and its sub-tab.
//
// The list is filtered the SAME way the sidebar is — a destination whose
// section the role can't see, or whose own `needs` the role lacks, is never
// offered, so search can't send anyone to a screen that 403s on arrival.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { SectionId } from "@/lib/staffNav";
import type { UiPermission } from "@/lib/permissions";
import { staffRecordSearch, type StaffSearchHit } from "@/lib/api";
import { SearchIcon } from "@/components/icons";

export type SearchDest = {
  label: string;
  section: SectionId;
  /** Panel id (the sub-tab, e.g. "p-withdrawals") to open after switching section. */
  anchor?: string;
  /** Short label kept for a future compact display. Falls back to `label`. */
  short?: string;
  /** Small grey text on the right — which section it lives in. */
  hint?: string;
  /** Extra words to match on, beyond the label. */
  keywords: string;
  /** Permissions required on top of the section being visible (ALL of them). */
  needs?: UiPermission[];
};

const DESTINATIONS: SearchDest[] = [
  // --- the sections themselves ------------------------------------------------
  { label: "Dashboard", section: "dashboard", keywords: "kpi analytics overview stats numbers charts" },
  { label: "Money & payouts", section: "money", keywords: "cash out pay treasury" },
  { label: "Users & IDs", section: "users", keywords: "accounts members people kyc" },
  { label: "Tasks & networks", section: "tasks", keywords: "offers campaigns adverts proofs" },
  { label: "Mining (ROZI)", section: "mining", keywords: "rozi token rigs machines emission conversion store" },
  { label: "Growth", section: "growth", keywords: "referral invite leaderboard" },
  { label: "Messages & content", section: "messages", keywords: "broadcast announcement notification home cards" },
  { label: "Support tickets", section: "support", keywords: "help complaints replies" },
  { label: "Audit log", section: "audit", keywords: "history changes who did what" },
  { label: "Features & settings", section: "settings", keywords: "flags toggles config alerts" },
  { label: "Staff & roles", section: "team", keywords: "permissions admins agents managers" },

  // --- deep links to individual panels -------------------------------------
  { label: "Money overview", short: "Overview", section: "money", anchor: "p-overview", hint: "Money & payouts",
    keywords: "money overview held treasury inflow outflow deposits withdrawals net flow balance", needs: ["withdrawals.view"] },
  { label: "Withdrawals queue", short: "Withdrawals", section: "money", anchor: "p-withdrawals", hint: "Money & payouts",
    keywords: "withdraw payout cash out pay approve reject mark paid", needs: ["withdrawals.view"] },
  { label: "USDT deposits", short: "Deposits", section: "money", anchor: "p-usdt-deposits", hint: "Money & payouts",
    keywords: "topup top up deposit confirm tx hash credit", needs: ["deposits.view"] },
  { label: "USDT refunds", short: "Refunds", section: "money", anchor: "p-usdt-refunds", hint: "Money & payouts",
    keywords: "refund get money back return deposit", needs: ["refunds.view"] },
  { label: "BNB withdrawals", short: "BNB out", section: "money", anchor: "p-bnb-withdrawals", hint: "Money & payouts",
    keywords: "bnb gas withdraw native failed", needs: ["withdrawals.view"] },
  { label: "Payout relay jobs", short: "Relay jobs", section: "money", anchor: "p-relay-jobs", hint: "Money & payouts",
    keywords: "relay job payout sign broadcast gas prefund forward failed stuck", needs: ["withdrawals.view"] },
  { label: "Treasury wallet", short: "Treasury", section: "money", anchor: "p-treasury", hint: "Money & payouts",
    keywords: "hot wallet balance gas fund bnb address", needs: ["treasury.view"] },
  { label: "Reconciliation history", short: "Reconciliation", section: "money", anchor: "p-reconciliation", hint: "Money & payouts",
    keywords: "reconcile treasury shortfall snapshot ledger owed delta", needs: ["analytics.view"] },
  { label: "Withdrawal fee & auto-approve limits", short: "Fees & limits", section: "money", anchor: "p-withdrawal-fee", hint: "Money & payouts",
    keywords: "fee fees gas ceiling auto withdraw refund limit approval 100 usdt step up charge", needs: ["settings.manage"] },
  { label: "Users list", short: "Users", section: "users", anchor: "p-users", hint: "Users & IDs",
    keywords: "search find user suspend restore export csv bulk review hold", needs: ["users.list"] },
  { label: "Verify IDs (KYC)", short: "IDs (KYC)", section: "users", anchor: "p-kyc", hint: "Users & IDs",
    keywords: "kyc id card verify identity document approve reject", needs: ["kyc.view"] },
  { label: "Look up a user", short: "Look up", section: "users", anchor: "p-lookup", hint: "Users & IDs",
    keywords: "dispute ledger find account id email handle balances devices", needs: ["users.view"] },
  { label: "Fraud flags", short: "Fraud", section: "users", anchor: "p-fraud", hint: "Users & IDs",
    keywords: "fraud abuse ring device ip velocity resolve", needs: ["fraud.view"] },

  { label: "Our own tasks", short: "Our tasks", section: "tasks", anchor: "p-tasks", hint: "Tasks & networks",
    keywords: "custom task social whatsapp telegram reward rozi budget campaign", needs: ["tasks.view"] },
  { label: "Task proofs", short: "Proofs", section: "tasks", anchor: "p-proofs", hint: "Tasks & networks",
    keywords: "proof review approve reject screenshot answers", needs: ["tasks.review"] },
  { label: "Ad networks", short: "Networks", section: "tasks", anchor: "p-networks", hint: "Tasks & networks",
    keywords: "cpx offerwall postback commission split referral bonus", needs: ["networks.manage"] },

  { label: "Referral rates", short: "Referrals", section: "growth", anchor: "p-referrals", hint: "Growth",
    keywords: "referral bonus l1 l2 percent invite reward first task", needs: ["referrals.manage"] },
  { label: "Leaderboard", short: "Leaderboard", section: "growth", anchor: "p-leaderboard", hint: "Growth",
    keywords: "leaderboard top earners inviters exclude hide", needs: ["leaderboard.manage"] },

  { label: "Send a message", short: "Messages", section: "messages", anchor: "p-broadcast", hint: "Messages & content",
    keywords: "broadcast announcement inbox push audience", needs: ["notifications.send"] },
  { label: "Home screen cards", short: "Home cards", section: "messages", anchor: "p-content", hint: "Messages & content",
    keywords: "content block banner home card schedule", needs: ["content.manage"] },

  { label: "Feature flags", short: "Flags", section: "settings", anchor: "p-flags", hint: "Features & settings",
    keywords: "flag toggle enable disable transfers ads deposits conversion kyc", needs: ["flags.manage"] },
  { label: "Global settings", short: "Settings", section: "settings", anchor: "p-settings", hint: "Features & settings",
    keywords: "settings minimum withdrawal points config value", needs: ["settings.manage"] },
  { label: "Staff alerts (Telegram)", short: "Alerts", section: "settings", anchor: "p-alerts", hint: "Features & settings",
    keywords: "alert telegram paging chat test notify", needs: ["infra.view"] },
];

function score(d: SearchDest, words: string[]): number {
  const label = d.label.toLowerCase();
  const hay = `${label} ${d.keywords} ${d.hint ?? ""}`.toLowerCase();
  let s = 0;
  for (const w of words) {
    if (!hay.includes(w)) return -1; // every word must match somewhere
    if (label.startsWith(w)) s += 5;
    else if (label.includes(w)) s += 3;
    else s += 1;
  }
  if (!d.anchor) s += 0.5; // a section slightly outranks its own sub-panels on a tie
  return s;
}

const TYPE_LABEL: Record<StaffSearchHit["type"], string> = {
  user: "User", withdrawal: "Withdrawal", refund: "Refund", deposit: "Deposit",
  ticket: "Ticket", task: "Task", network: "Network",
};

type Item =
  | { kind: "record"; hit: StaffSearchHit }
  | { kind: "dest"; dest: SearchDest };

export function StaffSearch({
  visibleSections, has, onGo, onRecord,
}: {
  visibleSections: SectionId[];
  has: (p: UiPermission) => boolean;
  onGo: (section: SectionId, anchor?: string) => void;
  onRecord?: (hit: StaffSearchHit) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [records, setRecords] = useState<StaffSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pool = useMemo(() => {
    const vis = new Set(visibleSections);
    return DESTINATIONS.filter(
      (d) => vis.has(d.section) && (!d.needs || d.needs.every(has)),
    );
  }, [visibleSections, has]);

  const dests = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    return pool
      .map((d) => ({ d, s: score(d, words) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
      .map((x) => x.d);
  }, [q, pool]);

  // Debounced record search against the API (permission-filtered server-side).
  // All state changes happen inside the timeout, never synchronously in the
  // effect body — the sub-2-char "clear" is one 250ms tick late, imperceptibly.
  useEffect(() => {
    const term = q.trim();
    const id = setTimeout(() => {
      if (term.length < 2) { setRecords([]); setSearching(false); return; }
      setSearching(true);
      staffRecordSearch(term)
        .then((r) => setRecords(r.results))
        .catch(() => setRecords([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(id);
  }, [q]);

  const items: Item[] = useMemo(() => [
    ...records.map((hit) => ({ kind: "record" as const, hit })),
    ...dests.map((dest) => ({ kind: "dest" as const, dest })),
  ], [records, dests]);

  // `/` or Ctrl/Cmd+K focuses the box from anywhere on the page.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if ((e.key === "/" && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click outside closes the dropdown.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const activeIdx = active < items.length ? active : 0;

  function reset() { setQ(""); setRecords([]); setOpen(false); inputRef.current?.blur(); }
  function pick(it: Item) {
    if (it.kind === "dest") onGo(it.dest.section, it.dest.anchor);
    else onRecord?.(it.hit);
    reset();
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "Escape") { reset(); return; }
    if (items.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((activeIdx + 1) % items.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((activeIdx - 1 + items.length) % items.length); }
    else if (e.key === "Enter") { e.preventDefault(); pick(items[activeIdx] ?? items[0]); }
  }

  return (
    <div ref={wrapRef} className="relative w-full">
      <div className="flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2">
        <SearchIcon size={16} className="shrink-0 text-muted" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search — a screen, or an email · @handle · id · tx · ticket  ( / )"
          autoCapitalize="none" autoCorrect="off" spellCheck={false}
          className="w-full bg-transparent text-sm text-brand-ink outline-none placeholder:text-muted"
        />
        {q && (
          <button type="button" onClick={() => { setQ(""); setRecords([]); inputRef.current?.focus(); }}
            className="shrink-0 text-xs font-semibold text-muted hover:text-brand-ink">clear</button>
        )}
      </div>

      {open && q.trim() !== "" && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[70vh] overflow-y-auto rounded-lg border border-line bg-card shadow-lg">
          {records.length > 0 && (
            <p className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">Records</p>
          )}
          {records.map((hit, i) => (
            <button
              key={`r:${hit.type}:${hit.id}`}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => pick({ kind: "record", hit })}
              className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm ${i === activeIdx ? "bg-brand-tint" : ""}`}
            >
              <span className="min-w-0">
                <span className="block truncate font-semibold text-brand-ink">{hit.label}</span>
                <span className="block truncate text-xs text-muted">{hit.sub}</span>
              </span>
              <span className="shrink-0 rounded bg-brand-tint/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-brand">{TYPE_LABEL[hit.type]}</span>
            </button>
          ))}

          {dests.length > 0 && (
            <p className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">Go to</p>
          )}
          {dests.map((d, j) => {
            const idx = records.length + j;
            return (
              <button
                key={`d:${d.section}:${d.anchor ?? ""}`}
                type="button"
                onMouseEnter={() => setActive(idx)}
                onClick={() => pick({ kind: "dest", dest: d })}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm ${idx === activeIdx ? "bg-brand-tint" : ""}`}
              >
                <span className="font-semibold text-brand-ink">{d.label}</span>
                {d.hint && <span className="shrink-0 text-xs text-muted">{d.hint}</span>}
              </button>
            );
          })}

          {items.length === 0 && (
            <p className="p-3 text-sm text-muted">{searching ? "Searching…" : `Nothing matches “${q}”.`}</p>
          )}
        </div>
      )}
    </div>
  );
}
