"use client";

// Last-resort boundary for the earner app (staff has its own in staff/error.tsx).
// Without this file Next.js shows its own blank "This page couldn't load"
// screen, which tells an earner nothing and offers no way back. Strings are
// inline, not from the copy deck: the I18nProvider lives inside the tree this
// boundary replaces, so it may not exist when this renders.
//
// NOTE: this Next version passes `unstable_retry`, not `reset` (see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md).
import Link from "next/link";
import { useEffect } from "react";

export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[app] page crashed:", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-md p-8 pt-16 text-center">
      <h1 className="text-xl font-bold text-brand-ink">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted">
        Your points are safe. Please try again — if it keeps happening, tell us in Help.
      </p>
      <div className="mt-5 flex justify-center gap-2">
        <button
          onClick={() => unstable_retry()}
          className="rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white"
        >
          Try again
        </button>
        <Link href="/" className="rounded-xl bg-brand-tint px-4 py-2.5 text-sm font-semibold text-brand">
          Back to home
        </Link>
      </div>
    </div>
  );
}
