import type { FastifyInstance } from "fastify";
import { sql, now, newId, postLedger } from "../db.ts";
import { getAdapter } from "../adapters/index.ts";
import { creditCompletion, type NetworkRow } from "../credit.ts";

// Inbound ad-network postbacks. Together with staff approval of a custom-task
// proof, this is the only way task points are ever credited (guardrail #1). The
// frontend can NEVER credit points. Every postback is logged, verified or not,
// so Agents can resolve disputes.
//
// The crediting itself lives in ../credit.ts and is shared with the custom-task
// approval path, so both get identical referral bonuses, velocity caps and
// mining boosts. Do not re-implement any of that here.
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
        newId(), network, externalId ?? null, verified ? 1 : 0, outcome,
        JSON.stringify({ ...input, _ip: req.ip }), now(),
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
    const net = await sql.get<NetworkRow>(
      `SELECT status, referral_bonus_pct, referral_bonus_pct_l2, referral_first_task_bonus, referral_bonus_days
       FROM networks WHERE id = ?`, network,
    );
    if (net && net.status === "disabled") {
      await logPostback(false, "network_disabled");
      return reply.code(403).send({ error: "network disabled" });
    }

    // 1. Verify the signature per this network's method. The request IP is passed
    // so a network that publishes fixed postback IPs can pin them.
    const result = await adapter.verifyPostback(input, { ip: req.ip });
    if (!result.ok) {
      await logPostback(false, `rejected:${result.reason}`, input.txn_id ?? input.trans_id);
      return reply.code(401).send({ error: "verification failed" });
    }
    const { userId, taskId, externalId, points: signedPoints, offerType, reversal } = result.data;

    // ---- 2. REVERSAL --------------------------------------------------------
    // The network is taking back a completion it already paid us for (CPX calls
    // us again with status=2 when a survey is judged fraudulent, up to ~60 days
    // later). We reverse every credit that completion produced — the user's
    // reward AND the referral bonuses it paid out — with compensating debits.
    // The original entries are never deleted (append-only ledger, guardrail #2).
    // A user who already withdrew can go negative; that is correct, and it is
    // flagged for staff rather than silently written off.
    if (reversal) {
      const done = await sql.get<{ id: string; user_id: string; status: string }>(
        "SELECT id, user_id, status FROM task_completions WHERE network = ? AND external_id = ?",
        network, externalId,
      );
      if (!done) {
        await logPostback(true, "reversal_unknown_completion", externalId);
        return reply.send({ ok: true, reversed: false, reason: "unknown completion" });
      }
      if (done.status !== "credited") {
        // Already reversed (or never credited) — idempotent no-op.
        await logPostback(true, "reversal_duplicate", externalId);
        return reply.send({ ok: true, reversed: false, alreadyHandled: true });
      }

      await sql.tx(async (t) => {
        const credits = await t.all<{ user_id: string; amount: number }>(
          "SELECT user_id, amount FROM ledger_entries WHERE source_ref_id = ? AND amount > 0",
          done.id,
        );
        for (const c of credits) {
          await postLedger({
            userId: c.user_id, points: c.amount, direction: "debit",
            sourceType: "admin_adjustment", sourceRefId: done.id,
            note: "Survey cancelled by the partner — points taken back",
          }, t);
        }
        await t.run("UPDATE task_completions SET status = 'reversed' WHERE id = ?", done.id);
        await t.run(
          "INSERT INTO fraud_flags (id, user_id, flag_type, severity, detail, created_at) VALUES (?,?,?,?,?,?)",
          newId(), done.user_id, "network_reversal", "high",
          `${network} reversed completion ${externalId} as fraud. ${credits.length} credit(s) taken back.`,
          now(),
        );
      });

      await logPostback(true, "reversed", externalId);
      return reply.send({ ok: true, reversed: true });
    }

    // ---- 3. Resolve the reward ----------------------------------------------
    // Fixed-catalog network -> reward comes from OUR task row (never the payload).
    // Dynamic network (CPX) -> reward is the signed amount the adapter validated
    // and capped; there is no task row for an ad-hoc survey.
    let rewardPoints: number;
    let rewardType: string;
    if (taskId) {
      const task = await sql.get<{ id: string; type: string; points: number }>(
        "SELECT id, type, points FROM tasks WHERE id = ? AND status = 'active'", taskId,
      );
      if (!task) {
        await logPostback(true, "unknown_task", externalId);
        return reply.code(400).send({ error: "unknown task" });
      }
      rewardPoints = task.points;
      rewardType = task.type;
    } else if (signedPoints && signedPoints > 0) {
      rewardPoints = signedPoints;
      rewardType = offerType ?? "survey";
    } else {
      await logPostback(true, "no_reward", externalId);
      return reply.code(400).send({ error: "no reward on postback" });
    }

    // ---- 4. Credit — the shared path (../credit.ts) --------------------------
    const outcome = await creditCompletion({
      userId, network, externalId, taskId, points: rewardPoints, offerType: rewardType,
      payload: input,
      reportedCountry: input.country ?? input.country_code ?? input.geo,
      net,
    }, app.log);

    switch (outcome.status) {
      case "duplicate":
        await logPostback(true, "duplicate", externalId);
        return reply.send({ ok: true, status: outcome.completionStatus, duplicate: true });

      case "unknown_user":
        await logPostback(true, "unknown_user", externalId);
        return reply.code(400).send({ error: "unknown user" });

      case "velocity_blocked":
        await logPostback(
          true, outcome.scope === "global" ? "velocity_blocked_global" : "velocity_blocked", externalId,
        );
        return reply.send({ ok: true, credited: 0, flagged: "velocity" });

      case "credited":
        await logPostback(true, "credited", externalId);
        return reply.send({ ok: true, credited: outcome.points });
    }
  });
}
