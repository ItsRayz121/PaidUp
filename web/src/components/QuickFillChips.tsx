"use client";

import { useI18n } from "@/lib/i18n";

// Max + 25/50/75% quick-fill chips for a withdraw amount field (founder,
// 2026-09-03, same day: "most exchanges have this on withdraw"). Shared by
// /wallet/withdraw and /wallet/earnings/withdraw — they draw on different
// balances (real deposit+earned USDT vs. task/referral points) and call
// different endpoints, but the chip row itself is identical, so it lives
// once here rather than as two copies that can drift.
export function QuickFillChips({ onPick }: { onPick: (pct: 25 | 50 | 75 | 100) => void }) {
  const { t } = useI18n();
  return (
    <div className="mt-2 flex gap-1.5">
      {([25, 50, 75] as const).map((pct) => (
        <button key={pct} type="button" onClick={() => onPick(pct)}
          className="flex-1 rounded-lg border border-line bg-card py-1.5 text-xs font-semibold text-muted active:bg-brand-tint/40">
          {pct}%
        </button>
      ))}
      <button type="button" onClick={() => onPick(100)}
        className="flex-1 rounded-lg border border-brand/30 bg-brand-tint py-1.5 text-xs font-bold text-brand active:bg-brand-tint/70">
        {t("withdraw.max")}
      </button>
    </div>
  );
}
