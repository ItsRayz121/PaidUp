"use client";

import { useRouter } from "next/navigation";
import { clearSession } from "@/lib/api";
import { Button } from "./ui";
import { InfoIcon } from "./icons";

// Skeleton block shown while data loads (no blank screens — DESIGN_BRIEF).
export function Loading({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-20 animate-pulse rounded-2xl bg-brand-tint/60" />
      ))}
    </div>
  );
}

// Error state always says what to do next.
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-6 text-center">
      <p className="flex items-center justify-center gap-2 font-semibold text-brand-ink">
        <InfoIcon size={18} className="text-danger" /> Something went wrong
      </p>
      <p className="mt-1 text-sm text-muted">{message}</p>
      {onRetry && (
        <div className="mt-4">
          <Button variant="ghost" size="md" full={false} onClick={onRetry}>Try again</Button>
        </div>
      )}
    </div>
  );
}

// Empty state says WHY and gives a next action.
export function EmptyState({ title, body, action }: {
  title: string; body: string; action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-line bg-card p-6 text-center">
      <p className="font-semibold text-brand-ink">{title}</p>
      <p className="mt-1 text-sm text-muted">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      onClick={() => { clearSession(); router.replace("/login"); }}
      className="text-sm font-semibold text-brand"
    >
      Sign out
    </button>
  );
}
