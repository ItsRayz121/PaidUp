// PER-CAMPAIGN BUDGET AND REVENUE (brief parts 15 + 16).
//
// WHY THIS EXISTS
// ---------------
// A `tasks` row had a reward and no ceiling. Nothing in the system knew how many
// times a campaign was allowed to pay out, so "the partner bought 2,000
// conversions" was a fact that lived in an email — and the only brake was a
// human noticing the number climbing and clicking Disable. Over a weekend, or
// over a postback burst, that is not a brake.
//
// TWO RULES THIS FILE EXISTS TO KEEP
// ----------------------------------
// 1. SPEND IS DERIVED, NEVER COUNTED TWICE. There is no `spent_conversions`
//    column incrementing beside the ledger. Spend is a COUNT over the credited
//    completions that already exist, exactly as analytics.ts does it — a
//    campaign counter that can disagree with the completions table is worse
//    than no counter, because it is the one people would trust.
//
// 2. THE CHECK AND THE WRITE SHARE A LOCK. A budget check is read-then-write on
//    a shared total, which is guardrail #8's exact shape one level up from a
//    user balance: two postbacks arriving together both count 1,999 credited,
//    both pass, and the campaign delivers 2,001. `lockCampaign` is taken inside
//    the same transaction as the completion insert, before the count is read.
//    The lock is per-campaign, so two different campaigns never wait on each
//    other.
import { sql, type TxApi } from "./db.ts";

/** Marks a campaign that has hit a cap. Filtered out of the earner feed by the
 *  same `status = 'active'` test that has always hidden a disabled task, so
 *  auto-pausing needed no new condition on the feed. */
export const EXHAUSTED = "exhausted";

export type BudgetRow = {
  budget_conversions: number | null;
  budget_points: number | null;
  budget_usdt_micro?: number | null;
};

export type BudgetVerdict =
  | { ok: true }
  | { ok: false; reason: "conversions" | "points" | "usdt"; used: number; cap: number };

/**
 * Serialize every budget decision for ONE campaign.
 *
 * ⚠️ MUST BE CALLED BEFORE THE COUNT IS READ, inside the transaction that will
 * write the completion. Reading first and locking after is the same non-fix as
 * checking a balance outside `lockUser()` — the stale read has already happened.
 */
export function lockCampaign(t: Pick<TxApi, "run">, taskId: string) {
  return t.run("SELECT pg_advisory_xact_lock(hashtext(?))", `task-budget:${taskId}`);
}

/**
 * What this campaign has already spent, from the completions table.
 *
 * `pending` and `rejected` completions are deliberately NOT counted: nothing was
 * paid for them. A rejected postback that still consumed a partner's conversion
 * would let a farm burn a campaign down without ever being credited a point.
 */
export async function campaignSpend(
  t: Pick<TxApi, "get">, taskId: string,
): Promise<{ conversions: number; points: number; usdtMicro: number }> {
  const row = await t.get<{ n: number; pts: number; usdt: string | number }>(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(points), 0)::int AS pts,
            COALESCE(SUM(usdt_micro), 0) AS usdt
       FROM task_completions WHERE task_id = ? AND status = 'credited'`,
    taskId,
  );
  return { conversions: row?.n ?? 0, points: row?.pts ?? 0, usdtMicro: Number(row?.usdt ?? 0) };
}

/**
 * Would crediting `points` more on this campaign break a cap?
 *
 * ⚠️ THE POINTS TEST IS `used + points > cap`, NOT `used >= cap`. A ceiling on
 * spend has to be checked against the spend that is about to happen, or the last
 * conversion is always allowed to overshoot it by a whole reward — which on a
 * campaign with one big reward left is most of the overspend the cap exists to
 * prevent. The conversions test is `used >= cap` because this completion is
 * exactly one more.
 */
export function overBudget(
  budget: BudgetRow, spend: { conversions: number; points: number; usdtMicro?: number },
  points: number, usdtMicro = 0,
): BudgetVerdict {
  if (budget.budget_conversions !== null && budget.budget_conversions !== undefined
      && spend.conversions >= budget.budget_conversions) {
    return { ok: false, reason: "conversions", used: spend.conversions, cap: budget.budget_conversions };
  }
  if (budget.budget_points !== null && budget.budget_points !== undefined
      && spend.points + points > budget.budget_points) {
    return { ok: false, reason: "points", used: spend.points, cap: budget.budget_points };
  }
  if (budget.budget_usdt_micro !== null && budget.budget_usdt_micro !== undefined
      && (spend.usdtMicro ?? 0) + usdtMicro > budget.budget_usdt_micro) {
    return { ok: false, reason: "usdt", used: spend.usdtMicro ?? 0, cap: budget.budget_usdt_micro };
  }
  return { ok: true };
}

/**
 * Auto-pause. Flips the campaign to `exhausted` so it stops being offered and
 * stops crediting, and stamps when it happened.
 *
 * ⚠️ ONLY EVER MOVES AN `active` ROW. A campaign an Admin has deliberately
 * `disabled` must not be quietly relabelled by a late postback — "I disabled
 * this" and "it ran out" are different answers to "why did it stop", and staff
 * act on them differently.
 */
export async function markExhausted(t: Pick<TxApi, "run">, taskId: string, at: string) {
  await t.run(
    `UPDATE tasks SET status = ?, budget_exhausted_at = ?
      WHERE id = ? AND status = 'active'`,
    EXHAUSTED, at, taskId,
  );
}

/**
 * Per-campaign money, for the staff panel (part 15).
 *
 * Derived in one query from rows that already exist. `referralPoints` is the
 * commission those completions paid to inviters — it is not charged against the
 * budget (see the column note in db.ts) but it IS real spend, so a margin that
 * left it out would overstate every campaign that has any referred users on it.
 */
export type CampaignMoney = {
  taskId: string;
  conversions: number;
  points: number;
  usdtMicro: number;
  referralPoints: number;
  revenueMicro: number;
  /** Revenue minus everything paid out, in micro-USD. Negative = losing money. */
  marginMicro: number;
};

export async function campaignMoney(pointsPerUsdt: number): Promise<Map<string, CampaignMoney>> {
  // One pass over the credited completions, one over the referral bonuses those
  // completions triggered (they are joined by ledger source_ref_id = completion
  // id, which is how credit.ts writes them).
  const rows = await sql.all<{
    task_id: string; n: number; pts: number; usdt: string | number; ref_pts: number; rev: string | number;
  }>(
    `SELECT c.task_id,
            COUNT(*)::int AS n,
            COALESCE(SUM(c.points), 0)::int AS pts,
            COALESCE(SUM(c.usdt_micro), 0) AS usdt,
            COALESCE((
              SELECT SUM(l.amount) FROM ledger_entries l
               WHERE l.source_type = 'referral_bonus'
                 AND l.direction = 'credit'
                 AND l.source_ref_id IN (
                   SELECT c2.id FROM task_completions c2
                    WHERE c2.task_id = c.task_id AND c2.status = 'credited')
            ), 0)::int AS ref_pts,
            COALESCE(MAX(t.revenue_per_conversion_micro), 0) AS rev
       FROM task_completions c
       JOIN tasks t ON t.id = c.task_id
      WHERE c.status = 'credited'
      GROUP BY c.task_id`,
  );

  const out = new Map<string, CampaignMoney>();
  for (const r of rows) {
    const revenueMicro = Number(r.rev) * r.n;
    // Points -> micro-USD at the SAME rate a payout uses. Not a new rate: the
    // margin has to be in the money we actually pay in, or it is a number that
    // agrees with nothing else in the app.
    const directUsdtMicro = Number(r.usdt ?? 0);
    const costMicro = Math.round(((r.pts + r.ref_pts) / pointsPerUsdt) * 1e6) + directUsdtMicro;
    out.set(r.task_id, {
      taskId: r.task_id,
      conversions: r.n,
      points: r.pts,
      usdtMicro: directUsdtMicro,
      referralPoints: r.ref_pts,
      revenueMicro,
      marginMicro: revenueMicro - costMicro,
    });
  }
  return out;
}
