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
import { staffDisbursementRoutes } from "./routes/staffDisbursements.ts";
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
import { emailConfigured } from "./email.ts";

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
  // Email: a WARNING, not a fatal. Sending now fails closed in production
  // (email.ts, audit finding A-01), so an unconfigured provider is an honest
  // error at the moment a user asks for a code rather than a silent success —
  // and the Telegram sign-in path does not touch email at all, so the app is
  // still usable without it. Refusing to boot would take down a working
  // deployment over a feature that has its own working fallback. What must not
  // happen is that this stays invisible, so it is loud, once, on every start.
  if (!emailConfigured()) {
    console.warn(
      "WARNING: RESEND_API_KEY is not set. Email codes CANNOT be sent, so signup " +
      "verification, password reset, email linking and withdrawal step-up will all " +
      "return an error when used. Telegram sign-in is unaffected. Set RESEND_API_KEY " +
      "and a verified EMAIL_FROM domain to enable them.",
    );
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
// edge proxy's. The IP fraud rules, the per-IP rate limits and the postback IP
// pin are only meaningful if that is right. See config.trustProxy for why it is
// a list of trusted networks and not a hop count (Fastify 5.12.1 neutered hop
// counts) and not `true` (a client can forge the left-most X-Forwarded-For).
const app = Fastify({ logger: true, trustProxy: config.trustProxy });

// ⚠️ A MISCONFIGURED TRUST LIST IS SILENT, WHICH IS WHY THIS EXISTS.
// If the edge in front of this API presents an address the list does not cover,
// nothing errors: req.ip simply becomes that edge's address, the same value for
// every request. Per-IP rate limiting then shares one bucket for the whole
// internet — the login limiter turns into a self-inflicted lockout — and every
// IP fraud rule sees one enormous address. The symptom is indistinguishable
// from "we have a lot of users behind one NAT", which is a real thing in our
// markets, so it would not be noticed by looking at the data.
//
// The tell is unambiguous, though: an X-Forwarded-For header arrived AND req.ip
// still equals the socket peer. Logged at most once every ten minutes, because
// if it is wrong it is wrong on every single request.
let lastProxyWarnAt = 0;
// ...and the other half: CONFIRMATION. The warning below only fires when the
// list is wrong, so a correct deployment gets silence — which is
// indistinguishable from "the hook never ran". Logged once per process, on the
// first request that actually carries an X-Forwarded-For, so the deploy log
// says in one line what this API believes a user's address is and what it
// derived that from. That is the difference between "I think the proxy config
// is right" and knowing it.
let loggedProxyResolution = false;
app.addHook("onRequest", async (req) => {
  if (!req.headers["x-forwarded-for"]) return;
  const peer = req.socket?.remoteAddress ?? "";
  if (!loggedProxyResolution) {
    loggedProxyResolution = true;
    app.log.info(
      { peer, xForwardedFor: req.headers["x-forwarded-for"], resolvedIp: req.ip, trustProxy: config.trustProxy },
      "proxy check: this is the address rate limits and IP fraud rules will use. " +
      "resolvedIp should be the USER's address, not peer.",
    );
  }
  if (!peer || req.ip !== peer) return;
  const now = Date.now();
  if (now - lastProxyWarnAt < 10 * 60_000) return;
  lastProxyWarnAt = now;
  app.log.warn(
    { peer, xForwardedFor: req.headers["x-forwarded-for"], trustProxy: config.trustProxy },
    "TRUST_PROXY does not cover the proxy in front of this API: req.ip is the edge's own " +
    "address, identical for every user, so per-IP rate limits and IP fraud rules are not " +
    "working. Add the peer address/network shown here to TRUST_PROXY.",
  );
});

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
await app.register(staffDisbursementRoutes);
await app.register(staffGrowthRoutes);
await app.register(staffNotifyRoutes);
await app.register(kycRoutes);
await app.register(staffKycRoutes);
await app.register(pushRoutes);
await app.register(profileRoutes);

// ---- Background timers: never let one overlap itself ----------------------
// ⚠️ EVERY `setInterval` BELOW GOES THROUGH THIS. IT IS NOT OPTIONAL PLUMBING.
//
// `setInterval` fires on a fixed clock with no idea whether the previous tick has
// finished. Each of these ticks opens a transaction, and a transaction holds one
// pooled connection for its whole duration — so a tick that runs longer than its
// interval used to be joined by a second one holding a second connection, then a
// third, until the pool was gone and the API stopped answering requests that had
// nothing to do with mining or deposits. That is not a hypothetical shape: the
// mining accrual sweep was measured at 6 minutes for 100,000 sessions against a
// 15-minute interval, and it is the tick most likely to grow past its own window
// first. Audit 2026-09-04, finding B8.
//
// A skipped tick is always safe here and that is what makes this the right fix
// rather than a bigger interval: settlement is idempotent on the `mining_epochs`
// primary key, the deposit scan is cursor-based, the relay re-reads its jobs, the
// reconciliation snapshot is a periodic sample, and the ticket sweep is a plain
// re-query. Every one of them simply does the same work on the next tick.
//
// The duration log is deliberate too — the audit's closing note was that nothing
// in this codebase would tell you which bottleneck you were approaching, and a
// tick quietly taking longer than its interval is the first symptom of most of
// them. `slowMs` is the line past which that stops being noise and starts being
// the warning.
function everyNoOverlap(
  name: string, intervalMs: number, fn: () => Promise<unknown>,
): () => Promise<void> {
  let running = false;
  let skipped = 0;
  const slowMs = Math.max(1_000, Math.floor(intervalMs * 0.5));
  const run = async () => {
    if (running) {
      skipped++;
      // Log the FIRST skip and then rarely, so a genuinely stuck tick is loud
      // once and does not then bury every other line in the log.
      if (skipped === 1 || skipped % 10 === 0) {
        app.log.warn({ tick: name, skipped }, "tick still running from last time — skipping this one");
      }
      return;
    }
    running = true;
    const started = Date.now();
    try {
      await fn();
    } catch (err) {
      // A tick must never throw out of here: an unhandled rejection in a timer
      // takes the process down, and none of this work is worth the API for it.
      app.log.error({ err, tick: name }, "tick failed");
    } finally {
      running = false;
      const ms = Date.now() - started;
      if (ms >= slowMs) {
        app.log.warn({ tick: name, ms, intervalMs }, "tick is taking a large share of its interval");
      }
      if (skipped > 0) {
        app.log.warn({ tick: name, skipped, ms }, "tick finished after skipping runs");
        skipped = 0;
      }
    }
  };
  setInterval(run, intervalMs).unref();
  return run;
}

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
  // Keep a task's STORED status in step with its schedule, so the admin list's
  // status filter agrees with the status badge (which is computed from
  // starts_at/ends_at by campaignState). Without this, a task whose ends_at
  // passed sits stored as 'active' — showing "ended" in the badge but only
  // matching the "active" filter. The list route also filters on the computed
  // value, so this is belt-and-braces; it also keeps every other query that
  // reads the raw column honest.
  try {
    const nowIso = new Date().toISOString();
    await sql.run(
      `UPDATE tasks SET status = 'active'
        WHERE source = 'custom' AND status = 'scheduled'
          AND (starts_at IS NULL OR starts_at <= ?)
          AND (ends_at IS NULL OR ends_at > ?)`,
      nowIso, nowIso,
    );
    await sql.run(
      `UPDATE tasks SET status = 'ended'
        WHERE source = 'custom' AND status IN ('active','scheduled')
          AND ends_at IS NOT NULL AND ends_at <= ?`,
      nowIso,
    );
  } catch (err) {
    app.log.error({ err }, "Task schedule sweep failed");
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
const runSettlement = everyNoOverlap("settlement", SETTLE_INTERVAL_MS, tickSettlement);

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
const runDeposits = everyNoOverlap("deposits", config.depositScanIntervalMs, tickDeposits);

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
const runPayoutRelayJob = everyNoOverlap("payout-relay", config.depositScanIntervalMs, tickPayoutRelayJob);

// ---- Reconciliation — CUSTODY_SPEC.md § 5 step 3 / § 3.5 -------------------
// Hourly, much slower than the deposit/sweep ticks above: this is a
// treasury-balance-vs-ledger check, not something that needs to be fresh to
// the second. A no-op until a treasury signer is configured (reconcile.ts).
// Env-tunable (RECONCILE_INTERVAL_MS): its RPC cost is one multicall per 300
// deposit addresses, so unlike the fixed-cadence ticks above this one grows
// with the user base. Slowing it must be possible without a deploy.
const runReconcile = everyNoOverlap("reconcile", config.reconcileIntervalMs, tickReconcile);

// ---- Support tickets: auto-close a stale 'answered' ticket — ticketAutoClose.ts
// ⚠️ ITS OWN, FINER cadence — NOT the hourly reconcile interval above. The
// window this checks against is admin-tunable in HOURS now (default 3,
// founder 2026-09-02: "close after two or three hours"), so an hourly tick
// could sit for up to another full hour past a short window before catching
// it — a third of the window itself. A cheap SELECT every 10 minutes keeps
// the close within a small fraction of whatever the admin sets, even at the
// lowest sane setting.
const TICKET_AUTO_CLOSE_TICK_MS = 10 * 60 * 1000;
const runTicketAutoClose = everyNoOverlap("ticket-auto-close", TICKET_AUTO_CLOSE_TICK_MS, tickTicketAutoClose);

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  // Kick each tick once at boot through its OWN guard, not by calling the raw
  // function — a boot run and the first interval run would otherwise be able to
  // overlap, which is the exact thing the guard exists to prevent.
  void runSettlement();
  void runDeposits();
  void runPayoutRelayJob();
  void runReconcile();
  void runTicketAutoClose();
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
