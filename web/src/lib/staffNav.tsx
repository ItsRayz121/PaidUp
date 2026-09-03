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
   */
  goToSection: (id: SectionId, panelId?: string) => void;
  /** Jump to Users & IDs, Look-up sub-tab, with a user pre-loaded. */
  openUser: (userId: string) => void;
};

const noop: StaffNav = { goToSection: () => {}, openUser: () => {} };

export const StaffNavContext = createContext<StaffNav>(noop);

/** Read the current navigation actions. Safe to call anywhere under StaffPage — falls back to no-ops outside it (e.g. in tests). */
export function useStaffNav(): StaffNav {
  return useContext(StaffNavContext);
}
