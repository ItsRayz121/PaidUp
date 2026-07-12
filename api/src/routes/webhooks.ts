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
    const net = await sql.get<{
      status: string; referral_bonus_pct: number; referral_bonus_pct_l2: number;
      referral_first_task_bonus: number; referral_bonus_days: number;
    }>(
      `SELECT status, referral_bonus_pct, referral_bonus_pct_l2, referral_first_task_bonus, referral_bonus_days
       FROM networks WHERE id = ?`, network,
    );
    if (net && net.status === "disabled") {
      await logPostback(false, "network_disabled");
      return reply.code(403).send({ error: "network disabled" });
    }

    // 1. Verify the signature per this network's method. The request IP is passed
    // so a network that publishes fixed postback IPs can pin them.
    const result = adapter.verifyPostback(input, { ip: req.ip });
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

    // ---- 3. Idempotency — already processed this completion? Ack, don't re-credit.
    const dup = await sql.get<{ status: string }>(
      "SELECT status FROM task_completions WHERE network = ? AND external_id = ?", network, externalId,
    );
    if (dup) {
      await logPostback(true, "duplicate", externalId);
      return reply.send({ ok: true, status: dup.status, duplicate: true });
    }

    // ---- 4. Resolve the user and the reward ---------------------------------
    const user = await sql.get<{ id: string; referred_by: string | null; created_at: string; country: string }>(
      "SELECT id, referred_by, created_at, country FROM users WHERE id = ?", userId,
    );
    if (!user) {
      await logPostback(true, "unknown_user", externalId);
      return reply.code(400).send({ error: "unknown user" });
    }

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

    // ---- 5. Fraud velocity caps --------------------------------------------
    // Per offer TYPE per day. Reads offer_type off the completion, so it works
    // for dynamic networks that have no task row.
    const since = new Date(); since.setHours(0, 0, 0, 0);
    const typeRow = await sql.get<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM task_completions
       WHERE user_id = ? AND offer_type = ? AND status = 'credited' AND created_at >= ?`,
      userId, rewardType, since.toISOString(),
    );
    const todayCount = typeRow?.n ?? 0;

    const blockForVelocity = async (detail: string, outcome: string) => {
      await sql.tx(async (t) => {
        await t.run(
          `INSERT INTO task_completions (id, user_id, task_id, network, external_id, status, points, offer_type, postback_payload, created_at)
           VALUES (?,?,?,?,?, 'rejected', ?,?,?,?)`,
          newId(), userId, taskId ?? null, network, externalId, rewardPoints, rewardType,
          JSON.stringify(input), now(),
        );
        await t.run(
          "INSERT INTO fraud_flags (id, user_id, flag_type, severity, detail, created_at) VALUES (?,?,?,?,?,?)",
          newId(), userId, "velocity", "medium", detail, now(),
        );
      });
      await logPostback(true, outcome, externalId);
    };

    if (todayCount >= config.velocityCapPerTypePerDay) {
      await blockForVelocity(
        `Over cap for offer type "${rewardType}" (${todayCount} today)`, "velocity_blocked",
      );
      return reply.send({ ok: true, credited: 0, flagged: "velocity" });
    }

    // Tighter global cap: total credited completions across ALL offer types today.
    const allRow = await sql.get<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM task_completions
       WHERE user_id = ? AND status = 'credited' AND created_at >= ?`,
      userId, since.toISOString(),
    );
    if ((allRow?.n ?? 0) >= config.velocityCapAllTypesPerDay) {
      await blockForVelocity(
        `Over daily cap across all offer types (${allRow?.n ?? 0} today)`, "velocity_blocked_global",
      );
      return reply.send({ ok: true, credited: 0, flagged: "velocity" });
    }

    // Is this the user's FIRST ever credited task? (Drives the referral
    // first-task bonus — paid once, only for real activity, not signups.)
    const priorCredited = await sql.get<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM task_completions WHERE user_id = ? AND status = 'credited'",
      userId,
    );
    const isFirstCreditedTask = (priorCredited?.n ?? 0) === 0;

    // ---- 6. Verified + clean: record the completion and credit together ------
    // If either write fails, neither lands — no points without a completion row,
    // no completion row without points.
    const completionId = newId();
    await sql.tx(async (t) => {
      await t.run(
        `INSERT INTO task_completions (id, user_id, task_id, network, external_id, status, points, offer_type, postback_payload, created_at, verified_at)
         VALUES (?,?,?,?,?, 'credited', ?,?,?,?,?)`,
        completionId, userId, taskId ?? null, network, externalId, rewardPoints, rewardType,
        JSON.stringify(input), now(), now(),
      );

      await postLedger({
        userId, points: rewardPoints, direction: "credit",
        sourceType: "task_completion", sourceRefId: completionId, note: "Task reward",
      }, t);

      // Referral commission (2-level): the inviter (L1) and the inviter's inviter
      // (L2) each earn a share of this user's task points. Shares are the
      // network's configured percentages (Admin-set, never hardcoded). Every
      // referral payout comes from margin; it NEVER reduces this user's reward.
      const windowDays = net ? net.referral_bonus_days : config.referralBonusDays;
      const inviteAgeDays = (Date.now() - new Date(user.created_at).getTime()) / 86400_000;
      const withinWindow = windowDays <= 0 || inviteAgeDays <= windowDays;

      const l1 = user.referred_by;
      if (l1) {
        if (withinWindow) {
          const pct1 = net ? net.referral_bonus_pct / 100 : config.referralCommissionPct;
          const bonus1 = Math.floor(rewardPoints * pct1);
          if (bonus1 > 0) {
            await postLedger({
              userId: l1, points: bonus1, direction: "credit",
              sourceType: "referral_bonus", sourceRefId: completionId,
              note: "Referral bonus from your invite",
            }, t);
          }

          const pct2 = net ? net.referral_bonus_pct_l2 / 100 : config.referralCommissionL2Pct;
          if (pct2 > 0) {
            const l1Row = await t.get<{ referred_by: string | null }>(
              "SELECT referred_by FROM users WHERE id = ?", l1,
            );
            const l2 = l1Row?.referred_by;
            // Guard against a self/loop referral crediting the same account twice.
            if (l2 && l2 !== userId && l2 !== l1) {
              const bonus2 = Math.floor(rewardPoints * pct2);
              if (bonus2 > 0) {
                await postLedger({
                  userId: l2, points: bonus2, direction: "credit",
                  sourceType: "referral_bonus", sourceRefId: completionId,
                  note: "Referral bonus (level 2)",
                }, t);
              }
            }
          }
        }

        // One-time flat reward to the DIRECT inviter when this invited user
        // completes their first task. Rewards real activity, not empty signups.
        if (isFirstCreditedTask) {
          const firstBonus = net ? net.referral_first_task_bonus : config.referralFirstTaskBonusPoints;
          if (firstBonus > 0) {
            await postLedger({
              userId: l1, points: firstBonus, direction: "credit",
              sourceType: "referral_bonus", sourceRefId: completionId,
              note: "Bonus — your invite finished their first task",
            }, t);
          }
        }
      }
    });

    // Geo-mismatch signal: raise a soft fraud flag if the network says the
    // completion came from a different country than the account's. Runs AFTER
    // the credit lands — it never blocks a verified reward, only flags for staff.
    const reportedCountry = input.country ?? input.country_code ?? input.geo;
    await checkGeoMismatch(userId, user.country, reportedCountry);

    await logPostback(true, "credited", externalId);
    return reply.send({ ok: true, credited: rewardPoints });
  });
}
