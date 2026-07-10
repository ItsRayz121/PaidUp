import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";
import type { AdNetworkAdapter, PostbackInput, VerifyResult } from "./types.ts";

// Example offerwall adapter. Verifies an HMAC-SHA256 signature over a stable
// string of the identifiers, using this network's shared secret.
//   sig = HMAC_SHA256(secret, `${sub_id}:${offer_id}:${txn_id}`)
// A real network's exact scheme (query token / HMAC / IP allowlist) varies —
// this is the pattern each adapter follows.
export const offerhubAdapter: AdNetworkAdapter = {
  name: "offerhub",

  verifyPostback(input: PostbackInput): VerifyResult {
    const userId = input.sub_id ?? "";
    const taskId = input.offer_id ?? "";
    const externalId = input.txn_id ?? "";
    const sig = input.sig ?? "";

    if (!userId || !taskId || !externalId || !sig) {
      return { ok: false, reason: "missing required fields" };
    }

    const secret = config.postbackSecrets.offerhub;
    const expected = createHmac("sha256", secret)
      .update(`${userId}:${taskId}:${externalId}`)
      .digest("hex");

    // Constant-time compare; guard against length mismatch throwing.
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "bad signature" };
    }

    return { ok: true, data: { userId, taskId, externalId } };
  },
};
