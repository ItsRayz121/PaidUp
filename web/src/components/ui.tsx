import Link from "next/link";
import type { ReactNode } from "react";
import { CheckIcon, ClockIcon, XIcon, StarIcon, InfoIcon } from "./icons";
import { formatPointsAsRozi } from "@/lib/format";

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

// ---- Reward pill ----------------------------------------------------------
// Takes POINTS (what the API sends) and shows ROZI (what the user reads). The
// prop keeps its name because points is genuinely what the number is; the
// conversion happens here, at the last possible moment, exactly once.
//
// It used to render USDT, and this pill is why that had to stop: a 5-point task
// is $0.005, so the reward on a task card read "0.005 USDT" — the smallest,
// least motivating number in the app, sitting on the exact element that has to
// persuade someone to do the work. The same reward is 0.05 ROZI, in the one
// currency the rest of the app now speaks.
export function PointsPill({ points }: { points: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent-tint px-2.5 py-1 text-accent-ink font-semibold text-sm whitespace-nowrap">
      <StarIcon size={15} />
      <span className="num">+{formatPointsAsRozi(points)}</span>
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

// ---- Tile — a compact entry point ----------------------------------------
//
// One icon, one word, in a third of a row. It replaces the full-width
// "icon + title + sentence + chevron" card that this app had started using for
// EVERY secondary link — /mine had six of them stacked vertically, each ~76px
// tall, so the six links a user rarely taps occupied more of the screen than
// the mining dial they came for.
//
// The rule that keeps it honest: a Tile is for a DESTINATION, never for an
// action with a consequence. Anything that spends, sends or withdraws keeps a
// full-size Button with words on it — a one-word tile is too easy to hit by
// accident, and "Send" costing someone ROZI on a mis-tap is not a trade worth
// making for tidiness.
export function Tile({
  href, Icon, label, tone = "brand", disabled = false, title,
}: {
  href: string;
  Icon: (p: { size?: number; className?: string }) => ReactNode;
  label: string;
  tone?: "brand" | "accent";
  disabled?: boolean;
  title?: string;
}) {
  const inner = (
    <>
      <span
        className={`grid h-11 w-11 place-items-center rounded-xl ${
          tone === "accent" ? "bg-accent text-brand-ink" : "bg-brand-tint text-brand"
        }`}
      >
        <Icon size={22} />
      </span>
      {/* leading-tight + two-line room: "Road map" and "Add USDT" must not
          reflow the grid or be cut off on a 360px screen. */}
      <span className="text-center text-xs font-semibold leading-tight text-brand-ink">
        {label}
      </span>
    </>
  );

  const cls =
    "flex min-h-[92px] flex-col items-center justify-center gap-2 rounded-2xl border border-line bg-card p-2 transition active:brightness-95";

  if (disabled) {
    return (
      <span className={`${cls} opacity-50`} title={title} aria-disabled>
        {inner}
      </span>
    );
  }
  return <Link href={href} className={cls} title={title}>{inner}</Link>;
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
