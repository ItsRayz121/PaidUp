// Web push — the user-facing endpoints. Turning notifications on/off is the
// USER's choice, made in the app (Help screen); these routes just record it.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { config } from "../config.ts";
import { getUserId, requireActiveUser } from "../auth.ts";
import { pushEnabled, savePushSubscription, deletePushSubscription } from "../push.ts";

function guard(
  handler: (userId: string, req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = getUserId(req);
      await requireActiveUser(userId);
      return await handler(userId, req, reply);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Something went wrong" });
    }
  };
}

// The endpoint is a URL WE will later POST to (that is how web push works), so
// an unchecked value would let an authenticated user aim our server's requests
// at internal services (SSRF). Real push services are always https on a public
// DNS hostname — so require exactly that shape: no http, no IP literals, no
// localhost. The body we send is ciphertext either way, but there is no reason
// to let anyone point us at 169.254.169.254 and find out.
function looksLikePushService(endpoint: string): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // IPv4 literal
  if (host.includes(":") || host.startsWith("[")) return false; // IPv6 literal
  if (!host.includes(".")) return false; // bare single-label names are internal
  return true;
}

const subscriptionSchema = z.object({
  endpoint: z.string().max(2000).refine(looksLikePushService, {
    message: "not a push service endpoint",
  }),
  keys: z.object({
    p256dh: z.string().min(1).max(300),
    auth: z.string().min(1).max(100),
  }),
});

export async function pushRoutes(app: FastifyInstance) {
  // Public on purpose: the VAPID public key is, as named, public — it's in
  // every subscribe call the browser makes. `enabled` lets the web app hide
  // the whole feature when the server has no keys.
  app.get("/push/config", async () => ({
    enabled: pushEnabled,
    publicKey: pushEnabled ? config.vapidPublicKey : null,
  }));

  // The browser subscribed — remember where to reach it.
  app.post("/push/subscriptions", guard(async (userId, req, reply) => {
    if (!pushEnabled) return reply.code(503).send({ error: "Notifications are off right now." });
    const parsed = subscriptionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "That does not look like a subscription." });
    const { endpoint, keys } = parsed.data;
    await savePushSubscription(userId, { endpoint, p256dh: keys.p256dh, auth: keys.auth });
    return { ok: true };
  }));

  // The user turned notifications off — forget this browser.
  app.delete("/push/subscriptions", guard(async (userId, req, reply) => {
    const parsed = z.object({ endpoint: z.string().url().max(2000) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Missing endpoint." });
    await deletePushSubscription(userId, parsed.data.endpoint);
    return { ok: true };
  }));
}
