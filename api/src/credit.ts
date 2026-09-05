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
import { sql, now, newId, postLedger, postEarnedUsdt, postRozi } from "./db.ts";
import { config } from "./config.ts";
import {
  lockCampaign, campaignSpend, overBudget, markExhausted,
  type BudgetRow, type BudgetVerdict,
} from "./taskBudget.ts";
import { checkGeoMismatch } from "./fraud.ts";
import { accrue, grantBoost } from "./mining/engine.ts";
import { loadMiningSettings, totalEmittedMicro } from "./mining/settings.ts";
import { toMicro } from "./mining/core.ts";
import { enabled as flagEnabled } from "./flags.ts";
import { sendPushToUser } from "./push.ts";

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
  /** Direct task reward in micro-USDT, kept separate from deposited USDT. */
  usdtMicro?: number;
  /** Direct task reward in MICRO-ROZI — the real mined token (rozi_ledger,
   *  non-withdrawable, counts against the 21M cap). Custom/RoziPay tasks only;
   *  network postbacks never set this. Founder, 2026-08-29. */
  roziMicro?: number;
  rewardType?: "points" | "rozi" | "usdt" | "both";
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
  // The campaign has paid out everything it was bought for (taskBudget.ts).
  // A refusal, not a deferral: the campaign is now paused and this completion
  // will not become creditable by waiting.
  | { status: "budget_exhausted"; reason: "conversions" | "points" | "usdt"; used: number; cap: number }
  | { status: "credited"; completionId: string; points: number; usdtMicro: number; roziMicro: number };

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
  const usdtMicro = Math.max(0, Math.trunc(req.usdtMicro ?? 0));
  const roziMicro = Math.max(0, Math.trunc(req.roziMicro ?? 0));
  const rewardType = req.rewardType
    ?? (roziMicro > 0 && points === 0 && usdtMicro === 0 ? "rozi"
      : usdtMicro > 0 ? (points > 0 ? "both" : "usdt")
      : "points");

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
  const verdict = await sql.tx<BudgetVerdict>(async (t) => {
    // ---- CAMPAIGN BUDGET (brief part 16) ----------------------------------
    // ⚠️ INSIDE THIS TRANSACTION, AND UNDER THE LOCK, ON PURPOSE. This is a
    // read-then-write on a shared total — guardrail #8's shape, one level up
    // from a user balance. Checked before the transaction, two postbacks
    // arriving together would both count 1,999 credited, both pass, and the
    // partner would be handed 2,001 conversions. Do not lift it out to "read
    // the budget once at the top"; the stale read is the entire bug.
    //
    // Only fixed-catalog tasks have a campaign at all. A dynamic survey (CPX)
    // arrives with no task_id and is unaffected — there is no row to budget.
    if (taskId) {
      await lockCampaign(t, taskId);
      const budget = await t.get<BudgetRow>(
        "SELECT budget_conversions, budget_points, budget_usdt_micro FROM tasks WHERE id = ?", taskId,
      );
      if (budget) {
        // The "points" cap now also caps whole-ROZI spend on a custom task
        // (see campaignSpend). Pass the ROZI reward of THIS completion, as
        // whole ROZI, as part of the incremental amount.
        const pointsInc = points + Math.floor(roziMicro / 1_000_000);
        const v = overBudget(budget, await campaignSpend(t, taskId), pointsInc, usdtMicro);
        if (!v.ok) {
          // Auto-pause: the whole point of a budget. It stops being offered and
          // stops crediting without anyone having to notice a number climbing.
          await markExhausted(t, taskId, now());
          // Same rule as a velocity block: a POSTBACK that was refused must be
          // on the record, a staff-approved proof must not burn its external_id
          // (see recordRejection on the request).
          if (req.recordRejection !== false) {
            await t.run(
              `INSERT INTO task_completions (id, user_id, task_id, network, external_id, status, points, offer_type, postback_payload, created_at)
               VALUES (?,?,?,?,?, 'rejected', ?,?,?,?)`,
              newId(), userId, taskId, network, externalId, points, offerType,
              JSON.stringify(payload), now(),
            );
          }
          return v;
        }
      }
    }

    await t.run(
      `INSERT INTO task_completions (id, user_id, task_id, network, external_id, status, points, usdt_micro,
                                    reward_rozi_micro, reward_type, offer_type, postback_payload, created_at, verified_at)
       VALUES (?,?,?,?,?, 'credited', ?,?,?,?,?,?,?,?)`,
      completionId, userId, taskId ?? null, network, externalId, points, usdtMicro, roziMicro, rewardType, offerType,
      JSON.stringify(payload), now(), now(),
    );

    if (points > 0) {
      await postLedger({
        userId, points, direction: "credit",
        sourceType: "task_completion", sourceRefId: completionId, note: "Task reward",
      }, t);
    }
    if (usdtMicro > 0) {
      await postEarnedUsdt({
        userId, micro: usdtMicro, direction: "credit",
        sourceType: "task_reward", sourceRefId: completionId, note: "Task reward",
      }, t);
    }

    // Real mined-token ROZI reward for a custom/RoziPay task (founder,
    // 2026-08-29). It counts against the 21M cap — totalEmittedMicro() now
    // sums 'task_reward' rows — so mint only if there is room. If the cap is
    // full the task still completes and any points/USDT portion still pays;
    // only the ROZI portion is skipped.
    let roziPaid = 0;
    if (roziMicro > 0) {
      const capMicro = toMicro((await loadMiningSettings()).supplyCap);
      const emitted = await totalEmittedMicro(t);
      if (emitted + roziMicro <= capMicro) {
        await postRozi({
          userId, micro: roziMicro, direction: "credit",
          sourceType: "task_reward", sourceRefId: completionId, note: "Task reward",
        }, t);
        roziPaid = roziMicro;
      } else {
        log.error(
          { userId, completionId, roziMicro, emitted, capMicro },
          "Task ROZI reward skipped — 21M supply cap reached",
        );
      }
    }

    // Referral bonuses are paid in the SAME currency as the task's main
    // reward: ROZI for a ROZI task (via rozi_ledger, also counted by the cap),
    // points otherwise. `roziReferral` is false when the cap blocked the main
    // ROZI mint, so a blocked task pays no referral ROZI either.
    const roziReferral = roziPaid > 0;
    const refBase = roziReferral ? roziMicro : points;
    const payReferral = async (target: string, amount: number, note: string) => {
      if (amount <= 0) return;
      if (roziReferral) {
        await postRozi({
          userId: target, micro: amount, direction: "credit",
          sourceType: "task_reward", sourceRefId: completionId, note,
        }, t);
      } else {
        await postLedger({
          userId: target, points: amount, direction: "credit",
          sourceType: "referral_bonus", sourceRefId: completionId, note,
        }, t);
      }
    };

    // Referral commission (2-level): the inviter (L1) and the inviter's inviter
    // (L2) each earn a share of this user's task points. Shares are the network's
    // configured percentages (Admin-set, never hardcoded). Every referral payout
    // comes from margin; it NEVER reduces this user's reward.
    //
    // The referrals feature flag (flags.ts) is folded into `withinWindow` rather
    // than wrapped around the block: switching referrals off stops NEW bonuses
    // and nothing else. Bonuses already paid stay paid — they are ledger rows,
    // and clawing them back from a switch would be taking money users have
    // already been shown and may already have withdrawn.
    const referralsOn = await flagEnabled("referrals");
    const windowDays = net ? net.referral_bonus_days : config.referralBonusDays;
    const inviteAgeDays = (Date.now() - new Date(user.created_at).getTime()) / 86400_000;
    const withinWindow = referralsOn && (windowDays <= 0 || inviteAgeDays <= windowDays);

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
        await payReferral(l1, Math.floor(refBase * pct1), "Referral bonus from your invite");

        const pct2 = net ? net.referral_bonus_pct_l2 / 100 : config.referralCommissionL2Pct;
        if (pct2 > 0) {
          const l1Row = await t.get<{ referred_by: string | null }>(
            "SELECT referred_by FROM users WHERE id = ?", l1,
          );
          const l2 = l1Row?.referred_by;
          // Guard against a self/loop referral crediting the same account twice.
          if (l2 && l2 !== userId && l2 !== l1) {
            await payReferral(l2, Math.floor(refBase * pct2), "Referral bonus (level 2)");
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
          // The flat bonus is a whole number — whole ROZI for a ROZI task
          // (converted to micro), whole points otherwise.
          const firstAmount = roziReferral ? toMicro(firstBonus) : firstBonus;
          await payReferral(l1, firstAmount, "Bonus — your invite finished their first task");
        }
      }
    }
    return { ok: true };
  });

  if (!verdict.ok) {
    return {
      status: "budget_exhausted", reason: verdict.reason, used: verdict.used, cap: verdict.cap,
    };
  }

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

  // Tell the user their reward actually landed (founder, 2026-09-05: "if user
  // received the rewards of the task ... there is no notification"). Fires
  // from the ONE shared crediting path — this file's own header rule — so a
  // custom RoziPay task and a network-postback offer are both covered by one
  // call site, never two that could drift. Deliberately no exact amount in the
  // copy: the reward can be points, ROZI or USDT (or a mix), and this file has
  // no user-facing currency formatter of its own (the earner app's "no points
  // in the copy" rule lives in web/src/lib/format.ts) — sending them to the
  // app to see the real number is simpler than risking wrong-currency text.
  void sendPushToUser(userId, {
    title: "You got a reward!",
    body: "A task you completed was approved. Open the app to see what you earned.",
    url: "/tasks?view=mine",
  });

  return { status: "credited", completionId, points, usdtMicro, roziMicro };
}
