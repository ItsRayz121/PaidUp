// Feature flags — the REGISTRY. What each flag is, what it does, and where its
// value lives (brief part 44).
//
// Split from flags.ts for the same reason mining/core.ts is split from
// mining/settings.ts: this file imports NOTHING that opens a database
// connection, so the unit tests can read the registry without one. A test file
// holding a live connection never exits — node:test hangs until it times out
// and reports every passing assertion as a failure. See mining/core.ts's header.
//
// ⚠️ THE HARD RULE: A FLAG DELEGATES TO THE SWITCH THAT ALREADY EXISTS.
// Five of these features already had a working switch before this file — ROZI
// transfers, advertisements, USDT deposits, ROZI conversion, the ID check — each
// read at its own enforcement point and each already tested. Adding a SECOND
// switch for the same feature would be strictly worse than having none: two
// controls, disagreeing, and no way to tell from the panel which one is
// actually stopping the thing. So each entry below names WHERE its value lives,
// and for those five that location is the existing key, unchanged. Only genuinely
// new flags get a new row.
//
// ⚠️ THE OTHER HARD RULE: A FLAG MUST DO SOMETHING.
// A switch that reads back what you set but changes no behaviour is worse than
// no switch, because it will be trusted in an incident. Every flag here names
// its enforcement point in a comment, and the ones that are display-only say so
// in the panel rather than pretending.
//
// Defaults are ON for everything already live, so deploying this file changes
// nothing about a running system.

import type { MiningSettings } from "./mining/core.ts";

export type FlagId =
  | "rozi_transfers" | "usdt_deposits" | "usdt_withdrawals"
  | "bnb_deposits" | "bnb_withdrawals"
  | "mining" | "machines" | "tasks" | "surveys" | "advertisements"
  | "referrals" | "kyc" | "telegram" | "leaderboard" | "rozi_conversion"
  | "earnings_view";

type Store =
  // Lives in a `mining.*` app_settings row — the existing switch for that feature.
  | { kind: "mining"; key: keyof MiningSettings }
  // Lives in an app_settings row under its own name — again, the existing one.
  | { kind: "setting"; key: string; onValue?: string }
  // New flag, no prior home: app_settings under `flag.<id>`.
  | { kind: "flag" };

type FlagDef = {
  label: string;
  /** What a user loses when this is off. Shown in the panel, so it is honest. */
  effect: string;
  store: Store;
  /** Where the switch is actually read and enforced. Not decorative. */
  enforcedAt: string;
  /**
   * True when turning this off only hides the feature in the app but does not
   * make the underlying route refuse. Surfaced in the panel so nobody switches
   * one of these off in an incident and believes the door is shut.
   */
  displayOnly?: boolean;
  /**
   * Almost every flag defaults ON — its feature was live before it had a
   * switch. A flag for something NOT YET launched defaults OFF instead, so
   * deploying the registry does not turn the feature on.
   */
  defaultOff?: boolean;
};

export const FLAGS: Record<FlagId, FlagDef> = {
  // ---- Already had a switch. These DELEGATE; no new row is created. --------
  rozi_transfers: {
    label: "ROZI transfers",
    effect: "Users cannot send ROZI to each other. Receiving stays open.",
    store: { kind: "mining", key: "transfersEnabled" },
    enforcedAt: "POST /mining/transfer",
  },
  usdt_deposits: {
    label: "USDT deposits",
    effect: "The top-up screen closes. Money already deposited is untouched.",
    store: { kind: "mining", key: "usdtTopupEnabled" },
    enforcedAt: "POST /usdt/topups",
  },
  advertisements: {
    label: "Advertisements",
    effect: "No ads are shown and the watch-to-boost button disappears.",
    store: { kind: "mining", key: "adsEnabled" },
    enforcedAt: "GET /mining/state, POST /mining/ad/*",
  },
  rozi_conversion: {
    label: "ROZI conversion window",
    effect: "Users cannot convert ROZI to points. Open windows stop accepting.",
    store: { kind: "mining", key: "conversionEnabled" },
    enforcedAt: "POST /mining/convert",
  },
  kyc: {
    label: "ID check (KYC)",
    effect:
      "OFF WAIVES THE ID CHECK on withdrawals, refunds and ROZI transfers. " +
      "This makes those paths EASIER, not safer — it is not a kill switch.",
    // The existing key stores "1"/"0" and defaults to ON when absent.
    store: { kind: "setting", key: "kyc_enabled" },
    enforcedAt: "kyc.ts kycFeatureEnabled(), read by withdrawals/refunds/transfer",
  },

  // ---- Genuinely new switches ---------------------------------------------
  usdt_withdrawals: {
    label: "USDT withdrawals",
    effect: "Nobody can request a cash-out. Requests already in the queue still pay.",
    store: { kind: "flag" },
    enforcedAt: "POST /withdrawals; POST /wallet/withdraw whenever it draws on points or task USDT " +
      "(a request covered entirely by a deposit refund is unaffected, same as /usdt/refunds always has been)",
  },
  bnb_deposits: {
    label: "BNB deposits",
    effect: "The BNB deposit address is hidden in the wallet.",
    store: { kind: "flag" },
    // Honest: there is nothing to refuse. A deposit is the user sending BNB to
    // an address on a public chain — we cannot stop that, only stop advertising
    // it. Pretending otherwise would be the worst kind of flag.
    enforcedAt: "GET /wallet/balance — hides the address; the chain cannot be switched off",
    displayOnly: true,
  },
  bnb_withdrawals: {
    label: "BNB withdrawals",
    effect: "Users cannot pull the BNB they hold for gas back out.",
    store: { kind: "flag" },
    enforcedAt: "POST /wallet/bnb/withdraw",
  },
  mining: {
    label: "Mining",
    effect:
      "No new mining session can be started. Sessions already running still " +
      "settle — stopping mid-session would destroy earnings people have already done.",
    store: { kind: "flag" },
    enforcedAt: "POST /mining/start",
  },
  machines: {
    label: "Machines (rigs)",
    effect: "The rig shop closes. Rigs already owned keep working.",
    store: { kind: "flag" },
    enforcedAt: "POST /mining/rigs/:id/buy",
  },
  tasks: {
    label: "Tasks",
    effect: "The task list is empty and no task can be started or submitted.",
    store: { kind: "flag" },
    enforcedAt: "GET /tasks, POST /tasks/:id/proof",
  },
  surveys: {
    label: "Surveys (CPX)",
    effect: "The survey wall closes. Postbacks for surveys already done still credit.",
    store: { kind: "flag" },
    // Postbacks deliberately keep crediting: a user who finished a survey
    // before the switch was thrown earned that money, and a network reversal
    // window runs for weeks afterwards.
    enforcedAt: "GET /surveys/url",
  },
  referrals: {
    label: "Referrals",
    effect:
      "No NEW referral bonuses are paid and the invite screens close. " +
      "Bonuses already credited are never clawed back.",
    store: { kind: "flag" },
    enforcedAt: "credit.ts — the referral payout branch",
  },
  telegram: {
    label: "Telegram login",
    effect: "Telegram sign-in and account linking stop working.",
    store: { kind: "flag" },
    enforcedAt: "POST /auth/telegram*",
  },
  leaderboard: {
    label: "Leaderboard",
    effect: "The leaderboard page shows nothing.",
    store: { kind: "flag" },
    enforcedAt: "GET /leaderboard",
  },
  earnings_view: {
    label: "Earnings summary (earner app)",
    effect:
      "Shows a user a 'what you've earned from the platform' page. Built ahead " +
      "of real USDT payouts and kept OFF until those start — turning it on early " +
      "shows people a number they cannot yet act on.",
    store: { kind: "flag" },
    enforcedAt: "GET /me/earnings — 403; the /earnings page and the profile link are hidden",
    displayOnly: false,
    defaultOff: true,
  },
};

export const FLAG_IDS = Object.keys(FLAGS) as FlagId[];
export function isFlagId(v: unknown): v is FlagId {
  return typeof v === "string" && (FLAG_IDS as string[]).includes(v);
}


export type { Store, FlagDef };
