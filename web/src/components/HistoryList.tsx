"use client";

// Shared "list of transactions" rendering — used by /wallet and the per-token
// pages. Each screen owns its own fetch + filtering; this just draws the rows.
import { Card, StatusBadge } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import type { Row } from "@/lib/walletHistory";

export function HistoryList({ rows, onOpen }: { rows: Row[]; onOpen: (row: Row) => void }) {
  return (
    <ul className="space-y-2.5">
      {rows.map((e) => (
        <li key={e.key}>
          <button onClick={() => onOpen(e)} className="w-full text-left">
            <Card className="p-3.5">
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
                  <e.Icon size={20} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-brand-ink leading-snug">{e.label}</p>
                  <p className="text-xs text-muted">{timeAgo(e.at)}</p>
                </div>
                <div className="text-right">
                  <p className={`num font-bold ${e.credit ? "text-success" : "text-brand-ink"}`}>{e.amountText}</p>
                  {e.status && <div className="mt-1 flex justify-end"><StatusBadge status={e.status} /></div>}
                </div>
              </div>
            </Card>
          </button>
        </li>
      ))}
    </ul>
  );
}
