"use client";

import { usePathname } from "next/navigation";
import { BottomNav } from "./BottomNav";
import { InstallPrompt } from "./InstallPrompt";
import { I18nProvider } from "@/lib/i18n";

// Earner app = phone-framed (max 480) with bottom tabs.
// Staff panel = full-width, dense, no tab bar (internal tool — DESIGN_BRIEF).
// Login = phone-framed, no tabs.
export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const isStaff = path.startsWith("/staff");
  const isAuth = path === "/login";
  // Don't cover the sign-in form, and don't interrupt someone mid-survey (the
  // network's iframe owns that screen — a sheet over it can cost them the reward).
  const canPromptInstall = !isAuth && !path.startsWith("/surveys");

  // The staff panel writes its copy inline (internal tool, jargon allowed). The
  // earner app pulls every string from the copy deck in @/lib/i18n, so all
  // user-facing wording can be reviewed for plain English in one file.
  if (isStaff) {
    return <div className="min-h-[100dvh] bg-bg">{children}</div>;
  }

  return (
    <I18nProvider>
      <div className="app-frame flex flex-col">
        <main className="flex-1">{children}</main>
        {canPromptInstall && <InstallPrompt />}
        {!isAuth && <BottomNav />}
      </div>
    </I18nProvider>
  );
}
