import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "../db.ts";
import type { AdNetworkAdapter, PostbackContext, PostbackInput, VerifyResult } from "./types.ts";

// OUR OWN tasks, verified by OUR OWN postback.
//
// An Admin writes a task in /staff, picks verify_mode = 'postback', and gets a
// URL + a secret to hand to whoever is running the offer (a partner, an app we
// promote, our own bot). Their server calls us when a user finishes; we credit
// only if the signature checks out. It is the ad-network contract, with us as
// the network.
//
// Postback:
//   POST/GET /webhooks/custom/postback
//     task_id=<our task id>
//     user_id=<our user id>
//     txn_id=<partner's unique id for this completion>   -> idempotency key
//     sig=hex(HMAC_SHA256(task_secret, `${task_id}.${user_id}.${txn_id}`))
//
// WHAT MAKES THIS SAFE:
//   • The secret is PER TASK, so leaking one task's secret cannot mint
//     completions for any other task.
//   • The signature covers the user and the transaction, so a captured postback
//     cannot be re-pointed at a different user.
//   • No amount is accepted from the caller. The reward is read from OUR tasks
//     row by the webhook. A partner cannot inflate their own payout — which is
//     the exact weakness we had to work around on CPX.
//   • The unique (network, external_id) index makes a replay an idempotent no-op.

function hexEq(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export const customAdapter: AdNetworkAdapter = {
  name: "custom",

  async verifyPostback(input: PostbackInput, _ctx: PostbackContext): Promise<VerifyResult> {
    const taskId = (input.task_id ?? "").trim();
    const userId = (input.user_id ?? "").trim();
    const txnId = (input.txn_id ?? "").trim();
    const sig = (input.sig ?? "").trim().toLowerCase();

    if (!taskId || !userId || !txnId || !sig) {
      return { ok: false, reason: "missing required fields" };
    }

    const task = await sql.get<{ postback_secret: string | null; status: string; verify_mode: string }>(
      "SELECT postback_secret, status, verify_mode FROM tasks WHERE id = ? AND source = 'custom'",
      taskId,
    );
    if (!task) return { ok: false, reason: "unknown custom task" };
    if (task.status !== "active") return { ok: false, reason: "task not active" };
    // A 'proof' task is credited by a staff member reviewing evidence. It has no
    // postback contract, so refuse — otherwise the weaker of the two verification
    // modes could be used to bypass the stronger one.
    if (task.verify_mode !== "postback") return { ok: false, reason: "task is not postback-verified" };
    if (!task.postback_secret) return { ok: false, reason: "task has no secret" };

    const expected = createHmac("sha256", task.postback_secret)
      .update(`${taskId}.${userId}.${txnId}`)
      .digest("hex");

    if (!hexEq(sig, expected)) return { ok: false, reason: "bad signature" };

    return {
      ok: true,
      // taskId set => the webhook reads the reward from our own tasks row.
      // No amount is ever taken from the payload.
      data: { userId, taskId, externalId: `${taskId}:${txnId}` },
    };
  },
};
