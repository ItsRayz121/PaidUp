import type { FastifyInstance } from "fastify";
import { db, now, newId, postLedger } from "../db.ts";
import { config } from "../config.ts";
import { getAdapter } from "../adapters/index.ts";

// Inbound ad-network postbacks. THIS is the only place task points are credited
// (guardrail #1). The frontend can NEVER credit points. Every postback is
// logged, verified or not, so Agents can resolve disputes.
export async function webhookRoutes(app: FastifyInstance) {
  app.all("/webhooks/:network/postback", async (req, reply) => {
    const network = (req.params as { network: string }).network;
    // Networks send params via query (GET) or body (POST); accept both.
    const input = {
      ...(typeof req.body === "object" && req.body ? (req.body as Record<string, string>) : {}),
      ...(req.query as Record<string, string>),
    };

    const logPostback = (verified: boolean, outcome: string, externalId?: string) => {
      db.prepare(
        "INSERT INTO postback_log (id, network, external_id, verified, outcome, raw, created_at) VALUES (?,?,?,?,?,?,?)",
      ).run(newId(), network, externalId ?? null, verified ? 1 : 0, outcome, JSON.stringify(input), now());
    };

    const adapter = getAdapter(network);
    if (!adapter) {
      logPostback(false, "unknown_network");
      return reply.code(404).send({ error: "unknown network" });
    }

    // 1. Verify signature per this network's method.
    const result = adapter.verifyPostback(input);
    if (!result.ok) {
      logPostback(false, `rejected:${result.reason}`, input.txn_id);
      return reply.code(401).send({ error: "verification failed" });
    }
    const { userId, taskId, externalId } = result.data;

    // 2. Idempotency — already processed this completion? Ack, don't re-credit.
    const dup = db
      .prepare("SELECT status FROM task_completions WHERE network = ? AND external_id = ?")
      .get(network, externalId) as { status: string } | undefined;
    if (dup) {
      logPostback(true, "duplicate", externalId);
      return reply.send({ ok: true, status: dup.status, duplicate: true });
    }

    // 3. Validate our user + task exist and task is active.
    const user = db.prepare("SELECT id, referred_by FROM users WHERE id = ?").get(userId) as
      | { id: string; referred_by: string | null } | undefined;
    const task = db.prepare("SELECT id, type, points FROM tasks WHERE id = ? AND status = 'active'").get(taskId) as
      | { id: string; type: string; points: number } | undefined;
    if (!user || !task) {
      logPostback(true, "unknown_user_or_task", externalId);
      return reply.code(400).send({ error: "unknown user or task" });
    }

    // 4. Fraud velocity cap: too many of this offer TYPE today => flag, no credit.
    const since = new Date(); since.setHours(0, 0, 0, 0);
    const todayCount = (db.prepare(
      `SELECT COUNT(*) AS n FROM task_completions tc
       JOIN tasks t ON t.id = tc.task_id
       WHERE tc.user_id = ? AND t.type = ? AND tc.status = 'credited' AND tc.created_at >= ?`,
    ).get(userId, task.type, since.toISOString()) as { n: number }).n;

    if (todayCount >= config.velocityCapPerTypePerDay) {
      db.prepare(
        `INSERT INTO task_completions (id, user_id, task_id, network, external_id, status, postback_payload, created_at)
         VALUES (?,?,?,?,?, 'rejected', ?, ?)`,
      ).run(newId(), userId, taskId, network, externalId, JSON.stringify(input), now());
      db.prepare(
        "INSERT INTO fraud_flags (id, user_id, flag_type, severity, detail, created_at) VALUES (?,?,?,?,?,?)",
      ).run(newId(), userId, "velocity", "medium",
        `Over cap for offer type "${task.type}" (${todayCount} today)`, now());
      logPostback(true, "velocity_blocked", externalId);
      return reply.send({ ok: true, credited: 0, flagged: "velocity" });
    }

    // 5. Verified + clean: record the completion, then credit the ledger.
    // Points come from OUR task row, never from the network payload.
    const completionId = newId();
    db.prepare(
      `INSERT INTO task_completions (id, user_id, task_id, network, external_id, status, postback_payload, created_at, verified_at)
       VALUES (?,?,?,?,?, 'credited', ?, ?, ?)`,
    ).run(completionId, userId, taskId, network, externalId, JSON.stringify(input), now(), now());

    postLedger({
      userId, points: task.points, direction: "credit",
      sourceType: "task_completion", sourceRefId: completionId, note: "Task reward",
    });

    // Referral commission (P1): inviter earns a share, tracked separately.
    if (user.referred_by) {
      const bonus = Math.floor(task.points * config.referralCommissionPct);
      if (bonus > 0) {
        postLedger({
          userId: user.referred_by, points: bonus, direction: "credit",
          sourceType: "referral_bonus", sourceRefId: completionId,
          note: "Referral bonus from your invite",
        });
      }
    }

    logPostback(true, "credited", externalId);
    return reply.send({ ok: true, credited: task.points });
  });
}
