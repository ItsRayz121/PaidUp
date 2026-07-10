import Fastify from "fastify";
import cors from "@fastify/cors";
import { config, isProdSecretsMissing } from "./config.ts";
import { authRoutes } from "./auth.ts";
import { appRoutes } from "./routes/app.ts";
import { webhookRoutes } from "./routes/webhooks.ts";
import { withdrawalRoutes } from "./routes/withdrawals.ts";
import { staffRoutes } from "./routes/staff.ts";
import "./db.ts";

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

// SECURITY: never boot in production with default secrets. Default JWT/OTP/
// postback secrets are source-visible, so leaving them enabled in prod allows
// session forgery, admin impersonation, and forged postbacks. Fail fast.
const usingDefaultPostback = Object.values(config.postbackSecrets).some((s) => s.startsWith("dev-"));
if (process.env.NODE_ENV === "production" && (isProdSecretsMissing || usingDefaultPostback)) {
  console.error(
    "FATAL: refusing to start in production with default secrets. Set JWT_SECRET, " +
    "OTP_PEPPER, and POSTBACK_SECRET_* to strong random values.",
  );
  process.exit(1);
}

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
