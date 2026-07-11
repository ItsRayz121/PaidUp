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
  // The default below is a deliberately-unregisterable `.invalid` sentinel
  // (RFC 6761) so production fail-fasts if EMAIL_FROM was never set — it can
  // never collide with a real verified sending domain (e.g. login@rozipay.xyz).
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  emailFrom: process.env.EMAIL_FROM ?? "login@rozipay.invalid",
  emailFromName: process.env.EMAIL_FROM_NAME ?? "RoziPay",

  // Product rules (mirror the frontend demo values; real numbers are a
  // business decision — see docs/PROJECT_SPEC.md Open Questions).
  minWithdrawPoints: 2000,
  otpTtlMinutes: 10,
  otpMaxAttempts: 5,

  // Referral commission: referrer earns this share of a referred user's task
  // points, as a separate referral_bonus ledger entry. Fallbacks used only when
  // a network has no config row (2-level, launch defaults L1 15% / L2 5%).
  referralCommissionPct: 0.15, // level 1 (direct inviter)
  referralCommissionL2Pct: 0.05, // level 2 (the inviter's inviter)
  // Flat one-time bonus (points) to the direct inviter when their invited user
  // completes their FIRST credited task. Fallback when a network row is absent.
  referralFirstTaskBonusPoints: 100,
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
  // Tighter fraud (P2): flag when one payout wallet address is used by this many
  // distinct accounts. A farm funnels many fake accounts' points into a single
  // cash-out wallet, so a shared destination address is a strong signal — but we
  // still only flag for staff review (never block the withdrawal), since a
  // family legitimately sharing one wallet is possible in our markets.
  payoutAddressReuseThreshold: 3,

  // Postback replay window (P2): a signed postback whose timestamp is older or
  // newer than this many seconds is rejected (adapters that sign a timestamp,
  // e.g. surveyx). Defends against replay of a captured signed callback.
  postbackFreshnessSeconds: 300,

  // Withdrawal approval chain: at/below this an Agent may approve; above it a
  // Manager must approve (docs/PROJECT_SPEC.md).
  agentApprovalMaxPoints: 5000,

  // ---- Payout / USDT send -------------------------------------------------
  // Points -> USDT conversion at pay time. How many points equal 1 USDT. This is
  // a business number derived from the commission split; the value below is a
  // launch placeholder (1000 points = 1 USDT). Set POINTS_PER_USDT in prod.
  pointsPerUsdt: Number(process.env.POINTS_PER_USDT ?? 1000),
  // Payout mode. "manual" (default, v1 non-goal): a staff member sends USDT from
  // the treasury wallet and records the tx hash when marking paid. "onchain":
  // the API signs+broadcasts the USDT transfer itself when an admin clicks pay.
  // On-chain is OFF unless explicitly set AND a signer key is present, and it
  // must be proven on testnet before mainnet use — see api/src/payout.ts.
  payoutMode: (process.env.PAYOUT_MODE ?? "manual") as "manual" | "onchain",
  // Treasury signer for onchain mode (EVM hot wallet private key, 0x + 64 hex).
  // Empty => onchain mode refuses to send (falls back to requiring manual hash).
  payoutSignerKey: process.env.PAYOUT_SIGNER_KEY ?? "",
  // Per-chain JSON-RPC endpoints for onchain broadcast. Empty => that chain
  // cannot auto-send and staff must pay it manually.
  payoutRpc: {
    bep20: process.env.RPC_BEP20 ?? "",
    base: process.env.RPC_BASE ?? "",
  } as Record<string, string>,

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

  // Telegram login fallback (P2): a cheaper alternative to email if email hurts
  // signup. Empty => the /auth/telegram endpoint is off and the web button hides.
  // Set to the BotFather token of the login bot to turn it on. The bot's domain
  // must also be set in BotFather to your web origin for the widget to render.
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",

  // Comma-separated founder/admin emails seeded as role=admin on first run.
  adminEmails: (process.env.ADMIN_EMAILS ?? "fazalelahi5577@gmail.com")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
};

export const isProdSecretsMissing =
  config.jwtSecret.startsWith("dev-only") || config.otpPepper.startsWith("dev-only");
