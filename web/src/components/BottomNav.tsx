"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HomeIcon, TasksIcon, MineIcon, WalletIcon, ReferIcon, HelpIcon } from "./icons";
import { useI18n } from "@/lib/i18n";

// Icon + LABEL nav — first-time smartphone users get confused by icon-only nav
// (DESIGN_BRIEF). Labels always visible, not just icons. Labels are localized.
//
// Six tabs is at the limit of what fits on a 360px phone, so the label drops to
// 10px here. Mining earns its slot: it is the one screen with something to do on
// a day when the survey wall has no fill, which is most days.
const items = [
  { href: "/", key: "nav.home", Icon: HomeIcon },
  { href: "/tasks", key: "nav.tasks", Icon: TasksIcon },
  { href: "/mine", key: "nav.mine", Icon: MineIcon },
  { href: "/wallet", key: "nav.wallet", Icon: WalletIcon },
  { href: "/refer", key: "nav.refer", Icon: ReferIcon },
  { href: "/help", key: "nav.help", Icon: HelpIcon },
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
      <ul className="grid grid-cols-6" style={{ minHeight: "var(--bottomnav-h)" }}>
        {items.map(({ href, key, Icon }) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium leading-tight ${
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
