"use client";

import { useState } from "react";
import { Card } from "@/components/ui";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { StarIcon, GiftIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchLeaderboard, type LeaderRow } from "@/lib/api";
import { formatPoints } from "@/lib/format";

type Board = "earners" | "referrers";

export default function LeaderboardPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const lb = useApi(fetchLeaderboard, []);
  const [board, setBoard] = useState<Board>("earners");

  if (!ready || lb.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (lb.error) return <div className="p-4 pt-6"><ErrorState message={lb.error} onRetry={lb.reload} /></div>;

  const rows = board === "earners" ? lb.data?.topEarners ?? [] : lb.data?.topReferrers ?? [];

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header>
        <h1 className="text-xl font-bold text-brand-ink">{t("leaderboard.title")}</h1>
        <p className="text-sm text-muted">{t("leaderboard.subtitle")}</p>
      </header>

      <div className="grid grid-cols-2 gap-2">
        <TabButton active={board === "earners"} onClick={() => setBoard("earners")}>
          {t("leaderboard.topEarners")}
        </TabButton>
        <TabButton active={board === "referrers"} onClick={() => setBoard("referrers")}>
          {t("leaderboard.topReferrers")}
        </TabButton>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={t("leaderboard.emptyTitle")} body={t("leaderboard.emptyBody")} />
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => <Row key={r.rank} r={r} board={board} t={t} />)}
        </ul>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={active}
      className={`rounded-xl px-3 py-2.5 text-sm font-semibold ${
        active ? "bg-brand text-white" : "border border-line bg-card text-muted"
      }`}>
      {children}
    </button>
  );
}

const MEDAL = ["🥇", "🥈", "🥉"];

function Row({ r, board, t }: { r: LeaderRow; board: Board; t: (k: string, v?: Record<string, string>) => string }) {
  const medal = r.rank <= 3 ? MEDAL[r.rank - 1] : null;
  return (
    <li>
      <Card className={`flex items-center gap-3 p-3 ${r.isMe ? "border-brand bg-brand-tint/50" : ""}`}>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-tint text-sm font-bold text-brand">
          {medal ?? r.rank}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-brand-ink">
            {r.name}{r.isMe && <span className="ms-1 text-xs font-bold text-brand">· {t("leaderboard.you")}</span>}
          </p>
          {board === "referrers" && (
            <p className="text-xs text-muted">{t("leaderboard.invitesLabel", { n: String(r.invites ?? 0) })}</p>
          )}
        </div>
        <span className="flex items-center gap-1 font-bold text-brand-ink">
          {board === "referrers" ? <GiftIcon size={16} className="text-accent-ink" /> : <StarIcon size={16} className="text-accent" />}
          <span className="num">{formatPoints(r.points)}</span>
        </span>
      </Card>
    </li>
  );
}
