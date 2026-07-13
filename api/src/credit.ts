// THE ONE PLACE TASK POINTS ARE CREDITED.
//
// This logic used to live inline in the postback webhook. Custom tasks (which a
// staff member approves from a proof, with no ad network involved) need exactly
// the same treatment — the ledger write, the 2-level referral bonuses, the
// first-task bonus, the daily velocity caps, the mining boost — so it lives here
// and BOTH callers use it. A second, parallel crediting path is how you end up
// with a task type that silently skips referral payouts or fraud caps.
//
// Guardrail #1 still holds: this function does not decide that a task is done.
// It is only ever called from something that has ALREADY verified the completion
// — a signed network postback, or a staff member approving a proof (a real human
// decision, audit-logged, never the user's own click).
import { sql, now, newId, postLedger } from "./db.ts";
import { config } from "./config.ts";
import { checkGeoMismatch } from "./fraud.ts";
import { accrue, grantBoost } from "./mining/engine.ts";
import { loadMiningSettings } from "./mining/settings.ts";

type Logger = { error: (obj: unknown, msg?: string) => void };

export type NetworkRow = {
  status: string;
  referral_bonus_pct: number;
  referral_bonus_pct_l2: number;
  referral_first_task_bonus: number;
  referral_bonus_days: number;
};

export type CreditRequest = {
  userId: string;
  network: string;
  /** Unique per completion within the network. Replay protection lives on the
   *  unique (network, external_id) index — a repeat is a no-op, not a re-credit. */
  externalId: string;
  taskId?: string | null;
  points: number;
  offerType: string;
  /** Stored on the completion so an Agent can resolve a dispute later. */
  payload: unknown;
  /** Country the source claims the completion came from, if it says. Soft flag only. */
  reportedCountry?: string;
  /** Referral config for this network. Absent -> global config defaults. */
  net?: NetworkRow | null;
  /**
   * When a velocity cap blocks the credit, write a 'rejected' completion row so
   * the attempt is visible. TRUE for postbacks: a network tried to pay and we
   * refused, and that must be on the record.
   *
   * FALSE for a staff-approved proof, and it matters: the rejected row would
   * take the (network, external_id) slot, so when the Agent re-approves the
   * proof tomorrow — once the user is under their cap again — the credit would
   * be swallowed as a "duplicate" and the user would never be paid. The proof
   * row is the record in that flow; it just stays pending.
   */
  recordRejection?: boolean;
};

export type CreditOutcome =
  | { status: "duplicate"; completionStatus: string }
  | { status: "unknown_user" }
  | { status: "velocity_blocked"; scope: "type" | "global"; detail: string }
  | { status: "credited"; completionId: string; points: number };

// A credited task boosts the user's mining hashrate for a while. Accrue first so
// the seconds already mined this session are paid at the OLD rate — the boost
// applies from now on, never retroactively.
async function grantTaskBoost(userId: string, completionId: string): Promise<void> {
  const s = await loadMiningSettings();
  if (s.taskBoostPct <= 0) return;
  await accrue(userId);
  await grantBoost(userId, "task", s.taskBoostPct, s.taskBoostHours, completionId);
}

export async function creditCompletion(req: CreditRequest, log: Logger): Promise<CreditOutcome> {
  const { userId, network, externalId, taskId, points, offerType, payload, net } = req;

  // ---- Idempotency — already processed this completion? Don't re-credit.
  const dup = await sql.get<{ status: string }>(
    "SELECT status FROM task_completions WHERE network = ? AND external_id = ?", network, externalId,
  );
  if (dup) return { status: "duplicate", completionStatus: dup.status };

  const user = await sql.get<{ id: string; referred_by: string | null; created_at: string; country: string }>(
    "SELECT id, referred_by, created_at, country FROM users WHERE id = ?", userId,
  );
  if (!user) return { status: "unknown_user" };

  // ---- Fraud velocity caps ------------------------------------------------
  // Per offer TYPE per day, then a tighter cap across ALL types.
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const typeRow = await sql.get<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM task_completions
     WHERE user_id = ? AND offer_type = ? AND status = 'credited' AND created_at >= ?`,
    userId, offerType, since.toISOString(),
  );
  const allRow = await sql.get<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM task_completions
     WHERE user_id = ? AND status = 'credited' AND created_at >= ?`,
    userId, since.toISOString(),
  );

  const overType = (typeRow?.n ?? 0) >= config.velocityCapPerTypePerDay;
  const overAll = (allRow?.n ?? 0) >= config.velocityCapAllTypesPerDay;

  if (overType || overAll) {
    const detail = overType
      ? `Over cap for offer type "${offerType}" (${typeRow?.n ?? 0} today)`
      : `Over daily cap across all offer types (${allRow?.n ?? 0} today)`;

    // Flag it, and (for postbacks) record the rejection so the attempt is not
    // invisible. See recordRejection on the request for why a proof must NOT
    // burn the external_id here.
    await sql.tx(async (t) => {
      if (req.recordRejection !== false) {
        await t.run(
          `INSERT INTO task_completions (id, user_id, task_id, network, external_id, status, points, offer_type, postback_payload, created_at)
           VALUES (?,?,?,?,?, 'rejected', ?,?,?,?)`,
          newId(), userId, taskId ?? null, network, externalId, points, offerType,
          JSON.stringify(payload), now(),
        );
      }
      await t.run(
        "INSERT INTO fraud_flags (id, user_id, flag_type, severity, detail, created_at) VALUES (?,?,?,?,?,?)",
        newId(), userId, "velocity", "medium", detail, now(),
      );
    });
    return { status: "velocity_blocked", scope: overType ? "type" : "global", detail };
  }

  // ---- Record the completion and credit together --------------------------
  // If either write fails, neither lands — no points without a completion row,
  // no completion row without points.
  const completionId = newId();
  await sql.tx(async (t) => {
    await t.run(
      `INSERT INTO task_completions (id, user_id, task_id, network, external_id, status, points, offer_type, postback_payload, created_at, verified_at)
       VALUES (?,?,?,?,?, 'credited', ?,?,?,?,?)`,
      completionId, userId, taskId ?? null, network, externalId, points, offerType,
      JSON.stringify(payload), now(), now(),
    );

    await postLedger({
      userId, points, direction: "credit",
      sourceType: "task_completion", sourceRefId: completionId, note: "Task reward",
    }, t);

    // Referral commission (2-level): the inviter (L1) and the inviter's inviter
    // (L2) each earn a share of this user's task points. Shares are the network's
    // configured percentages (Admin-set, never hardcoded). Every referral payout
    // comes from margin; it NEVER reduces this user's reward.
    const windowDays = net ? net.referral_bonus_days : config.referralBonusDays;
    const inviteAgeDays = (Date.now() - new Date(user.created_at).getTime()) / 86400_000;
    const withinWindow = windowDays <= 0 || inviteAgeDays <= windowDays;

    // KYC GATE (founder decision, 2026-07-13): an invitee earns their inviter
    // NOTHING until they are a verified, valid user.
    //
    // This is the same anti-farm line as the mining referral hashrate, applied to
    // the CASH currency, where it matters more — referral bonuses here are real
    // Points, redeemable for real USDT out of the treasury. Without this gate, a
    // farm of scripted accounts completing cheap offers pays its operator a
    // commission on every one of them. With it, each of those accounts needs a
    // distinct real ID card and a human's approval before it is worth a rupee.
    //
    // The invitee is unaffected: they are paid their full task reward above,
    // whatever their KYC state. Only the INVITER's commission waits. That keeps
    // the guardrail — a referral payout comes from margin and never reduces the
    // earner's own reward — exactly true.
    const invitee = await t.get<{ kyc_status: string; kyc_approved_at: string | null }>(
      "SELECT kyc_status, kyc_approved_at FROM users WHERE id = ?", userId);
    const inviteeIsValid = invitee?.kyc_status === "approved";

    const l1 = user.referred_by;
    if (l1 && inviteeIsValid) {
      if (withinWindow) {
        const pct1 = net ? net.referral_bonus_pct / 100 : config.referralCommissionPct;
        const bonus1 = Math.floor(points * pct1);
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
            const bonus2 = Math.floor(points * pct2);
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

      // One-time flat reward to the DIRECT inviter, paid on this invitee's first
      // credited task ON OR AFTER they verified their ID — NOT their literal first
      // task ever.
      //
      // Why "after verify": referral commission only pays for a verified invitee
      // (the KYC gate above), but people verify near the withdrawal threshold, long
      // after their real first task. Anchoring the bonus to the literal first task
      // therefore meant it almost never fired — the first task was used up while the
      // invitee was still unverified and the inviter got nothing. Firing on the
      // first task after approval keeps the incentive alive and rewards the
      // strongest genuine-activity signal there is: a verified user doing a task.
      //
      // We are inside `inviteeIsValid`, so kyc_approved_at is set (the migration
      // backfilled it for pre-existing approvals). "First since approval" = no other
      // credited task for this user on/after that stamp; the current completion is
      // already inserted, so it is excluded by id.
      if (invitee?.kyc_approved_at) {
        const priorSinceApproval = await t.get<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM task_completions
           WHERE user_id = ? AND status = 'credited' AND created_at >= ? AND id <> ?`,
          userId, invitee.kyc_approved_at, completionId,
        );
        if ((priorSinceApproval?.n ?? 0) === 0) {
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
    }
  });

  // Geo-mismatch signal: raise a soft fraud flag if the source says the
  // completion came from a different country than the account's. Runs AFTER the
  // credit lands — it never blocks a verified reward, only flags for staff.
  await checkGeoMismatch(userId, user.country, req.reportedCountry);

  // MINING: a credited task grants a temporary hashrate boost (MINING_SPEC.md
  // § 4.4). This is the line that makes mining FEED the revenue engine instead of
  // competing with it.
  //
  // Deliberately outside the transaction above and deliberately swallowed: a
  // boost is a nice-to-have, and a bug in the mining code must never roll back or
  // block a real, verified, revenue-generating points credit.
  try {
    await grantTaskBoost(userId, completionId);
  } catch (err) {
    log.error({ err, userId, completionId }, "Failed to grant mining boost for a credited task");
  }

  return { status: "credited", completionId, points };
}
