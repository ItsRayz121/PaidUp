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
  // Allowed browser origin(s) for CORS in production. Accepts a comma-separated
  // list so the apex domain, www, and (during a domain switch) the old Vercel
  // URL can all be allowed at once, e.g.
  //   WEB_ORIGIN=https://rozipay.xyz,https://www.rozipay.xyz
  webOrigins: (process.env.WEB_ORIGIN ?? "http://localhost:3000")
    .split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean),

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
    // CPX Research (REAL network). This is the "app secure hash" from the CPX
    // dashboard. Production refuses to boot if it's still the dev default.
    cpx: process.env.POSTBACK_SECRET_CPX ?? "dev-postback-secret",
  } as Record<string, string>,

  // ---- CPX Research -------------------------------------------------------
  // Public app id (safe to expose to the browser — it's in the survey-wall URL).
  cpxAppId: process.env.CPX_APP_ID ?? "34405",
  // Sanity cap: refuse to credit a single survey worth more than this many
  // points. CPX signs only trans_id, not the amount, so this bounds the blast
  // radius if the secure hash ever leaks. 600 points = $1 of our revenue, so
  // 20000 (~$33 of user reward) is far above any real survey.
  cpxMaxPointsPerSurvey: Number(process.env.CPX_MAX_POINTS ?? 20000),
  // Pin postbacks to CPX's published IPs. OFF by default — Railway sits behind a
  // proxy, so turn this on only after confirming the observed IP in the postback
  // log, or you'd silently reject real paid completions.
  cpxEnforceIp: (process.env.CPX_ENFORCE_IP ?? "false").toLowerCase() === "true",

  // How many reverse proxies sit in front of us. req.ip is what the IP fraud
  // rules (ip_reuse, referral-ring-by-IP) and the postback IP pin read, and
  // Fastify defaults to the socket peer — which behind Railway is RAILWAY'S edge,
  // identical for every user. Untrusted, those rules compare everyone to everyone.
  //
  // This is a hop COUNT, not `true`, on purpose. `trustProxy: true` takes the
  // left-most X-Forwarded-For entry, which the client writes — so a user could
  // send `X-Forwarded-For: 1.2.3.4` and choose their own apparent IP, defeating
  // the very rules this exists to feed. Counting hops from the right reads the
  // address OUR proxy observed, which the client cannot forge.
  //
  //   1 = Railway only (api.rozipay.xyz on "DNS only" / grey cloud)  <- default
  //   2 = Cloudflare proxy (orange cloud) in front of Railway
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 1),

  // Ceiling on a SINGLE hand-made points adjustment by staff. A manual credit
  // mints money that is redeemable for real USDT, so an admin session is now a
  // treasury key. This bounds what one stolen session (or one typo — an extra
  // zero) can cost before anyone notices. Raise it deliberately, not casually.
  adminAdjustMaxPoints: Number(process.env.ADMIN_ADJUST_MAX_POINTS ?? 50000),

  // Static per-network tokens for networks that gate with a shared token in
  // addition to a signature (e.g. tapvid rewarded-video).
  postbackTokens: {
    tapvid: process.env.POSTBACK_TOKEN_TAPVID ?? "dev-postback-token",
  } as Record<string, string>,

  // ---- Web push notifications ----------------------------------------------
  // VAPID keypair for browser push (the "server identity" the push services
  // require). Generate once with:  npx web-push generate-vapid-keys
  // Both empty => the whole feature is OFF: the API reports it disabled, the
  // web app hides the toggle, and sends are no-ops. The PUBLIC key is safe to
  // hand to browsers; the private key is a server secret like any other.
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? "",
  // Contact URI the push services may use to reach us about misbehaving senders.
  vapidSubject: process.env.VAPID_SUBJECT ?? "mailto:fazalelahi5577@gmail.com",

  // Telegram login fallback (P2): a cheaper alternative to email if email hurts
  // signup. Empty => the /auth/telegram endpoint is off and the web button hides.
  // Set to the BotFather token of the login bot to turn it on. The bot's domain
  // must also be set in BotFather to your web origin for the widget to render.
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",

  // Comma-separated founder/admin emails seeded as role=admin on first run.
  adminEmails: (process.env.ADMIN_EMAILS ?? "fazalelahi5577@gmail.com")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),

  // ---- KYC ------------------------------------------------------------------
  // AES-256-GCM key for the ID photos, as 64 hex chars (32 bytes). Generate with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  //
  // We are storing Pakistani national ID cards. The key lives HERE (an env var),
  // never in the database, so a leaked DB backup on its own decrypts to nothing.
  // Empty in dev => a fixed dev key, and production refuses to boot (see below):
  // shipping real IDs under a key that is in the git history would be worse than
  // not encrypting at all, because it would look safe.
  kycEncryptionKey: process.env.KYC_ENCRYPTION_KEY ?? "",

  // Max bytes per uploaded photo, AFTER base64 decode. Phone cameras produce
  // 2-5MB; the web compresses before upload, and this is the hard backstop.
  kycMaxImageBytes: Number(process.env.KYC_MAX_IMAGE_BYTES ?? 4_000_000),

  // Require an approved KYC before a withdrawal can be requested. On by default:
  // you should know who you are sending money to.
  kycRequiredForWithdrawal:
    (process.env.KYC_REQUIRED_FOR_WITHDRAWAL ?? "true").toLowerCase() === "true",
};

export const isProdSecretsMissing =
  config.jwtSecret.startsWith("dev-only") || config.otpPepper.startsWith("dev-only");
