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

  // fn identity changes each render; we intentionally key off caller-provided deps.
  const run = useCallback(() => {
    setLoading(true);
    setError(null);
    fn()
      .then((d) => setData(d))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { run(); }, [run]);

  return { data, error, loading, reload: run };
}
