"use client";

// Cross-section navigation for the staff panel — the SPA is one hash-routed
// page (web/src/app/staff/page.tsx), so "click this stat tile / this flagged
// user / this leaderboard row and land on the relevant screen" needs a way to
// reach the section switcher from components mounted deep inside a section.
// A React context is simpler than threading an onNavigate prop through every
// panel between page.tsx and, say, a table row in growth-admin.tsx.
import { createContext, useContext } from "react";

// "settings" was its own section id until 2026-09-03 — Global settings is
// now a sub-tab of "flags" (Feature flags), not a separate top-level section.
export type SectionId =
  | "dashboard" | "money" | "users" | "tasks" | "mining" | "growth" | "messages"
  | "support" | "audit" | "flags" | "team";

export type StaffNav = {
  /**
   * Switch to a section (e.g. from a stat tile to the queue it counts).
   * Pass a panel id (e.g. "p-fraud") to also select that sub-tab — the section
   * mounts exactly one panel at a time (founder, 2026-09-01). Omit it to land
   * on the section's first panel.
   *
   * Some panels are themselves a GROUP of further sub-tabs (Withdrawals ->
   * USDT/BNB/Relay jobs/All money out — see MoneyQueues.tsx's GroupTabs) —
   * pass `groupSubTab` when the destination is unambiguous (e.g. a dashboard
   * tile that counts exactly one inner tab's rows) to land on that inner tab
   * directly, rather than the group's own default first tab. See
   * setPendingGroupSubTab's own comment for why this is a tiny module-scoped
   * registry rather than more context plumbing.
   */
  goToSection: (id: SectionId, panelId?: string, groupSubTab?: string) => void;
  /** Jump to Users & IDs, Look-up sub-tab, with a user pre-loaded. */
  openUser: (userId: string) => void;
};

const noop: StaffNav = { goToSection: () => {}, openUser: () => {} };

// A tiny handoff for "land on this INNER tab of a GroupTabs panel", keyed by
// the panel id (e.g. "p-withdrawals-group") so unrelated groups never collide.
// Not React state on purpose: `goToSection` and the GroupTabs it targets are
// far apart in the tree (a dashboard tile vs. a panel several sections away),
// and both already agree on navigating via the panelId in the URL hash — this
// just rides along the same one-shot "next navigation" moment, read once by
// GroupTabs on mount and then cleared, so a later manual tab click is never
// second-guessed by a stale value.
const pendingGroupSubTab = new Map<string, string>();
export function setPendingGroupSubTab(panelId: string, subTab: string): void {
  pendingGroupSubTab.set(panelId, subTab);
}
export function consumePendingGroupSubTab(panelId: string): string | null {
  const v = pendingGroupSubTab.get(panelId);
  if (v !== undefined) pendingGroupSubTab.delete(panelId);
  return v ?? null;
}

export const StaffNavContext = createContext<StaffNav>(noop);

/** Read the current navigation actions. Safe to call anywhere under StaffPage — falls back to no-ops outside it (e.g. in tests). */
export function useStaffNav(): StaffNav {
  return useContext(StaffNavContext);
}
