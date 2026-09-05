"use client";

import { useState } from "react";
import { Card } from "@/components/ui";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { StarIcon, GiftIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchLeaderboard, type LeaderRow, type LeaderboardWindow, type LeaderboardStanding } from "@/lib/api";
import { formatPointsAsRozi } from "@/lib/format";

type Board = "earners" | "referrers";

const WINDOWS: { key: LeaderboardWindow; label: string }[] = [
  { key: "all", label: "All Time" },
  { key: "week", label: "This Week" },
  { key: "month", label: "This Month" },
];

export default function LeaderboardPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const [board, setBoard] = useState<Board>("earners");
  const [win, setWin] = useState<LeaderboardWindow>("all");
  const lb = useApi(() => fetchLeaderboard(win), [win]);

  if (!ready || lb.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (lb.error) return <div className="p-4 pt-6"><ErrorState message={lb.error} onRetry={lb.reload} /></div>;

  const rows = board === "earners" ? lb.data?.topEarners ?? [] : lb.data?.topReferrers ?? [];
  const standing = board === "earners" ? lb.data?.myStanding?.earners ?? null : lb.data?.myStanding?.referrers ?? null;
  const podium = rows.slice(0, 3);
  const rest = rows.slice(3);

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

      <div className="flex gap-1.5 rounded-xl bg-brand-tint/40 p-1">
        {WINDOWS.map((w) => (
          <button key={w.key} onClick={() => setWin(w.key)} aria-pressed={win === w.key}
            className={`flex-1 rounded-lg py-1.5 text-xs font-semibold transition ${
              win === w.key ? "bg-card text-brand-ink shadow-sm" : "text-muted"
            }`}>
            {w.label}
          </button>
        ))}
      </div>

      <StandingBanner standing={standing} win={win} />

      {rows.length === 0 ? (
        <EmptyState title={t("leaderboard.emptyTitle")} body={t("leaderboard.emptyBody")} />
      ) : (
        <>
          <Podium rows={podium} board={board} />
          {rest.length > 0 && (
            <ul className="space-y-2">
              {rest.map((r) => <Row key={r.rank} r={r} board={board} t={t} />)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function StandingBanner({ standing, win }: { standing: LeaderboardStanding; win: LeaderboardWindow }) {
  if (!standing || win === "all") return null;
  const cadence = win === "week" ? "this week" : "this month";
  return (
    <Card className="flex items-center gap-3 border-accent bg-accent-tint p-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-lg">🏆</span>
      <p className="text-sm text-accent-ink">
        <span className="font-bold">You&apos;re #{standing.rank} {cadence}</span> — tracking to win{" "}
        <span className="num font-bold">{standing.roziReward} ROZI</span> when it settles.
      </p>
    </Card>
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

// #1 raised and centered, #2 to its left, #3 to its right — DOM order stays
// rank order (screen readers, and a page with only 1-2 rows never has a gap
// where #1 "should" be); the visual reflow is CSS `order` only.
function Podium({ rows, board }: { rows: LeaderRow[]; board: Board }) {
  const [first, second, third] = rows;
  if (rows.length === 0) return null;
  return (
    <div className="flex items-end justify-center gap-2 pt-2">
      {second && <PodiumSlot r={second} board={board} size="md" className="order-1" />}
      {first && <PodiumSlot r={first} board={board} size="lg" className="order-2" />}
      {third && <PodiumSlot r={third} board={board} size="sm" className="order-3" />}
    </div>
  );
}

const PODIUM_DIMS = {
  lg: { avatar: "h-20 w-20 text-3xl", ring: "ring-4 ring-accent", stand: "h-24", name: "text-sm", crown: true },
  md: { avatar: "h-16 w-16 text-2xl", ring: "ring-2 ring-line-strong", stand: "h-16", name: "text-xs", crown: false },
  sm: { avatar: "h-14 w-14 text-xl", ring: "ring-2 ring-line-strong", stand: "h-10", name: "text-xs", crown: false },
} as const;

function PodiumSlot({ r, board, size, className }: {
  r: LeaderRow; board: Board; size: keyof typeof PODIUM_DIMS; className?: string;
}) {
  const d = PODIUM_DIMS[size];
  return (
    <div className={`flex min-w-0 flex-1 flex-col items-center ${className ?? ""}`}>
      {d.crown && <span className="mb-0.5 text-lg leading-none">👑</span>}
      <span className={`grid shrink-0 place-items-center rounded-full bg-brand-tint ${d.avatar} ${d.ring}`}>
        {MEDAL[r.rank - 1]}
      </span>
      <p className={`mt-1.5 max-w-[84px] truncate text-center font-bold ${d.name} ${r.isMe ? "text-brand" : "text-brand-ink"}`}>
        {r.name}{r.isMe && <span className="text-brand"> · You</span>}
      </p>
      <p className="num text-[11px] font-semibold text-accent-ink">{formatPointsAsRozi(r.points)}</p>
      {board === "referrers" && (
        <p className="text-[10px] text-muted">{r.invites ?? 0} invites</p>
      )}
      <div className={`mt-1.5 w-full rounded-t-xl bg-brand-tint ${d.stand}`} />
    </div>
  );
}

function Row({ r, board, t }: { r: LeaderRow; board: Board; t: (k: string, v?: Record<string, string>) => string }) {
  return (
    <li>
      <Card className={`flex items-center gap-3 p-3 ${r.isMe ? "border-brand bg-brand-tint/50" : ""}`}>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-tint text-sm font-bold text-brand">
          {r.rank}
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
          <span className="num">{formatPointsAsRozi(r.points)}</span>
        </span>
      </Card>
    </li>
  );
}
