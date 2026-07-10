import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";
import type { AdNetworkAdapter, PostbackInput, VerifyResult } from "./types.ts";

// Rewarded-video network (network #2). Deliberately a DIFFERENT verification
// scheme from offerhub, to prove the adapter interface absorbs each network's
// own method (docs/ARCHITECTURE.md § Ad network adapters). Here the network
// sends a static shared `token` AND a per-completion HMAC signature over a
// pipe-joined string that includes the reward it thinks it paid:
//   hash = HMAC_SHA256(secret, `${user}|${offer}|${tx}|${reward}`)
// We still never trust `reward` for crediting — points come from our task row.
export const tapvidAdapter: AdNetworkAdapter = {
  name: "tapvid",

  verifyPostback(input: PostbackInput): VerifyResult {
    const userId = input.user ?? "";
    const taskId = input.offer ?? "";
    const externalId = input.tx ?? "";
    const reward = input.reward ?? "";
    const token = input.token ?? "";
    const hash = input.hash ?? "";

    if (!userId || !taskId || !externalId || !hash) {
      return { ok: false, reason: "missing required fields" };
    }

    const secret = config.postbackSecrets.tapvid;
    // Static token gate first — a cheap reject for traffic that isn't this
    // network at all, before the constant-time HMAC compare.
    if (token !== config.postbackTokens.tapvid) {
      return { ok: false, reason: "bad token" };
    }

    const expected = createHmac("sha256", secret)
      .update(`${userId}|${taskId}|${externalId}|${reward}`)
      .digest("hex");

    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "bad signature" };
    }

    return { ok: true, data: { userId, taskId, externalId } };
  },
};
