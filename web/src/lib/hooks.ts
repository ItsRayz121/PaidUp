"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getToken, getStoredUser, storeUser, fetchMe, onSessionEnded, type SessionUser } from "./api";
import { permissionsKnown } from "./permissions";

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
    // If the token is proven dead WHILE this screen is mounted (api.ts confirms
    // it against /auth/me), go to /login right away — don't wait for the next
    // navigation to notice, which is what made a browser Back read as a logout.
    return onSessionEnded(() => router.replace("/login"));
  }, [router]);

  return { user, ready };
}

// The staff panel's session. Same as useRequireAuth, plus one thing: it
// re-reads /auth/me when the stored copy predates the permission list, and
// writes the fresh copy back.
//
// WHY THIS EXISTS. The stored user is written once, at sign-in, and never
// refreshed. On the deploy that introduced permissions, every staff member
// already signed in was holding a session with no `permissions` field — and the
// panel now decides what to draw from exactly that field. Without this, they
// would each have opened an empty panel until they happened to sign out and
// back in. It also picks up a role CHANGE without a re-login, which is the same
// problem a day later.
//
// `ready` stays false until the permissions are actually known, so the panel
// shows its loading state rather than a wrong screen for one frame.
export function useStaffSession(): { user: SessionUser | null; ready: boolean } {
  const { user: stored, ready: storedReady } = useRequireAuth();
  const [fresh, setFresh] = useState<SessionUser | null>(null);
  const [refreshed, setRefreshed] = useState(false);

  useEffect(() => {
    if (!storedReady) return;
    let live = true;
    fetchMe()
      .then(({ user }) => {
        if (!live) return;
        storeUser(user);
        setFresh(user);
      })
      // A failed refresh is not fatal: fall back to whatever was stored. The
      // API is the real gate either way, so the worst case is a section that
      // renders and then 403s — far better than locking staff out of the panel
      // because one request timed out.
      .catch(() => {})
      .finally(() => { if (live) setRefreshed(true); });
    return () => { live = false; };
  }, [storedReady]);

  const user = fresh ?? stored;
  return { user, ready: storedReady && (refreshed || permissionsKnown(user)) };
}

// Small data-fetching hook: loading / error / data + reload.
//
// `enabled` defers the request until it is true, for data that only some users
// need. Hooks cannot be called conditionally, so the gate has to live in here
// rather than at the call site. While it is false the hook reports
// `loading: false` and `data: null` — never a spinner that resolves to nothing.
//
// It exists for /wallet's USDT row: top-ups ship OFF, so that request was a
// round trip on the second-most-visited screen to render 0.00 for ~100% of
// users. The gate flips it on with the feature.
// `pollMs` is optional and additive: omit it and this hook behaves exactly as
// before. When set, it re-runs `fn` on that interval — but ONLY while the tab
// is actually visible. This app has twice shipped a real billing incident
// (see CLAUDE.md's Alchemy entries) from something polling unattended in the
// background forever; a staff queue left open overnight in a background tab
// must not repeat that shape against our own API.
export function useApi<T>(fn: () => Promise<T>, deps: unknown[] = [], enabled = true, pollMs?: number): {
  data: T | null; error: string | null; loading: boolean; reload: () => void; updatedAt: number | null;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // fn identity changes each render; we intentionally key off caller-provided
  // deps, exactly like useEffect's second argument. That opts this hook out of
  // the compiler's memoization analysis (use-memo needs a literal array).
  const run = useCallback(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    fn()
      .then((d) => { setData(d); setUpdatedAt(Date.now()); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
  }, [...deps, enabled]);

  useEffect(() => { run(); }, [run]);

  // A background refetch never shows the loading state — that would blank a
  // queue someone is actively reading every time the interval ticks. It's a
  // silent reload; the row count and "updated Xs ago" changing is the signal.
  useEffect(() => {
    if (!pollMs || !enabled) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") {
        fn().then((d) => { setData(d); setUpdatedAt(Date.now()); }).catch(() => {});
      }
    }, pollMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollMs, enabled, ...deps]);

  return { data, error, loading, reload: run, updatedAt };
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
