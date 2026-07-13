"use client";

// The slim bar that stays at the top of every earner screen while you scroll.
//
// Founder, 2026-07-13: the top of the page used to scroll away, so the brand and
// the balance vanished as soon as you moved. This is the pattern nearly every
// app uses — a compact bar pinned to the top with the identity and the one
// number that matters, while the big page title scrolls away so a phone screen
// isn't half-full of chrome.
//
// `sticky` (not `fixed`) is deliberate: it mirrors BottomNav, so the bar takes
// part in layout and no page needs padding to avoid being covered by it.
import Link from "next/link";
import { useApi } from "@/lib/hooks";
import { fetchBalance } from "@/lib/api";
import { formatPoints } from "@/lib/format";
import { LogoMark } from "./Logo";
import { useI18n } from "@/lib/i18n";

export function TopBar() {
  const { t } = useI18n();
  const balance = useApi(fetchBalance, []);

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-card/95 backdrop-blur">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <Link href="/" className="flex items-center gap-2">
          <LogoMark size={28} />
          <span className="text-base font-bold leading-none text-brand-ink">
            Rozi<span className="text-brand">Pay</span>
          </span>
        </Link>

        {/* Tapping the balance goes to the wallet — the thing you'd want next. */}
        <Link
          href="/wallet"
          className="flex items-center gap-1.5 rounded-full bg-brand-tint px-3 py-1.5"
          aria-label={t("topbar.balanceLabel")}
        >
          <span className="num text-sm font-bold leading-none text-brand">
            {balance.data ? formatPoints(balance.data.points) : "—"}
          </span>
          <span className="text-[11px] font-medium leading-none text-brand/70">
            {t("topbar.points")}
          </span>
        </Link>
      </div>
    </header>
  );
}
