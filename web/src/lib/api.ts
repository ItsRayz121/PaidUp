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

// Staff roles, mirroring the API's permissions.ts. `null` is a normal earner.
export type StaffRole =
  | "admin" | "manager" | "agent"
  | "operations" | "task_manager" | "finance" | "support" | "marketing" | "analyst";

export type SessionUser = {
  id: string; email: string; country: string;
  referralCode: string; status: string; role: StaffRole | null;
  // What the role is called on screen. The panel never shows the raw key.
  roleLabel?: string | null;
  // What this account may DO. The staff panel gates every section on these
  // rather than on `role === "admin"` — with nine roles, a role check has to be
  // re-edited for each one added, and until it is, the new role sees an empty
  // screen with no explanation.
  //
  // ⚠️ THIS IS FOR DRAWING THE SCREEN, NEVER FOR SECURITY. The API re-checks
  // every route against the role it reads from the database; a tampered list in
  // localStorage buys nothing but a panel full of buttons that all return 403.
  // Optional: sessions stored before this field existed simply lack it, and
  // `can()` treats a missing list as "nothing" for earners and falls back to
  // the legacy ladder for the three old roles.
  permissions?: string[];
  // Whether a Telegram account is connected (presence only, never the id).
  // Optional: sessions stored before this field existed simply lack it.
  hasTelegram?: boolean;
  // False for Telegram-created accounts that haven't added a real email yet
  // (their stored address is a synthetic placeholder, never shown or mailed).
  hasEmail?: boolean;
  // What the app calls this person, and their public handle. Both optional and
  // both may be null: an account that never opens the settings screen has
  // neither, and every screen falls back to the email prefix.
  displayName?: string | null;
  username?: string | null;
};

// ---- Profile settings -------------------------------------------------------

export type ProfileState = {
  displayName: string | null;
  username: string | null;
  // ISO date the handle unlocks again, or null when it can be changed now.
  usernameLockedUntil: string | null;
  cooldownDays: number;
  hasAvatar: boolean;
};
export const fetchProfile = () => apiFetch<ProfileState>("/profile");
export const updateProfile = (patch: { displayName?: string; username?: string }) =>
  apiFetch<{ displayName: string | null; username: string | null; usernameLockedUntil: string | null }>(
    "/profile", { method: "PATCH", body: JSON.stringify(patch) });
export const fetchAvatar = () => apiFetch<{ image: string | null }>("/profile/avatar");
export const uploadAvatar = (image: string) =>
  apiFetch<{ ok: true }>("/profile/avatar", { method: "PUT", body: JSON.stringify({ image }) });
export const removeAvatar = () =>
  apiFetch<{ ok: true }>("/profile/avatar", { method: "DELETE" });

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
// Overwrite the stored user without touching the token. Used when a screen
// re-reads /auth/me and finds something the stored copy predates — a role
// change, or the permission list itself on the deploy that introduced it.
export function storeUser(user: SessionUser) {
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
  rewardType?: "points" | "usdt" | "both";
  rewardUsdtMicro?: number;
  // Present only on our OWN tasks (source === "custom").
  source?: "network" | "custom";
  verifyMode?: "proof" | "postback";
  instructions?: string;
  proofLabel?: string;
  proofHeading?: string;
  proofHelp?: string;
  // Whether this task asks the user to TYPE evidence. False = a single "I did
  // it" confirmation. Either way the claim lands in the staff queue and a human
  // approves it before any points move (guardrail #1). Optional so an older API
  // that does not send it is read as true, which is the stricter default.
  proofRequired?: boolean;
  actionUrl?: string;
  // Which logo the card shows — a key into `taskIcon` (components/icons.tsx),
  // never a URL. Absent => the icon for the task's type.
  icon?: string;
  logoAssetId?: string;
  buttonLabel?: string;
  startsAt?: string;
  endsAt?: string;
  campaignStatus?: "draft" | "scheduled" | "active" | "paused" | "exhausted" | "ended";
  userState?: "not_started" | "started" | "pending_review" | "rejected_retryable" | "completed";
  // The current user's standing on a 'proof' task, if they've submitted.
  proofStatus?: "pending" | "approved" | "rejected";
  proofNote?: string;
  // ---- Stage 7 -------------------------------------------------------------
  /** One of TASK_CATEGORIES (api/src/routes/staffTasks.ts). Absent = uncategorised. */
  category?: string;
  /** How many questions the task asks. 0 = the old single proof box. */
  fieldCount?: number;
  /** Set when the user has NOT met a targeting rule they still CAN meet ("finish
   *  2 more tasks first"). The card renders locked and the API refuses a submit.
   *  Rules nobody can ever meet (wrong country) never reach the client at all —
   *  see api/src/taskTargeting.ts. */
  lockedReason?: string;
};

// ---- A task's configurable input fields (Stage 7) -------------------------
export type TaskFieldKind = "text" | "longtext" | "number" | "email" | "url" | "phone" | "choice" | "username" | "crypto_address";
export type TaskField = {
  id: string; label: string; kind: TaskFieldKind; required: boolean;
  placeholder?: string; help?: string; options?: string[]; maxLen: number;
  validation?: "evm" | "tron" | "solana" | "generic";
};
export const fetchTask = (id: string) =>
  apiFetch<{ ok: boolean; error?: string; task?: Task; fields?: TaskField[] }>(`/tasks/${id}`);

// The chips on /tasks and the labels the staff form offers. Must match
// TASK_CATEGORIES in api/src/routes/staffTasks.ts — the API refuses anything
// not on that list, so a value added here alone just fails to save.
export const TASK_CATEGORY_LABELS: Record<string, string> = {
  social: "Social",
  signup: "Sign up",
  app: "Apps",
  survey: "Surveys",
  video: "Videos",
  shopping: "Shopping",
  other: "Other",
};
export type LedgerEntry = {
  id: string; label: string; points: number;
  // "refunded" never comes from the API — it's assigned client-side in
  // walletHistory.ts for a rejected outgoing send, reusing this union so
  // Row["status"] (@/lib/walletHistory) doesn't need a second type.
  status: "earned" | "pending" | "sending" | "paid" | "rejected" | "refunded"; kind: string; at: string;
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

// Mini App login: the signed `initData` string Telegram gives its webview.
export const loginWithTelegramMiniApp = (initData: string) =>
  apiFetch<AuthOk>("/auth/telegram/miniapp", {
    method: "POST", body: JSON.stringify({ initData }),
  });

// Whether Telegram login is on, and which bot to render the widget for —
// served by the API so the bot username never lives in a web env var.
export const fetchTelegramConfig = () =>
  apiFetch<{ enabled: boolean; botUsername: string }>("/auth/telegram/config");

// Connect Telegram to the signed-in account with the Mini App's own signed
// initData — the one-tap path when already inside Telegram.
export const linkTelegram = (payload: { initData?: string; widget?: Record<string, unknown> }) =>
  apiFetch<{ ok: true; user: SessionUser }>("/auth/telegram/link", {
    method: "POST", body: JSON.stringify(payload),
  });

// Mint a one-time BINDING code for the website flow: t.me/<bot>?startapp=<startParam>
// opens Telegram, and the Mini App login consumes it — no Telegram login form.
export const createTelegramLinkCode = () =>
  apiFetch<{ startParam: string; expiresInMinutes: number }>("/auth/telegram/link-code", {
    method: "POST",
  });

// The mirror direction: a Telegram-created account adds an email + password
// (code to the inbox proves it), and the SAME account then works on the
// website with a normal email login.
export const startEmailLink = (email: string, password: string) =>
  apiFetch<{ ok: true }>("/auth/email/link-start", {
    method: "POST", body: JSON.stringify({ email, password }),
  });
export const confirmEmailLink = (email: string, code: string) =>
  apiFetch<{ ok: true; user: SessionUser }>("/auth/email/link-confirm", {
    method: "POST", body: JSON.stringify({ email, code }),
  });

export const fetchMe = () => apiFetch<{ user: SessionUser }>("/auth/me");

// ---- Earner ---------------------------------------------------------------
export const fetchBalance = () =>
  apiFetch<{
    points: number; minWithdrawPoints: number; withdrawalFeePoints: number;
    earnedUsdtMicro: number;
    gasFeePercent: number; gasFeeFixedMicro: number;
    // The user's own gas wallet (founder, 2026-08-08, second pass) — see
    // UsdtState's identical fields for the full explanation.
    personalGasWei: string | null;
    personalGasRequiredWei: string | null;
    personalGasReady: boolean | null;
    // ---- Wallet overhaul (Total Balance) -----------------------------------
    // The wallet's headline USDT figure: real deposited USDT (usdt_ledger)
    // PLUS withdrawable task/referral points, at the real 1000pts=$1 rate —
    // see the comment above this computation in api/src/routes/app.ts.
    // "Locked" is the points-derived half while the account sits below
    // minWithdrawPoints; it becomes "Available" automatically the moment it
    // clears, with no separate unlock call. Micro-USDT, same scale as every
    // other USDT figure in this app (USDT_SCALE in format.ts).
    usdtAvailableMicro: number;
    usdtLockedMicro: number;
    usdtTotalMicro: number;
  }>("/wallet/balance");
export const fetchLedger = () => apiFetch<{ entries: LedgerEntry[] }>("/wallet/ledger");
export type UsdtTaskReward = { id: string; amountMicro: number; completionId: string | null; label: string; at: string };
export const fetchUsdtTaskRewards = () => apiFetch<{ rewards: UsdtTaskReward[] }>("/wallet/usdt-task-rewards");
export type TaskView = "available" | "mine" | "history";
export const fetchTasks = (view: TaskView = "available", cursor = 0, limit = 12) =>
  apiFetch<{ tasks: Task[]; nextCursor: number | null; total: number; view: TaskView }>(
    `/tasks?view=${view}&cursor=${cursor}&limit=${limit}`);
export const startTask = (taskId: string) =>
  apiFetch<{ ok: boolean; error?: string; status?: string }>(`/tasks/${taskId}/start`, { method: "POST" });
export const taskAssetUrl = (id?: string | null) => id ? `${API_BASE}/task-assets/${encodeURIComponent(id)}` : "";
// `proof` is empty for a task whose Admin switched evidence off. The server
// decides whether that is allowed — it re-reads the task's own setting.
// `answers` is fieldId -> what they typed, for a task with configured fields.
// The server re-checks every one of them against the task's CURRENT fields
// (api/src/taskFields.ts); the form's own validation only saves a round trip.
export const submitTaskProof = (
  taskId: string, proof: string, answers?: Record<string, string>,
) =>
  apiFetch<{ ok: boolean; status?: string; error?: string }>(`/tasks/${taskId}/proof`, {
    method: "POST", body: JSON.stringify({ proof, answers }),
  });
// `rewards` is what a friend is WORTH, served by the API rather than written into
// the copy deck, because every one of those numbers is Admin-tunable. An invite
// screen that prints a stale 15% is an invite screen that lies.
export type Referrals = {
  code: string;
  joined: number;   // friends you invited
  joined2: number;  // friends THEY invited
  earnedPoints: number;
  rewards: {
    l1Pct: number;          // % of a friend's task points, paid to you
    l2Pct: number;          // % of a friend-of-a-friend's task points
    firstTaskBonus: number; // one-off points when a friend finishes their 1st task
    miningL1Pct: number;    // % of a mining friend's speed added to yours
    miningL2Pct: number;
  };
};
export const fetchReferrals = () => apiFetch<Referrals>("/referrals/me");
export const fetchWithdrawals = () => apiFetch<{ requests: Withdrawal[] }>("/withdrawals");
export const createWithdrawal = (amountPoints: number, chain: string, address: string) =>
  apiFetch<{ request: Withdrawal }>("/withdrawals", {
    method: "POST", body: JSON.stringify({ amountPoints, chain, address }),
  });

// Saved payout addresses (set once per chain, reused). `addresses` is keyed by
// chain id -> the saved wallet address. `verified` says, per chain, whether the
// user PROVED they hold it by signing with the wallet rather than pasting it.
export const fetchPayoutAddresses = () =>
  apiFetch<{ addresses: Record<string, string>; verified?: Record<string, boolean> }>(
    "/withdrawals/addresses");
export const savePayoutAddress = (chain: string, address: string) =>
  apiFetch<{ ok: true; chain: string; address: string }>("/withdrawals/addresses", {
    method: "PUT", body: JSON.stringify({ chain, address }),
  });

// ---- Connect a wallet instead of pasting an address ------------------------
// Two steps. The server picks the words that get signed (so a signature from
// anywhere else is worthless here), and works out the address from the
// signature itself — the address below is only the user's claim about which
// account their wallet handed over.
export const requestWalletChallenge = (chain: string, address: string) =>
  apiFetch<{ nonce: string; message: string; expiresAt: string }>(
    "/withdrawals/addresses/challenge",
    { method: "POST", body: JSON.stringify({ chain, address }) },
  );
export const verifyWalletSignature = (nonce: string, signature: string) =>
  apiFetch<{ ok: true; chain: string; address: string; verified: true }>(
    "/withdrawals/addresses/verify",
    { method: "POST", body: JSON.stringify({ nonce, signature }) },
  );

// ---- BNB withdraw (wallet overhaul) ----------------------------------------
// A user pulling their OWN gas balance back out of their derived custody
// address. No ledger, no treasury involvement — api/src/bnbWithdraw.ts.
export type BnbWithdrawal = {
  id: string; address: string; amountWei: string; status: "pending" | "sending" | "paid" | "failed";
  txHash?: string; at: string; completedAt?: string;
};
export const fetchBnbWithdrawals = () =>
  apiFetch<{ requests: BnbWithdrawal[] }>("/wallet/bnb/withdrawals");
export const createBnbWithdrawal = (address: string, amountBnb: string) =>
  apiFetch<{ ok: true; id: string; status: "pending" }>("/wallet/bnb/withdraw", {
    method: "POST", body: JSON.stringify({ address, amountBnb }),
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
  // Whether the user proved this exact address is theirs by signing for it with
  // the wallet, as of the moment they asked. Optional so an older API build
  // (mid-deploy) renders "not checked" rather than crashing the queue.
  addressVerified?: boolean;
  // ⚠️ NET IS WHAT GETS SENT; `amount` is what the user was debited. Manual
  // payout is a human reading this row and sending USDT by hand, so the fee
  // has to be on it — otherwise the gross gets sent and the platform eats the
  // fee it just charged. Optional for the same mid-deploy reason as above.
  feePoints?: number;
  netUsdt?: string;
};
// Treasury (hot wallet) address per chain — where payouts are sent FROM.
export type TreasuryAddresses = { bep20: string; base: string; aptos: string };
// ⚠️ NULL ON THE `paid` AND `rejected` TABS, deliberately. The panel renders
// this as "to send", which is only true while the money is still owed — on a
// paid tab it would be an instruction to fund a payout that already left.
export type PendingTotal = { count: number; points: number; usdt: string };
export const fetchStaffQueue = (status = "pending") =>
  apiFetch<{ requests: StaffWithdrawal[]; treasury: TreasuryAddresses; pendingTotal?: PendingTotal | null }>(
    `/staff/withdrawals?status=${encodeURIComponent(status)}`,
  );
export const decideWithdrawal = (id: string, action: "approve" | "reject" | "pay", note?: string, txHash?: string) =>
  apiFetch<{ ok: true; status: string; txHash?: string; usdt?: string }>(`/staff/withdrawals/${id}/decision`, {
    method: "POST", body: JSON.stringify({ action, note, txHash }),
  });
// One user, everything about them (brief part 34). Every field is derived from
// a table that already exists — there is no per-user counter to drift.
export type StaffUserDetail = {
  user: Record<string, unknown> & {
    id: string; email: string;
    // ⚠️ THREE SEPARATE LEDGERS, SHOWN SIDE BY SIDE AND NEVER SUMMED
    // (guardrail #7). Points and USDT deposit credit have real rates; ROZI
    // does not, and adding them together on a staff screen is how a made-up
    // rate gets quoted to a user in a dispute.
    balancePoints: number; roziMicro: number; usdtMicro: number;
    withdrawalHeld: boolean;
  };
  ledger: Record<string, unknown>[]; fraudFlags: Record<string, unknown>[];
  // Deposit refunds ("Get your USDT back") and top-ups — a SEPARATE money
  // trail from `ledger` above (that one is points; this is usdt_ledger).
  usdtRefunds: Record<string, unknown>[]; usdtTopups: Record<string, unknown>[];
  withdrawals: Record<string, unknown>[];
  paidSummary: { count: number; totalPoints: number };
  invitedBy: { id: string; email: string; referral_code: string } | null;
  // ⚠️ `invitees` IS CAPPED AT 50 ROWS; `inviteeCount` IS THE REAL TOTAL. Never
  // show `invitees.length` as "how many did they invite" — that is the number a
  // referral-ring review turns on, and the list is a page, not the answer.
  invitees: Record<string, unknown>[];
  inviteeCount: number;
  tickets: Record<string, unknown>[];
};
export const fetchStaffUser = (id: string) =>
  apiFetch<StaffUserDetail>(`/staff/users/${id}`);
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

export type StaffMember = {
  userId: string; email: string; role: StaffRole; roleLabel: string; at: string;
};
export type RoleOption = { id: StaffRole; label: string; permissions: string[] };
// The role list comes from the SERVER, not a constant here: a role added in the
// API's permissions.ts then appears in the picker with no web deploy, and — the
// part that matters — the picker can never offer a role the API would refuse.
export const fetchStaffMembers = () =>
  apiFetch<{ staff: StaffMember[]; roles: RoleOption[] }>("/staff/staff");
export const setStaffRole = (userId: string, role: StaffRole | "none") =>
  apiFetch<{ ok: true; role: string }>(`/staff/staff/${userId}`, {
    method: "PUT", body: JSON.stringify({ role }),
  });

// ---- Audit log (brief part 46) --------------------------------------------
export type AuditEntry = {
  id: string; at: string; action: string; actorRole: string;
  actorEmail: string; actorUserId: string;
  targetEmail: string | null; targetUserId: string | null;
  detail: string | null;
  // What the value was before and after. Null on actions with no before/after
  // (an approval, a resolved flag) — most of the log, and not a gap.
  previousValue: string | null; newValue: string | null;
  ip: string | null;
};
export const fetchAudit = (q: {
  actor?: string; action?: string; target?: string; since?: string; cursor?: string;
} = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
  return apiFetch<{ entries: AuditEntry[]; nextCursor: string | null }>(
    `/staff/audit${p.toString() ? `?${p}` : ""}`);
};
export const fetchAuditActions = () =>
  apiFetch<{ actions: { action: string; count: number }[] }>("/staff/audit/actions");

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
// ⚠️ THE EARNER TYPE HAS NO 'internal', AND THAT IS THE POINT. GET
// /support/tickets filters internal notes out server-side (routes/app.ts), so a
// user can never receive one — stating that in the type keeps the two views
// from being quietly merged later. The staff view has its own wider type below.
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
  // Who has picked this up. Null = still in the pool.
  assignedTo: string | null; assigneeEmail: string | null;
};
export const fetchStaffTickets = (status = "open", q = "", mine = "") =>
  apiFetch<{ counts: Record<string, number>; tickets: StaffTicket[] }>(
    `/staff/tickets?status=${encodeURIComponent(status)}` +
    (q ? `&q=${encodeURIComponent(q)}` : "") +
    (mine ? `&mine=${encodeURIComponent(mine)}` : ""));
// Staff see the whole thread INCLUDING internal notes — hiding them from the
// people who wrote them would defeat the point. Hence a separate, wider type
// from the earner-facing `TicketMessage` above.
export type StaffTicketMessage = {
  author_role: "user" | "staff" | "internal";
  body: string; created_at: string; author_email?: string | null;
};
export const fetchStaffTicket = (id: string) =>
  apiFetch<{ ticket: Record<string, unknown>; messages: StaffTicketMessage[] }>(`/staff/tickets/${id}`);
// `internal: true` writes a note the USER NEVER SEES and sends no push. The
// filter that keeps it from them lives in the API (GET /support/tickets).
export const replyStaffTicket = (id: string, message: string, close = false, internal = false) =>
  apiFetch<{ ok: true }>(`/staff/tickets/${id}/reply`, {
    method: "POST", body: JSON.stringify({ message, close, internal }),
  });
export const patchStaffTicket = (id: string, patch: { assignedTo?: string | null; status?: string }) =>
  apiFetch<{ ok: true }>(`/staff/tickets/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

// ---- Notifications (brief part 39) ---------------------------------------
export type NotifyAudience = { id: string; label: string; note: string; size: number };
export type Broadcast = {
  id: string; title: string; body: string; url: string | null; audience: string;
  recipients: number; pushed: boolean; sentBy: string; at: string;
};
export const fetchNotifyAdmin = () =>
  apiFetch<{ pushAvailable: boolean; audiences: NotifyAudience[]; history: Broadcast[] }>(
    "/staff/notifications");
export const sendBroadcast = (b: {
  audience: string; title: string; body: string; url?: string | null; alsoPush?: boolean;
}) => apiFetch<{ ok: true; id: string; recipients: number }>("/staff/notifications", {
  method: "POST", body: JSON.stringify(b),
});
export const notifyOneUser = (userId: string, m: { title: string; body: string; url?: string | null }) =>
  apiFetch<{ ok: true }>(`/staff/users/${userId}/notify`, { method: "POST", body: JSON.stringify(m) });

// ---- Home content (brief part 43) ----------------------------------------
export type ContentBlock = {
  id: string; title: string; body: string; icon: string;
  linkUrl: string | null; linkLabel: string | null;
  tone: "info" | "good" | "warn"; status: "draft" | "live";
  startsAt: string | null; endsAt: string | null; sort: number; updatedAt: string;
};
export const fetchContentAdmin = () =>
  apiFetch<{ icons: string[]; blocks: ContentBlock[] }>("/staff/content");
export const createContentBlock = (b: Record<string, unknown>) =>
  apiFetch<{ ok: true; id: string }>("/staff/content", { method: "POST", body: JSON.stringify(b) });
export const updateContentBlock = (id: string, patch: Record<string, unknown>) =>
  apiFetch<{ ok: true }>(`/staff/content/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteContentBlock = (id: string) =>
  apiFetch<{ ok: true }>(`/staff/content/${id}`, { method: "DELETE" });

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

// Set referral rewards on EVERY network at once. Raising them one network at a
// time does not raise what users are shown: the invite screens advertise the
// MINIMUM across active networks, so one forgotten row pins the advertised rate
// to the old number with nothing to indicate it.
export const updateAllNetworkReferrals = (patch: {
  referralBonusPct?: number; referralBonusPctL2?: number;
  referralFirstTaskBonus?: number; referralBonusDays?: number;
}) => apiFetch<{ ok: true; updated: number }>(
  "/staff/networks/referrals/all", { method: "PATCH", body: JSON.stringify(patch) });

// ---- Admin: our own custom tasks -----------------------------------------
export type CustomTask = {
  id: string; title: string; points: number; type: string;
  reward_type: "points" | "usdt" | "both"; reward_usdt_micro: number;
  verify_mode: "proof" | "postback"; instructions: string | null; proof_label: string | null;
  proof_heading: string | null; proof_help: string | null;
  // Postgres INTEGER: 1 = ask the user for evidence, 0 = a tap-to-confirm task.
  proof_required: number;
  action_url: string | null; icon: string | null; minutes: number; country: string;
  button_label: string | null; logo_asset_id: string | null;
  starts_at: string | null; ends_at: string | null; featured: number; priority: number;
  // 'active' | 'disabled' | 'exhausted'. ⚠️ `exhausted` is set BY THE SERVER when
  // a campaign hits its budget — an Admin never picks it, which is why the input
  // type below does not offer it.
  status: string;
  effectiveStatus: "draft" | "scheduled" | "active" | "paused" | "exhausted" | "ended";
  created_at: string; has_secret: boolean; credited_count: number; pending_proofs: number;
  // ---- Campaign budget + revenue (brief parts 15 + 16) --------------------
  // null on either cap = unlimited. Every figure below is computed server-side
  // (api/src/taskBudget.ts) for the same reason `netUsdt` is on the withdrawal
  // queue: a number the panel derives for itself is a second definition of
  // spend, and it will eventually disagree with the ledger.
  budget_conversions: number | null;
  budget_points: number | null;
  budget_usdt_micro: number | null;
  revenue_per_conversion_micro: number;
  budget_exhausted_at: string | null;
  spentConversions: number;
  spentPoints: number;
  spentUsdtMicro: number;
  /** Referral commission these completions paid. Real spend, counted in margin,
   *  deliberately NOT charged against the budget — see db.ts. */
  referralPointsPaid: number;
  revenueMicro: number;
  marginMicro: number;
  /** null when the campaign has no conversion cap. NOT 0 — an uncapped campaign
   *  is not "0% used", and a bar stuck at 0% reads as a budget that isn't moving. */
  budgetUsedPct: number | null;
  // ---- Category + targeting (Stage 7) --------------------------------------
  category: string | null;
  /** Served unpacked from the comma-wrapped storage form, so the panel never
   *  has to know it. ['ALL'] = everywhere. */
  countries: string[];
  target_min_account_days: number | null;
  target_max_account_days: number | null;
  target_min_completed: number | null;
  /** How many questions this task asks. */
  fieldCount: number;
};
export type CustomTaskInput = {
  title: string; points: number; verifyMode: "proof" | "postback";
  rewardType: "points" | "usdt" | "both"; rewardUsdtMicro: number;
  instructions?: string; proofLabel?: string; proofHeading?: string; proofHelp?: string; proofRequired?: boolean;
  actionUrl?: string; buttonLabel?: string; icon?: string; logoAssetId?: string | null;
  minutes?: number; country?: string; status?: "draft" | "scheduled" | "active" | "paused" | "disabled" | "ended";
  startsAt?: string | null; endsAt?: string | null; featured?: boolean; priority?: number;
  // null clears a cap back to unlimited; omitted leaves it untouched.
  budgetConversions?: number | null;
  budgetPoints?: number | null;
  budgetUsdtMicro?: number | null;
  revenuePerConversionMicro?: number;
  // ---- Category + targeting (Stage 7). null clears a rule; omitted leaves it.
  category?: string;
  countries?: string[];
  targetMinAccountDays?: number | null;
  targetMaxAccountDays?: number | null;
  targetMinCompleted?: number | null;
};
export const TASK_CATEGORY_CHOICES = [
  "", "social", "signup", "app", "survey", "video", "shopping", "other",
] as const;
// Must match TASK_ICONS in api/src/routes/staffTasks.ts — the API refuses
// anything not on that list, so a value added here alone just fails to save.
export const TASK_ICON_CHOICES = [
  "", "whatsapp", "telegram", "twitter", "youtube", "facebook", "instagram", "star",
] as const;
export const fetchCustomTasks = () => apiFetch<{ tasks: CustomTask[] }>("/staff/tasks");
export const createCustomTask = (input: CustomTaskInput) =>
  apiFetch<{ ok: boolean; id?: string }>("/staff/tasks", { method: "POST", body: JSON.stringify(input) });
export const updateCustomTask = (id: string, patch: Partial<CustomTaskInput>) =>
  apiFetch<{ ok: boolean }>(`/staff/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const fetchTaskPostback = (id: string) =>
  apiFetch<{ ok: boolean; error?: string; taskId?: string; secret?: string; path?: string; signature?: string; params?: string[] }>(
    `/staff/tasks/${id}/postback`);
export const updateTaskLifecycle = (id: string, action: "pause" | "resume" | "end") =>
  apiFetch<{ ok: boolean; error?: string; status?: string }>(`/staff/tasks/${id}/lifecycle`, {
    method: "POST", body: JSON.stringify({ action }),
  });
export const createEarnedUsdtWithdrawal = (amountUsdtMicro: number, chain: string, address: string) =>
  apiFetch<{ request: Withdrawal }>("/withdrawals", {
    method: "POST", body: JSON.stringify({ amountUsdtMicro, chain, address }),
  });
export const uploadTaskLogo = (data: string) =>
  apiFetch<{ ok: boolean; error?: string; id?: string; url?: string }>("/staff/task-assets", {
    method: "POST", body: JSON.stringify({ data }),
  });

// Admin: a task's input fields. Sent as a WHOLE LIST — order is a property of
// the list, not of any one row, so there is no per-field endpoint.
export type StaffTaskFieldInput = {
  id?: string; label: string; kind: TaskFieldKind; required: boolean;
  placeholder?: string; help?: string; options?: string; maxLen?: number | null;
  validation?: "evm" | "tron" | "solana" | "generic";
};
export const fetchTaskFields = (taskId: string) =>
  apiFetch<{ fields: TaskField[] }>(`/staff/tasks/${taskId}/fields`);
export const saveTaskFields = (taskId: string, fields: StaffTaskFieldInput[]) =>
  apiFetch<{ ok: boolean; error?: string; fields?: TaskField[] }>(
    `/staff/tasks/${taskId}/fields`, { method: "PUT", body: JSON.stringify({ fields }) });

/** One stored answer. The label and kind are SNAPSHOTTED at submit time, so a
 *  question renamed afterwards never relabels evidence already reviewed. */
export type ProofAnswer = {
  fieldId: string; label: string; kind: TaskFieldKind; value: string;
  validation?: "evm" | "tron" | "solana" | "generic";
};
export type TaskProof = {
  id: string; task_id: string; user_id: string; proof_text: string; status: string;
  review_note: string | null; created_at: string; reviewed_at: string | null;
  user_email: string; user_handle: string | null; user_country: string | null;
  user_joined: string | null; reviewer_email: string | null;
  task_title: string; task_points: number; task_usdt_micro: number;
  task_logo_asset_id: string | null; proof_label: string | null; category: string | null;
  /** Empty for tasks with no configured fields — those fall back to proof_text,
   *  which every row still carries. */
  answers: ProofAnswer[];
  /** This user's decided proofs across every task. A repeat rejection is the
   *  signal a reviewer would otherwise have to go looking for. */
  userHistory: { approved: number; rejected: number };
};
export type ProofQueue = {
  /** Over ALL proofs, never the current filter — a pending count that shrank
   *  because someone typed a search reads as the backlog clearing. */
  counts: { pending: number; approved: number; rejected: number };
  tasks: { id: string; title: string; pending: number }[];
  proofs: TaskProof[];
};
export const fetchTaskProofs = (status = "pending", taskId = "", q = "") =>
  apiFetch<ProofQueue>(
    `/staff/task-proofs?status=${encodeURIComponent(status)}`
    + `&taskId=${encodeURIComponent(taskId)}&q=${encodeURIComponent(q)}`);
export const decideTaskProof = (id: string, action: "approve" | "reject", note?: string) =>
  apiFetch<{ ok: boolean; error?: string; credited?: number; creditedUsdtMicro?: number; status?: string }>(
    `/staff/task-proofs/${id}/decision`, { method: "POST", body: JSON.stringify({ action, note }) });
export const decideTaskProofsBulk = (ids: string[], action: "approve" | "reject", note?: string) =>
  apiFetch<{
    ok: boolean; done: number; failed: number; creditedPoints: number; creditedUsdtMicro: number;
    results: { id: string; ok: boolean; error?: string; credited?: number; creditedUsdtMicro?: number }[];
  }>("/staff/task-proofs/bulk", { method: "POST", body: JSON.stringify({ ids, action, note }) });

// ---- Manager: KPI dashboard ----------------------------------------------
export type Kpis = {
  users: { total: number; new7d: number };
  withdrawals: { pendingCount: number; pendingPoints: number; paidCount7d: number; paidPoints7d: number; paidPointsAll: number };
  earning: { taskPointsAll: number; referralPointsAll: number; completionsToday: number };
  risk: { openFraud: number; openTickets: number };
  series: { day: string; completions: number; points: number }[];
};
export const fetchKpis = () => apiFetch<Kpis>("/staff/kpis");

// ---- Analytics (brief part 48) --------------------------------------------
// Micro-USDT and micro-ROZI totals arrive as STRINGS: they are 6-decimal
// integers that can exceed what a JS number holds exactly. Parse deliberately
// at the point of formatting, never with implicit arithmetic.
export type Analytics = {
  generatedAt: string; windowDays: number;
  users: {
    total: number; verified: number; newToday: number; new7d: number; new30d: number;
    dau: number; wau: number; mau: number; stickiness: number;
  };
  retention: Record<"d1" | "d7" | "d30", { cohort: number; returned: number; pct: number }>
    & { sampleWindow: number };
  tasks: {
    starts: number; verified: number; credited: number; completionRate: number;
    proofsSubmitted: number; proofsApproved: number; proofsPending: number;
    approvalRate: number; completionsToday: number;
  };
  mining: { activeMiners: number; sessions: number; roziMinedTodayMicro: string };
  money: {
    depositMicro30d: string; depositMicroAll: string; refundMicro30d: string;
    withdrawnPoints30d: number; withdrawnPointsAll: number; withdrawPendingPoints: number;
    rewardCostPoints: number; referralCostPoints: number;
    revenuePoints: number; revenuePerActiveUser: number;
  };
  referrals: { signups: number; activated: number; conversion: number };
  risk: { openFraud: number; openTickets: number };
  series: { day: string; signups: number; active: number; completions: number; points: number }[];
  miningSeries: { day: string; rozi: string; miners: number }[];
  byNetwork: {
    network: string; label: string; split: number; status: string;
    completions: number; userPoints: number; marginPoints: number;
  }[];
};
export const fetchAnalytics = (days = 30) =>
  apiFetch<Analytics>(`/staff/analytics?days=${days}`);

// ---- Admin: global settings (withdrawal fee) -----------------------------
export const fetchSettings = () =>
  apiFetch<{
    withdrawalFeePoints: number; gasFeePercent: number; gasFeeFixedMicro: number;
    autoWithdrawMaxPoints: number; autoRefundMaxMicro: number; autoSendLive: boolean;
    kycEnabled: boolean; treasury: TreasuryAddresses;
    // Global settings (brief part 45).
    appName: string; supportEmail: string; supportTelegram: string;
    minWithdrawPoints: number;
    maintenanceMode: boolean; maintenanceMessage: string;
  }>("/staff/settings");
export const updateSettings = (patch: {
  withdrawalFeePoints?: number;
  gasFeePercent?: number;
  gasFeeFixedMicro?: number;
  autoWithdrawMaxPoints?: number;
  autoRefundMaxMicro?: number;
  kycEnabled?: boolean;
  treasury?: Partial<TreasuryAddresses>;
  appName?: string;
  supportEmail?: string;
  supportTelegram?: string;
  minWithdrawPoints?: number;
  maintenanceMode?: boolean;
  maintenanceMessage?: string;
}) =>
  apiFetch<{ ok: true }>("/staff/settings", { method: "PATCH", body: JSON.stringify(patch) });

// ---- Admin: feature flags (brief part 44) --------------------------------
export type FeatureFlag = {
  id: string; enabled: boolean; label: string; effect: string;
  enforcedAt: string;
  // True when switching this off only HIDES the feature and does not make the
  // underlying route refuse. Surfaced so nobody flips it in an incident and
  // believes the door is shut.
  displayOnly: boolean;
};
export const fetchFlags = () => apiFetch<{ flags: FeatureFlag[] }>("/staff/flags");
export const setFlag = (id: string, enabled: boolean) =>
  apiFetch<{ ok: true; id: string; enabled: boolean }>(`/staff/flags/${id}`, {
    method: "PATCH", body: JSON.stringify({ enabled }),
  });

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
    // Show an ad around the start-mining tap. Soft: the server still starts
    // the session if no ad was shown.
    gateOnStart: boolean;
    provider: string;
    // Vignette zone (the ad on mining start) + direct-link URL (the
    // watch-to-boost button) + in-page-push zone (the banner on /mine).
    // Any may be empty; each disables its own part.
    monetagZoneId: string;
    monetagDirectLink: string;
    monetagBannerZone: string;
    // Rewarded video (a real "user finished watching" promise) — Monetag only
    // offers it inside Telegram Mini Apps, so it is used only there.
    monetagRewardedZone: string;
  };
  convertible: boolean;
  // The shop has something in stock. Drives whether /mine links to it at all.
  storeOpen: boolean;
  transfersEnabled: boolean;
  // Top-ups are switched on AND a treasury address is set. One flag for both,
  // so the link never leads to a screen with nowhere to send money.
  usdtTopup: boolean;
  // Why the user can or cannot send, answered by the server so the send screen
  // can say so before they type. The route re-checks every one of these — this
  // is for the copy, never for the decision.
  transfer: {
    enabled: boolean;
    canSend: boolean;
    requireKyc: boolean;
    kycStatus: string;
    accountDays: number;
    minAccountDays: number;
    dailyCap: number;
    sentTodayMicro: number;
    feePct: number;
  };
  deviceBlocked: boolean;
};
export const fetchMiningState = () => apiFetch<MiningState>("/mining/state");

// Send ROZI to another RoziPay user, by referral code or email.
//
// A TRANSFER, not a trade: no price, no matching, no money leg. Adding any of
// those would make us an exchange (MINING_SPEC.md § 7) — so this signature takes
// a recipient and an amount, and must never grow a `price`.
export const sendRozi = (to: string, amount: number) =>
  apiFetch<{
    ok: true; id: string; feeMicro: number; receivedMicro: number; roziMicro: number;
  }>("/mining/transfer", { method: "POST", body: JSON.stringify({ to, amount }) });

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
  // null => this machine is ROZI-only, which is the default for all of them.
  nextCostUsdtMicro: number | null;
};
export const fetchRigs = () => apiFetch<{
  roziMicro: number; usdtMicro: number; usdtEnabled: boolean;
  // Display-only estimate — see the setting's comment in api/src/mining/core.ts.
  roziUsdtDisplayRate: number;
  rigs: Rig[];
}>("/mining/rigs");
export const upgradeRig = (id: string, pay: "rozi" | "usdt" = "rozi") =>
  apiFetch<{
    ok: true; level: number; paidWith: string;
    spentMicro: number; spentUsdtMicro: number; roziMicro: number; usdtMicro: number;
  }>(`/mining/rigs/${id}/upgrade`, { method: "POST", body: JSON.stringify({ pay }) });

// ---- USDT top-up credit -----------------------------------------------------
// Credit for buying mining machines. It leaves in exactly two ways: buying a
// machine, or being refunded to the person who deposited it (founder,
// 2026-08-01). There is still no transfer and no conversion — see the
// usdt_ledger comment in api/src/db.ts for what that boundary is protecting.

export type UsdtTopup = {
  id: string; chain: string; txHash: string; amountMicro: number;
  status: "pending" | "confirmed" | "rejected";
  rejectReason: string | null; createdAt: string;
};
// A plain BNB transfer into the user's own deposit address, found by
// deposits/adapters/evmNative.ts. History-only — this never touches a
// balance (see native_deposits' table comment in api/src/db.ts); the BNB
// balance itself is still the live eth_getBalance read served as
// personalGasWei below.
export type BnbDeposit = {
  id: string; txHash: string; amountWei: string; fromAddress: string; createdAt: string;
};
export type UsdtRefund = {
  id: string; chain: string; address: string; amountMicro: number;
  // The gas fee (founder, 2026-08-08), snapshotted at request time. What was
  // actually sent is amountMicro - feeMicro.
  feeMicro: number;
  status: "pending" | "sending" | "paid" | "rejected";
  txHash: string | null; rejectReason: string | null; createdAt: string;
};
export type UsdtState = {
  enabled: boolean;
  balanceMicro: number;
  treasuryAddress: string | null;
  treasuryChain: string | null;
  chainLabel: string;
  // Per-user deposit address (CUSTODY_SPEC.md § 5 step 1). Null on every
  // deployment that has not set an xpub — meaning "use treasuryAddress above",
  // exactly as before this existed.
  personalAddress: string | null;
  minTopup: number;
  maxTopup: number;
  topups: UsdtTopup[];
  // Asking for a deposit back does NOT depend on `enabled`: deposits can be
  // switched off while people still hold a balance, and that is exactly when
  // being unable to ask for it back would be worst.
  refundMinMicro: number;
  // The gas fee (founder, 2026-08-08) — percent + a fixed floor, deducted from
  // what gets SENT back, never from what gets debited. Used to preview the fee
  // before submitting; the fee actually charged is re-computed and
  // snapshotted server-side at request time, never trusted from the client.
  gasFeePercent: number;
  gasFeeFixedMicro: number;
  // The user's own gas wallet (founder, 2026-08-08, second pass). Present
  // only when the relay can sign from the user's own derived address — that
  // address must hold enough BNB before a refund/withdrawal can go through,
  // and the screen needs to say so BEFORE the user submits, not just relay a
  // 400 after the fact. Wei, as decimal strings (BNB has 18 decimals — too
  // large to round-trip through a JS number safely).
  personalGasWei: string | null;
  personalGasRequiredWei: string | null;
  personalGasReady: boolean | null;
  refunds: UsdtRefund[];
  // BNB deposits into the same personal address, for history display only.
  nativeDeposits: BnbDeposit[];
};
export const fetchUsdt = () => apiFetch<UsdtState>("/usdt");
export const claimUsdtTopup = (txHash: string, amount: number) =>
  apiFetch<{ ok: true; id: string; status: string }>(
    "/usdt/topups", { method: "POST", body: JSON.stringify({ txHash, amount }) });
export const requestUsdtRefund = (amount: number, address: string) =>
  apiFetch<{
    ok: true; id: string; status: "pending" | "sending" | "paid"; txHash?: string; balanceMicro: number;
    feeMicro: number; netMicro: number;
  }>("/usdt/refunds", { method: "POST", body: JSON.stringify({ amount, address }) });

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
  // Whether the ID check is switched on at all (Admin, /staff → Verify IDs).
  // When false the tab reads "Coming soon" and does not open. It is optional on
  // the type so an older API that does not send it is read as ON, which is the
  // safe default — the alternative would hide a live feature after a deploy skew.
  enabled?: boolean;
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

// (Wallet-to-wallet ROZI lives in `sendRozi` above — this file used to carry a
// second, unused copy of it under a different name, whose return type had also
// drifted from what the route sends back.)

// ---- ROZI -> Points conversion (MINING_SPEC.md § 6) ------------------------
//
// The value bridge, and the ONLY path between the two ledgers. A window holds a
// pot of Points fixed before it opened; everyone who burns ROZI into it shares
// that pot pro-rata. THE RATE FLOATS — there is no fixed ROZI->Points rate
// anywhere in this app, and no type here should ever grow one.
//
// `allowanceMicro` is the second bound: how much more ROZI THIS account may ever
// convert, being a percentage of what it has mined over its whole life. The
// server re-checks it under a lock on every burn; these fields are for the copy.
export type ConversionState = {
  open: boolean;
  enabled: boolean;
  roziMicro: number;
  maxPctOfMined: number;
  allowanceMicro: number;
  minedMicro: number;
  convertedMicro: number;
  // Present only while a window is open.
  windowId?: string;
  potPoints?: number;
  closesAt?: string;
  totalBurnedMicro?: number;
  myBurnMicro?: number;
  myPointsIfClosedNow?: number;
};
// `fetchMyConversion`, not `fetchConversion` — the admin panel already owns that
// name for /staff/mining/conversion, which is a different thing (every window
// ever opened, plus the suggested pot). Same word, opposite side of the desk.
export const fetchMyConversion = () => apiFetch<ConversionState>("/mining/conversion");
export const burnRozi = (rozi: number) =>
  apiFetch<{ ok: true; burnedMicro: number; roziMicro: number }>(
    "/mining/conversion/burn", { method: "POST", body: JSON.stringify({ rozi }) });

// ---- ROZI store -----------------------------------------------------------
//
// Spend ROZI on something real, at a price WE set and can move. Note what is
// NOT here and must never be added: a sell price, a buy-back rate, or any field
// that would turn this into an offer to purchase ROZI back. It is a shop, and a
// shop's exposure is bounded by its stock (MINING_SPEC.md § 6).
export type StoreItem = {
  id: string; title: string; description: string | null;
  costMicro: number; inputLabel: string | null; inStock: boolean;
};
export type Redemption = {
  id: string; itemId: string; title: string; costMicro: number;
  status: "pending" | "fulfilled" | "rejected";
  target: string | null; staffNote: string | null; at: string;
};
export const fetchStore = () =>
  apiFetch<{ roziMicro: number; items: StoreItem[]; redemptions: Redemption[] }>("/mining/store");
export const redeemStoreItem = (id: string, target?: string) =>
  apiFetch<{ ok: true; id: string; spentMicro: number; roziMicro: number }>(
    `/mining/store/${id}/redeem`, { method: "POST", body: JSON.stringify({ target }) });

// ---- Admin: ROZI store ----------------------------------------------------
export type StoreItemAdmin = {
  id: string; title: string; description: string | null; costRozi: number;
  inputLabel: string | null; stock: number; status: "active" | "hidden"; sort: number;
};
export type RedemptionAdmin = {
  id: string; userId: string; email: string; title: string; costRozi: number;
  target: string | null; status: string; staffNote: string | null;
  at: string; decidedAt: string | null;
};
export const fetchStoreAdmin = () =>
  apiFetch<{ items: StoreItemAdmin[] }>("/staff/mining/store");
export const createStoreItem = (body: {
  title: string; description?: string; costRozi: number;
  inputLabel?: string; stock: number; status?: "active" | "hidden"; sort?: number;
}) => apiFetch<{ ok: true; id: string }>("/staff/mining/store", {
  method: "POST", body: JSON.stringify(body),
});
export const updateStoreItem = (id: string, patch: Partial<{
  title: string; description: string; costRozi: number;
  inputLabel: string; stock: number; status: "active" | "hidden"; sort: number;
}>) => apiFetch<{ ok: true }>(`/staff/mining/store/${id}`, {
  method: "PATCH", body: JSON.stringify(patch),
});
export const fetchRedemptions = (status?: string) =>
  apiFetch<{ redemptions: RedemptionAdmin[] }>(
    `/staff/mining/redemptions${status ? `?status=${status}` : ""}`);
export const decideRedemption = (id: string, action: "fulfil" | "reject", note?: string) =>
  apiFetch<{ ok: true }>(`/staff/mining/redemptions/${id}`, {
    method: "POST", body: JSON.stringify({ action, note }),
  });

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
  // Whole USDT, or null for "ROZI only" — which is every rig by default.
  base_cost_usdt: number | null;
  // What this machine actually DID (brief part 38). Derived from user_rigs and
  // the two ledgers' own rig_purchase rows — there is no stored counter.
  owners: number; levelsSold: number; roziBurned: number; usdtSpent: number;
};
export const fetchAdminRigs = () => apiFetch<{ rigs: AdminRig[] }>("/staff/mining/rigs");
export const updateAdminRig = (id: string, patch: Record<string, unknown>) =>
  apiFetch<{ ok: true }>(`/staff/mining/rigs/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

// Points-priced boosters. Separate from the earner-facing `Booster` type above:
// this one carries the sales figures and the on/off switch, which a user must
// never see.
export type AdminBooster = {
  id: string; name: string; price_points: number; multiplier_pct: number;
  hours: number; status: string; purchases: number; pointsSpent: number;
};
export const fetchAdminBoosters = () =>
  apiFetch<{ boosters: AdminBooster[] }>("/staff/mining/boosters");
export const createAdminBooster = (b: Record<string, unknown>) =>
  apiFetch<{ ok: true; id: string }>("/staff/mining/boosters", { method: "POST", body: JSON.stringify(b) });
export const updateAdminBooster = (id: string, patch: Record<string, unknown>) =>
  apiFetch<{ ok: true }>(`/staff/mining/boosters/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

// ---- Growth: referrals + leaderboard (brief parts 41/42) --------------------
export type ReferralNetwork = {
  id: string; name: string; status: string;
  commissionSplitPct: number; marginPct: number;
  referralBonusPct: number; referralBonusPctL2: number;
  referralFirstTaskBonus: number; referralBonusDays: number;
  // margin − (L1 + L2). Negative means every referred task loses money.
  headroomPct: number;
};
export type ReferralAdmin = {
  enabled: boolean;
  // What the invite screens PROMISE: the minimum across active networks.
  advertised: { l1: number; l2: number; firstTaskBonus: number; windowDays: number };
  // Which active networks are holding that minimum down.
  pinning: string[];
  networks: ReferralNetwork[];
  totals: {
    paidAll: number; paid30d: number; referredUsers: number;
    activatedUsers: number; payingReferrers: number; activationPct: number;
  };
  topReferrers: {
    id: string; email: string; status: string; points: number;
    invites: number; activeInvites: number; openFlags: number;
  }[];
};
export const fetchReferralAdmin = () => apiFetch<ReferralAdmin>("/staff/referrals");
export const setReferralRatesForAll = (patch: Record<string, number>) =>
  apiFetch<{ ok: true; updated: number }>("/staff/networks/referrals/all", {
    method: "PATCH", body: JSON.stringify(patch),
  });

export type LeaderboardAdmin = {
  enabled: boolean;
  topEarners: { rank: number; id: string; email: string; points: number }[];
  topReferrers: { rank: number; id: string; email: string; points: number; invites: number }[];
  exclusions: { userId: string; email: string; reason: string; at: string }[];
};
export const fetchLeaderboardAdmin = () => apiFetch<LeaderboardAdmin>("/staff/leaderboard");
export const excludeFromLeaderboard = (userId: string, reason: string) =>
  apiFetch<{ ok: true }>("/staff/leaderboard/exclusions", {
    method: "POST", body: JSON.stringify({ userId, reason }),
  });
export const unexcludeFromLeaderboard = (userId: string) =>
  apiFetch<{ ok: true }>(`/staff/leaderboard/exclusions/${userId}`, { method: "DELETE" });

// ---- USDT top-up review queue (staff) ---------------------------------------
export type AdminTopup = {
  id: string; user_id: string; email: string; username: string | null;
  chain: string; tx_hash: string; amount: number; status: string;
  reject_reason: string | null; created_at: string;
};
export const fetchAdminTopups = (status = "pending") =>
  apiFetch<{ treasuryAddress: string; treasuryChain: string; topups: AdminTopup[] }>(
    `/staff/mining/topups?status=${status}`);
export const confirmTopup = (id: string, amount: number) =>
  apiFetch<{ ok: true; balanceMicro: number }>(
    `/staff/mining/topups/${id}/confirm`, { method: "POST", body: JSON.stringify({ amount }) });
export const rejectTopup = (id: string, reason: string) =>
  apiFetch<{ ok: true }>(
    `/staff/mining/topups/${id}/reject`, { method: "POST", body: JSON.stringify({ reason }) });

// ---- USDT refund queue (staff) ----------------------------------------------
// The money was already debited when the user asked, so "paid" records the tx
// hash and moves no balance, while "reject" credits it back. See the handlers
// in api/src/routes/staffMining.ts — getting those two backwards is a
// double-debit or a free top-up.
export type AdminRefund = {
  id: string; user_id: string; email: string; username: string | null;
  chain: string; chainLabel: string; address: string; amount: number;
  // The gas fee (founder, 2026-08-08), snapshotted on the row. `amount` is
  // what was debited from the user; `netAmount` is what staff should ACTUALLY
  // send on-chain — the two only differ when a gas fee is configured.
  feeAmount: number; netAmount: number;
  status: string; tx_hash: string | null; reject_reason: string | null;
  addressVerified: boolean; created_at: string;
};
export const fetchAdminRefunds = (status = "pending") =>
  apiFetch<{ refunds: AdminRefund[] }>(`/staff/mining/refunds?status=${status}`);
export const payRefund = (id: string, txHash: string) =>
  apiFetch<{ ok: true }>(
    `/staff/mining/refunds/${id}/paid`, { method: "POST", body: JSON.stringify({ txHash }) });
export const rejectRefund = (id: string, reason: string) =>
  apiFetch<{ ok: true; balanceMicro: number }>(
    `/staff/mining/refunds/${id}/reject`, { method: "POST", body: JSON.stringify({ reason }) });

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

// ---- My inbox (earner side) -------------------------------------------------
// Deliberately NOT push. See api/src/notify.ts's header: a browser push
// subscription is revoked once and permanently, and the message it exists for
// is "your withdrawal was paid".
export type InboxItem = {
  id: string; title: string; body: string; url: string | null; read: boolean; at: string;
};
export const fetchNotifications = () =>
  apiFetch<{ unread: number; notifications: InboxItem[] }>("/notifications");
export const markNotificationsRead = (id?: string) =>
  apiFetch<{ ok: true }>("/notifications/read", {
    method: "POST", body: JSON.stringify(id ? { id } : {}),
  });

// Announcement cards on home, written by staff with no deploy. The live window
// is applied server-side, so whatever comes back is what should be on screen.
export type HomeBlock = {
  id: string; title: string; body: string; icon: string;
  tone: "info" | "good" | "warn"; linkUrl: string | null; linkLabel: string | null;
  external: boolean;
};
export const fetchHomeContent = () => apiFetch<{ blocks: HomeBlock[] }>("/content/home");

// ---- Web push notifications -------------------------------------------------
export const fetchPushConfig = () =>
  apiFetch<{ enabled: boolean; publicKey: string | null }>("/push/config");
export const registerPushSubscription = (sub: {
  endpoint: string; keys: { p256dh: string; auth: string };
}) => apiFetch<{ ok: true }>("/push/subscriptions", { method: "POST", body: JSON.stringify(sub) });
export const removePushSubscription = (endpoint: string) =>
  apiFetch<{ ok: true }>("/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint }) });
