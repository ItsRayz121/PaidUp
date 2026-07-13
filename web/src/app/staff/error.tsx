"use client";

// Last-resort boundary for /staff. Individual panels are wrapped in <Panel>, so
// reaching this means something outside them broke. Without this file Next.js
// falls back to its own blank "This page couldn't load" screen, which tells
// staff nothing and offers no way back.
//
// NOTE: this Next version passes `unstable_retry`, not `reset` (see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md).
import Link from "next/link";
import { useEffect } from "react";

export default function StaffError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[staff] page crashed:", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-md p-8 text-center">
      <h1 className="text-xl font-bold text-brand-ink">The staff page hit an error</h1>
      <p className="mt-2 text-sm text-muted">
        Nothing was lost — no withdrawal was approved, rejected, or paid by this error.
      </p>
      <p className="mt-2 break-all font-mono text-xs text-danger">{error.message}</p>
      <div className="mt-4 flex justify-center gap-2">
        <button
          onClick={() => unstable_retry()}
          className="rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white"
        >
          Try again
        </button>
        <Link href="/" className="rounded-md bg-brand-tint px-3 py-2 text-sm font-semibold text-brand">
          Back to the app
        </Link>
      </div>
    </div>
  );
}
