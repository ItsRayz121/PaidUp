"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getToken, getStoredUser, type SessionUser } from "./api";

// Redirect to /login if there's no session. Returns the stored user once known.
export function useRequireAuth(): { user: SessionUser | null; ready: boolean } {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    // Syncing FROM localStorage (an external system) after mount. It can't be
    // state's initial value: the page is statically prerendered, and reading
    // storage during the first render would make hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUser(getStoredUser());
    setReady(true);
  }, [router]);

  return { user, ready };
}

// Small data-fetching hook: loading / error / data + reload.
export function useApi<T>(fn: () => Promise<T>, deps: unknown[] = []): {
  data: T | null; error: string | null; loading: boolean; reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // fn identity changes each render; we intentionally key off caller-provided
  // deps, exactly like useEffect's second argument. That opts this hook out of
  // the compiler's memoization analysis (use-memo needs a literal array).
  const run = useCallback(() => {
    setLoading(true);
    setError(null);
    fn()
      .then((d) => setData(d))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
  }, deps);

  useEffect(() => { run(); }, [run]);

  return { data, error, loading, reload: run };
}

// Time left until an ISO timestamp, in words, ticking once a second. Null once
// it has passed — callers use that as "the session is over" and refetch.
//
// Lives here rather than in /mine because the home screen leads with mining now
// and needs the same clock; two copies of a countdown drift the moment one of
// them is edited.
export function useCountdown(until: string | null | undefined): string | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (!until) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [until]);

  if (!until) return null;
  // A countdown exists to read the clock: the interval above re-renders us once
  // a second precisely so this render-time Date.now() is fresh.
  // eslint-disable-next-line react-hooks/purity
  const ms = Date.parse(until) - Date.now();
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}
