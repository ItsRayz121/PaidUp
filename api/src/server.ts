import Fastify from "fastify";
import cors from "@fastify/cors";
import { config, isProdSecretsMissing } from "./config.ts";
import { authRoutes } from "./auth.ts";
import { appRoutes } from "./routes/app.ts";
import { webhookRoutes } from "./routes/webhooks.ts";
import { withdrawalRoutes } from "./routes/withdrawals.ts";
import { staffRoutes } from "./routes/staff.ts";
import "./db.ts";

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
}

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
  if (!config.brevoApiKey) {
    app.log.warn("No BREVO_API_KEY set — login codes will print to this console, not email.");
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
