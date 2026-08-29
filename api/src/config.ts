// Loads .env (if present) using Node's built-in loader — no dotenv dependency.
import { existsSync } from "node:fs";

if (existsSync(new URL("../.env", import.meta.url))) {
  process.loadEnvFile(new URL("../.env", import.meta.url));
}

// Parse a comma-separated RPC list from the environment, falling back to the
// built-in public endpoints when it is unset or blank. Entries are trimmed, and
// anything that is not an http(s) URL is dropped rather than silently kept — a
// typo'd endpoint in the middle of a failover list would otherwise burn a retry
// on every single call.
function rpcList(raw: string | undefined, fallback: string[]): string[] {
  const parsed = (raw ?? "")
    .split(",")
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter((u) => /^https?:\/\//i.test(u));
  return parsed.length ? parsed : fallback;
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
  // 1000 points = 10 ROZI = 1 USDT (founder, 2026-08-01, second pass — lowered
  // from 5000/$5, which had itself been raised from 2000/$2 earlier the same day).
  //
  // ⚠️ GUARDRAIL #4 — a payout threshold must never be effectively unreachable.
  // Each move has been DOWNWARD for the same reason: CPX has no survey fill for
  // Pakistani traffic most of the day, so the honest read of our own numbers is
  // that a $5 threshold takes an ordinary user weeks. $1 is reachable in days.
  // The cost is more, smaller, manual payouts — an operational load we accept
  // deliberately, because a threshold nobody reaches is the single fastest way
  // to lose an earner base. Revisit upward only once real fill data says users
  // clear it comfortably.
  minWithdrawPoints: 1000,
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
  // Treasury signer for onchain mode — encrypted at rest (api/src/signer.ts),
  // NOT a plaintext private key in an env var. TWO separate variables: the
  // ciphertext, and the AES key that unlocks it. Both empty => onchain mode
  // refuses to send (falls back to requiring a manual hash), same as before.
  treasuryKeyEncrypted: process.env.TREASURY_KEY_ENCRYPTED ?? "",
  treasuryKeySecret: process.env.TREASURY_KEY_SECRET ?? "",
  // Ceiling for FULLY AUTOMATIC withdrawal (founder, 2026-08-05) — a request at
  // or under this settles the instant it's made, no staff step at all. Above
  // it, or if the account is held (users.withdrawal_hold_reason), it drops
  // into the same manual queue every withdrawal used to go through — nothing
  // about the manual path changed. The default is 50 USDT (50,000 internal
  // points), and an Admin can tune it without a deploy.
  autoWithdrawMaxPoints: Number(process.env.AUTO_WITHDRAW_MAX_POINTS ?? 50000),
  // The same automatic-settlement idea, applied to a refund of a user's OWN
  // USDT deposit (routes/mining.ts POST /usdt/refunds) instead of a points
  // withdrawal (founder, 2026-08-06: "money he deposited, he can withdraw it
  // anytime with no issues" — the only gate should be staff approval, and only
  // above a ceiling). Shares the same PAYOUT_MODE/signer/RPC gating as
  // withdrawals — see autoRefund.ts — so this stays a no-op (falls back to the
  // manual queue) until onchain payout is actually proven and turned on.
  // Denominated in MICRO-USDT, not points, because a refund never touches the
  // points ledger at all. $100 (founder, 2026-08-08: "no human involvement
  // unless it's a big amount, like $100 or more") — admin-tunable at runtime
  // now (autoSettleSettings.ts, /staff → Withdrawal fee); this env var is
  // only the fallback for a deployment that never touches that setting.
  autoRefundMaxMicro: Number(process.env.AUTO_REFUND_MAX_MICRO ?? 100_000_000), // $100
  // Rolling 24h cap on auto-settled refunds, same reasoning as
  // autoWithdrawMaxPointsPer24h below: the per-request ceiling above bounds
  // ONE request, this bounds the SUM of many.
  autoRefundMaxMicroPer24h: Number(process.env.AUTO_REFUND_MAX_MICRO_PER_24H ?? 15_000_000), // $15
  // Per-chain JSON-RPC endpoints. A LIST, not one URL (founder, 2026-08-01):
  // set RPC_BEP20 to a comma-separated list and callers try them in order,
  // moving to the next on a network error, a 429, or a 5xx.
  //
  // The defaults below are PUBLIC endpoints, so a chain read works out of the
  // box with nothing to sign up for. That is the point — but be clear-eyed
  // about what public endpoints are:
  //   • They rate-limit aggressively and without warning, which is why there
  //     are several and why failover exists at all. One is a single point of
  //     failure; five is a working system at small volume.
  //   • They are fine for READ traffic (checking a deposit exists, reading a
  //     balance) at our scale.
  //   • They are NOT fine as the only source for a chain LISTENER that must
  //     not miss a deposit — CUSTODY_SPEC.md § 4 still wants a paid provider
  //     before anything credits automatically. Missing a block on a public
  //     node is silent, and a silently-missed deposit is a user who paid us
  //     and got nothing.
  // Put a paid endpoint FIRST in the list when you have one; the public ones
  // then act as the fallback rather than the primary.
  //
  // ⚠️ ORDER MATTERS MORE THAN IT LOOKS (measured directly, 2026-08-12): the
  // three official BNB Chain "dataseed" nodes below all REFUSE eth_getLogs
  // outright — not "too wide a range", every width tested down to 50 blocks
  // failed with a real JSON-RPC error body. rpc.ts's failover deliberately
  // does NOT try the next endpoint after a well-formed JSON-RPC error (that's
  // "the chain answered", not a transport failure) — so whichever of these
  // is reached FIRST for eth_getLogs kills the whole call right there, and
  // every endpoint listed after it never gets a chance. They still work fine
  // for cheaper calls (eth_blockNumber, eth_getBlockByNumber), which is why
  // they stay in the list — just last, not first. publicnode/blastapi/1rpc
  // are ordered first because they answer eth_getLogs for real (publicnode:
  // wide range but blocks some cloud/datacenter IPs with a 403, which fails
  // over correctly; blastapi: exactly 10 inclusive blocks; 1rpc: 50).
  payoutRpc: {
    bep20: rpcList(process.env.RPC_BEP20, [
      "https://bsc-rpc.publicnode.com",
      "https://bsc-mainnet.public.blastapi.io",
      "https://1rpc.io/bnb",
      "https://bsc-dataseed.bnbchain.org",
      "https://bsc-dataseed1.defibit.io",
      "https://bsc-dataseed1.ninicoin.io",
    ]),
    base: rpcList(process.env.RPC_BASE, [
      "https://mainnet.base.org",
      "https://base-rpc.publicnode.com",
      "https://1rpc.io/base",
    ]),
  } as Record<string, string[]>,

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

  // Staff paging (alerts.ts): the chat id a Telegram group receives
  // HIGH-severity fraud/reconciliation alerts in, the instant fraud.ts's
  // flagOnce raises a NEW one. Reuses telegramBotToken above. Empty => a
  // quiet no-op, same "ships OFF" pattern as every other optional integration
  // here. See .env.example for how to get a group's chat id.
  telegramAlertChatId: process.env.TELEGRAM_ALERT_CHAT_ID ?? "",

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

  // ---- Per-user deposit addresses (docs/CUSTODY_SPEC.md § 5, step 1) --------
  // ONE public extended key (xpub) per chain, at the account-derivation branch
  // (m/44'/60'/0' for BEP20/EVM). From this alone the server can derive an
  // unlimited number of user addresses — but can never sign a transaction,
  // because no private key is ever present in this process.
  //
  // ⚠️ FOUNDER DECISION 2026-08-03: "an xpub, never a seed phrase." Generate the
  // seed OFFLINE (hardware wallet or an air-gapped tool), derive this ONE
  // account-level xpub from it, and only THIS value goes into Railway. The seed
  // itself must never be typed into this codebase, an env var, or a chat.
  //
  // Empty => the feature is off and every user falls back to the one shared
  // treasury address (usdtTreasuryAddress) exactly as today. Setting this does
  // NOT by itself turn on auto-withdrawal (stage 4 of CUSTODY_SPEC.md, gated
  // separately by PAYOUT_MODE + a treasury signer). It DOES enable
  // auto-crediting (stages 2-3, deposits/scanner.ts + credit.ts) for USDT
  // landing on a personal address — that deposit is detected and credited with
  // no staff step. A deposit to the one shared treasury address above still
  // needs a staff member pasting the tx hash; only per-user addresses are
  // watched by the scanner.
  custodyXpub: {
    bep20: process.env.CUSTODY_XPUB_BEP20 ?? "",
  },

  // BscScan API key — used ONLY for the on-demand BNB history lookup on
  // /wallet/bnb (api/src/bscscan.ts), when a user opens that screen. Never on
  // a timer: the native BNB deposit scanner is deliberately off (it cost real
  // money running 24/7), so this read-when-asked lookup is how incoming BNB
  // shows up in history at all. Empty => the BNB screen just shows our own
  // withdrawal rows, no error. Free key at bscscan.com/myapikey.
  bscscanApiKey: process.env.BSCSCAN_API_KEY ?? "",

  // ---- Sweep signing (docs/CUSTODY_SPEC.md § 5, steps 2-4) -------------------
  // ⚠️ THIS IS A STRICTLY BIGGER SECRET THAN THE TREASURY KEY. Where the
  // treasury key can only move the treasury's own balance and is rotatable
  // after a leak, a chain-family seed can derive the PRIVATE key of every
  // deposit address on that chain, past and future, and cannot be rotated
  // after the fact — the addresses are already published to users. This is
  // the encrypted-at-rest extension of custody.ts's account-branch xpub: the
  // SAME account branch (m/44'/60'/0' for EVM), just its private half, so a
  // child derived here (custodySeeds.ts) always produces the identical
  // address custody.ts's public-only derivation already shows the user.
  //
  // ONE KEY PAIR PER CHAIN FAMILY, not one shared seed — a leaked UTXO seed
  // must not also compromise every EVM deposit address. Empty => sweeping is
  // off for that family; deposits still accrue on-chain, just unswept, same
  // as today before any of this existed.
  custodySweepSeedEncrypted: {
    evm: process.env.CUSTODY_SEED_EVM_ENCRYPTED ?? "",
    tron: process.env.CUSTODY_SEED_TRON_ENCRYPTED ?? "",
    utxo: process.env.CUSTODY_SEED_UTXO_ENCRYPTED ?? "",
  } as Record<string, string>,
  custodySweepSeedSecret: {
    evm: process.env.CUSTODY_SEED_EVM_SECRET ?? "",
    tron: process.env.CUSTODY_SEED_TRON_SECRET ?? "",
    utxo: process.env.CUSTODY_SEED_UTXO_SECRET ?? "",
  } as Record<string, string>,

  // Whether deposits/sweep.ts's automatic treasury consolidation runs at all
  // (founder, 2026-08-08: "never sweep" — deposits stay at the user's own
  // address so a refund can genuinely be signed by that address, and
  // payoutRelay.ts's withdrawal pass-through routes THROUGH it too). Default
  // OFF. The code is left in place, not deleted, for a possible future
  // admin-triggered manual consolidation — this flag is the automatic-tick
  // kill switch, checked at the top of tickSweep/sweepDepositAddress.
  custodySweepEnabled: (process.env.CUSTODY_SWEEP_ENABLED ?? "false") === "true",

  // Unlocks EVERY row in deposit_address_pool at once (Solana/Aptos — ed25519
  // has no public-only child derivation, so those addresses are pre-generated
  // offline instead of derived; see custodySeeds.ts). One key for the whole
  // pool, same shape as TREASURY_KEY_SECRET unlocking the one treasury key.
  poolKeyEncryptedSecret: process.env.POOL_KEY_ENCRYPTED_SECRET ?? "",

  // How many blocks/confirmations a deposit needs before it is credited.
  // Never credit before this — a reorg underneath an uncredited deposit costs
  // nothing; a reorg underneath a CREDITED one is money paid for a deposit
  // that no longer exists on-chain. bep20 defaults to ~15 blocks (≈45s at 3s
  // blocks), a common exchange practice for a BEP20-value stablecoin.
  depositConfirmations: {
    bep20: Number(process.env.DEPOSIT_CONFIRMATIONS_BEP20 ?? 15),
  } as Record<string, number>,

  // How often the deposit scanner ticks, per chain family cadence. One value
  // today (EVM); other chain families will want their own once built (a
  // 10-minute-block UTXO chain scanning every 20s is pure wasted RPC calls).
  depositScanIntervalMs: Number(process.env.DEPOSIT_SCAN_INTERVAL_MS ?? 20_000),

  // Support tickets sitting in 'answered' (staff replied last, user never
  // came back) auto-close after this many days — see ticketAutoClose.ts. 0
  // turns it off. A ticket a user never replies to is not the same as an
  // unresolved one; leaving it open forever just pads the "open" count staff
  // watch on the dashboard.
  ticketAutoCloseDays: Number(process.env.TICKET_AUTO_CLOSE_DAYS ?? 7),

  // Kill switch for deposits/adapters/evmNative.ts (the BNB block-by-block
  // walker). Default OFF (founder, 2026-08-13 — real billing incident: this
  // scanner calls eth_getBlockByNumber(..., true) once per BLOCK, every
  // tick, forever, the moment ANY user has a deposit_wallets row — unlike
  // the USDT scanner's eth_getLogs (one ranged query per tick), there is no
  // way to batch or shrink this: every block on the chain must be fetched
  // individually, so its RPC-call volume is driven by the chain's own block
  // rate, not by real user activity — it burned real Alchemy CU with zero
  // deposits, zero withdrawals, zero transactions of any kind. And
  // creditNative.ts's own header says this scan is NOT money-authoritative —
  // /wallet/bnb's balance is a live eth_getBalance read regardless of
  // whether this ever runs (bnbWithdraw.ts's userGasWallet). Its only output
  // is a "BNB received" push notification. Flip this on only behind a
  // provider that prices/allows it, and only if that notification is worth
  // the sustained per-block cost.
  nativeDepositScanEnabled: (process.env.NATIVE_DEPOSIT_SCAN_ENABLED ?? "false") === "true",

  // How many blocks the native (BNB) walker covers per tick. Tunable without a
  // redeploy because BSC's block rate is not fixed: post-Maxwell (2025) it
  // produces ~200k blocks/day (≈0.45s/block), so the old hard-coded 100 could
  // not keep pace with the chain even in steady state — the cursor would fall
  // progressively further behind. At the default DEPOSIT_SCAN_INTERVAL_MS this
  // needs to be ≳ (blocks/day ÷ ticks/day) to stay caught up; 600 gives margin.
  // ⚠️ Every unit here is one more eth_getBlockByNumber(..., true) per tick,
  // 24/7 — the exact cost the nativeDepositScanEnabled comment above is about.
  // Raise it only as far as the RPC provider's free allowance actually
  // sustains, and watch the provider dashboard after changing it.
  nativeDepositScanBlockRange: Math.max(1, Number(process.env.NATIVE_DEPOSIT_SCAN_BLOCK_RANGE ?? 100)),

  // Below this, sweeping a deposit costs more in gas than it moves — CUSTODY_SPEC.md
  // § 2a prices a BEP20 sweep at ~$0.15-0.25. Micro-USDT.
  sweepDustFloorMicro: Number(process.env.SWEEP_DUST_FLOOR_MICRO ?? 500_000), // $0.50
  // Native gas (BNB, in wei-equivalent smallest unit as a decimal string) sent
  // to a deposit address before it can send the token it holds out. Used by
  // the (off-by-default) treasury sweeper, AND reused by payoutRelay.ts's
  // hasEnoughGas() as the "the user's own wallet must hold at least this much
  // BNB before we start a withdrawal/refund" floor (founder, 2026-08-08,
  // second pass: gas is the user's own responsibility, not a treasury top-up
  // or a USDT surcharge) — one number for "what a BEP20 USDT transfer costs,
  // with buffer" rather than two that could drift apart.
  evmSweepGasAmountWei: process.env.EVM_SWEEP_GAS_AMOUNT_WEI ?? "300000000000000", // 0.0003 BNB

  // How many times payoutRelay.ts retries ONE job phase before giving up and
  // marking it 'failed' instead of retrying forever. Ticks run every
  // depositScanIntervalMs (20s default), so 15 surfaces a stuck job to staff
  // within ~5 minutes — long enough to ride out a transient RPC blip, short
  // enough that a genuinely unfundable job (e.g. an empty treasury) doesn't
  // spin silently for hours the way it did before this existed.
  relayMaxAttempts: Number(process.env.RELAY_MAX_ATTEMPTS ?? 15),

  // ---- Withdrawal abuse controls, now that there is no per-request human
  // approval below the auto-withdraw ceiling (docs/CUSTODY_SPEC.md § 3.3: "a
  // limit is where an attacker will aim, repeatedly, just under it"). --------
  // Cumulative cap across a rolling 24h window, DISTINCT from the per-request
  // autoWithdrawMaxPoints ceiling above — closes "many requests just under the
  // limit". A request that would push the user's own trailing-24h auto-paid
  // total over this falls back to the manual queue, same as any other refusal.
  autoWithdrawMaxPointsPer24h: Number(process.env.AUTO_WITHDRAW_MAX_POINTS_PER_24H ?? 50000),
  // Soft flag (never blocks): this many withdrawal REQUESTS from one user in
  // 24h gets a staff-review flag, regardless of amount or auto/manual outcome.
  withdrawalVelocityFlagCount: Number(process.env.WITHDRAWAL_VELOCITY_FLAG_COUNT ?? 4),
  // At or above this amount, a withdrawal needs a fresh email code before it
  // can be created at all — reusing the exact email_codes machinery every
  // login/reset already relies on, not a new channel. 0 = never required.
  stepUpMinPoints: Number(process.env.STEP_UP_MIN_POINTS ?? 4000),
};

export const isProdSecretsMissing =
  config.jwtSecret.startsWith("dev-only") || config.otpPepper.startsWith("dev-only");
