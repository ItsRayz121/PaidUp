import type { FastifyInstance } from "fastify";
import { sql, now, newId, postLedger } from "../db.ts";
import { config } from "../config.ts";
import { getAdapter } from "../adapters/index.ts";
import { checkGeoMismatch } from "../fraud.ts";

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

    const logPostback = async (verified: boolean, outcome: string, externalId?: string) => {
      await sql.run(
        "INSERT INTO postback_log (id, network, external_id, verified, outcome, raw, created_at) VALUES (?,?,?,?,?,?,?)",
        newId(), network, externalId ?? null, verified ? 1 : 0, outcome, JSON.stringify(input), now(),
      );
    };

    const adapter = getAdapter(network);
    if (!adapter) {
      await logPostback(false, "unknown_network");
      return reply.code(404).send({ error: "unknown network" });
    }

    // A network the Admin has disabled stops crediting immediately — no code
    // change or redeploy needed. Row may be absent for a network that predates
    // the table; absence is treated as active so we never silently drop traffic.
    const net = await sql.get<{ status: string; referral_bonus_pct: number; referral_bonus_days: number }>(
      "SELECT status, referral_bonus_pct, referral_bonus_days FROM networks WHERE id = ?", network,
    );
    if (net && net.status === "disabled") {
      await logPostback(false, "network_disabled");
      return reply.code(403).send({ error: "network disabled" });
    }

    // 1. Verify signature per this network's method.
    const result = adapter.verifyPostback(input);
    if (!result.ok) {
      await logPostback(false, `rejected:${result.reason}`, input.txn_id);
      return reply.code(401).send({ error: "verification failed" });
    }
    const { userId, taskId, externalId } = result.data;

    // 2. Idempotency — already processed this completion? Ack, don't re-credit.
    const dup = await sql.get<{ status: string }>(
      "SELECT status FROM task_completions WHERE network = ? AND external_id = ?", network, externalId,
    );
    if (dup) {
      await logPostback(true, "duplicate", externalId);
      return reply.send({ ok: true, status: dup.status, duplicate: true });
    }

    // 3. Validate our user + task exist and task is active.
    const user = await sql.get<{ id: string; referred_by: string | null; created_at: string; country: string }>(
      "SELECT id, referred_by, created_at, country FROM users WHERE id = ?", userId,
    );
    const task = await sql.get<{ id: string; type: string; points: number }>(
      "SELECT id, type, points FROM tasks WHERE id = ? AND status = 'active'", taskId,
    );
    if (!user || !task) {
      await logPostback(true, "unknown_user_or_task", externalId);
      return reply.code(400).send({ error: "unknown user or task" });
    }

    // 4. Fraud velocity cap: too many of this offer TYPE today => flag, no credit.
    const since = new Date(); since.setHours(0, 0, 0, 0);
    const countRow = await sql.get<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM task_completions tc
       JOIN tasks t ON t.id = tc.task_id
       WHERE tc.user_id = ? AND t.type = ? AND tc.status = 'credited' AND tc.created_at >= ?`,
      userId, task.type, since.toISOString(),
    );
    const todayCount = countRow?.n ?? 0;

    if (todayCount >= config.velocityCapPerTypePerDay) {
      await sql.tx(async (t) => {
        await t.run(
          `INSERT INTO task_completions (id, user_id, task_id, network, external_id, status, postback_payload, created_at)
           VALUES (?,?,?,?,?, 'rejected', ?, ?)`,
          newId(), userId, taskId, network, externalId, JSON.stringify(input), now(),
        );
        await t.run(
          "INSERT INTO fraud_flags (id, user_id, flag_type, severity, detail, created_at) VALUES (?,?,?,?,?,?)",
          newId(), userId, "velocity", "medium",
          `Over cap for offer type "${task.type}" (${todayCount} today)`, now(),
        );
      });
      await logPostback(true, "velocity_blocked", externalId);
      return reply.send({ ok: true, credited: 0, flagged: "velocity" });
    }

    // 4b. Tighter global cap: total credited completions across ALL offer types
    // today. Blocks a user maxing every type at once (guardrail #5).
    const allTypesRow = await sql.get<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM task_completions
       WHERE user_id = ? AND status = 'credited' AND created_at >= ?`,
      userId, since.toISOString(),
    );
    if ((allTypesRow?.n ?? 0) >= config.velocityCapAllTypesPerDay) {
      const total = allTypesRow?.n ?? 0;
      await sql.tx(async (t) => {
        await t.run(
          `INSERT INTO task_completions (id, user_id, task_id, network, external_id, status, postback_payload, created_at)
           VALUES (?,?,?,?,?, 'rejected', ?, ?)`,
          newId(), userId, taskId, network, externalId, JSON.stringify(input), now(),
        );
        await t.run(
          "INSERT INTO fraud_flags (id, user_id, flag_type, severity, detail, created_at) VALUES (?,?,?,?,?,?)",
          newId(), userId, "velocity", "medium",
          `Over daily cap across all offer types (${total} today)`, now(),
        );
      });
      await logPostback(true, "velocity_blocked_global", externalId);
      return reply.send({ ok: true, credited: 0, flagged: "velocity" });
    }

    // 5. Verified + clean: record the completion and credit the ledger together.
    // If either write fails, neither lands — no points without a completion row,
    // no completion row without points. Points come from OUR task row, never
    // from the network payload.
    const completionId = newId();
    await sql.tx(async (t) => {
      await t.run(
        `INSERT INTO task_completions (id, user_id, task_id, network, external_id, status, postback_payload, created_at, verified_at)
         VALUES (?,?,?,?,?, 'credited', ?, ?, ?)`,
        completionId, userId, taskId, network, externalId, JSON.stringify(input), now(), now(),
      );

      await postLedger({
        userId, points: task.points, direction: "credit",
        sourceType: "task_completion", sourceRefId: completionId, note: "Task reward",
      }, t);

      // Referral commission (P1): inviter earns a share, tracked separately.
      // The share is the network's configured referral_bonus_pct (Admin-set,
      // never hardcoded), falling back to the global default if unset.
      // P2 tuning: only pay while the invited account is inside the referral
      // window (referral_bonus_days; 0 = lifetime). Past the window the inviter
      // stops earning from this referral — caps long-tail cost and farm value.
      const windowDays = net ? net.referral_bonus_days : config.referralBonusDays;
      const inviteAgeDays = (Date.now() - new Date(user.created_at).getTime()) / 86400_000;
      const withinWindow = windowDays <= 0 || inviteAgeDays <= windowDays;
      if (user.referred_by && withinWindow) {
        const pct = net ? net.referral_bonus_pct / 100 : config.referralCommissionPct;
        const bonus = Math.floor(task.points * pct);
        if (bonus > 0) {
          await postLedger({
            userId: user.referred_by, points: bonus, direction: "credit",
            sourceType: "referral_bonus", sourceRefId: completionId,
            note: "Referral bonus from your invite",
          }, t);
        }
      }
    });

    // Geo-mismatch signal (P2): raise a soft fraud flag if the network says the
    // completion came from a different country than the account's. Runs AFTER
    // the credit lands — it never blocks a verified reward, only flags for staff
    // review. Networks vary in which key carries the geo; accept the common ones.
    const reportedCountry = input.country ?? input.country_code ?? input.geo;
    await checkGeoMismatch(userId, user.country, reportedCountry);

    await logPostback(true, "credited", externalId);
    return reply.send({ ok: true, credited: task.points });
  });
}
