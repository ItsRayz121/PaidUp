import Fastify from "fastify";
import cors from "@fastify/cors";
import { config, isProdSecretsMissing } from "./config.ts";
import { authRoutes } from "./auth.ts";
import { appRoutes } from "./routes/app.ts";
import "./db.ts";

const app = Fastify({ logger: true });

await app.register(cors, { origin: config.webOrigin, credentials: true });

app.get("/health", async () => ({ ok: true, service: "paidup-api" }));

await app.register(authRoutes);
await app.register(appRoutes);

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
