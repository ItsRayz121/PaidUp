// ROZI mining — earner-facing endpoints (docs/MINING_SPEC.md).
//
// GUARDRAIL #7 runs through this whole file: ROZI and Points are separate
// ledgers. The ONLY two routes here that touch the Points ledger are the booster
// purchase (a Points debit — a sink) and conversion settlement (a Points credit
// out of a pre-committed, hard-capped pot). Everything else moves ROZI only.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  sql, now, newId, postLedger, postRozi, balanceOf, roziBalanceMicroOf,
  postUsdt, usdtBalanceMicroOf, usdtToMicro, getOrCreateDepositAddress, type TxApi,
} from "../db.ts";
import { chainById, validateAddress, type ChainId } from "../chains.ts";
import { config } from "../config.ts";
import { getUserId, requireActiveUser } from "../auth.ts";
import { flagOnce } from "../fraud.ts";
import { kycFeatureEnabled, kycSatisfied } from "../kyc.ts";
import { custodyEnabled } from "../custody.ts";
import { tryAutoSettleRefund } from "../autoRefund.ts";
import { getGasFeeRate, gasFeeMicro } from "../fees.ts";
import { sendPushToUser } from "../push.ts";
import { relayAvailable, hasEnoughGas } from "../payoutRelay.ts";
import { loadMiningSettings } from "../mining/settings.ts";
import {
  startSession, sessionState, accrue, hashrateOf, grantBoost,
} from "../mining/engine.ts";
import {
  rigUpgradeCost, rigPower, conversionPayout, conversionAllowanceMicro, toMicro, fromMicro,
} from "../mining/core.ts";
import { requireFeature } from "../flags.ts";

// Every ROZI amount crossing this API is MICRO-ROZI, and every field carrying one
// is named `...Micro`. The web formats it for display (web/src/lib/format.ts).
// Naming them plainly `rozi` would be a trap: a client that read the number
// straight would show someone 3,333,333 ROZI instead of 3.33.

function guard(
  handler: (userId: string, req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = getUserId(req);
      await requireActiveUser(userId);
      return await handler(userId, req, reply);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Something went wrong" });
    }
  };
}

function deviceOf(req: FastifyRequest): string {
  const raw = req.headers["x-device-id"];
  const id = Array.isArray(raw) ? raw[0] : raw;
  return id ? String(id).slice(0, 100) : "";
}

// Serialize every balance-changing transaction for one user, exactly as the
// withdrawal path does (routes/withdrawals.ts).
//
// Without this, under READ COMMITTED two concurrent requests both read the same
// balance, both pass the "can you afford it" check, and both debit — spending
// the same currency twice. That is not theoretical here: the booster purchase
// debits the REAL Points ledger, and a conversion burn buys a pro-rata slice of
// a pot of real Points, so an unserialized double-debit is a direct route to
// money we never earned.
//
// MUST be the first statement in any transaction that reads a balance and then
// writes against it. The lock is released when the transaction commits.
function lockUser(t: Pick<TxApi, "run">, userId: string) {
  return t.run("SELECT pg_advisory_xact_lock(hashtext(?))", userId);
}

type RigRow = {
  id: string; name: string; icon: string; base_cost: number; cost_growth: number;
  base_power: number; power_growth: number; max_level: number; status: string;
  base_cost_usdt: string | number | null;
};

// What a rig costs in USDT at a given level, in MICRO-USDT, or null when this rig
// cannot be bought with money at all (the shipped default for every rig).
//
// The USDT price curve reuses cost_growth, so a rig that doubles in ROZI per
// level doubles in dollars too. It is deliberately NOT derived from the ROZI
// price by any rate: that rate would be a published ROZI valuation, which is the
// one thing this product does not have and must not invent (guardrail #7).
function rigUsdtCostMicro(r: RigRow, level: number): number | null {
  if (r.base_cost_usdt === null || r.base_cost_usdt === undefined) return null;
  const base = Number(r.base_cost_usdt);
  if (!(base > 0)) return null;
  return Math.floor(base * Math.pow(r.cost_growth / 100, level));
}
const defOf = (r: RigRow) => ({
  baseCost: Number(r.base_cost), costGrowth: r.cost_growth,
  basePower: r.base_power, powerGrowth: r.power_growth, maxLevel: r.max_level,
});

// ---- Ad-watch (revenue line #2) ---------------------------------------------
//
// The reward for watching an ad is a hashrate BOOST, never a direct currency
// credit — so a faked ad view cannot mint ROZI out of nothing, and guardrail #1
// (points only from verified events) is untouched. Note the nuance under the "pi"
// emission model, now the default: a boost multiplies the miner's OWN payout, so a
// faked view DOES increase the faker's own minted ROZI — it is not the "reshuffles
// a fixed pot, mints nothing" story that held under the pool model. What keeps the
// weak, no-postback verification acceptable (Monetag has no S2S callback) is that
// the boost is temporary, capped per day (adWatchDailyCap), identical to what an
// honest ad-watcher earns, and bounded by the supply cap — with conversion to
// Points OFF at launch. It is toll evasion, not theft.
//
// State lives in ad_impressions, never in process memory: the API runs more than
// one instance on Railway, so an in-memory nonce set would reject a valid
// completion that happened to land on a different instance.
const MIN_WATCH_SECONDS = 15;

// Ads need BOTH the flag and a configured provider. Without the provider check, an
// Admin who flips adsEnabled=1 before the ad tag is actually integrated would be
// handing out free hashrate boosts for a video nobody watched — all of the
// dilution, none of the revenue. The flag alone is not consent to pay out.
const adsLive = (s: { adsEnabled: number; adProvider: string }) =>
  Boolean(s.adsEnabled) && Boolean(s.adProvider);

// Consume one ad nonce and grant the boost. Throws if the nonce is invalid, not
// yours, too fresh, already spent, or over the daily cap.
//
// ONE copy of this, called by both /mining/ad/complete and /mining/start, because
// it carries a fix that is easy to lose. It used to SELECT the row, check
// `status = 'issued'`, and only UPDATE it several statements later. That gap is
// exploitable: fire fifty concurrent POSTs with the SAME nonce and every one reads
// `issued`, every one passes the check, and every one grants a boost. The daily cap
// had the same hole.
//
// That is not cosmetic. Hashrate decides your share of the day's ROZI emission, and
// ROZI is a claim on future Conversion Window pots, which pay out real Points.
// Inflating your hashrate takes real money from honest miners. So: an advisory lock
// per user (guardrail #8), and the nonce is consumed by a CONDITIONAL update whose
// row count is the authority — the database picks the winner, not a read we did
// earlier. Duplicating this logic instead of calling it would reintroduce the race.
async function redeemAdNonce(
  userId: string,
  nonce: string,
  s: { adsEnabled: number; adProvider: string; adBoostPct: number; adBoostHours: number; adWatchDailyCap: number },
): Promise<{ watchedSeconds: number }> {
  await accrue(userId); // pay out the pre-boost seconds at the pre-boost rate

  const result = await sql.tx(async (t) => {
    await lockUser(t, userId);

    const row = await t.get<{ id: string; user_id: string; status: string; issued_at: string }>(
      "SELECT id, user_id, status, issued_at FROM ad_impressions WHERE nonce = ?", nonce);
    if (!row) throw { statusCode: 400, message: "That ad view is not valid." };

    // The nonce is bound to the user it was issued to. Compared in constant time so
    // it cannot be probed byte-by-byte to harvest another user's nonce.
    const a = Buffer.from(row.user_id);
    const b = Buffer.from(userId);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw { statusCode: 403, message: "That ad view is not yours." };
    }

    const watchedSeconds = (Date.now() - Date.parse(row.issued_at)) / 1000;
    if (watchedSeconds < MIN_WATCH_SECONDS) {
      await t.run(
        "UPDATE ad_impressions SET status = 'rejected' WHERE id = ? AND status = 'issued'", row.id);
      throw { statusCode: 400, message: "Watch the whole ad to get your boost." };
    }

    // The cap is enforced HERE, at spend, not at issue. Issuing a nonce is free and
    // does not count toward the cap (only 'rewarded' rows do), so a user could bank
    // 50 nonces while their rewarded count was still 0, wait out the dwell timer
    // once, and redeem them all.
    const rewardedToday = await t.get<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ad_impressions
       WHERE user_id = ? AND status = 'rewarded' AND rewarded_at > ?`,
      userId, new Date(Date.now() - 86_400_000).toISOString(),
    );
    if (Number(rewardedToday?.n ?? 0) >= s.adWatchDailyCap) {
      await t.run(
        "UPDATE ad_impressions SET status = 'rejected' WHERE id = ? AND status = 'issued'", row.id);
      throw { statusCode: 429, message: `You have watched your ${s.adWatchDailyCap} ads for today. Come back tomorrow.` };
    }

    const consumed = await t.run(
      "UPDATE ad_impressions SET status = 'rewarded', rewarded_at = ? WHERE id = ? AND status = 'issued'",
      now(), row.id,
    );
    if (consumed.rowCount === 0) {
      throw { statusCode: 400, message: "That ad was already counted." };
    }

    await grantBoost(userId, "ad", s.adBoostPct, s.adBoostHours, row.id, t);
    return { watchedSeconds };
  });

  // Machine-regular completions (always redeemed at exactly the dwell minimum) are
  // the bot signature here. Flag, never block.
  if (result.watchedSeconds < MIN_WATCH_SECONDS + 0.5) {
    await flagOnce("mining_bot_pattern", `ad:${userId}`, userId, "medium",
      `Ad completions land at exactly the ${MIN_WATCH_SECONDS}s dwell minimum.`);
  }
  return result;
}

export async function miningRoutes(app: FastifyInstance) {
  // ---- State ---------------------------------------------------------------
  // The one call the /mine screen polls. Accrues first, so the numbers it
  // returns are already up to date.
  app.get("/mining/state", guard(async (userId) => {
    const s = await loadMiningSettings();
    const state = await sessionState(userId);
    const { breakdown } = await hashrateOf(userId, s);
    const [roziMicro, streak, boosts, adsToday, me, sentToday, store] = await Promise.all([
      roziBalanceMicroOf(userId),
      sql.get<{ current_days: number; best_days: number }>(
        "SELECT current_days, best_days FROM mining_streaks WHERE user_id = ?", userId),
      sql.all<{ kind: string; multiplier_pct: number; expires_at: string }>(
        "SELECT kind, multiplier_pct, expires_at FROM user_boosts WHERE user_id = ? AND expires_at > ? ORDER BY expires_at",
        userId, now()),
      sql.get<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ad_impressions
         WHERE user_id = ? AND status = 'rewarded' AND rewarded_at > ?`,
        userId, new Date(Date.now() - 86_400_000).toISOString()),
      // For the send screen: every reason a transfer could be refused, answered
      // here so the UI can say so BEFORE the user types an amount. Finding out
      // you are not allowed to send only after filling the form is the worst
      // version of this screen.
      sql.get<{ created_at: string; kyc_status: string }>(
        "SELECT created_at, kyc_status FROM users WHERE id = ?", userId),
      sql.get<{ t: string }>(
        "SELECT COALESCE(SUM(amount), 0) AS t FROM rozi_transfers WHERE from_user_id = ? AND created_at > ?",
        userId, new Date(Date.now() - 86_400_000).toISOString()),
      sql.get<{ n: string }>(
        "SELECT COUNT(*) AS n FROM rozi_store_items WHERE status = 'active' AND stock > 0"),
    ]);

    const accountDays = Math.floor((Date.now() - Date.parse(me!.created_at)) / 86_400_000);
    const storeCount = Number(store?.n ?? 0);

    // One read of the ID-check switch, shared by the two fields below. When it is
    // off the check is waived, not merely hidden — see kycSatisfied() in kyc.ts.
    const kycFeatureOn = await kycFeatureEnabled();
    const kycOk = me!.kyc_status === "approved" || !kycFeatureOn;

    return {
      roziMicro,
      session: {
        active: state.active,
        expiresAt: state.expiresAt ?? null,
        sessionHours: s.sessionHours,
      },
      hashrate: state.hashrate,
      breakdown,
      sharesToday: state.sharesToday,
      estimatedRoziMicro: state.estimatedRoziMicro,
      // Pool model: the UI MUST hedge this — it moves as other people mine, and
      // that is the difficulty adjustment working, not a bug.
      // Pi model: it is NOT an estimate. It is what the user has earned, it only
      // goes up, and hedging it would be a lie in the other direction.
      estimateIsLive: state.estimateIsLive,
      streak: { current: streak?.current_days ?? 0, best: streak?.best_days ?? 0 },
      boosts: boosts.map((b) => ({ kind: b.kind, pct: b.multiplier_pct, expiresAt: b.expires_at })),
      ads: {
        // Needs the flag AND a provider — see adsLive().
        enabled: adsLive(s),
        watchedToday: Number(adsToday?.n ?? 0),
        dailyCap: s.adWatchDailyCap,
        boostPct: s.adBoostPct,
        boostHours: s.adBoostHours,
        // Show an ad before mining starts. The client honours this; the server
        // never refuses to start a session for want of one (see adGateOnStart).
        gateOnStart: Boolean(s.adGateOnStart) && adsLive(s),
        provider: s.adProvider,
        monetagZoneId: s.monetagZoneId,
        monetagDirectLink: s.monetagDirectLink,
        monetagBannerZone: s.monetagBannerZone,
        monetagRewardedZone: s.monetagRewardedZone,
      },
      // Told plainly, and repeated in the UI. Pretending otherwise is the
      // fastest way to burn the brand.
      convertible: Boolean(s.conversionEnabled),
      // Whether the shop has anything to sell. The /mine link is hidden when it
      // does not — the rule everywhere on that screen is that a link never leads
      // to an empty room, because links that sometimes do get ignored.
      storeOpen: storeCount > 0,
      transfersEnabled: Boolean(s.transfersEnabled),
      // Both conditions folded into one flag, so the client cannot show a
      // top-up link that leads to a screen with no address to send money to.
      usdtTopup: Boolean(s.usdtTopupEnabled) && s.usdtTreasuryAddress !== "",
      // Everything the send screen needs to explain itself up front. `canSend`
      // is the server's answer, not the client's guess — the route re-checks all
      // of this anyway, so this block is for the copy, never for the decision.
      transfer: {
        enabled: Boolean(s.transfersEnabled),
        canSend:
          Boolean(s.transfersEnabled) &&
          accountDays >= s.transferMinAccountDays &&
          (!s.transferRequireKyc || kycOk),
        // False once an Admin switches the ID check off, so the send screen stops
        // showing a "verify your ID" prompt pointing at a hidden tab. Same source
        // of truth as the route, which is the only way the two can agree.
        requireKyc: Boolean(s.transferRequireKyc) && kycFeatureOn,
        kycStatus: me!.kyc_status ?? "none",
        accountDays,
        minAccountDays: s.transferMinAccountDays,
        dailyCap: s.transferDailyCap,
        sentTodayMicro: Number(sentToday?.t ?? 0),
        feePct: s.transferFeePct,
      },
      // A second account on a phone that already mined today accrues nothing.
      deviceBlocked: state.deviceBlocked,
    };
  }));

  // Start a session, optionally redeeming the ad the user just watched.
  //
  // The ad is a SOFT gate (see adGateOnStart in mining/core.ts). If `adNonce` is
  // present it is redeemed and the boost granted; if it is absent — because
  // Monetag had no fill, or because the user skipped it — the session starts
  // anyway. Refusing to start mining because an ad network was down would punish
  // the user for our supplier's outage and break a streak they had earned.
  app.post("/mining/start", guard(async (userId, req) => {
    // Feature flag (flags.ts). Only STARTING is refused. A session already
    // running still settles at the end of its epoch — cutting one off mid-way
    // would destroy hours of accrual a user has already done, which is exactly
    // the class of bug MINING_PLAN.md M9.5 exists to warn about.
    await requireFeature("mining");
    const body = z.object({ adNonce: z.string().optional() }).parse(req.body ?? {});

    // Redeem BEFORE starting, so the boost is live for the whole session rather
    // than being applied a second later to a session already accruing at the
    // un-boosted rate.
    let boost: { pct: number; hours: number } | null = null;
    if (body.adNonce) {
      const s = await loadMiningSettings();
      if (adsLive(s)) {
        try {
          await redeemAdNonce(userId, body.adNonce, s);
          boost = { pct: s.adBoostPct, hours: s.adBoostHours };
        } catch {
          // A bad, stale or already-spent nonce must NOT stop the user mining.
          // They lose the boost, not the session.
        }
      }
    }

    const r = await startSession(userId, deviceOf(req));
    if (!r.ok) throw { statusCode: 400, message: r.reason };
    return { ok: true, expiresAt: r.expiresAt, boost };
  }));

  // ---- ROZI history --------------------------------------------------------
  app.get("/mining/history", guard(async (userId) => {
    const rows = await sql.all<{
      id: string; amount: string; direction: string; source_type: string;
      note: string | null; created_at: string;
    }>(
      "SELECT id, amount, direction, source_type, note, created_at FROM rozi_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 100",
      userId,
    );
    // `amount` is dropped rather than passed through: it is a BIGINT that arrives
    // as a string, and leaving it beside amountMicro invites a client to read the
    // wrong one.
    return {
      entries: rows.map((r) => ({
        id: r.id,
        amountMicro: Number(r.amount),
        direction: r.direction,
        source_type: r.source_type,
        note: r.note,
        created_at: r.created_at,
      })),
    };
  }));

  // ---- Rigs (a ROZI sink) --------------------------------------------------
  app.get("/mining/rigs", guard(async (userId) => {
    const rigs = await sql.all<RigRow>(
      "SELECT * FROM rigs WHERE status = 'active' ORDER BY sort, base_cost");
    const owned = new Map(
      (await sql.all<{ rig_id: string; level: number }>(
        "SELECT rig_id, level FROM user_rigs WHERE user_id = ?", userId))
        .map((r) => [r.rig_id, r.level]),
    );
    const s = await loadMiningSettings();
    return {
      roziMicro: await roziBalanceMicroOf(userId),
      // The second way to pay. Zero for everyone until a deposit is confirmed,
      // and the whole USDT option stays hidden while top-ups are switched off.
      usdtMicro: await usdtBalanceMicroOf(userId),
      usdtEnabled: Boolean(s.usdtTopupEnabled) && s.usdtTreasuryAddress !== "",
      rigs: rigs.map((r) => {
        const level = owned.get(r.id) ?? 0;
        const def = defOf(r);
        const maxed = level >= r.max_level;
        return {
          id: r.id, name: r.name, icon: r.icon, level, maxLevel: r.max_level,
          power: rigPower(def, level),
          nextPower: maxed ? null : rigPower(def, level + 1),
          // The catalogue prices rigs in WHOLE ROZI (an admin types "50", not
          // "50000000"), so the cost is converted here, at the API edge, to the
          // same micro unit as the balance it will be compared against.
          nextCostMicro: maxed ? null : toMicro(rigUpgradeCost(def, level)),
          // null => this rig is ROZI-only. Most are, and that is the default.
          nextCostUsdtMicro: maxed ? null : rigUsdtCostMicro(r, level),
        };
      }),
    };
  }));

  // Buy or upgrade a rig, paying with MINED ROZI or with TOPPED-UP USDT
  // (founder, 2026-07-29). One route, because everything except which ledger
  // gets the debit is identical, and splitting it would be two places to forget
  // the advisory lock.
  app.post("/mining/rigs/:id/upgrade", guard(async (userId, req) => {
    // Rigs already owned keep working and keep their hashrate; only BUYING is
    // closed. A rig was paid for with ROZI that is now burned, so revoking one
    // would be taking something a user bought.
    await requireFeature("machines");
    const rigId = (req.params as { id: string }).id;
    const body = z.object({
      pay: z.enum(["rozi", "usdt"]).optional(),
    }).parse(req.body ?? {});
    const payWith = body.pay ?? "rozi";

    const s = await loadMiningSettings();
    if (payWith === "usdt" && !s.usdtTopupEnabled) {
      throw { statusCode: 400, message: "Paying with USDT is not switched on yet." };
    }

    // Accrue BEFORE the hashrate changes, so the seconds already mined are paid
    // at the old rate and the new rig applies only from now on.
    await accrue(userId);

    return sql.tx(async (t) => {
      // The lock covers BOTH ledgers, because it is keyed on the user and not on
      // the currency. Two requests from one account — one spending ROZI, one
      // spending USDT — must still serialize, or they both read level N and both
      // write level N+1 for the price of one.
      await lockUser(t, userId);

      const rig = await t.get<RigRow>(
        "SELECT * FROM rigs WHERE id = ? AND status = 'active'", rigId);
      if (!rig) throw { statusCode: 404, message: "That rig is not available." };

      const cur = await t.get<{ level: number }>(
        "SELECT level FROM user_rigs WHERE user_id = ? AND rig_id = ?", userId, rigId);
      const level = cur?.level ?? 0;
      if (level >= rig.max_level) throw { statusCode: 400, message: "This rig is already at max level." };

      // Catalogue price is whole ROZI; the ledger is micro. Convert once, here,
      // and compare like with like.
      const costMicro = toMicro(rigUpgradeCost(defOf(rig), level));
      const usdtCostMicro = rigUsdtCostMicro(rig, level);

      let usdtMicro = 0;
      if (payWith === "usdt") {
        if (usdtCostMicro === null) {
          throw { statusCode: 400, message: "This machine can only be bought with ROZI." };
        }
        usdtMicro = await usdtBalanceMicroOf(userId, t);
        if (usdtMicro < usdtCostMicro) {
          throw { statusCode: 400, message: "You do not have enough USDT for this yet." };
        }
        await postUsdt({
          userId, micro: usdtCostMicro, direction: "debit", sourceType: "rig_purchase",
          sourceRefId: rigId, note: `${rig.name} level ${level + 1}`,
        }, t);
      }

      const balMicro = await roziBalanceMicroOf(userId, t);
      if (payWith === "rozi") {
        if (balMicro < costMicro) {
          throw { statusCode: 400, message: "You do not have enough ROZI for this yet." };
        }
        await postRozi({
          userId, micro: costMicro, direction: "debit", sourceType: "rig_purchase",
          sourceRefId: rigId, note: `${rig.name} level ${level + 1}`,
        }, t);
      }

      await t.run(
        `INSERT INTO user_rigs (user_id, rig_id, level, updated_at) VALUES (?,?,?,?)
         ON CONFLICT (user_id, rig_id) DO UPDATE SET level = EXCLUDED.level, updated_at = EXCLUDED.updated_at`,
        userId, rigId, level + 1, now(),
      );
      return {
        ok: true, level: level + 1, paidWith: payWith,
        spentMicro: payWith === "rozi" ? costMicro : 0,
        spentUsdtMicro: payWith === "usdt" ? usdtCostMicro : 0,
        roziMicro: payWith === "rozi" ? balMicro - costMicro : balMicro,
        usdtMicro: payWith === "usdt" ? usdtMicro - usdtCostMicro! : await usdtBalanceMicroOf(userId, t),
      };
    });
  }));

  // ---- USDT top-up credit ---------------------------------------------------
  //
  // READ THE usdt_ledger COMMENT IN db.ts BEFORE CHANGING ANYTHING HERE. The
  // short version: this balance is SPEND-ONLY, and there is deliberately no
  // route in this file (or any other) that lets the balance leave the app.
  // That absence is what keeps us out of holding customer funds. A deposit to
  // the one shared treasury address is confirmed by a staff member pasting the
  // tx hash (POST /usdt/topups below); a deposit to a personal address
  // (CUSTODY_SPEC.md § 5 steps 2-3) is detected and credited automatically by
  // deposits/scanner.ts + credit.ts, no staff step — both paths land in the
  // same usdt_ledger and the same `topups` array below.
  app.get("/usdt", guard(async (userId) => {
    const s = await loadMiningSettings();
    const enabled = Boolean(s.usdtTopupEnabled) && s.usdtTreasuryAddress !== "";
    const rows = await sql.all<{
      id: string; chain: string; tx_hash: string; amount: string;
      status: string; reject_reason: string | null; created_at: string;
    }>(
      `SELECT id, chain, tx_hash, amount, status, reject_reason, created_at
       FROM usdt_topups WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      userId,
    );
    // Deposits the scanner found and credited on its own (deposits/credit.ts)
    // — a personal deposit address (personalAddress below) never goes through
    // the manual-claim table above, so without this query those deposits move
    // the balance but leave no history row at all. 'reorged_out' rows are
    // excluded outright: as far as the user should ever see, that deposit
    // never happened.
    const autoRows = await sql.all<{
      id: string; chain: string; tx_hash: string; amount: string;
      status: string; created_at: string;
    }>(
      `SELECT id, chain, tx_hash, amount, status, created_at
       FROM chain_deposits WHERE user_id = ? AND token = 'usdt' AND status <> 'reorged_out'
       ORDER BY created_at DESC LIMIT 50`,
      userId,
    );
    // BNB deposits (deposits/creditNative.ts) — history-only, never a ledger
    // row; see native_deposits' table comment in db.ts.
    const nativeDepositRows = await sql.all<{
      id: string; tx_hash: string; amount_wei: string; from_address: string; created_at: string;
    }>(
      `SELECT id, tx_hash, amount_wei, from_address, created_at
       FROM native_deposits WHERE user_id = ? AND status = 'confirmed'
       ORDER BY created_at DESC LIMIT 50`,
      userId,
    );
    const refunds = await sql.all<{
      id: string; chain: string; address: string; amount: string; fee_micro: string;
      status: string; tx_hash: string | null; reject_reason: string | null; created_at: string;
    }>(
      `SELECT id, chain, address, amount, fee_micro, status, tx_hash, reject_reason, created_at
       FROM usdt_refund_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      userId,
    );
    const gasFeeRate = await getGasFeeRate();
    // The user's own gas wallet (founder, 2026-08-08, second pass): when the
    // relay can sign from the user's own derived address, the refund screen
    // needs to show its LIVE BNB balance, not just the USDT one — that is
    // now the thing standing between "Get my money back" and it actually
    // going through. null on any chain where the relay isn't wired up
    // (nothing changes there; the old direct-treasury fallback pays its own
    // gas, same as always).
    const relayReady = enabled && relayAvailable(s.usdtTreasuryChain);
    const gas = relayReady ? await hasEnoughGas(userId, s.usdtTreasuryChain as "bep20") : null;
    return {
      enabled,
      balanceMicro: await usdtBalanceMicroOf(userId),
      // Asking for a deposit back does NOT depend on `enabled`. Deposits can be
      // switched off while people still hold a balance, and that is exactly when
      // being unable to ask for it back would be worst.
      refundMinMicro: 1_000_000,
      // The gas fee (founder, 2026-08-08; DROPPED same day, second pass when
      // the relay is available — see gasReady below). Kept here, unchanged,
      // for the direct-treasury fallback path, where treasury really is
      // paying real gas and really does recover it this way.
      gasFeePercent: relayReady ? 0 : gasFeeRate.percent,
      gasFeeFixedMicro: relayReady ? 0 : gasFeeRate.fixedMicro,
      // Present only when the relay is wired up for this chain — the refund
      // screen uses this to show "you need BNB" BEFORE the user submits,
      // instead of only finding out from a 400 after tapping the button.
      personalGasWei: gas ? gas.balanceWei.toString() : null,
      personalGasRequiredWei: gas ? gas.requiredWei.toString() : null,
      personalGasReady: gas ? gas.ok : null,
      refunds: refunds.map((r) => ({
        id: r.id, chain: r.chain, address: r.address, amountMicro: Number(r.amount),
        feeMicro: Number(r.fee_micro ?? 0), status: r.status, txHash: r.tx_hash,
        rejectReason: r.reject_reason, createdAt: r.created_at,
      })),
      // Only sent when the feature is on — there is no reason for an address we
      // are not currently accepting deposits at to be sitting in a JSON response.
      treasuryAddress: enabled ? s.usdtTreasuryAddress : null,
      treasuryChain: enabled ? s.usdtTreasuryChain : null,
      chainLabel: chainById(s.usdtTreasuryChain)?.label ?? s.usdtTreasuryChain,
      // Per-user deposit address (CUSTODY_SPEC.md § 5 step 1). Only present
      // when an xpub is configured for the treasury chain — most deployments
      // have none yet, and null means "use the shared address above", exactly
      // like before this existed. Read-only: getting this address does not
      // change how a deposit is confirmed (still a staff member + a tx hash).
      personalAddress: enabled && custodyEnabled(s.usdtTreasuryChain)
        ? await getOrCreateDepositAddress(userId, s.usdtTreasuryChain)
        : null,
      minTopup: s.usdtMinTopup,
      maxTopup: s.usdtMaxTopup,
      topups: [
        ...rows.map((r) => ({
          id: r.id, chain: r.chain, txHash: r.tx_hash, amountMicro: Number(r.amount),
          status: r.status, rejectReason: r.reject_reason, createdAt: r.created_at,
        })),
        // chain_deposits has no 'rejected' state of its own — 'credited' is the
        // only terminal-success status, everything pre-credit reads as pending.
        ...autoRows.map((r) => ({
          id: r.id, chain: r.chain, txHash: r.tx_hash, amountMicro: Number(r.amount),
          status: r.status === "credited" ? "confirmed" : "pending",
          rejectReason: null as string | null, createdAt: r.created_at,
        })),
      ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, 50),
      nativeDeposits: nativeDepositRows.map((r) => ({
        id: r.id, txHash: r.tx_hash, amountWei: r.amount_wei, fromAddress: r.from_address, createdAt: r.created_at,
      })),
    };
  }));

  // "I sent you USDT — here is the transaction." Records a CLAIM. Nothing is
  // credited here; a staff member confirms it against the chain first.
  app.post("/usdt/topups", guard(async (userId, req) => {
    const body = z.object({
      txHash: z.string().trim().min(6).max(200),
      amount: z.number().positive(),   // whole USDT, as the user typed it
    }).parse(req.body);

    const s = await loadMiningSettings();
    if (!s.usdtTopupEnabled || s.usdtTreasuryAddress === "") {
      throw { statusCode: 400, message: "Adding USDT is not switched on yet." };
    }
    if (body.amount < s.usdtMinTopup) {
      throw { statusCode: 400, message: `The smallest top-up is ${s.usdtMinTopup} USDT.` };
    }
    if (body.amount > s.usdtMaxTopup) {
      throw { statusCode: 400, message: `The biggest top-up is ${s.usdtMaxTopup} USDT.` };
    }

    // The chain is OURS, not the user's choice: there is one treasury address
    // and deposits arrive on the chain it lives on. Letting the client pick
    // would only produce claims we cannot check.
    const chain = s.usdtTreasuryChain;

    // NORMALISE THE HASH BEFORE IT BECOMES THE UNIQUENESS KEY. The unique index
    // is what makes one real deposit creditable exactly once, and it compares
    // strings — so "0xABC" and "abc" are two different rows for one transaction.
    // That is a live double-credit: claim the same deposit twice in both
    // spellings, and a reviewer who pastes either into a block explorer sees a
    // real transaction for the real amount both times, because explorers accept
    // a hash with or without the prefix. Stripping "0x" and lower-casing closes
    // it in the one place that decides.
    const txHash = body.txHash.trim().toLowerCase().replace(/^0x/, "");
    if (txHash === "") throw { statusCode: 400, message: "Paste the transaction ID." };

    const id = newId();
    try {
      await sql.run(
        `INSERT INTO usdt_topups (id, user_id, chain, tx_hash, amount, status, created_at)
         VALUES (?,?,?,?,?, 'pending', ?)`,
        id, userId, chain, txHash, usdtToMicro(body.amount), now(),
      );
    } catch {
      // The unique index on (chain, tx_hash) is what makes one real deposit
      // creditable exactly once, no matter how many accounts paste the hash.
      throw { statusCode: 409, message: "That transaction has already been sent to us." };
    }
    return { ok: true, id, status: "pending" };
  }));

  // ---- Refund an unspent deposit (founder, 2026-08-01) ----------------------
  //
  // ⚠️ THIS IS THE ONE WAY DEPOSIT CREDIT LEAVES THE APP AS MONEY. Read the
  // note above usdt_ledger in db.ts before changing it — it records why the
  // original spend-only rule was amended and what was deliberately NOT amended.
  //
  // The short version of the boundary this route defends:
  //   • It can only return what the user DEPOSITED and has not spent. The cap
  //     is the usdt_ledger balance, which is topups minus rig purchases minus
  //     earlier refunds. Points and ROZI are different ledgers and cannot reach
  //     this route at all.
  //   • It is sent BY HAND by staff from the treasury, like every other payout.
  //     No signer, no hot wallet, no automation.
  //   • The debit happens HERE, at request time, under the advisory lock — not
  //     when staff get to it. Otherwise a user requests a refund of their whole
  //     balance and buys a rig with it while the request sits in the queue.
  const MIN_REFUND_MICRO = 1_000_000; // 1 USDT

  app.post("/usdt/refunds", guard(async (userId, req) => {
    const body = z.object({
      amount: z.number().positive(),      // whole USDT, as the user typed it
      address: z.string().trim().min(1).max(120),
    }).parse(req.body);

    const s = await loadMiningSettings();
    // NOT gated on usdtTopupEnabled, deliberately. Switching deposits OFF must
    // never strand money people already sent us — that is the exact situation
    // in which someone most wants their balance back.
    const chain = s.usdtTreasuryChain as ChainId;

    const addrCheck = validateAddress(chain, body.address);
    if (!addrCheck.ok) throw { statusCode: 400, message: addrCheck.error };
    const address = body.address.trim();

    // Same gate as a withdrawal, for the same reason: we are sending real money
    // to a real address and should know who is receiving it. A refund is also
    // the obvious laundering shape (deposit, then ask for it back somewhere
    // else), and the ID check is the only thing standing in front of that.
    //
    // Waived when an Admin has switched the ID check off entirely (kyc.ts): a
    // hidden /kyc screen must never leave someone's own deposit permanently
    // unreachable behind an instruction they cannot follow.
    if (config.kycRequiredForWithdrawal) {
      const u = await sql.get<{ kyc_status: string }>(
        "SELECT kyc_status FROM users WHERE id = ?", userId);
      if (!(await kycSatisfied(u?.kyc_status))) {
        throw {
          statusCode: 403,
          message: u?.kyc_status === "pending"
            ? "We are still checking your ID. You can ask for your money back as soon as that is done."
            : "Verify your ID first, then you can ask for your money back.",
        };
      }
    }

    const micro = usdtToMicro(body.amount);
    if (micro < MIN_REFUND_MICRO) {
      // Sending USDT on BEP20 costs us real gas. Below about a dollar the
      // transfer costs more than it returns, so a dust refund is a request we
      // should decline up front rather than queue and then argue about.
      throw { statusCode: 400, message: "The smallest amount we can send back is 1 USDT." };
    }

    // GAS IS THE USER'S OWN RESPONSIBILITY (founder, 2026-08-08, second
    // pass). A refund signs from the user's own derived address — that
    // address must hold enough BNB BEFORE anything else happens, or nothing
    // gets held. This is the exact check that would have caught the
    // production bug: three refund requests debited money the platform then
    // had no way to send, because the address funding gas (treasury) had
    // none — checking the RIGHT address, up front, closes it.
    if (relayAvailable(chain)) {
      const gas = await hasEnoughGas(userId, chain as "bep20");
      if (!gas.ok) {
        throw {
          statusCode: 400,
          message: "You need BNB in your wallet to pay the network fee. Please deposit BNB to your RoziPay wallet before withdrawing USDT.",
          gasRequired: true,
          walletAddress: gas.address,
        };
      }
    }

    // Snapshot the gas fee onto the request, same reason withdrawal_requests
    // snapshots fee_points: a later Admin change must not alter an in-flight
    // request. `micro` above is still what gets DEBITED — the user's full ask
    // leaves their deposit balance; the fee only reduces what actually gets
    // SENT (see the auto-settle and staff "mark paid" paths below).
    //
    // The gas-cost fee (founder, 2026-08-08; DROPPED same day, second pass)
    // does not apply when the relay is available — the user's own BNB (just
    // checked above) is what actually pays gas now, not a USDT surcharge.
    const gasRate = await getGasFeeRate();
    const feeMicro = relayAvailable(chain) ? 0 : gasFeeMicro(micro, gasRate);
    if (feeMicro >= micro) {
      throw { statusCode: 400, message: "The fee would take all of this amount. Ask for more than that." };
    }

    // Snapshot whether this exact destination was proved by a wallet signature,
    // for the same reason withdrawal_requests does: the staff member approving
    // an irreversible send must see what was true when the user asked.
    const proved = await sql.get<{ n: number }>(
      `SELECT 1 AS n FROM payout_addresses
       WHERE user_id = ? AND chain = ? AND verified_at IS NOT NULL AND LOWER(address) = LOWER(?)`,
      userId, chain, address,
    );

    const id = newId();
    const { balanceMicro } = await sql.tx(async (t) => {
      await lockUser(t, userId);

      const balance = await usdtBalanceMicroOf(userId, t);
      if (micro > balance) {
        throw { statusCode: 400, message: "You do not have that much deposited money left." };
      }

      await t.run(
        `INSERT INTO usdt_refund_requests (id, user_id, chain, address, amount, fee_micro, address_verified, status, created_at)
         VALUES (?,?,?,?,?,?,?, 'pending', ?)`,
        id, userId, chain, address, micro, feeMicro, proved ? 1 : 0, now(),
      );
      // Hold the funds by debiting now. A rejection writes the compensating
      // credit (see the staff route).
      await postUsdt({
        userId, micro, direction: "debit", sourceType: "refund",
        sourceRefId: id, note: "Money sent back",
      }, t);

      return { balanceMicro: balance - micro };
    });

    // Fully automatic refund settlement (founder, 2026-08-06: "the money he
    // deposited, he can withdraw it any time with no issues" — the only gate
    // should be staff approval, above a ceiling). Never blocks or fails the
    // request either way — see the guarantee on tryAutoSettleRefund. This
    // stays a silent no-op (falls back to the manual queue below, exactly the
    // pre-existing behaviour) until PAYOUT_MODE=onchain AND a proven treasury
    // signer are actually turned on — see autoRefund.ts and payout.ts.
    const auto = await tryAutoSettleRefund(id);
    if (auto.settled === true) {
      // autoRefund.ts sends its own "paid" push — a second "submitted" one
      // here would be redundant for money that already landed.
      return { ok: true, id, status: "paid", txHash: auto.txHash, balanceMicro, feeMicro, netMicro: micro - feeMicro };
    }
    if (auto.settled === "processing") {
      // Signed by the user's own address (payoutRelay.ts) — a few blocks
      // away from 'paid', not instant, but not the manual queue either.
      void sendPushToUser(userId, {
        title: "Refund submitted", body: "We're sending your USDT back now.", url: "/wallet/usdt",
      });
      return { ok: true, id, status: "sending", balanceMicro, feeMicro, netMicro: micro - feeMicro };
    }

    void sendPushToUser(userId, {
      title: "Refund submitted", body: "We got your request and will send it back soon.", url: "/wallet/usdt",
    });
    return { ok: true, id, status: "pending", balanceMicro, feeMicro, netMicro: micro - feeMicro };
  }));

  // ---- ROZI store (a ROZI sink, and the honest answer to "what is it worth?") -
  //
  // Spend ROZI on something real — mobile top-up, a data bundle — at a price WE
  // set. This is deliberately NOT a fixed ROZI->USD rate, and the difference is
  // the whole design:
  //
  //   • A buy-back rate is a standing offer to purchase an asset we mint for
  //     free. The liability grows with our own success and is unbounded
  //     (MINING_SPEC.md § 6).
  //   • A shop is a fixed number of items at a price we can raise tomorrow.
  //     Exposure is bounded by `stock`, and if ROZI inflates the price moves.
  //
  // Fulfilment is by a human, exactly like a withdrawal. The ROZI is debited when
  // the request is made — not when staff get to it — so it cannot be spent twice
  // while pending, and it is credited back in full if the request is rejected.
  app.get("/mining/store", guard(async (userId) => {
    const items = await sql.all<{
      id: string; title: string; description: string | null;
      cost_rozi: string; input_label: string | null; stock: number;
    }>(
      `SELECT id, title, description, cost_rozi, input_label, stock
       FROM rozi_store_items WHERE status = 'active' ORDER BY sort, cost_rozi`,
    );
    const mine = await sql.all<{
      id: string; item_id: string; cost_micro: string; status: string;
      target: string | null; staff_note: string | null; created_at: string; title: string;
    }>(
      `SELECT r.id, r.item_id, r.cost_micro, r.status, r.target, r.staff_note,
              r.created_at, i.title
       FROM rozi_redemptions r JOIN rozi_store_items i ON i.id = r.item_id
       WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 20`,
      userId,
    );
    return {
      roziMicro: await roziBalanceMicroOf(userId),
      items: items.map((i) => ({
        id: i.id, title: i.title, description: i.description,
        costMicro: toMicro(Number(i.cost_rozi)), inputLabel: i.input_label,
        // The exact stock count is ours, not the user's — "out of stock" is all
        // they need, and a live count is a queue nobody should be racing.
        inStock: i.stock > 0,
      })),
      redemptions: mine.map((r) => ({
        id: r.id, itemId: r.item_id, title: r.title, costMicro: Number(r.cost_micro),
        status: r.status, target: r.target, staffNote: r.staff_note, at: r.created_at,
      })),
    };
  }));

  app.post("/mining/store/:id/redeem", guard(async (userId, req) => {
    const itemId = (req.params as { id: string }).id;
    const body = z.object({
      // A phone number, usually. Bounded and stored verbatim; it is shown to
      // staff and never interpolated into a query or a shell.
      target: z.string().trim().min(1).max(120).optional(),
    }).parse(req.body ?? {});

    return sql.tx(async (t) => {
      // Guardrail #8. This reads a balance and then debits it, so it takes the
      // lock first — without it two concurrent redeems both see enough ROZI and
      // both go through, and the second one is a free item.
      await lockUser(t, userId);

      // Stock is decremented CONDITIONALLY, and the row count is the only
      // authority — same shape as the ad-nonce fix in MINING_PLAN M9.5. Reading
      // stock and then writing it would let two users take the last item.
      const item = await t.get<{
        id: string; title: string; cost_rozi: string; input_label: string | null;
      }>(
        "SELECT id, title, cost_rozi, input_label FROM rozi_store_items WHERE id = ? AND status = 'active'",
        itemId,
      );
      if (!item) throw { statusCode: 404, message: "That item is not available." };
      if (item.input_label && !body.target) {
        throw { statusCode: 400, message: `Please enter your ${item.input_label.toLowerCase()}.` };
      }

      const costMicro = toMicro(Number(item.cost_rozi));
      const balMicro = await roziBalanceMicroOf(userId, t);
      if (balMicro < costMicro) {
        throw { statusCode: 400, message: "You do not have enough ROZI for this yet." };
      }

      const taken = await t.run(
        "UPDATE rozi_store_items SET stock = stock - 1 WHERE id = ? AND stock > 0", itemId);
      if (!taken.rowCount) throw { statusCode: 400, message: "This one has just run out." };

      await postRozi({
        userId, micro: costMicro, direction: "debit", sourceType: "store_redemption",
        sourceRefId: itemId, note: item.title,
      }, t);
      const id = newId();
      await t.run(
        `INSERT INTO rozi_redemptions (id, user_id, item_id, cost_micro, target, status, created_at)
         VALUES (?,?,?,?,?, 'pending', ?)`,
        id, userId, itemId, costMicro, body.target ?? null, now(),
      );
      return { ok: true, id, spentMicro: costMicro, roziMicro: balMicro - costMicro };
    });
  }));

  // ---- Boosters (a POINTS sink) --------------------------------------------
  // One of the quietly valuable mechanics in the product: it converts cash-
  // currency liability into a token-currency promise, i.e. it reduces withdrawal
  // pressure on the USDT treasury.
  app.get("/mining/boosters", guard(async (userId) => ({
    points: await balanceOf(userId),
    boosters: await sql.all(
      "SELECT id, name, price_points, multiplier_pct, hours FROM boosters WHERE status = 'active' ORDER BY price_points"),
  })));

  app.post("/mining/boosters/:id/buy", guard(async (userId, req) => {
    const id = (req.params as { id: string }).id;
    await accrue(userId);

    return sql.tx(async (t) => {
      // This debits the REAL Points ledger — the same currency a withdrawal
      // spends. It has to serialize against withdrawals, or a concurrent
      // buy-and-withdraw drains more USDT-redeemable points than the user holds.
      await lockUser(t, userId);

      const b = await t.get<{ id: string; name: string; price_points: number; multiplier_pct: number; hours: number }>(
        "SELECT * FROM boosters WHERE id = ? AND status = 'active'", id);
      if (!b) throw { statusCode: 404, message: "That booster is not available." };

      const points = await balanceOf(userId, t);
      if (points < b.price_points) {
        throw { statusCode: 400, message: `Not enough points. You need ${b.price_points}.` };
      }

      // The ONLY Points debit in the mining system.
      await postLedger({
        userId, points: b.price_points, direction: "debit",
        sourceType: "booster_purchase", sourceRefId: b.id, note: b.name,
      }, t);
      await grantBoost(userId, "points", b.multiplier_pct, b.hours, b.id, t);
      return { ok: true, points: points - b.price_points };
    });
  }));

  app.post("/mining/ad/issue", guard(async (userId, req) => {
    const s = await loadMiningSettings();
    if (!adsLive(s)) throw { statusCode: 400, message: "Ads are not available right now." };

    const watched = await sql.get<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ad_impressions
       WHERE user_id = ? AND status = 'rewarded' AND rewarded_at > ?`,
      userId, new Date(Date.now() - 86_400_000).toISOString(),
    );
    if (Number(watched?.n ?? 0) >= s.adWatchDailyCap) {
      throw { statusCode: 429, message: `You have watched your ${s.adWatchDailyCap} ads for today. Come back tomorrow.` };
    }

    const nonce = randomBytes(24).toString("hex");
    await sql.run(
      `INSERT INTO ad_impressions (id, user_id, device_id, nonce, provider, status, issued_at)
       VALUES (?,?,?,?,?,'issued',?)`,
      newId(), userId, deviceOf(req) || null, nonce, s.adProvider || "none", now(),
    );
    return { nonce, minSeconds: MIN_WATCH_SECONDS };
  }));

  // Redeem an ad watched OUTSIDE the start-mining flow (the standalone "watch an
  // ad for a boost" button). The start-mining path calls redeemAdNonce directly.
  app.post("/mining/ad/complete", guard(async (userId, req) => {
    const body = z.object({ nonce: z.string().min(1) }).parse(req.body);
    const s = await loadMiningSettings();
    // Re-checked here: an Admin could switch ads off between issue and complete,
    // and an outstanding nonce must not still pay out afterwards.
    if (!adsLive(s)) throw { statusCode: 400, message: "Ads are not available right now." };

    await redeemAdNonce(userId, body.nonce, s);
    return { ok: true, boostPct: s.adBoostPct, hours: s.adBoostHours };
  }));

  // ---- ROZI transfers (wallet to wallet) -----------------------------------
  //
  // This is a TRANSFER, not a trade. There is no price, no order book, no
  // matching and no money leg — if we ran those we would BE an unlicensed
  // exchange, which under Pakistan's PVARA regime is the most prosecutable thing
  // in this product. See MINING_SPEC.md § 7. Do not add a `price` field here.
  app.post("/mining/transfer", guard(async (userId, req) => {
    // ROZI is divisible now, so a user can send 0.5. The wire carries whole ROZI
    // as a decimal (what the user typed); it becomes micro before it touches the
    // ledger, and .int() would reject the fractions the whole migration was for.
    const body = z.object({
      to: z.string().min(1),          // @handle, referral code, or email
      amount: z.number().positive(),  // in whole ROZI, may be fractional
    }).parse(req.body);
    const amountMicro = toMicro(body.amount);
    if (amountMicro <= 0) throw { statusCode: 400, message: "That amount is too small to send." };

    const s = await loadMiningSettings();
    if (!s.transfersEnabled) throw { statusCode: 400, message: "Sending ROZI is not switched on yet." };
    const dailyCapMicro = toMicro(s.transferDailyCap);
    if (amountMicro > dailyCapMicro) {
      throw { statusCode: 400, message: `You can send at most ${s.transferDailyCap} ROZI per day.` };
    }

    const me = await sql.get<{ created_at: string; kyc_status: string }>(
      "SELECT created_at, kyc_status FROM users WHERE id = ?", userId);
    const ageDays = (Date.now() - Date.parse(me!.created_at)) / 86_400_000;
    if (ageDays < s.transferMinAccountDays) {
      throw { statusCode: 403, message: `New accounts can send ROZI after ${s.transferMinAccountDays} days.` };
    }
    // Same gate withdrawals use, and for the same reason: this is the point where
    // value leaves one identity for another. Only SENDING is gated — see the note
    // on transferRequireKyc in mining/core.ts for why receiving is not.
    //
    // ⚠️ AND WAIVED WHEN AN ADMIN HAS SWITCHED THE ID CHECK OFF (kyc.ts). This is
    // the path that made the waive necessary: transfers are live today, so
    // hiding /kyc while still demanding an approval it can no longer produce
    // would have killed sending outright, silently, from an unrelated toggle.
    if (s.transferRequireKyc && !(await kycSatisfied(me!.kyc_status))) {
      throw {
        statusCode: 403,
        message: me!.kyc_status === "pending"
          ? "We are still checking your ID. You can send ROZI once it is approved."
          : "Verify your ID before you send ROZI.",
      };
    }

    // Three ways to name the person you are paying, in the order people actually
    // reach for them: the @handle they told you, an invite code, or an email.
    // The leading "@" is stripped because users type it — it is how a handle is
    // written everywhere else, and refusing it would be a lookup failure that
    // reads as "that person does not exist".
    const to = body.to.trim().replace(/^@/, "");

    // RESOLVED IN EXPLICIT PRIORITY ORDER, one namespace at a time. This used to
    // be a single `WHERE username = ? OR referral_code = ? OR email = ?`, and
    // that was a live theft vector:
    //
    // An invite code is up-to-6 uppercase letters plus two digits ("AHMED42"),
    // which lower-cases to "ahmed42" — a perfectly legal @handle. The username
    // index only checks other usernames, so an attacker could TAKE the lowercase
    // form of a victim's invite code as their handle. Both rows then matched the
    // OR, sql.get returned whichever one the planner felt like, and ROZI sent to
    // a code the victim had published on /refer could land in the attacker's
    // wallet. The victim could not even fix it: invite codes are generated, not
    // chosen.
    //
    // So: the INVITE CODE wins, because it is system-generated and cannot be
    // squatted. A user-chosen handle must never be able to shadow it. (The
    // collision is also refused at the point the handle is set — see
    // routes/profile.ts — but the order here is what makes any pre-existing
    // collision harmless rather than a coin flip.)
    const findBy = async (where: string, value: string) =>
      sql.get<{ id: string; status: string }>(
        `SELECT id, status FROM users WHERE ${where} LIMIT 1`, value);

    const target =
      await findBy("referral_code = ?", to)
      ?? await findBy("LOWER(username) = LOWER(?)", to)
      ?? await findBy("LOWER(email) = LOWER(?)", to);

    if (!target) throw { statusCode: 404, message: "We could not find that user." };
    if (target.id === userId) throw { statusCode: 400, message: "You cannot send ROZI to yourself." };
    if (target.status !== "active") throw { statusCode: 400, message: "That account cannot receive ROZI." };

    // rozi_transfers.amount is micro too (the boot migration rescaled it), so this
    // sum and the cap it is checked against are in the same unit.
    const sentToday = await sql.get<{ t: string }>(
      "SELECT COALESCE(SUM(amount), 0) AS t FROM rozi_transfers WHERE from_user_id = ? AND created_at > ?",
      userId, new Date(Date.now() - 86_400_000).toISOString(),
    );
    if (Number(sentToday?.t ?? 0) + amountMicro > dailyCapMicro) {
      throw { statusCode: 429, message: `That is over your ${s.transferDailyCap} ROZI daily sending limit.` };
    }

    const result = await sql.tx(async (t) => {
      await lockUser(t, userId);

      const balMicro = await roziBalanceMicroOf(userId, t);
      if (balMicro < amountMicro) {
        throw { statusCode: 400, message: "You do not have that much ROZI." };
      }

      const feeMicro = Math.floor((amountMicro * s.transferFeePct) / 100);
      const receivedMicro = amountMicro - feeMicro;
      const id = newId();

      await postRozi({ userId, micro: amountMicro, direction: "debit",
        sourceType: "transfer_out", sourceRefId: id, note: `Sent to ${body.to}` }, t);
      await postRozi({ userId: target.id, micro: receivedMicro, direction: "credit",
        sourceType: "transfer_in", sourceRefId: id, note: "Received ROZI" }, t);
      // The fee is BURNED, not collected — it is a sink, not revenue. There is no
      // credit row for it anywhere, which is exactly what makes it a burn.

      await t.run(
        `INSERT INTO rozi_transfers (id, from_user_id, to_user_id, amount, fee_burned, received, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        id, userId, target.id, amountMicro, feeMicro, receivedMicro, now(),
      );
      return {
        id, feeMicro, receivedMicro, roziMicro: balMicro - amountMicro,
      };
    });

    // A farm funnelling many accounts' ROZI into one wallet is the cash-out
    // signal, exactly like payout_address_reuse is for Points. Flag, don't block.
    const senders = await sql.get<{ n: string }>(
      "SELECT COUNT(DISTINCT from_user_id) AS n FROM rozi_transfers WHERE to_user_id = ?", target.id);
    if (Number(senders?.n ?? 0) >= 5) {
      await flagOnce("rozi_transfer_ring", `rozi:${target.id}`, target.id, "high",
        `${senders!.n} distinct accounts have sent ROZI to this account.`);
    }

    return { ok: true, ...result };
  }));

  // ---- Conversion: ROZI -> Points ------------------------------------------
  //
  // The only bridge between the two ledgers. Users BURN ROZI into a window that
  // holds a pot of Points fixed before it opened, and share that pot pro-rata.
  // The rate floats. There is no fixed rate anywhere, because a fixed rate is a
  // promise to buy back an asset we mint for free — an unfunded liability that
  // grows with our own success. See MINING_SPEC.md § 6.
  //
  // OFF at launch. Users mine for months before any of this is reachable.
  app.get("/mining/conversion", guard(async (userId) => {
    const s = await loadMiningSettings();
    const w = await sql.get<{
      id: string; pot_points: number; closes_at: string; total_burned: string;
    }>("SELECT id, pot_points, closes_at, total_burned FROM conversion_windows WHERE status = 'open' ORDER BY opens_at DESC LIMIT 1");

    // The allowance is reported even when no window is open, because it is the
    // answer to "how much of my ROZI will I ever be able to turn into money?" —
    // a question the mining screen should answer between windows, not only
    // during one.
    const cap = await conversionAllowanceOf(userId, s.conversionMaxPctOfMined);

    if (!s.conversionEnabled || !w) {
      return {
        open: false, enabled: Boolean(s.conversionEnabled),
        roziMicro: await roziBalanceMicroOf(userId),
        maxPctOfMined: s.conversionMaxPctOfMined,
        allowanceMicro: cap.allowanceMicro,
        minedMicro: cap.minedMicro,
        convertedMicro: cap.burnedMicro,
      };
    }

    // Burns are stored in micro. conversionPayout takes a RATIO of burns, so the
    // unit cancels — it returns POINTS (a whole integer) either way. That is why
    // it needs no micro variant: it never returns ROZI.
    const mine = await sql.get<{ t: string }>(
      "SELECT COALESCE(SUM(rozi), 0) AS t FROM conversion_burns WHERE window_id = ? AND user_id = ?",
      w.id, userId,
    );
    const myBurnMicro = Number(mine?.t ?? 0);
    const totalBurnMicro = Number(w.total_burned);

    return {
      open: true,
      enabled: true,
      windowId: w.id,
      potPoints: w.pot_points,
      closesAt: w.closes_at,
      totalBurnedMicro: totalBurnMicro,
      myBurnMicro,
      // What they'd get if the window closed right now. It WILL change as others
      // convert, and the UI says so in plain English.
      myPointsIfClosedNow: conversionPayout(myBurnMicro, totalBurnMicro, w.pot_points),
      roziMicro: await roziBalanceMicroOf(userId),
      // The per-user ceiling. The burn route re-checks all of this under a lock —
      // these fields exist so the screen can show the limit before someone types
      // an amount, never so the client can decide whether the limit applies.
      maxPctOfMined: s.conversionMaxPctOfMined,
      allowanceMicro: cap.allowanceMicro,
      minedMicro: cap.minedMicro,
      convertedMicro: cap.burnedMicro,
    };
  }));

  app.post("/mining/conversion/burn", guard(async (userId, req) => {
    // Whole ROZI on the wire, possibly fractional; micro in the ledger.
    const body = z.object({ rozi: z.number().positive() }).parse(req.body);
    const burnMicro = toMicro(body.rozi);
    if (burnMicro <= 0) throw { statusCode: 400, message: "That amount is too small to convert." };

    const s = await loadMiningSettings();
    if (!s.conversionEnabled) {
      throw { statusCode: 400, message: "Converting ROZI is not open yet." };
    }

    return sql.tx(async (t) => {
      // A burn buys a pro-rata slice of a pot of REAL Points. Two concurrent
      // burns that both read the same ROZI balance would let a user record more
      // burned ROZI than they ever held, and walk away with a bigger share of
      // actual money. Serialize.
      await lockUser(t, userId);

      const w = await t.get<{ id: string; closes_at: string }>(
        "SELECT id, closes_at FROM conversion_windows WHERE status = 'open' ORDER BY opens_at DESC LIMIT 1");
      if (!w) throw { statusCode: 400, message: "There is no conversion window open." };
      if (Date.parse(w.closes_at) <= Date.now()) {
        throw { statusCode: 400, message: "This conversion window has closed." };
      }

      const balMicro = await roziBalanceMicroOf(userId, t);
      if (balMicro < burnMicro) {
        throw { statusCode: 400, message: "You do not have that much ROZI." };
      }

      // The per-user lifetime ceiling, read INSIDE the lock alongside the balance
      // — for the same reason the balance is. Two concurrent burns that each read
      // the same "already converted" total would both pass this check and the
      // account would convert past its cap, which is money.
      const { allowanceMicro } = await conversionAllowanceOf(
        userId, s.conversionMaxPctOfMined, t,
      );
      if (burnMicro > allowanceMicro) {
        throw {
          statusCode: 400,
          message: allowanceMicro <= 0
            ? "You have converted all the ROZI you can for now. Mine more to unlock more."
            : `You can convert ${fromMicro(allowanceMicro)} more ROZI right now.`,
        };
      }

      await postRozi({
        userId, micro: burnMicro, direction: "debit", sourceType: "conversion_burn",
        sourceRefId: w.id, note: "Converted to points",
      }, t);
      await t.run(
        "INSERT INTO conversion_burns (id, window_id, user_id, rozi, created_at) VALUES (?,?,?,?,?)",
        newId(), w.id, userId, burnMicro, now(),
      );
      await t.run(
        "UPDATE conversion_windows SET total_burned = total_burned + ? WHERE id = ?",
        burnMicro, w.id,
      );
      return {
        ok: true, burnedMicro: burnMicro, roziMicro: balMicro - burnMicro,
      };
    });
  }));
}

// LIFETIME conversion allowance for one account, in micro-ROZI (§ 6).
//
// Two aggregate reads over the ROZI ledger — mining credits in, conversion burns
// out — fed to the pure ceiling function. Takes `t` so the burn path can read it
// INSIDE the locked transaction; without that, two concurrent burns both read
// the same "already burned" total, both pass the ceiling check, and the account
// converts past its cap. That is the same bug class as the double-spend the
// advisory lock exists for, so it is answered the same way.
async function conversionAllowanceOf(
  userId: string, maxPct: number, t: Pick<TxApi, "get"> = sql,
): Promise<{ allowanceMicro: number; minedMicro: number; burnedMicro: number }> {
  const mined = await t.get<{ s: string }>(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM rozi_ledger
     WHERE user_id = ? AND direction = 'credit' AND source_type = 'mining'`,
    userId,
  );
  const burned = await t.get<{ s: string }>(
    `SELECT COALESCE(SUM(ABS(amount)), 0) AS s FROM rozi_ledger
     WHERE user_id = ? AND direction = 'debit' AND source_type = 'conversion_burn'`,
    userId,
  );
  const minedMicro = Number(mined?.s ?? 0);
  const burnedMicro = Number(burned?.s ?? 0);
  return {
    allowanceMicro: conversionAllowanceMicro(minedMicro, burnedMicro, maxPct),
    minedMicro,
    burnedMicro,
  };
}

// Settle a closed conversion window: split its fixed pot of Points pro-rata
// among everyone who burned into it. Exported for the staff route and the tests.
//
// THE INVARIANT: the Points minted here can never exceed `pot_points`. It is
// asserted below, inside the transaction, and if it ever trips we roll back
// rather than mint cash-redeemable Points that no revenue backs.
// `rozi` on conversion_burns is MICRO. conversionPayout takes a ratio of burns,
// so the unit cancels out and it still returns whole POINTS — the pot is Points
// and cannot be exceeded regardless of what unit the burns are counted in.
export async function settleConversionWindow(windowId: string): Promise<{
  windowId: string; potPoints: number; totalBurnedMicro: number; pointsPaid: number; users: number;
}> {
  return sql.tx(async (t) => {
    const w = await t.get<{ id: string; pot_points: number; status: string; total_burned: string }>(
      "SELECT id, pot_points, status, total_burned FROM conversion_windows WHERE id = ?", windowId);
    if (!w) throw { statusCode: 404, message: "No such window." };
    if (w.status !== "open") throw { statusCode: 400, message: "That window is already settled." };

    // Settle PER BURN ROW, not per user.
    //
    // Grouping by user and then stamping that user's total onto every one of
    // their burn rows silently denormalises: a user who burned three times would
    // have the full total written to all three rows, and any future SUM() over
    // points_paid would triple-count real money. Paying each row on its own keeps
    // conversion_burns.points_paid exactly equal to the ledger credit it produced,
    // so the two can always be reconciled against each other.
    const burns = await t.all<{ id: string; user_id: string; rozi: string }>(
      "SELECT id, user_id, rozi FROM conversion_burns WHERE window_id = ? ORDER BY created_at",
      windowId,
    );
    const totalBurnMicro = burns.reduce((a, b) => a + Number(b.rozi), 0);

    let paid = 0;
    for (const b of burns) {
      const points = conversionPayout(Number(b.rozi), totalBurnMicro, w.pot_points);
      if (points <= 0) continue;
      await postLedger({
        userId: b.user_id, points, direction: "credit",
        sourceType: "mining_conversion", sourceRefId: windowId,
        note: "ROZI converted to points",
      }, t);
      await t.run("UPDATE conversion_burns SET points_paid = ? WHERE id = ?", points, b.id);
      paid += points;
    }

    // Belt and braces. conversionPayout() is proved to hold this by the unit
    // tests, but this is real money leaving the treasury, so we check it against
    // the database's own numbers too and abort the transaction if it is ever
    // wrong. A failed conversion is embarrassing; an unfunded one is fatal.
    if (paid > w.pot_points) {
      throw new Error(
        `CONVERSION OVERPAY: window ${windowId} paid ${paid} points from a pot of ${w.pot_points}. Rolled back.`,
      );
    }

    await t.run(
      "UPDATE conversion_windows SET status = 'settled', points_paid = ?, settled_at = ? WHERE id = ?",
      paid, now(), windowId,
    );
    return {
      windowId, potPoints: w.pot_points, totalBurnedMicro: totalBurnMicro,
      pointsPaid: paid,
      // Distinct PEOPLE, not burn rows — one user may have burned several times.
      users: new Set(burns.map((b) => b.user_id)).size,
    };
  });
}
