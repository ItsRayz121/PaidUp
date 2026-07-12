// Client-side API wrapper. All calls attach the saved token. On 401 it clears
// the session so the app can send the user back to /login.
// Base URL: set NEXT_PUBLIC_API_URL for deployed frontend (the Railway URL);
// defaults to the local backend for dev.

// trim() + /\/+$/ because a stray space, newline, or second slash pasted into
// the host's env var survives into every request path and 404s the whole API.
export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/+$/, "") || "http://localhost:4000";

import { getDeviceId } from "./device";

const TOKEN_KEY = "rozipay_token";
const USER_KEY = "rozipay_user";

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
  const deviceId = getDeviceId();
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(deviceId ? { "x-device-id": deviceId } : {}),
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
  id: string; amount: number; chain: string; address?: string;
  status: string; at: string; reviewNote?: string; paidAt?: string; txHash?: string; usdtAmount?: string; feePoints?: number;
};

// ---- Auth -----------------------------------------------------------------
type AuthOk = { token: string; user: SessionUser };

// Create an account. Emails a one-time code to verify the address.
export const register = (email: string, password: string, ref?: string) =>
  apiFetch<{ ok: true }>("/auth/register", {
    method: "POST", body: JSON.stringify({ email, password, ref }),
  });

// Confirm the signup code -> signed in.
export const verifyEmail = (email: string, code: string) =>
  apiFetch<AuthOk>("/auth/verify-email", {
    method: "POST", body: JSON.stringify({ email, code }),
  });

// Log in with email + password (no code once verified).
export const login = (email: string, password: string) =>
  apiFetch<AuthOk>("/auth/login", {
    method: "POST", body: JSON.stringify({ email, password }),
  });

// Ask for a password-reset code.
export const forgotPassword = (email: string) =>
  apiFetch<{ ok: true }>("/auth/forgot", { method: "POST", body: JSON.stringify({ email }) });

// Set a new password with the reset code -> signed in.
export const resetPassword = (email: string, code: string, password: string) =>
  apiFetch<AuthOk>("/auth/reset", {
    method: "POST", body: JSON.stringify({ email, code, password }),
  });

// Telegram login fallback: post the signed widget payload; backend re-verifies
// the signature and finds-or-creates the account. `ref` carries a referral code.
export const loginWithTelegram = (payload: Record<string, unknown>) =>
  apiFetch<AuthOk>("/auth/telegram", {
    method: "POST", body: JSON.stringify(payload),
  });

export const fetchMe = () => apiFetch<{ user: SessionUser }>("/auth/me");

// ---- Earner ---------------------------------------------------------------
export const fetchBalance = () =>
  apiFetch<{ points: number; minWithdrawPoints: number; withdrawalFeePoints: number }>("/wallet/balance");
export const fetchLedger = () => apiFetch<{ entries: LedgerEntry[] }>("/wallet/ledger");
export const fetchTasks = () => apiFetch<{ tasks: Task[] }>("/tasks");
export const fetchReferrals = () =>
  apiFetch<{ code: string; joined: number; earnedPoints: number }>("/referrals/me");
export const fetchWithdrawals = () => apiFetch<{ requests: Withdrawal[] }>("/withdrawals");
export const createWithdrawal = (amountPoints: number, chain: string, address: string) =>
  apiFetch<{ request: Withdrawal }>("/withdrawals", {
    method: "POST", body: JSON.stringify({ amountPoints, chain, address }),
  });

// Saved payout addresses (set once per chain, reused). `addresses` is keyed by
// chain id -> the saved wallet address.
export const fetchPayoutAddresses = () =>
  apiFetch<{ addresses: Record<string, string> }>("/withdrawals/addresses");
export const savePayoutAddress = (chain: string, address: string) =>
  apiFetch<{ ok: true; chain: string; address: string }>("/withdrawals/addresses", {
    method: "PUT", body: JSON.stringify({ chain, address }),
  });

// ---- Surveys (CPX Research) ----------------------------------------------
// The backend signs the survey-wall URL for this user (the secure hash is
// derived from a secret that must never reach the browser).
export const fetchSurveyWall = () =>
  apiFetch<{ enabled: boolean; url: string | null }>("/surveys/cpx");

// ---- Leaderboard ----------------------------------------------------------
export type LeaderRow = { rank: number; name: string; points: number; invites?: number; isMe: boolean };
export const fetchLeaderboard = () =>
  apiFetch<{ topEarners: LeaderRow[]; topReferrers: LeaderRow[] }>("/leaderboard");

// ---- Staff ----------------------------------------------------------------
export type StaffWithdrawal = {
  id: string; userId: string; userEmail: string; amount: number;
  chain: string; address: string | null; status: string; at: string; withinAgentLimit: boolean;
};
export const fetchStaffQueue = (status = "pending") =>
  apiFetch<{ requests: StaffWithdrawal[] }>(`/staff/withdrawals?status=${encodeURIComponent(status)}`);
export const decideWithdrawal = (id: string, action: "approve" | "reject" | "pay", note?: string, txHash?: string) =>
  apiFetch<{ ok: true; status: string; txHash?: string; usdt?: string }>(`/staff/withdrawals/${id}/decision`, {
    method: "POST", body: JSON.stringify({ action, note, txHash }),
  });
export const fetchStaffUser = (id: string) =>
  apiFetch<{ user: Record<string, unknown>; ledger: unknown[]; fraudFlags: unknown[] }>(`/staff/users/${id}`);
export const fetchFraud = () => apiFetch<{ flags: Record<string, unknown>[] }>("/staff/fraud");

// ---- Super-admin ----------------------------------------------------------
export type AdminUserRow = {
  id: string; email: string; country: string; status: string; created_at: string; balance: number;
};
export const searchUsers = (q = "") =>
  apiFetch<{ users: AdminUserRow[] }>(`/staff/users?q=${encodeURIComponent(q)}`);
export const setUserStatus = (id: string, status: "active" | "suspended", reason: string) =>
  apiFetch<{ ok: true; status: string }>(`/staff/users/${id}/status`, {
    method: "POST", body: JSON.stringify({ status, reason }),
  });
// Mints/burns points. `points` is signed: positive credits, negative debits.
export const adjustUserPoints = (id: string, points: number, reason: string) =>
  apiFetch<{ ok: true; before: number; after: number }>(`/staff/users/${id}/adjust`, {
    method: "POST", body: JSON.stringify({ points, reason }),
  });

export type StaffMember = { userId: string; email: string; role: string; at: string };
export const fetchStaffMembers = () => apiFetch<{ staff: StaffMember[] }>("/staff/staff");
export const setStaffRole = (userId: string, role: "agent" | "manager" | "admin" | "none") =>
  apiFetch<{ ok: true; role: string }>(`/staff/staff/${userId}`, {
    method: "PUT", body: JSON.stringify({ role }),
  });

export type MoneyView = {
  points: {
    credited: number; debited: number; adjustments: number;
    outstanding: number; paidPoints: number; pendingPoints: number; feePoints: number;
  };
  usdt: { outstanding: number; paid: number; pending: number };
  recentAudit: Record<string, unknown>[];
};
export const fetchMoney = () => apiFetch<MoneyView>("/staff/money");

// CSV export can't be a plain <a href>: the API authenticates with a Bearer
// header, which a browser navigation won't send. Fetch it as a blob instead.
export async function downloadExport(what: "ledger" | "withdrawals" | "audit"): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API_BASE}/staff/export/${what}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiError("Export failed.", res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${what}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
export const resolveFraud = (id: string, note?: string) =>
  apiFetch<{ ok: true }>(`/staff/fraud/${id}/resolve`, { method: "POST", body: JSON.stringify({ note }) });

// ---- Support tickets (earner side) ---------------------------------------
export type TicketMessage = { author_role: "user" | "staff"; body: string; created_at: string };
export type MyTicket = {
  id: string; subject: string; status: "open" | "answered" | "closed";
  at: string; updatedAt: string; messages: TicketMessage[];
};
export const fetchMyTickets = () => apiFetch<{ tickets: MyTicket[] }>("/support/tickets");
export const createTicket = (subject: string, message: string) =>
  apiFetch<{ ticket: { id: string } }>("/support/tickets", {
    method: "POST", body: JSON.stringify({ subject, message }),
  });
export const replyToMyTicket = (id: string, message: string) =>
  apiFetch<{ ok: true }>(`/support/tickets/${id}/messages`, {
    method: "POST", body: JSON.stringify({ message }),
  });

// ---- Support tickets (staff side) ----------------------------------------
export type StaffTicket = {
  id: string; userId: string; userEmail: string; subject: string;
  status: string; messageCount: number; at: string; updatedAt: string;
};
export const fetchStaffTickets = (status = "open") =>
  apiFetch<{ tickets: StaffTicket[] }>(`/staff/tickets?status=${encodeURIComponent(status)}`);
export const fetchStaffTicket = (id: string) =>
  apiFetch<{ ticket: Record<string, unknown>; messages: TicketMessage[] }>(`/staff/tickets/${id}`);
export const replyStaffTicket = (id: string, message: string, close = false) =>
  apiFetch<{ ok: true }>(`/staff/tickets/${id}/reply`, {
    method: "POST", body: JSON.stringify({ message, close }),
  });

// ---- Admin: ad-network config --------------------------------------------
export type NetworkConfig = {
  id: string; name: string; type: "offerwall" | "rewarded_video"; status: "active" | "disabled";
  commissionSplitPct: number; referralBonusPct: number; referralBonusPctL2: number;
  referralFirstTaskBonus: number; referralBonusDays: number;
  taskCount: number; creditedCount: number;
  updatedAt: string | null;
};
export const fetchNetworks = () => apiFetch<{ networks: NetworkConfig[] }>("/staff/networks");
export const updateNetwork = (
  id: string,
  patch: {
    status?: "active" | "disabled"; commissionSplitPct?: number; referralBonusPct?: number;
    referralBonusPctL2?: number; referralFirstTaskBonus?: number; referralBonusDays?: number;
  },
) => apiFetch<{ ok: true }>(`/staff/networks/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

// ---- Manager: KPI dashboard ----------------------------------------------
export type Kpis = {
  users: { total: number; new7d: number };
  withdrawals: { pendingCount: number; pendingPoints: number; paidCount7d: number; paidPoints7d: number; paidPointsAll: number };
  earning: { taskPointsAll: number; referralPointsAll: number; completionsToday: number };
  risk: { openFraud: number; openTickets: number };
  series: { day: string; completions: number; points: number }[];
};
export const fetchKpis = () => apiFetch<Kpis>("/staff/kpis");

// ---- Admin: global settings (withdrawal fee) -----------------------------
export const fetchSettings = () => apiFetch<{ withdrawalFeePoints: number }>("/staff/settings");
export const updateSettings = (patch: { withdrawalFeePoints: number }) =>
  apiFetch<{ ok: true }>("/staff/settings", { method: "PATCH", body: JSON.stringify(patch) });
