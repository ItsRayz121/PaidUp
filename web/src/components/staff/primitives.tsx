"use client";

// Shared display primitives for the staff console (admin rebuild, Phase A).
// One status vocabulary, one time format, one money format, one id chip — used
// on every list and every detail page so nothing formatted two ways.
import { useState, type ReactNode } from "react";
import { formatPoints, formatUsdtMicro } from "@/lib/format";

// ---- status badges --------------------------------------------------------
// Every state string the panel shows, mapped to one of four tones. A value not
// in the map still renders (as neutral) rather than disappearing.
type Tone = "neutral" | "info" | "good" | "warn" | "bad";

const STATUS_TONE: Record<string, Tone> = {
  // money / requests
  pending: "warn", agent_approved: "info", manager_approved: "info",
  approved: "good", paid: "good", sending: "info", processing: "info",
  confirmed: "good", credited: "good", seen: "neutral",
  rejected: "bad", failed: "bad", reorged_out: "bad", expired: "bad",
  refunded: "info", returned: "info",
  // accounts
  active: "good", suspended: "bad", held: "warn", under_review: "warn",
  // tasks / campaigns
  live: "good", draft: "neutral", paused: "warn", archived: "neutral",
  exhausted: "bad", scheduled: "info", ended: "neutral", deleted: "bad",
  // tickets
  open: "warn", answered: "info", closed: "neutral", resolved: "good",
  // generic
  enabled: "good", disabled: "neutral", on: "good", off: "neutral",
};

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-brand-tint/50 text-muted",
  info: "bg-brand-tint text-brand",
  good: "bg-success-tint text-success",
  warn: "bg-pending-tint text-pending",
  bad: "bg-danger-tint text-danger",
};

export function StatusBadge({ status, tone }: { status: string; tone?: Tone }) {
  const t = tone ?? STATUS_TONE[status?.toLowerCase?.() ?? ""] ?? "neutral";
  return (
    <span className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${TONE_CLASS[t]}`}>
      {String(status ?? "—").replace(/_/g, " ")}
    </span>
  );
}

// ---- time ---------------------------------------------------------------
// Founder is in Pakistan — every timestamp reads in PKT, with the full UTC on
// hover and a relative "3h ago" as the primary glance value.
const PKT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi", day: "2-digit", month: "short", year: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

export function relativeTime(iso: string | number | Date): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const sign = diff >= 0 ? "" : "in ";
  const suffix = diff >= 0 ? " ago" : "";
  const m = 60_000, h = 3_600_000, d = 86_400_000;
  if (abs < m) return "just now";
  if (abs < h) return `${sign}${Math.round(abs / m)}m${suffix}`;
  if (abs < d) return `${sign}${Math.round(abs / h)}h${suffix}`;
  if (abs < 30 * d) return `${sign}${Math.round(abs / d)}d${suffix}`;
  return PKT.format(new Date(then));
}

export function TimeCell({ iso }: { iso?: string | number | Date | null }) {
  if (!iso) return <span className="text-muted">—</span>;
  const d = new Date(iso);
  const full = `${PKT.format(d)} PKT  ·  ${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
  return <time dateTime={d.toISOString()} title={full} className="whitespace-nowrap text-muted">{relativeTime(d)}</time>;
}

// ---- money ------------------------------------------------------------
// The staff console works in raw points/micros on purpose (it is where the
// ledger is reconciled). These keep the rendering identical everywhere.
export function Points({ value }: { value: number | null | undefined }) {
  return <span className="num tabular-nums">{formatPoints(Number(value ?? 0))}</span>;
}
export function UsdtMicro({ value }: { value: number | null | undefined }) {
  return <span className="num tabular-nums">{formatUsdtMicro(Number(value ?? 0))}</span>;
}

// ---- copyable id -----------------------------------------------------
export function CopyId({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try { await navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1200); } catch { /* no clipboard */ }
      }}
      title={`Copy ${label ?? "id"}`}
      className="num inline-flex max-w-full items-center gap-1 rounded bg-brand-tint/50 px-1.5 py-0.5 text-xs text-brand hover:bg-brand-tint"
    >
      {label && <span className="text-muted">{label}:</span>}
      <span className="truncate">{value}</span>
      <span className="shrink-0 text-[10px] text-muted">{done ? "copied" : "copy"}</span>
    </button>
  );
}

// ---- address / hash (list view) -----------------------------------
// Middle-truncated + click-to-copy. A list cell must NEVER render a full
// 42/66-char address or tx hash with `break-all` — squeezed into a narrow
// column it wraps one character per line and the row becomes a wall (caught on
// the failed-relay queue, 2026-08-30). The full value stays one tap away in the
// row's detail view, and on hover via the title.
export function Addr({ value, lead = 8, tail = 6 }: { value?: string | null; lead?: number; tail?: number }) {
  const [done, setDone] = useState(false);
  if (!value) return <span className="text-muted">—</span>;
  const short = value.length > lead + tail + 1 ? `${value.slice(0, lead)}…${value.slice(-tail)}` : value;
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try { await navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1200); } catch { /* no clipboard */ }
      }}
      title={value}
      className="num inline-flex items-center gap-1 whitespace-nowrap rounded bg-brand-tint/40 px-1.5 py-0.5 text-xs text-brand hover:bg-brand-tint"
    >
      <span>{short}</span>
      <span className="text-[10px] text-muted">{done ? "✓" : "copy"}</span>
    </button>
  );
}

// ---- long error text (list view) --------------------------------
// A relay / payout error can be a whole paragraph. Show two lines with an
// ellipsis and the full text on hover; the row's detail view carries it in
// full.
export function ErrText({ value }: { value?: string | null }) {
  if (!value) return <span className="text-muted">—</span>;
  return <div title={value} className="line-clamp-2 max-w-[20rem] text-xs text-danger">{value}</div>;
}

// ---- shared list states --------------------------------------------
export function NoPermission({ what = "this" }: { what?: string }) {
  return (
    <div className="rounded-lg border border-line bg-card p-6 text-center text-sm text-muted">
      You do not have permission to view {what}.
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-card p-8 text-center">
      <p className="font-semibold text-brand-ink">{title}</p>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function ErrorRow({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-danger/30 bg-danger-tint/40 p-4 text-sm">
      <p className="font-semibold text-danger">Could not load this.</p>
      <p className="mt-1 break-all text-muted">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="mt-2 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white">
          Try again
        </button>
      )}
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return <p className="p-4 text-sm text-muted">{label}</p>;
}

export type { Tone, ReactNode };
