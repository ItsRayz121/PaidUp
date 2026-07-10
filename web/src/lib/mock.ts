// DEMO DATA ONLY.
// This stands in for the backend so the founder can click through the real
// screens on a phone. Every number here would come from the append-only
// ledger + verified postbacks in production (see docs/ARCHITECTURE.md).
// Nothing here credits points — that only happens server-side after a
// verified postback. This file never talks to money.

export type OfferType = "install" | "survey" | "video";

export type Task = {
  id: string;
  type: OfferType;
  title: string; // plain-English action
  points: number;
  network: string; // shown in the sponsored disclosure
  advertiser: string;
  minutes: number; // rough "how long"
  requirement?: string; // plain reason a task can fail, shown up front
};

export type LedgerStatus = "paid" | "pending" | "rejected" | "earned";

export type LedgerEntry = {
  id: string;
  kind: "task" | "referral" | "withdrawal";
  label: string;
  points: number; // positive = credit, negative = debit
  status: LedgerStatus;
  at: string; // ISO
  reason?: string; // plain reason, esp. for rejected
};

export const user = {
  name: "Ayesha",
  phone: "0300 1234567",
  country: "Pakistan",
  referralCode: "AYESHA50",
  balancePoints: 4820,
  minWithdrawPoints: 2000, // low, reachable threshold (guardrail #4)
  wallets: [
    { id: "jazzcash", label: "JazzCash", hint: "Mobile wallet" },
    { id: "easypaisa", label: "EasyPaisa", hint: "Mobile wallet" },
  ],
};

export const referral = {
  code: user.referralCode,
  invited: 7,
  joined: 4,
  earnedPoints: 800,
};

export const tasks: Task[] = [
  {
    id: "t1",
    type: "install",
    title: "Install Cricket Live and open it once",
    points: 350,
    network: "AdGate",
    advertiser: "Cricket Live",
    minutes: 3,
    requirement: "Keep the app installed for 24 hours to get your points.",
  },
  {
    id: "t2",
    type: "video",
    title: "Watch a short video",
    points: 40,
    network: "BitLabs",
    advertiser: "BitLabs",
    minutes: 1,
  },
  {
    id: "t3",
    type: "survey",
    title: "Answer a few questions about shopping",
    points: 220,
    network: "BitLabs",
    advertiser: "Survey partner",
    minutes: 6,
    requirement: "Answer honestly. If answers don't match, points may not be added.",
  },
  {
    id: "t4",
    type: "install",
    title: "Install Fast Wallet and make an account",
    points: 900,
    network: "AdGate",
    advertiser: "Fast Wallet",
    minutes: 5,
    requirement: "You must finish sign up inside the app to get your points.",
  },
  {
    id: "t5",
    type: "video",
    title: "Watch a video about a new game",
    points: 40,
    network: "BitLabs",
    advertiser: "GameHub",
    minutes: 1,
  },
];

export const ledger: LedgerEntry[] = [
  {
    id: "l1",
    kind: "task",
    label: "Watched a video",
    points: 40,
    status: "earned",
    at: new Date(Date.now() - 12 * 60000).toISOString(),
  },
  {
    id: "l2",
    kind: "referral",
    label: "Bonus — Bilal joined with your code",
    points: 200,
    status: "earned",
    at: new Date(Date.now() - 3 * 3600000).toISOString(),
  },
  {
    id: "l3",
    kind: "task",
    label: "Installed Cricket Live",
    points: 350,
    status: "pending",
    at: new Date(Date.now() - 20 * 3600000).toISOString(),
    reason: "This offer needs the app to stay installed for 24 hours. Check back tomorrow.",
  },
  {
    id: "l4",
    kind: "withdrawal",
    label: "Sent to JazzCash",
    points: -2000,
    status: "paid",
    at: new Date(Date.now() - 2 * 86400000).toISOString(),
  },
  {
    id: "l5",
    kind: "task",
    label: "Survey about shopping",
    points: 220,
    status: "rejected",
    at: new Date(Date.now() - 3 * 86400000).toISOString(),
    reason: "The survey partner said the answers did not match. You can try another survey.",
  },
];
