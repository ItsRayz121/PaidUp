// Client-side API wrapper. All calls attach the saved token. On 401 it clears
// the session so the app can send the user back to /login.
// Base URL: set NEXT_PUBLIC_API_URL for deployed frontend (the Railway URL);
// defaults to the local backend for dev.

// trim() + /\/+$/ because a stray space, newline, or second slash pasted into
// the host's env var survives into every request path and 404s the whole API.
export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/+$/, "") || "http://localhost:4000";

const TOKEN_KEY = "paidup_token";
const USER_KEY = "paidup_user";

export type SessionUser = {
  id: string; email: string; country: string;
  referralCode: string; status: string; role: "agent" | "manager" | "admin" | null;
};

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}
export function getStoredUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as SessionUser) : null;
}
export function setSession(token: string, user: SessionUser) {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}
export function clearSession() {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });

  let body: unknown = null;
  try { body = await res.json(); } catch { /* empty body */ }

  if (!res.ok) {
    if (res.status === 401) clearSession();
    const msg = (body as { error?: string })?.error || "Something went wrong. Please try again.";
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

// ---- Types (match the backend responses) ---------------------------------
export type Task = {
  id: string; type: "install" | "survey" | "video"; title: string;
  points: number; network: string; advertiser: string; minutes: number; requirement?: string;
};
export type LedgerEntry = {
  id: string; label: string; points: number;
  status: "earned" | "pending" | "paid" | "rejected"; kind: string; at: string;
};
export type Withdrawal = {
  id: string; amount: number; payoutRail: string;
  status: string; at: string; reviewNote?: string; paidAt?: string;
};

// ---- Auth -----------------------------------------------------------------
export const requestCode = (email: string) =>
  apiFetch<{ ok: true }>("/auth/email/request", { method: "POST", body: JSON.stringify({ email }) });

export const verifyCode = (email: string, code: string, ref?: string) =>
  apiFetch<{ token: string; user: SessionUser }>("/auth/email/verify", {
    method: "POST", body: JSON.stringify({ email, code, ref }),
  });

export const fetchMe = () => apiFetch<{ user: SessionUser }>("/auth/me");

// ---- Earner ---------------------------------------------------------------
export const fetchBalance = () =>
  apiFetch<{ points: number; minWithdrawPoints: number }>("/wallet/balance");
export const fetchLedger = () => apiFetch<{ entries: LedgerEntry[] }>("/wallet/ledger");
export const fetchTasks = () => apiFetch<{ tasks: Task[] }>("/tasks");
export const fetchReferrals = () =>
  apiFetch<{ code: string; joined: number; earnedPoints: number }>("/referrals/me");
export const fetchWithdrawals = () => apiFetch<{ requests: Withdrawal[] }>("/withdrawals");
export const createWithdrawal = (amountPoints: number, payoutRail: string) =>
  apiFetch<{ request: Withdrawal }>("/withdrawals", {
    method: "POST", body: JSON.stringify({ amountPoints, payoutRail }),
  });

// ---- Staff ----------------------------------------------------------------
export type StaffWithdrawal = {
  id: string; userId: string; userEmail: string; amount: number;
  payoutRail: string; status: string; at: string; withinAgentLimit: boolean;
};
export const fetchStaffQueue = (status = "pending") =>
  apiFetch<{ requests: StaffWithdrawal[] }>(`/staff/withdrawals?status=${encodeURIComponent(status)}`);
export const decideWithdrawal = (id: string, action: "approve" | "reject" | "pay", note?: string) =>
  apiFetch<{ ok: true; status: string }>(`/staff/withdrawals/${id}/decision`, {
    method: "POST", body: JSON.stringify({ action, note }),
  });
export const fetchStaffUser = (id: string) =>
  apiFetch<{ user: Record<string, unknown>; ledger: unknown[]; fraudFlags: unknown[] }>(`/staff/users/${id}`);
export const fetchFraud = () => apiFetch<{ flags: Record<string, unknown>[] }>("/staff/fraud");
