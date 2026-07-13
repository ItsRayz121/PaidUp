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
  // The full error payload. Some routes send structured fields alongside the
  // message — the withdrawal gate sends `kycRequired`, so the UI can offer the
  // "Verify your ID" button instead of a dead end. Reading a flag is honest;
  // string-matching the message would break the moment someone reworded it.
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const deviceId = getDeviceId();

  // Only declare a content type when there IS content.
  //
  // We used to send `content-type: application/json` on every request, body or
  // not. Fastify believes the header, goes looking for JSON, finds an empty body,
  // and rejects the request before it ever reaches the route — with a payload
  // whose `error` field is literally "Bad Request". That is the message the user
  // saw when they tapped "Start mining": the handler was never called.
  //
  // It only bit the mining routes because every older POST happens to send a body.
  // A POST with no entity body should not advertise a content type at all.
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      ...(opts.body !== undefined && opts.body !== null
        ? { "content-type": "application/json" }
        : {}),
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
    throw new ApiError(msg, res.status, (body as Record<string, unknown>) ?? {});
  }
  return body as T;
}

// ---- Types (match the backend responses) ---------------------------------
export type Task = {
  id: string; type: "install" | "survey" | "video" | "custom"; title: string;
  points: number; network: string; advertiser: string; minutes: number; requirement?: string;
  // Present only on our OWN tasks (source === "custom").
  source?: "network" | "custom";
  verifyMode?: "proof" | "postback";
  instructions?: string;
  proofLabel?: string;
  actionUrl?: string;
  // The current user's standing on a 'proof' task, if they've submitted.
  proofStatus?: "pending" | "approved" | "rejected";
  proofNote?: string;
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
export const submitTaskProof = (taskId: string, proof: string) =>
  apiFetch<{ ok: boolean; status?: string; error?: string }>(`/tasks/${taskId}/proof`, {
    method: "POST", body: JSON.stringify({ proof }),
  });
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
  // Decimal STRINGS, not numbers: the server floors to USDT's 6-dp smallest unit
  // (payout.ts `pointsToUsdt`) so a payout can never over-pay from rounding.
  // Parse before doing arithmetic or formatting — a string has no .toFixed.
  usdt: { outstanding: string; paid: string; pending: string };
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

// ---- Admin: our own custom tasks -----------------------------------------
export type CustomTask = {
  id: string; title: string; points: number; type: string;
  verify_mode: "proof" | "postback"; instructions: string | null; proof_label: string | null;
  action_url: string | null; minutes: number; country: string; status: string;
  created_at: string; has_secret: boolean; credited_count: number; pending_proofs: number;
};
export type CustomTaskInput = {
  title: string; points: number; verifyMode: "proof" | "postback";
  instructions?: string; proofLabel?: string; actionUrl?: string;
  minutes?: number; country?: string; status?: "active" | "disabled";
};
export const fetchCustomTasks = () => apiFetch<{ tasks: CustomTask[] }>("/staff/tasks");
export const createCustomTask = (input: CustomTaskInput) =>
  apiFetch<{ ok: boolean; id?: string }>("/staff/tasks", { method: "POST", body: JSON.stringify(input) });
export const updateCustomTask = (id: string, patch: Partial<CustomTaskInput>) =>
  apiFetch<{ ok: boolean }>(`/staff/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const fetchTaskPostback = (id: string) =>
  apiFetch<{ ok: boolean; error?: string; taskId?: string; secret?: string; path?: string; signature?: string; params?: string[] }>(
    `/staff/tasks/${id}/postback`);

export type TaskProof = {
  id: string; task_id: string; user_id: string; proof_text: string; status: string;
  review_note: string | null; created_at: string; user_email: string;
  task_title: string; task_points: number; proof_label: string | null;
};
export const fetchTaskProofs = (status = "pending") =>
  apiFetch<{ proofs: TaskProof[] }>(`/staff/task-proofs?status=${status}`);
export const decideTaskProof = (id: string, action: "approve" | "reject", note?: string) =>
  apiFetch<{ ok: boolean; error?: string; credited?: number; status?: string }>(
    `/staff/task-proofs/${id}/decision`, { method: "POST", body: JSON.stringify({ action, note }) });

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

// ---- ROZI mining (docs/MINING_SPEC.md) ------------------------------------
// ROZI is the MINED currency. It is a SEPARATE ledger from Points, it is not
// backed by revenue, and it is not withdrawable. Any UI built on these types
// must say so plainly — see the banner on /mine and in the wallet.
export type MiningBoost = { kind: "task" | "ad" | "points"; pct: number; expiresAt: string };
// EVERY ROZI amount below is MICRO-ROZI (an integer count of millionths), and the
// `...Micro` suffix is the contract. Run it through formatRozi() from lib/format
// before it reaches a screen — printed raw, a balance of 3.33 ROZI reads "3333333".
export type MiningState = {
  roziMicro: number;
  session: { active: boolean; expiresAt: string | null; sessionHours: number };
  hashrate: number;
  breakdown: {
    base: number; rigs: number; streakDays: number;
    streakMultiplierPct: number; boostPct: number; referral: number;
  };
  sharesToday: number;
  estimatedRoziMicro: number;
  estimateIsLive: boolean;
  streak: { current: number; best: number };
  boosts: MiningBoost[];
  ads: {
    enabled: boolean; watchedToday: number; dailyCap: number;
    boostPct: number; boostHours: number;
    // Show a video before mining starts. Soft: the server still starts the
    // session if no ad was watched.
    gateOnStart: boolean;
    provider: string;
    monetagZoneId: string;
  };
  convertible: boolean;
  transfersEnabled: boolean;
  deviceBlocked: boolean;
};
export const fetchMiningState = () => apiFetch<MiningState>("/mining/state");

// `adNonce` is OPTIONAL, and that is the whole design of the ad gate. If the user
// watched the video, we hand back the nonce and they get the speed boost. If
// Monetag had nothing to show — routine here at night — we start mining anyway.
// An ad network outage must never stop someone mining or break their streak.
export const startMining = (adNonce?: string) =>
  apiFetch<{ ok: true; expiresAt: string; boost: { pct: number; hours: number } | null }>(
    "/mining/start", { method: "POST", body: JSON.stringify({ adNonce }) });

export type Rig = {
  id: string; name: string; icon: string; level: number; maxLevel: number;
  power: number; nextPower: number | null; nextCostMicro: number | null;
};
export const fetchRigs = () => apiFetch<{ roziMicro: number; rigs: Rig[] }>("/mining/rigs");
export const upgradeRig = (id: string) =>
  apiFetch<{ ok: true; level: number; spentMicro: number; roziMicro: number }>(
    `/mining/rigs/${id}/upgrade`, { method: "POST" });

export type RoziEntry = {
  id: string; amountMicro: number; direction: "credit" | "debit";
  source_type: string; note: string | null; created_at: string;
};
export const fetchRoziHistory = () => apiFetch<{ entries: RoziEntry[] }>("/mining/history");

// Ad-watch: the reward is a hashrate BOOST, never currency. `issue` hands back a
// nonce; `complete` redeems it once, after a minimum watch time.
export const issueAd = () =>
  apiFetch<{ nonce: string; minSeconds: number }>("/mining/ad/issue", { method: "POST" });
export const completeAd = (nonce: string) =>
  apiFetch<{ ok: true; boostPct: number; hours: number }>(
    "/mining/ad/complete", { method: "POST", body: JSON.stringify({ nonce }) });

// ---- Verify your ID (KYC) ---------------------------------------------------
// Manual review by staff. The photos go UP and never come back down: not even to
// the user who sent them. There is no endpoint that returns them to a browser
// outside the admin review screen.
export type KycState = {
  status: "none" | "pending" | "approved" | "rejected";
  rejectReason: string | null;
  submittedAt: string | null;
};
export const fetchKyc = () => apiFetch<KycState>("/kyc");

// The three images are `data:image/jpeg;base64,...` strings. The server checks
// their MAGIC BYTES, not the type they claim, then encrypts them before storage.
export const submitKyc = (selfie: string, idFront: string, idBack: string) =>
  apiFetch<{ ok: true; status: "pending" }>("/kyc", {
    method: "POST", body: JSON.stringify({ selfie, idFront, idBack }),
  });

// ---- Admin: the ID review queue --------------------------------------------
export type KycSubmission = {
  id: string; user_id: string; email: string; country: string;
  status: string; created_at: string; reviewed_at: string | null;
};
export const fetchKycQueue = (status = "pending") =>
  apiFetch<{ submissions: KycSubmission[] }>(`/staff/kyc?status=${status}`);
export const decideKyc = (id: string, decision: "approved" | "rejected", reason?: string) =>
  apiFetch<{ ok: true; status: string }>(`/staff/kyc/${id}/decide`, {
    method: "POST", body: JSON.stringify({ decision, reason }),
  });

export type Booster = { id: string; name: string; price_points: number; multiplier_pct: number; hours: number };
export const fetchBoosters = () => apiFetch<{ points: number; boosters: Booster[] }>("/mining/boosters");
export const buyBooster = (id: string) =>
  apiFetch<{ ok: true; points: number }>(`/mining/boosters/${id}/buy`, { method: "POST" });

// Wallet-to-wallet ROZI. NOT a trade: no price, no order book, no money leg.
//
// `amount` goes out in WHOLE ROZI (what the user typed, decimals allowed — the
// server converts). Everything coming back is micro.
export const transferRozi = (to: string, amount: number) =>
  apiFetch<{ ok: true; feeMicro: number; receivedMicro: number; roziMicro: number }>(
    "/mining/transfer", { method: "POST", body: JSON.stringify({ to, amount }) });

// ---- Admin: mining economy (docs/MINING_SPEC.md § 10) --------------------
// Every number in the ROZI economy is tunable at runtime, with no redeploy.
export type MiningSettings = Record<string, number | string>;
export const fetchMiningSettings = () =>
  apiFetch<{ settings: MiningSettings; defaults: MiningSettings }>("/staff/mining/settings");
export const updateMiningSettings = (patch: Record<string, number | string>) =>
  apiFetch<{ ok: true; settings: MiningSettings }>("/staff/mining/settings", {
    method: "PATCH", body: JSON.stringify(patch),
  });

export type MiningStats = {
  epoch: number;
  emissionModel: string;
  pi: {
    population: number;
    baseRate: number;
    effectiveRate: number;
    halvingsSoFar: number;
    nextMilestone: number | null;
    rateTooLow: boolean;
  };
  todayEmission: number;
  supply: { cap: number; emitted: number; burned: number; circulating: number; remaining: number };
  today: { miners: number; totalShares: number; activeSessions: number };
  poolCoveragePoints: number | null;
  epochs: {
    epoch: number; emission: number; total_shares: number; miners: number;
    emitted: number; withheld: number; settled_at: string;
  }[];
};
export const fetchMiningStats = () => apiFetch<MiningStats>("/staff/mining/stats");
export const settleMining = (epoch?: number) =>
  apiFetch<{ ok: true; results: unknown[] }>("/staff/mining/settle", {
    method: "POST", body: JSON.stringify(epoch != null ? { epoch } : {}),
  });

export type AdminRig = {
  id: string; name: string; icon: string; base_cost: number; cost_growth: number;
  base_power: number; power_growth: number; max_level: number; sort: number; status: string;
};
export const fetchAdminRigs = () => apiFetch<{ rigs: AdminRig[] }>("/staff/mining/rigs");
export const updateAdminRig = (id: string, patch: Record<string, unknown>) =>
  apiFetch<{ ok: true }>(`/staff/mining/rigs/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

export type ConversionWindow = {
  id: string; pot_points: number; opens_at: string; closes_at: string;
  status: string; total_burned: number; points_paid: number; settled_at: string | null;
};
export const fetchConversion = () =>
  apiFetch<{
    enabled: boolean; conversionSharePct: number; marginPointsLast7Days: number;
    suggestedPotPoints: number; windows: ConversionWindow[];
  }>("/staff/mining/conversion");
export const openConversionWindow = (potPoints: number, hours: number) =>
  apiFetch<{ ok: true; id: string }>("/staff/mining/conversion/open", {
    method: "POST", body: JSON.stringify({ potPoints, hours }),
  });
export const settleConversionWindow = (id: string) =>
  apiFetch<{ ok: true; pointsPaid: number; users: number; totalBurned: number }>(
    `/staff/mining/conversion/${id}/settle`, { method: "POST" });
