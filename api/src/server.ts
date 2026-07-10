import Fastify from "fastify";
import cors from "@fastify/cors";
import { config, isProdSecretsMissing } from "./config.ts";
import { authRoutes } from "./auth.ts";
import { appRoutes } from "./routes/app.ts";
import { webhookRoutes } from "./routes/webhooks.ts";
import { withdrawalRoutes } from "./routes/withdrawals.ts";
import { staffRoutes } from "./routes/staff.ts";
import { initDb, usingRealPostgres } from "./db.ts";

// Print boot context first so the deploy log shows how far we got and on what
// Node version (node:sqlite needs Node >= 22.5; we pin 24).
console.log(`Booting paidup-api · node ${process.version} · NODE_ENV=${process.env.NODE_ENV ?? "(unset)"} · PORT=${process.env.PORT ?? config.port}`);

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
  if (missing.length) {
    console.error(`FATAL: not starting — these secrets are still defaults: ${missing.join(", ")}. Set them in the host environment and redeploy.`);
    process.exit(1);
  }
  // A sender on an unverified domain is rejected by the provider at send time,
  // which surfaces to the user as a generic login failure. Fail here instead.
  if (config.resendApiKey && config.emailFrom.endsWith("@paidup.app")) {
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

const app = Fastify({ logger: true });

// In production, only allow the configured web origin. In dev, reflect any
// origin so the app is reachable from localhost AND your phone on the LAN.
await app.register(cors, {
  origin: process.env.NODE_ENV === "production" ? config.webOrigin : true,
  credentials: true,
});

app.get("/health", async () => ({ ok: true, service: "paidup-api" }));

await app.register(authRoutes);
await app.register(appRoutes);
await app.register(webhookRoutes);
await app.register(withdrawalRoutes);
await app.register(staffRoutes);

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  if (isProdSecretsMissing) {
    app.log.warn("Using DEV secrets. Set JWT_SECRET and OTP_PEPPER in .env before real use.");
  }
  if (!config.resendApiKey) {
    app.log.warn("No RESEND_API_KEY set — login codes will print to this console, not email.");
  } else {
    app.log.info(`Email via Resend, from ${config.emailFrom}`);
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
