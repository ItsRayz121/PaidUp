"use client";

// The one detail-page shell for the staff console (admin rebuild, Phase A).
// Every record — a user, a withdrawal, a task, a ticket — renders through this:
// breadcrumb back to its list, a header (title + copyable ids + status badges +
// primary actions), a tab strip, the active tab's body, and a visually
// separated Danger zone that is always last.
import { type ReactNode } from "react";
import { CopyId } from "./primitives";

export type DetailTab = {
  id: string;
  label: string;
  /** Hidden entirely when false (a role without the permission for it). */
  show?: boolean;
  content: ReactNode;
};

type Props = {
  breadcrumb: { label: string; onClick?: () => void }[];
  title: ReactNode;
  ids?: { label: string; value: string }[];
  badges?: ReactNode;
  actions?: ReactNode;
  tabs: DetailTab[];
  activeTab: string;
  onTab: (id: string) => void;
  dangerZone?: ReactNode;
};

export function DetailLayout(p: Props) {
  const tabs = p.tabs.filter((t) => t.show !== false);
  const active = tabs.find((t) => t.id === p.activeTab) ?? tabs[0];

  return (
    <div className="space-y-4">
      {/* breadcrumb */}
      <nav className="flex flex-wrap items-center gap-1 text-xs text-muted">
        {p.breadcrumb.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            {c.onClick ? (
              <button onClick={c.onClick} className="font-semibold text-brand hover:underline">{c.label}</button>
            ) : (
              <span>{c.label}</span>
            )}
            {i < p.breadcrumb.length - 1 && <span className="text-line">/</span>}
          </span>
        ))}
      </nav>

      {/* header */}
      <div className="rounded-lg border border-line bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-brand-ink">{p.title}</h2>
            {p.ids && p.ids.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {p.ids.map((x) => <CopyId key={x.label} label={x.label} value={x.value} />)}
              </div>
            )}
            {p.badges && <div className="mt-2 flex flex-wrap gap-1.5">{p.badges}</div>}
          </div>
          {p.actions && <div className="flex shrink-0 flex-wrap gap-1.5">{p.actions}</div>}
        </div>
      </div>

      {/* tab strip */}
      <div className="flex flex-wrap gap-1 overflow-x-auto border-b border-line pb-px">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => p.onTab(t.id)}
            className={`whitespace-nowrap rounded-t-md px-3 py-2 text-sm font-semibold ${
              active?.id === t.id ? "border-x border-t border-line bg-card text-brand-ink" : "text-muted hover:text-brand-ink"
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* body */}
      <div>{active?.content}</div>

      {/* danger zone — always last, always separated */}
      {p.dangerZone && (
        <div className="mt-6 rounded-lg border border-danger/30 bg-danger-tint/20 p-4">
          <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-danger">Danger zone</h3>
          <div className="space-y-2">{p.dangerZone}</div>
        </div>
      )}
    </div>
  );
}
