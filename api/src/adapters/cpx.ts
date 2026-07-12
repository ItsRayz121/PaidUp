import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";
import type { AdNetworkAdapter, PostbackContext, PostbackInput, VerifyResult } from "./types.ts";

// CPX Research — a REAL survey wall (app id set in the CPX dashboard).
//
// Postback (server-to-server), per the CPX Postback Settings tab:
//   status={status}        1 = completed, 2 = cancelled/fraud (they re-call us)
//   trans_id={trans_id}    unique completion id  -> our idempotency key
//   user_id={user_id}      the ext_user_id we passed into the survey wall = our user id
//   amount_local={amount}  reward in OUR currency (points). CPX derives it from
//                          the conversion rate WE set in Reward Settings, which
//                          is where the 60/40 split is enforced — so this number
//                          is effectively server-controlled, not user-controlled.
//   amount_usd={...}       what CPX pays US (our revenue) — logged, not trusted
//   hash={secure_hash}     md5(`${trans_id}-${APP_SECURE_HASH}`)
//
// SECURITY NOTE: CPX's hash covers ONLY trans_id — not the amount. So a captured
// postback could in principle be replayed with a larger amount_local. Two things
// stop that: (1) the unique index on (network, external_id) makes a replayed
// trans_id a no-op duplicate, and (2) minting a NEW trans_id requires our secret.
// We additionally cap the amount and can pin CPX's source IPs.
const CPX_IPS = new Set(["188.40.3.73", "157.90.97.92", "2a01:4f8:d0a:30ff::2"]);

function md5Hex(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

// Constant-time hex compare that can't throw on a length mismatch.
function hexEq(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export const cpxAdapter: AdNetworkAdapter = {
  name: "cpx",

  verifyPostback(input: PostbackInput, ctx: PostbackContext): VerifyResult {
    const userId = (input.user_id ?? "").trim();
    const transId = (input.trans_id ?? "").trim();
    const hash = (input.hash ?? "").trim().toLowerCase();
    const status = (input.status ?? "").trim();

    if (!userId || !transId || !hash) return { ok: false, reason: "missing required fields" };

    // Optional IP pin. Off by default: Railway sits behind a proxy, so the
    // observed IP depends on trust-proxy config — enabling this before you've
    // confirmed the forwarded IP would silently reject real (paid) completions.
    // Turn on with CPX_ENFORCE_IP=true once verified in the postback log.
    if (config.cpxEnforceIp && ctx.ip && !CPX_IPS.has(ctx.ip)) {
      return { ok: false, reason: `ip not allowed: ${ctx.ip}` };
    }

    const expected = md5Hex(`${transId}-${config.postbackSecrets.cpx}`);
    if (!hexEq(hash, expected)) return { ok: false, reason: "bad signature" };

    // status 2 = the completion CPX already paid us for was judged fraudulent.
    // Reverse it. No amount needed — we reverse exactly what we credited.
    if (status === "2") {
      return { ok: true, data: { userId, externalId: transId, reversal: true } };
    }

    // status 1 = completed. Reward comes from the signed payload (dynamic).
    const points = Math.floor(Number(input.amount_local ?? "0"));
    if (!Number.isFinite(points) || points <= 0) {
      return { ok: false, reason: "bad amount_local" };
    }
    if (points > config.cpxMaxPointsPerSurvey) {
      // A single survey paying more than this is not plausible — refuse rather
      // than credit a number that would drain the treasury if the secret leaked.
      return { ok: false, reason: `amount over cap (${points})` };
    }

    return { ok: true, data: { userId, externalId: transId, points, offerType: "survey" } };
  },
};
