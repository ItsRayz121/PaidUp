import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { config, isProdSecretsMissing } from "./config.ts";
import { authRoutes } from "./auth.ts";
import { appRoutes } from "./routes/app.ts";
import { webhookRoutes } from "./routes/webhooks.ts";
import { withdrawalRoutes } from "./routes/withdrawals.ts";
import { staffRoutes } from "./routes/staff.ts";
import { miningRoutes } from "./routes/mining.ts";
import { staffMiningRoutes } from "./routes/staffMining.ts";
import { staffTaskRoutes } from "./routes/staffTasks.ts";
import { staffGrowthRoutes } from "./routes/staffGrowth.ts";
import { staffNotifyRoutes } from "./routes/staffNotify.ts";
import { kycRoutes } from "./routes/kyc.ts";
import { staffKycRoutes } from "./routes/staffKyc.ts";
import { pushRoutes } from "./routes/push.ts";
import { profileRoutes } from "./routes/profile.ts";
import { pushEnabled } from "./push.ts";
import { usingDevKycKey } from "./kyc.ts";
import { settleDueEpochs } from "./mining/engine.ts";
import { configureTelegramMenuButton } from "./telegram.ts";
import { initDb, sql, usingRealPostgres, getSetting } from "./db.ts";
import { tickDepositScan } from "./deposits/scanner.ts";
import { tickSweep } from "./deposits/sweep.ts";
import { tickReconcile } from "./deposits/reconcile.ts";
import { tickPayoutRelay } from "./payoutRelay.ts";
import { tickBnbWithdrawals } from "./bnbWithdraw.ts";
import { tickTicketAutoClose } from "./ticketAutoClose.ts";

// Print boot context first so the deploy log shows how far we got and on what
// Node version (node:sqlite needs Node >= 22.5; we pin 24).
console.log(`Booting rozipay-api · node ${process.version} · NODE_ENV=${process.env.NODE_ENV ?? "(unset)"} · PORT=${process.env.PORT ?? config.port}`);

// SECURITY: never boot in production with default (source-visible) secrets —
// they allow session forgery, admin impersonation, and forged postbacks.
// List exactly which are unset so the deploy log is actionable.
if (process.env.NODE_ENV === "production") {
  const missing: string[] = [];
  if (config.jwtSecret.startsWith("dev-only")) missing.push("JWT_SECRET");
  if (config.otpPepper.startsWith("dev-only")) missing.push("OTP_PEPPER");
  for (const [name, secret] of Object.entries(config.postbackSecrets)) {
    if (secret.startsWith("dev-")) missing.push(`POSTBACK_SECRET_${name.toUpperCase()}`);
  }
  for (const [name, token] of Object.entries(config.postbackTokens)) {
    if (token.startsWith("dev-")) missing.push(`POSTBACK_TOKEN_${name.toUpperCase()}`);
  }
  // The KYC key is in this list, not warned about, because the failure is silent
  // and permanent: without it we would encrypt real Pakistani ID cards under a key
  // that is published in this repository's git history. That is worse than storing
  // them in plaintext, because it LOOKS encrypted. Refuse to start.
  if (usingDevKycKey()) missing.push("KYC_ENCRYPTION_KEY");

  if (missing.length) {
    console.error(`FATAL: not starting — these secrets are still defaults: ${missing.join(", ")}. Set them in the host environment and redeploy.`);
    process.exit(1);
  }
  // A sender on an unverified domain is rejected by the provider at send time,
  // which surfaces to the user as a generic login failure. Fail here instead.
  if (config.resendApiKey && config.emailFrom.endsWith("@rozipay.invalid")) {
    console.error(`FATAL: not starting — EMAIL_FROM is still the ${config.emailFrom} default. Set it to an address on a domain verified in Resend.`);
    process.exit(1);
  }
}

// Data outlives deploys only on a real Postgres server. PGlite writes to the
// container's disk, which Railway wipes on every redeploy.
if (process.env.NODE_ENV === "production" && !usingRealPostgres) {
  console.error("FATAL: not starting — DATABASE_URL is unset, so data would live on ephemeral disk and be lost on the next deploy. Add the Railway Postgres plugin.");
  process.exit(1);
}

await initDb();

// trustProxy is required for req.ip to be the USER's address rather than the
// edge proxy's. The IP fraud rules and the postback IP pin are only meaningful
// if that is right. See config.trustProxyHops for why it is a hop count and not
// `true` (a client can forge the left-most X-Forwarded-For entry).
const app = Fastify({ logger: true, trustProxy: config.trustProxyHops });

// In production, only allow the configured web origin(s). In dev, reflect any
// origin so the app is reachable from localhost AND your phone on the LAN.
await app.register(cors, {
  origin: process.env.NODE_ENV === "production" ? config.webOrigins : true,
  credentials: true,
});

// Rate limiting (guardrail #5). Registered with global: false ON PURPOSE:
// carrier-grade NAT in our launch markets puts hundreds of legitimate users
// behind one IP, and ad-network postbacks arrive in bursts from a handful of
// addresses — a blanket per-IP cap would lock out real earners and silently
// drop paid completions. So only the endpoints an attacker can abuse WITHOUT
// an account opt in, each with its own budget (see auth.ts / kyc.ts):
//   - login (password brute force — scrypt makes each guess costly, this
//     makes volume impossible)
//   - register / forgot (each call sends an email: inbox bombing + it burns
//     our Resend quota and sender reputation)
//   - verify / reset (6-digit code guessing, on top of the per-code attempt cap)
//   - kyc submit (20MB body + three AES passes per call)
await app.register(rateLimit, {
  global: false,
  errorResponseBuilder: () => ({
    statusCode: 429,
    error: "Too many tries. Please wait a minute and try again.",
  }),
});

// An empty body on a JSON request is an empty object, not an error.
//
// Fastify's default JSON parser rejects `content-type: application/json` with a
// zero-length body — the route never runs and the client gets a bare
// "Bad Request". That is what broke "Start mining": a POST with nothing to send.
//
// The client no longer sends the header when there is no body, but this is the
// half of the fix that cannot regress: any future body-less POST just works.
// Safe for postbacks — those are verified over parsed FIELD VALUES (body merged
// with query), never over a raw body string, so nothing here touches a signature.
app.addContentTypeParser(
  "application/json", { parseAs: "string" },
  (_req, body: string, done) => {
    if (!body || body.trim() === "") return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch {
      done(Object.assign(new Error("Body is not valid JSON"), { statusCode: 400 }), undefined);
    }
  },
);

app.get("/health", async () => ({ ok: true, service: "rozipay-api" }));

// ---- Maintenance mode (brief part 45) --------------------------------------
// One switch that closes the app to earners. A global hook rather than a check
// in each route's guard: there are five separate `guard()` helpers across the
// route files, and a mode that half the endpoints honour is worse than none.
//
// WHAT STAYS OPEN, DELIBERATELY:
//   /staff/*   — the reason you turn this on is usually so staff can go and fix
//                something. Locking them out with it would be self-defeating.
//   /auth/*    — a staff member has to be able to sign in to reach /staff.
//   /health    — the platform's own probe; failing it would make Railway
//                restart the API in a loop while it is deliberately closed.
//   /webhooks/*— ad-network postbacks. These are OTHER PEOPLE'S servers
//                reporting work a user has already done, most will not retry,
//                and refusing them means users silently lose earnings they
//                already earned. This is the important exception.
//   /features  — so the app can read that maintenance is on and say so.
const MAINTENANCE_OPEN = /^\/(health|auth|staff|webhooks|features)\b/;
app.addHook("onRequest", async (req, reply) => {
  if (MAINTENANCE_OPEN.test(req.url.split("?")[0])) return;
  if ((await getSetting("maintenance_mode", "0")) !== "1") return;
  const message = await getSetting("maintenance_message", "");
  return reply.code(503).send({
    error: message || "We are doing some work on the app. Please check back soon.",
    maintenance: true,
  });
});

await app.register(authRoutes);
await app.register(appRoutes);
await app.register(webhookRoutes);
await app.register(withdrawalRoutes);
await app.register(staffRoutes);
await app.register(miningRoutes);
await app.register(staffMiningRoutes);
await app.register(staffTaskRoutes);
await app.register(staffGrowthRoutes);
await app.register(staffNotifyRoutes);
await app.register(kycRoutes);
await app.register(staffKycRoutes);
await app.register(pushRoutes);
await app.register(profileRoutes);

// ---- Mining: accrual sweep + epoch settlement ------------------------------
// Each tick does two things, IN ORDER:
//   1. Accrue every open mining session, so a user who tapped "Start mining" and
//      closed the app still has their time on the books. Shares used to be written
//      only when the user polled, which meant a closed app earned nothing.
//   2. Settle any day that has been closed for longer than the grace period.
//
// Running on a timer (rather than an external cron) keeps the deploy a single
// service, and it is safe to run often: settlement is idempotent on the
// mining_epochs primary key, and it takes a global advisory lock so two instances
// cannot jointly mint past the supply cap.
const SETTLE_INTERVAL_MS = 15 * 60 * 1000;
async function tickSettlement() {
  try {
    const results = await settleDueEpochs();
    for (const r of results) {
      if (r.skipped) continue;
      app.log.info(
        `Mining epoch ${r.epoch} settled: ${r.emitted} ROZI to ${r.miners} miners ` +
        `(${r.withheld} withheld, ${r.totalShares} total shares)`,
      );
    }
  } catch (err) {
    // Never let a settlement failure take the API down — the next tick retries,
    // and the epoch stays unsettled (not half-settled) because it is one tx.
    app.log.error({ err }, "Mining settlement tick failed");
  }
  // Housekeeping on the same tick: drop dead login/reset codes. Every code
  // expires within minutes, so anything older than a day is unreachable — it
  // only makes the table (and the per-login index lookups) grow forever.
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await sql.run("DELETE FROM email_codes WHERE created_at < ?", cutoff);
    // Same reasoning for the wallet-connect challenges: they expire in ten
    // minutes, so a day-old row can never be claimed again and only makes the
    // table grow. Deleting a SPENT one is safe — replay is refused by the
    // expiry too, not by the row's continued existence.
    await sql.run("DELETE FROM wallet_link_nonces WHERE created_at < ?", cutoff);
  } catch (err) {
    app.log.error({ err }, "email_codes purge failed");
  }
}
setInterval(tickSettlement, SETTLE_INTERVAL_MS).unref();

// ---- Deposits: chain scan + sweep — CUSTODY_SPEC.md § 5, steps 2-3 --------
// Same posture as the settlement timer above: one setInterval each, in this
// same process, no external cron/queue. tickDepositScan takes its own global
// advisory lock internally (deposits/scanner.ts) so multiple API instances
// never scan the same block range twice. tickSweep is deliberately NOT
// wrapped in one lock/transaction — each address's sweep is its own small
// atomic step, so one address failing does not block the others, and a
// concurrent instance racing to open the same sweep job just loses a DB
// constraint, not a network broadcast.
//
// Both are no-ops (return immediately) until their respective config is set —
// CUSTODY_XPUB_BEP20 for scanning, CUSTODY_SEED_EVM_ENCRYPTED/_SECRET plus a
// treasury signer for sweeping — so enabling this feature is adding env vars,
// never a code change.
async function tickDeposits() {
  try {
    await tickDepositScan();
  } catch (err) {
    app.log.error({ err }, "Deposit scan tick failed");
  }
  try {
    await tickSweep();
  } catch (err) {
    app.log.error({ err }, "Sweep tick failed");
  }
}
setInterval(tickDeposits, config.depositScanIntervalMs).unref();

// ---- Payout relay — payoutRelay.ts ------------------------------------------
// Advances every in-flight withdrawal/refund relay job one phase (gas ->
// prefund -> forward, per-phase confirmation waits). Same cadence as the
// deposit scan above — a user is actively watching this one, unlike the
// hourly reconciliation below. A no-op per job until the RPC receipt it's
// waiting on lands; a no-op entirely when no jobs are open.
async function tickPayoutRelayJob() {
  try {
    await tickPayoutRelay();
  } catch (err) {
    app.log.error({ err }, "Payout relay tick failed");
  }
  try {
    await tickBnbWithdrawals();
  } catch (err) {
    app.log.error({ err }, "BNB withdrawal tick failed");
  }
}
setInterval(tickPayoutRelayJob, config.depositScanIntervalMs).unref();

// ---- Reconciliation — CUSTODY_SPEC.md § 5 step 3 / § 3.5 -------------------
// Hourly, much slower than the deposit/sweep ticks above: this is a
// treasury-balance-vs-ledger check, not something that needs to be fresh to
// the second. A no-op until a treasury signer is configured (reconcile.ts).
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
setInterval(() => {
  void tickReconcile().catch((err) => app.log.error({ err }, "Reconciliation tick failed"));
}, RECONCILE_INTERVAL_MS).unref();

// ---- Support tickets: auto-close a stale 'answered' ticket — ticketAutoClose.ts
// Same cadence as reconciliation above: not time-critical, one pass an hour is
// plenty for a days-long staleness window.
setInterval(() => {
  void tickTicketAutoClose().catch((err) => app.log.error({ err }, "Ticket auto-close tick failed"));
}, RECONCILE_INTERVAL_MS).unref();

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  void tickSettlement();
  void tickDeposits();
  void tickPayoutRelayJob();
  void tickReconcile().catch((err) => app.log.error({ err }, "Reconciliation tick failed"));
  // Bot self-setup (menu button -> the web app). Fire-and-forget: Telegram
  // being slow or down must never delay or fail OUR boot.
  void configureTelegramMenuButton();
  if (isProdSecretsMissing) {
    app.log.warn("Using DEV secrets. Set JWT_SECRET and OTP_PEPPER in .env before real use.");
  }
  if (!config.resendApiKey) {
    app.log.warn("No RESEND_API_KEY set — login codes will print to this console, not email.");
  } else {
    app.log.info(`Email via Resend, from ${config.emailFrom}`);
  }
  if (!pushEnabled) {
    app.log.warn("Web push OFF — set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY to enable notifications.");
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
