import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";
import type { AdNetworkAdapter, PostbackInput, VerifyResult } from "./types.ts";

// Survey network (network #3). A THIRD, distinct verification scheme, to keep
// proving the adapter interface absorbs each network's own method
// (docs/ARCHITECTURE.md § Ad network adapters). offerhub = plain HMAC, tapvid =
// token + HMAC; surveyx adds two dimensions neither has:
//   1. A signed UNIX timestamp with a freshness window — a captured signed
//      callback replayed later than config.postbackFreshnessSeconds is rejected
//      (defence-in-depth on top of the idempotency check in webhooks.ts).
//   2. A completion `status` — surveys screen users out or hit quota; only
//      "complete" pays. The status is inside the signature so it can't be
//      flipped in transit.
//   sig = HMAC_SHA256(secret, `${uid}.${sid}.${cid}.${ts}.${status}`)
// We still never trust any reward value from the network — points come from our
// own task row.
export const surveyxAdapter: AdNetworkAdapter = {
  name: "surveyx",

  verifyPostback(input: PostbackInput): VerifyResult {
    const userId = input.uid ?? "";
    const taskId = input.sid ?? "";
    const externalId = input.cid ?? "";
    const ts = input.ts ?? "";
    const status = input.status ?? "";
    const sig = input.sig ?? "";

    if (!userId || !taskId || !externalId || !ts || !status || !sig) {
      return { ok: false, reason: "missing required fields" };
    }

    // Only completed surveys pay. Screenouts / quota-full are signed too, but
    // carry no reward — record the reject reason for dispute lookups.
    if (status !== "complete") {
      return { ok: false, reason: `not a completed survey (${status})` };
    }

    // Freshness: reject a timestamp too far in the past or future. Blocks replay
    // of an old signed callback; the ± window also tolerates clock skew.
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) {
      return { ok: false, reason: "bad timestamp" };
    }
    const skew = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
    if (skew > config.postbackFreshnessSeconds) {
      return { ok: false, reason: "stale or future timestamp" };
    }

    const secret = config.postbackSecrets.surveyx;
    const expected = createHmac("sha256", secret)
      .update(`${userId}.${taskId}.${externalId}.${ts}.${status}`)
      .digest("hex");

    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "bad signature" };
    }

    return { ok: true, data: { userId, taskId, externalId } };
  },
};
