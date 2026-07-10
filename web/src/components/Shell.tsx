"use client";

import { usePathname } from "next/navigation";
import { BottomNav } from "./BottomNav";

// Earner app = phone-framed (max 480) with bottom tabs.
// Staff panel = full-width, dense, no tab bar (internal tool — DESIGN_BRIEF).
// Login = phone-framed, no tabs.
export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const isStaff = path.startsWith("/staff");
  const isAuth = path === "/login";

  if (isStaff) {
    return <div className="min-h-[100dvh] bg-bg">{children}</div>;
  }

  return (
    <div className="app-frame flex flex-col">
      <main className="flex-1">{children}</main>
      {!isAuth && <BottomNav />}
    </div>
  );
}
