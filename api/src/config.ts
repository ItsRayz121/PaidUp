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
};

export const isProdSecretsMissing =
  config.jwtSecret.startsWith("dev-only") || config.otpPepper.startsWith("dev-only");
