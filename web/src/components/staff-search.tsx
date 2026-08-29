"use client";

// Staff-panel search box (founder request, 2026-08-29: "the admin panel is
// confusing — a search button so I can go straight to the thing I want").
//
// The panel is one hash-routed page with ~11 sections and ~30 sub-panels
// inside them. This is a flat index of every place worth jumping to; typing
// filters it and picking a result switches section (and scrolls to the panel).
//
// The list is filtered the SAME way the sidebar is — a destination whose
// section the role can't see, or whose own `needs` the role lacks, is never
// offered, so search can't send anyone to a screen that 403s on arrival.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { SectionId } from "@/lib/staffNav";
import type { UiPermission } from "@/lib/permissions";
import { SearchIcon } from "@/components/icons";

export type SearchDest = {
  label: string;
  section: SectionId;
  /** Panel id (see <Panel id="…">) to scroll to after switching section. */
  anchor?: string;
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
  { label: "Withdrawals queue", section: "money", anchor: "p-withdrawals", hint: "Money & payouts",
    keywords: "withdraw payout cash out pay approve reject mark paid", needs: ["withdrawals.view"] },
  { label: "USDT deposits", section: "money", anchor: "p-usdt-deposits", hint: "Money & payouts",
    keywords: "topup top up deposit confirm tx hash credit", needs: ["deposits.view"] },
  { label: "USDT refunds", section: "money", anchor: "p-usdt-refunds", hint: "Money & payouts",
    keywords: "refund get money back return deposit", needs: ["refunds.view"] },
  { label: "Treasury wallet", section: "money", anchor: "p-treasury", hint: "Money & payouts",
    keywords: "hot wallet balance gas fund bnb address", needs: ["treasury.view"] },
  { label: "Withdrawal fee & auto-approve limit", section: "money", anchor: "p-withdrawal-fee", hint: "Money & payouts",
    keywords: "fee gas ceiling auto withdraw refund limit approval 100 usdt step up", needs: ["settings.manage"] },
  { label: "Money owed vs paid", section: "money", anchor: "p-money", hint: "Money & payouts",
    keywords: "balance owed liability reconcile", needs: ["money.view"] },

  { label: "Users list", section: "users", anchor: "p-users", hint: "Users & IDs",
    keywords: "search find user suspend restore export csv bulk review hold", needs: ["users.list"] },
  { label: "Verify IDs (KYC)", section: "users", anchor: "p-kyc", hint: "Users & IDs",
    keywords: "kyc id card verify identity document approve reject", needs: ["kyc.view"] },
  { label: "Look up a user", section: "users", anchor: "p-lookup", hint: "Users & IDs",
    keywords: "dispute ledger find account id email handle balances devices", needs: ["users.view"] },
  { label: "Fraud flags", section: "users", anchor: "p-fraud", hint: "Users & IDs",
    keywords: "fraud abuse ring device ip velocity resolve", needs: ["fraud.view"] },

  { label: "Our own tasks", section: "tasks", anchor: "p-tasks", hint: "Tasks & networks",
    keywords: "custom task social whatsapp telegram reward rozi budget campaign", needs: ["tasks.view"] },
  { label: "Task proofs", section: "tasks", anchor: "p-proofs", hint: "Tasks & networks",
    keywords: "proof review approve reject screenshot answers", needs: ["tasks.review"] },
  { label: "Ad networks", section: "tasks", anchor: "p-networks", hint: "Tasks & networks",
    keywords: "cpx offerwall postback commission split referral bonus", needs: ["networks.manage"] },

  { label: "Referral rates", section: "growth", anchor: "p-referrals", hint: "Growth",
    keywords: "referral bonus l1 l2 percent invite reward first task", needs: ["referrals.manage"] },
  { label: "Leaderboard", section: "growth", anchor: "p-leaderboard", hint: "Growth",
    keywords: "leaderboard top earners inviters exclude hide", needs: ["leaderboard.manage"] },

  { label: "Send a message", section: "messages", anchor: "p-broadcast", hint: "Messages & content",
    keywords: "broadcast announcement inbox push audience", needs: ["notifications.send"] },
  { label: "Home screen cards", section: "messages", anchor: "p-content", hint: "Messages & content",
    keywords: "content block banner home card schedule", needs: ["content.manage"] },

  { label: "Feature flags", section: "settings", anchor: "p-flags", hint: "Features & settings",
    keywords: "flag toggle enable disable transfers ads deposits conversion kyc", needs: ["flags.manage"] },
  { label: "Global settings", section: "settings", anchor: "p-settings", hint: "Features & settings",
    keywords: "settings minimum withdrawal points config value", needs: ["settings.manage"] },
  { label: "Staff alerts (Telegram)", section: "settings", anchor: "p-alerts", hint: "Features & settings",
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

export function StaffSearch({
  visibleSections, has, onGo,
}: {
  visibleSections: SectionId[];
  has: (p: UiPermission) => boolean;
  onGo: (section: SectionId, anchor?: string) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pool = useMemo(() => {
    const vis = new Set(visibleSections);
    return DESTINATIONS.filter(
      (d) => vis.has(d.section) && (!d.needs || d.needs.every(has)),
    );
  }, [visibleSections, has]);

  const results = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    return pool
      .map((d) => ({ d, s: score(d, words) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
      .map((x) => x.d);
  }, [q, pool]);

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

  // Keep the highlighted row in range as the result list shrinks/grows.
  const activeIdx = active < results.length ? active : 0;

  function pick(d: SearchDest) {
    onGo(d.section, d.anchor);
    setQ("");
    setOpen(false);
    inputRef.current?.blur();
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "Escape") { setQ(""); setOpen(false); inputRef.current?.blur(); return; }
    if (results.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((activeIdx + 1) % results.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((activeIdx - 1 + results.length) % results.length); }
    else if (e.key === "Enter") { e.preventDefault(); pick(results[activeIdx] ?? results[0]); }
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
          placeholder="Search the panel — try “withdraw”, “kyc”, “flags”  ( / )"
          autoCapitalize="none" autoCorrect="off" spellCheck={false}
          className="w-full bg-transparent text-sm text-brand-ink outline-none placeholder:text-muted"
        />
        {q && (
          <button type="button" onClick={() => { setQ(""); inputRef.current?.focus(); }}
            className="shrink-0 text-xs font-semibold text-muted hover:text-brand-ink">clear</button>
        )}
      </div>

      {open && q.trim() !== "" && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-line bg-card shadow-lg">
          {results.length === 0 ? (
            <p className="p-3 text-sm text-muted">Nothing matches “{q}”.</p>
          ) : (
            results.map((d, i) => (
              <button
                key={`${d.section}:${d.anchor ?? ""}`}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(d)}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm ${
                  i === activeIdx ? "bg-brand-tint" : ""
                }`}
              >
                <span className="font-semibold text-brand-ink">{d.label}</span>
                {d.hint && <span className="shrink-0 text-xs text-muted">{d.hint}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
