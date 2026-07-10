"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HomeIcon, TasksIcon, WalletIcon, ReferIcon } from "./icons";

// Icon + LABEL nav — first-time smartphone users get confused by icon-only nav
// (DESIGN_BRIEF). Labels always visible, not just icons.
const items = [
  { href: "/", label: "Home", Icon: HomeIcon },
  { href: "/tasks", label: "Tasks", Icon: TasksIcon },
  { href: "/wallet", label: "Wallet", Icon: WalletIcon },
  { href: "/refer", label: "Refer", Icon: ReferIcon },
];

// Screens that should NOT show the tab bar (full-screen flows).
const hiddenOn = ["/login"];

export function BottomNav() {
  const path = usePathname();
  if (hiddenOn.includes(path)) return null;

  return (
    <nav
      aria-label="Main"
      className="sticky bottom-0 z-20 border-t border-line bg-card/95 backdrop-blur"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="grid grid-cols-4">
        {items.map(({ href, label, Icon }) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-1 py-2.5 text-xs font-medium ${
                  active ? "text-brand" : "text-muted"
                }`}
              >
                <Icon size={24} />
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
