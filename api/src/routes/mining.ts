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
  sql, now, newId, postLedger, postRozi, balanceOf, roziBalanceMicroOf, type TxApi,
} from "../db.ts";
import { getUserId, requireActiveUser } from "../auth.ts";
import { flagOnce } from "../fraud.ts";
import { loadMiningSettings } from "../mining/settings.ts";
import {
  startSession, sessionState, accrue, hashrateOf, grantBoost,
} from "../mining/engine.ts";
import { rigUpgradeCost, rigPower, conversionPayout, toMicro } from "../mining/core.ts";

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
};
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
    const [roziMicro, streak, boosts, adsToday] = await Promise.all([
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
    ]);

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
      },
      // Told plainly, and repeated in the UI. Pretending otherwise is the
      // fastest way to burn the brand.
      convertible: Boolean(s.conversionEnabled),
      transfersEnabled: Boolean(s.transfersEnabled),
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
    return {
      roziMicro: await roziBalanceMicroOf(userId),
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
        };
      }),
    };
  }));

  app.post("/mining/rigs/:id/upgrade", guard(async (userId, req) => {
    const rigId = (req.params as { id: string }).id;

    // Accrue BEFORE the hashrate changes, so the seconds already mined are paid
    // at the old rate and the new rig applies only from now on.
    await accrue(userId);

    return sql.tx(async (t) => {
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
      const balMicro = await roziBalanceMicroOf(userId, t);
      if (balMicro < costMicro) {
        throw { statusCode: 400, message: "You do not have enough ROZI for this yet." };
      }

      await postRozi({
        userId, micro: costMicro, direction: "debit", sourceType: "rig_purchase",
        sourceRefId: rigId, note: `${rig.name} level ${level + 1}`,
      }, t);
      await t.run(
        `INSERT INTO user_rigs (user_id, rig_id, level, updated_at) VALUES (?,?,?,?)
         ON CONFLICT (user_id, rig_id) DO UPDATE SET level = EXCLUDED.level, updated_at = EXCLUDED.updated_at`,
        userId, rigId, level + 1, now(),
      );
      return {
        ok: true, level: level + 1,
        spentMicro: costMicro, roziMicro: balMicro - costMicro,
      };
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
      to: z.string().min(1),          // referral code or email
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

    const me = await sql.get<{ created_at: string }>(
      "SELECT created_at FROM users WHERE id = ?", userId);
    const ageDays = (Date.now() - Date.parse(me!.created_at)) / 86_400_000;
    if (ageDays < s.transferMinAccountDays) {
      throw { statusCode: 403, message: `New accounts can send ROZI after ${s.transferMinAccountDays} days.` };
    }

    const target = await sql.get<{ id: string; status: string }>(
      "SELECT id, status FROM users WHERE referral_code = ? OR LOWER(email) = LOWER(?)",
      body.to, body.to,
    );
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

    if (!s.conversionEnabled || !w) {
      return {
        open: false, enabled: Boolean(s.conversionEnabled),
        roziMicro: await roziBalanceMicroOf(userId),
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
