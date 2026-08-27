"use client";

// Cross-section navigation for the staff panel — the SPA is one hash-routed
// page (web/src/app/staff/page.tsx), so "click this stat tile / this flagged
// user / this leaderboard row and land on the relevant screen" needs a way to
// reach the section switcher from components mounted deep inside a section.
// A React context is simpler than threading an onNavigate prop through every
// panel between page.tsx and, say, a table row in growth-admin.tsx.
import { createContext, useContext } from "react";

export type SectionId =
  | "dashboard" | "money" | "users" | "tasks" | "mining" | "growth" | "messages"
  | "support" | "audit" | "settings" | "team";

export type StaffNav = {
  /** Switch to a section (e.g. from a stat tile to the queue it counts). */
  goToSection: (id: SectionId) => void;
  /** Jump to Users & IDs with a specific user pre-loaded in the lookup box. */
  openUser: (userId: string) => void;
};

const noop: StaffNav = { goToSection: () => {}, openUser: () => {} };

export const StaffNavContext = createContext<StaffNav>(noop);

/** Read the current navigation actions. Safe to call anywhere under StaffPage — falls back to no-ops outside it (e.g. in tests). */
export function useStaffNav(): StaffNav {
  return useContext(StaffNavContext);
}
