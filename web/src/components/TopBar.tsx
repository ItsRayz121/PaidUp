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
import { fetchNotifications } from "@/lib/api";
import { LogoMark } from "./Logo";
import { BellIcon } from "./icons";
import { useI18n } from "@/lib/i18n";

export function TopBar() {
  const { t } = useI18n();
  // The unread count (brief part 39). A message that lands in the inbox with
  // nothing on screen to say so is a message nobody reads — which is the whole
  // reason people reach for a push notification instead, and push is the thing
  // this design is protecting.
  const inbox = useApi(fetchNotifications, []);
  // Mining state as well as the balance, because this bar shows the SAME
  // combined figure as home and /wallet. It costs one extra request per page
  // load, and that is the cheap side of the trade: a top bar that says 2.20
  // while the card below it says 14.68 is a user working out which number the
  // app is lying with. One balance means one balance everywhere it appears.

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-card/95 backdrop-blur">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <Link href="/" className="flex items-center gap-2">
          <LogoMark size={28} />
          <span className="text-base font-bold leading-none text-brand-ink">
            Rozi<span className="text-brand">Pay</span>
          </span>
        </Link>

        <div className="flex items-center gap-2">
          {/* The bell only appears once there is something unread. An always-on
              bell with a permanent zero is furniture; one that shows up when a
              message arrives is the signal. */}
          {(inbox.data?.unread ?? 0) > 0 && (
            <Link href="/notifications" aria-label={t("inbox.title")}
              className="relative rounded-full bg-brand-tint p-2 text-brand">
              <BellIcon size={18} />
              <span className="num absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-brand px-1 text-center text-[10px] font-bold leading-[18px] text-white">
                {Math.min(inbox.data!.unread, 99)}
              </span>
            </Link>
          )}

          {/* Tapping the balance goes to the wallet — the thing you'd want next. */}
          <Link
            href="/wallet"
            className="flex items-center gap-1.5 rounded-full border border-brand/10 bg-brand-tint px-3 py-1.5"
            aria-label={t("topbar.balanceLabel")}
          >
            {/* Waits for BOTH calls: showing the mined half first would let the
                number visibly jump a moment later, which reads as a glitch on
                every screen in the app rather than just one.
                A failed call is NOT the same as a slow one, and used to look
                identical — the dash simply sat there forever, on every screen,
                with nothing saying why. Now it says so, and the pill still
                leads to /wallet, which has the retry. */}
            <span className="text-xs font-bold leading-none text-brand">
              {t("topbar.roziComingSoon")}
            </span>
          </Link>
        </div>
      </div>
    </header>
  );
}
