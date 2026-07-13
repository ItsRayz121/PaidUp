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
import { kycRoutes } from "./routes/kyc.ts";
import { staffKycRoutes } from "./routes/staffKyc.ts";
import { pushRoutes } from "./routes/push.ts";
import { pushEnabled } from "./push.ts";
import { usingDevKycKey } from "./kyc.ts";
import { settleDueEpochs } from "./mining/engine.ts";
import { initDb, sql, usingRealPostgres } from "./db.ts";

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

await app.register(authRoutes);
await app.register(appRoutes);
await app.register(webhookRoutes);
await app.register(withdrawalRoutes);
await app.register(staffRoutes);
await app.register(miningRoutes);
await app.register(staffMiningRoutes);
await app.register(staffTaskRoutes);
await app.register(kycRoutes);
await app.register(staffKycRoutes);
await app.register(pushRoutes);

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
  } catch (err) {
    app.log.error({ err }, "email_codes purge failed");
  }
}
setInterval(tickSettlement, SETTLE_INTERVAL_MS).unref();

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  void tickSettlement();
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
