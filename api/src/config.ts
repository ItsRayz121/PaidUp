// Loads .env (if present) using Node's built-in loader — no dotenv dependency.
import { existsSync } from "node:fs";

if (existsSync(new URL("../.env", import.meta.url))) {
  process.loadEnvFile(new URL("../.env", import.meta.url));
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  // Postgres. Unset locally => PGlite (embedded Postgres) under api/data/pg.
  databaseUrl: process.env.DATABASE_URL ?? "",
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-change-me",
  otpPepper: process.env.OTP_PEPPER ?? "dev-only-change-me-too",
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3000",

  // Email. Resend is used if RESEND_API_KEY is set, else codes print to the
  // console (local dev). EMAIL_FROM must be on a domain verified in Resend.
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  emailFrom: process.env.EMAIL_FROM ?? "login@paidup.app",
  emailFromName: process.env.EMAIL_FROM_NAME ?? "PaidUp",

  // Product rules (mirror the frontend demo values; real numbers are a
  // business decision — see docs/PROJECT_SPEC.md Open Questions).
  minWithdrawPoints: 2000,
  otpTtlMinutes: 10,
  otpMaxAttempts: 5,

  // Referral commission (P1): referrer earns this share of a referred user's
  // task points, as a separate referral_bonus ledger entry. Business decision.
  // Used only as the fallback when a network has no config row.
  referralCommissionPct: 0.1,
  // Referral bonus WINDOW (P2 tuning): pay the inviter a bonus only while the
  // invited account is younger than this many days. 0 = lifetime (no window).
  // Per-network `referral_bonus_days` overrides this; this is the fallback.
  referralBonusDays: 0,

  // Fraud: a single user can only get credited for the same offer TYPE this
  // many times per day. Over the cap => flagged, not credited (guardrail #5).
  velocityCapPerTypePerDay: 20,
  // Tighter cap (P2): total credited completions across ALL offer types in one
  // day. Stops a user maxing every type at once (20 installs + 20 surveys + …).
  velocityCapAllTypesPerDay: 40,
  // Tighter fraud (P2): flag when this many distinct accounts are seen from one
  // IP. Higher than the device threshold on purpose — carrier-grade NAT in our
  // markets makes many users legitimately share an IP, so this is a soft,
  // medium-severity signal for staff review, never an auto-ban.
  ipReuseThreshold: 6,

  // Postback replay window (P2): a signed postback whose timestamp is older or
  // newer than this many seconds is rejected (adapters that sign a timestamp,
  // e.g. surveyx). Defends against replay of a captured signed callback.
  postbackFreshnessSeconds: 300,

  // Withdrawal approval chain: at/below this an Agent may approve; above it a
  // Manager must approve (docs/PROJECT_SPEC.md).
  agentApprovalMaxPoints: 5000,

  // Per-network postback secrets (HMAC). Empty in dev falls back to a known
  // dev secret so the demo adapter still verifies. Set real secrets in prod.
  postbackSecrets: {
    offerhub: process.env.POSTBACK_SECRET_OFFERHUB ?? "dev-postback-secret",
    tapvid: process.env.POSTBACK_SECRET_TAPVID ?? "dev-postback-secret",
    surveyx: process.env.POSTBACK_SECRET_SURVEYX ?? "dev-postback-secret",
  } as Record<string, string>,

  // Static per-network tokens for networks that gate with a shared token in
  // addition to a signature (e.g. tapvid rewarded-video).
  postbackTokens: {
    tapvid: process.env.POSTBACK_TOKEN_TAPVID ?? "dev-postback-token",
  } as Record<string, string>,

  // Comma-separated founder/admin emails seeded as role=admin on first run.
  adminEmails: (process.env.ADMIN_EMAILS ?? "fazalelahi5577@gmail.com")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
};

export const isProdSecretsMissing =
  config.jwtSecret.startsWith("dev-only") || config.otpPepper.startsWith("dev-only");
