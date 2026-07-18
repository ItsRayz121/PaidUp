"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HomeIcon, TasksIcon, MineIcon, WalletIcon, ProfileIcon } from "./icons";
import { useI18n } from "@/lib/i18n";

// Icon + LABEL nav — first-time smartphone users get confused by icon-only nav
// (DESIGN_BRIEF). Labels always visible, not just icons. Labels are localized.
//
// Five tabs, hard cap (founder, 2026-07-17): the four earning screens + Profile.
// Everything else (refer, help, ID check, leaderboard, notifications) lives as a
// row inside Profile, so the bar never has to shrink to fit a sixth slot. `also`
// lists the screens reached FROM a tab, so the tab stays lit while you're there.
const items = [
  { href: "/", key: "nav.home", Icon: HomeIcon, also: [] as string[] },
  { href: "/tasks", key: "nav.tasks", Icon: TasksIcon, also: ["/surveys"] },
  { href: "/mine", key: "nav.mine", Icon: MineIcon, also: [] },
  { href: "/wallet", key: "nav.wallet", Icon: WalletIcon, also: [] },
  { href: "/profile", key: "nav.profile", Icon: ProfileIcon, also: ["/refer", "/help", "/kyc", "/leaderboard"] },
];

// Screens that should NOT show the tab bar (full-screen flows).
const hiddenOn = ["/login"];

export function BottomNav() {
  const path = usePathname();
  const { t } = useI18n();
  if (hiddenOn.includes(path)) return null;

  return (
    <nav
      aria-label="Main"
      className="sticky bottom-0 z-20 border-t border-line bg-card/95 backdrop-blur"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="grid grid-cols-5" style={{ minHeight: "var(--bottomnav-h)" }}>
        {items.map(({ href, key, Icon, also }) => {
          const active =
            href === "/"
              ? path === "/"
              : [href, ...also].some((h) => path.startsWith(h));
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium leading-tight ${
                  active ? "text-brand" : "text-muted"
                }`}
              >
                <Icon size={22} />
                <span className="text-center">{t(key)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
