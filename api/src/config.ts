// Loads .env (if present) using Node's built-in loader — no dotenv dependency.
import { existsSync } from "node:fs";

if (existsSync(new URL("../.env", import.meta.url))) {
  process.loadEnvFile(new URL("../.env", import.meta.url));
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-change-me",
  otpPepper: process.env.OTP_PEPPER ?? "dev-only-change-me-too",
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3000",

  brevoApiKey: process.env.BREVO_API_KEY ?? "",
  emailFrom: process.env.EMAIL_FROM ?? "login@paidup.app",
  emailFromName: process.env.EMAIL_FROM_NAME ?? "PaidUp",

  // Product rules (mirror the frontend demo values; real numbers are a
  // business decision — see docs/PROJECT_SPEC.md Open Questions).
  minWithdrawPoints: 2000,
  otpTtlMinutes: 10,
  otpMaxAttempts: 5,

  // Referral commission (P1): referrer earns this share of a referred user's
  // task points, as a separate referral_bonus ledger entry. Business decision.
  referralCommissionPct: 0.1,

  // Fraud: a single user can only get credited for the same offer TYPE this
  // many times per day. Over the cap => flagged, not credited (guardrail #5).
  velocityCapPerTypePerDay: 20,

  // Withdrawal approval chain: at/below this an Agent may approve; above it a
  // Manager must approve (docs/PROJECT_SPEC.md).
  agentApprovalMaxPoints: 5000,

  // Per-network postback secrets (HMAC). Empty in dev falls back to a known
  // dev secret so the demo adapter still verifies. Set real secrets in prod.
  postbackSecrets: {
    offerhub: process.env.POSTBACK_SECRET_OFFERHUB ?? "dev-postback-secret",
  } as Record<string, string>,

  // Comma-separated founder/admin emails seeded as role=admin on first run.
  adminEmails: (process.env.ADMIN_EMAILS ?? "fazalelahi5577@gmail.com")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
};

export const isProdSecretsMissing =
  config.jwtSecret.startsWith("dev-only") || config.otpPepper.startsWith("dev-only");
