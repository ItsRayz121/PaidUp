import Link from "next/link";
import type { ReactNode } from "react";
import { CheckIcon, ClockIcon, XIcon, StarIcon, InfoIcon } from "./icons";

// Matches the backend's ledger row status (see @/lib/api LedgerEntry).
type LedgerStatus = "earned" | "paid" | "pending" | "rejected";

// ---- Button ---------------------------------------------------------------
// One action per button, named by the action (DESIGN_BRIEF simple-English).
type ButtonProps = {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  variant?: "primary" | "accent" | "ghost";
  size?: "lg" | "md";
  full?: boolean;
  type?: "button" | "submit";
  disabled?: boolean;
};

const variants: Record<string, string> = {
  primary: "bg-brand text-white hover:brightness-110 active:brightness-95",
  accent: "bg-accent text-brand-ink hover:brightness-105 active:brightness-95",
  ghost: "bg-transparent text-brand border border-line hover:bg-brand-tint",
};

export function Button({
  children, href, onClick, variant = "primary", size = "lg",
  full = true, type = "button", disabled,
}: ButtonProps) {
  const cls = [
    "inline-flex items-center justify-center gap-2 rounded-xl font-semibold",
    "transition disabled:opacity-50 disabled:pointer-events-none",
    size === "lg" ? "min-h-[52px] px-5 text-base" : "min-h-[44px] px-4 text-sm",
    full ? "w-full" : "",
    variants[variant],
  ].join(" ");

  if (href) return <Link href={href} className={cls}>{children}</Link>;
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cls}>
      {children}
    </button>
  );
}

// ---- Card -----------------------------------------------------------------
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl bg-card border border-line shadow-[0_1px_2px_rgba(8,47,54,0.04)] ${className}`}>
      {children}
    </div>
  );
}

// ---- Points pill ----------------------------------------------------------
export function PointsPill({ points }: { points: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent-tint px-2.5 py-1 text-accent-ink font-semibold text-sm whitespace-nowrap">
      <StarIcon size={15} />
      <span className="num">+{points}</span>
      <span className="sr-only">points</span>
      <span aria-hidden>pts</span>
    </span>
  );
}

// ---- Status badge — icon + WORD, never color alone -----------------------
const statusMap: Record<LedgerStatus, { label: string; Icon: typeof CheckIcon; cls: string }> = {
  earned: { label: "Added", Icon: CheckIcon, cls: "bg-success-tint text-success" },
  paid: { label: "Paid", Icon: CheckIcon, cls: "bg-success-tint text-success" },
  pending: { label: "Waiting", Icon: ClockIcon, cls: "bg-pending-tint text-pending" },
  rejected: { label: "Not added", Icon: XIcon, cls: "bg-danger-tint text-danger" },
};

export function StatusBadge({ status }: { status: LedgerStatus }) {
  const { label, Icon, cls } = statusMap[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${cls}`}>
      <Icon size={14} />
      {label}
    </span>
  );
}

// ---- Sponsored disclosure (guardrail #3) ---------------------------------
export function SponsoredTag({ network }: { network: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-brand-tint px-2 py-0.5 text-[11px] font-semibold text-brand uppercase tracking-wide">
      <InfoIcon size={12} />
      Sponsored · {network}
    </span>
  );
}

// ---- Section title --------------------------------------------------------
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between px-1 mb-2">
      <h2 className="text-base font-bold text-brand-ink">{children}</h2>
      {action}
    </div>
  );
}
