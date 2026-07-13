// Admin control surface for the ROZI economy (docs/MINING_SPEC.md § 10).
//
// Every number in the mining system is tunable here at runtime — emission,
// halving, hashrate, boosts, rigs, boosters, transfers, conversion — with NO
// redeploy, exactly like the `networks` commission split already works. Every
// write goes through the existing admin_audit_log: an Admin can now mint ROZI
// and commit real Points to a conversion pot, so this panel is a treasury key.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { sql, now, newId, postRozi, logAudit } from "../db.ts";
import { requireStaff, type Role } from "../roles.ts";
import { settleConversionWindow } from "./mining.ts";
import {
  loadMiningSettings, setMiningSetting, isMiningKey, totalEmitted, MINING_DEFAULTS,
} from "../mining/settings.ts";
import { settleEpoch, settleDueEpochs } from "../mining/engine.ts";
import { emissionAt, epochOf } from "../mining/core.ts";

function staffGuard(
  allowed: Role[],
  handler: (ctx: { userId: string; role: Role }, req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await handler(await requireStaff(req, allowed), req, reply);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Something went wrong" });
    }
  };
}

export async function staffMiningRoutes(app: FastifyInstance) {
  // ---- Settings ------------------------------------------------------------
  app.get("/staff/mining/settings", staffGuard(["admin"], async () => ({
    settings: await loadMiningSettings(),
    defaults: MINING_DEFAULTS,
  })));

  app.patch("/staff/mining/settings", staffGuard(["admin"], async ({ userId, role }, req, reply) => {
    const body = z.record(z.union([z.string(), z.number()])).parse(req.body);
    const applied: string[] = [];

    for (const [k, v] of Object.entries(body)) {
      if (!isMiningKey(k)) {
        return reply.code(400).send({ error: `Unknown mining setting: ${k}` });
      }
      // Numeric settings must stay numeric and non-negative. A negative emission
      // or a NaN cap would not throw — it would quietly poison every settlement
      // from then on, which is far worse than a 400 here.
      if (typeof MINING_DEFAULTS[k] === "number") {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) {
          return reply.code(400).send({ error: `${k} must be a number >= 0` });
        }
      }
      await setMiningSetting(k, v);
      applied.push(`${k}=${v}`);
    }

    await logAudit({
      actorUserId: userId, actorRole: role, action: "mining_settings_update",
      detail: applied.join(", "),
    });
    return { ok: true, settings: await loadMiningSettings() };
  }));

  // ---- Dashboard -----------------------------------------------------------
  app.get("/staff/mining/stats", staffGuard(["manager", "admin"], async () => {
    const s = await loadMiningSettings();
    const epoch = epochOf();

    const [emitted, circulatingRow, sinkBurns, feeBurns, activeMiners, hashRow, epochs, lastWindow] =
      await Promise.all([
        totalEmitted(),
        // Circulating float, straight from the ledger. This is the ONLY definition
        // that cannot drift: it is the sum of every ROZI row ever written, so it
        // stays right no matter what new source types get added later.
        sql.get<{ t: string }>("SELECT COALESCE(SUM(amount), 0) AS t FROM rozi_ledger"),
        sql.get<{ t: string }>(
          `SELECT COALESCE(SUM(ABS(amount)), 0) AS t FROM rozi_ledger
           WHERE direction = 'debit' AND source_type IN ('rig_purchase','conversion_burn')`),
        // Transfer fees are burned, and deliberately leave NO ledger row: the
        // sender is debited the gross and the recipient credited the net, so the
        // fee simply ceases to exist. That is what makes it a real burn — but it
        // also means summing the ledger by source_type misses it entirely, which
        // is exactly how this stat was under-reporting the burn before.
        sql.get<{ t: string }>("SELECT COALESCE(SUM(fee_burned), 0) AS t FROM rozi_transfers"),
        sql.get<{ n: string }>(
          "SELECT COUNT(DISTINCT user_id) AS n FROM mining_sessions WHERE status = 'active'"),
        sql.get<{ t: string; n: string }>(
          "SELECT COALESCE(SUM(shares), 0) AS t, COUNT(*) AS n FROM mining_shares WHERE epoch = ?", epoch),
        sql.all<Record<string, unknown>>(
          "SELECT * FROM mining_epochs ORDER BY epoch DESC LIMIT 14"),
        sql.get<{ pot_points: number; total_burned: string }>(
          "SELECT pot_points, total_burned FROM conversion_windows WHERE status = 'settled' ORDER BY settled_at DESC LIMIT 1"),
      ]);

    const emittedN = Number(emitted);
    const burnedN = Number(sinkBurns?.t ?? 0) + Number(feeBurns?.t ?? 0);
    const circulating = Number(circulatingRow?.t ?? 0);

    // POOL COVERAGE: what the entire circulating ROZI float would cost, in
    // Points, at the last window's clearing rate. This is the number that tells
    // you whether the economy is healthy — if it is drifting toward the size of
    // your actual margin, the next conversion window will be brutal and you
    // should be shrinking emission, not growing it.
    let poolCoverage: number | null = null;
    if (lastWindow && Number(lastWindow.total_burned) > 0) {
      const lastRate = lastWindow.pot_points / Number(lastWindow.total_burned);
      poolCoverage = Math.round(circulating * lastRate);
    }

    return {
      epoch,
      todayEmission: emissionAt(epoch, s),
      supply: {
        cap: s.supplyCap,
        emitted: emittedN,
        burned: burnedN,
        circulating,
        remaining: Math.max(0, s.supplyCap - emittedN),
      },
      today: {
        miners: Number(hashRow?.n ?? 0),
        totalShares: Number(hashRow?.t ?? 0),
        activeSessions: Number(activeMiners?.n ?? 0),
      },
      poolCoveragePoints: poolCoverage,
      epochs: epochs.map((e) => ({
        ...e,
        emission: Number(e.emission),
        total_shares: Number(e.total_shares),
        emitted: Number(e.emitted),
        withheld: Number(e.withheld),
      })),
    };
  }));

  // Force settlement now rather than waiting for the timer (support + testing).
  // Idempotent, so the worst an impatient click can do is nothing.
  app.post("/staff/mining/settle", staffGuard(["admin"], async ({ userId, role }, req) => {
    const body = z.object({ epoch: z.number().int().optional() }).parse(req.body ?? {});
    const results = body.epoch != null
      ? [await settleEpoch(body.epoch)]
      : await settleDueEpochs();
    await logAudit({
      actorUserId: userId, actorRole: role, action: "mining_settle_manual",
      detail: JSON.stringify(results),
    });
    return { ok: true, results };
  }));

  // ---- Rigs (CRUD) ---------------------------------------------------------
  app.get("/staff/mining/rigs", staffGuard(["admin"], async () => ({
    rigs: (await sql.all<Record<string, unknown>>("SELECT * FROM rigs ORDER BY sort, base_cost"))
      .map((r) => ({ ...r, base_cost: Number(r.base_cost) })),
  })));

  const rigSchema = z.object({
    name: z.string().min(1).max(60),
    icon: z.string().max(30).default("chip"),
    baseCost: z.number().int().positive(),
    costGrowth: z.number().int().min(100).max(500),
    basePower: z.number().int().positive(),
    powerGrowth: z.number().int().min(100).max(500),
    maxLevel: z.number().int().min(1).max(50),
    sort: z.number().int().default(0),
    status: z.enum(["active", "disabled"]).default("active"),
  });

  const assertDeflationary = (costGrowth: number, powerGrowth: number) => {
    // The upgrade tree MUST be a treadmill: cost growth has to outrun power
    // growth, or a whale buys unbounded hashrate and the economy is over. This
    // is not a style preference, it is the thing holding the rig sink up, so it
    // is refused at the API rather than left as advice in a doc.
    if (costGrowth <= powerGrowth) {
      throw {
        statusCode: 400,
        message: `Cost growth (${costGrowth}) must be GREATER than power growth (${powerGrowth}), ` +
          `or each rig level gets cheaper per H/s and hashrate runs away. Refused.`,
      };
    }
  };

  app.post("/staff/mining/rigs", staffGuard(["admin"], async ({ userId, role }, req) => {
    const b = rigSchema.parse(req.body);
    assertDeflationary(b.costGrowth, b.powerGrowth);
    const id = newId();
    await sql.run(
      `INSERT INTO rigs (id, name, icon, base_cost, cost_growth, base_power, power_growth, max_level, sort, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, b.name, b.icon, b.baseCost, b.costGrowth, b.basePower, b.powerGrowth,
      b.maxLevel, b.sort, b.status, now(),
    );
    await logAudit({ actorUserId: userId, actorRole: role, action: "mining_rig_create", detail: `${b.name} (${id})` });
    return { ok: true, id };
  }));

  app.patch("/staff/mining/rigs/:id", staffGuard(["admin"], async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    const b = rigSchema.partial().parse(req.body);

    const cur = await sql.get<{ cost_growth: number; power_growth: number }>(
      "SELECT cost_growth, power_growth FROM rigs WHERE id = ?", id);
    if (!cur) throw { statusCode: 404, message: "No such rig." };
    assertDeflationary(
      b.costGrowth ?? cur.cost_growth,
      b.powerGrowth ?? cur.power_growth,
    );

    const cols: Record<string, unknown> = {
      name: b.name, icon: b.icon, base_cost: b.baseCost, cost_growth: b.costGrowth,
      base_power: b.basePower, power_growth: b.powerGrowth, max_level: b.maxLevel,
      sort: b.sort, status: b.status,
    };
    const sets = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (!sets.length) return { ok: true };

    await sql.run(
      `UPDATE rigs SET ${sets.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`,
      ...sets.map(([, v]) => v), id,
    );
    await logAudit({
      actorUserId: userId, actorRole: role, action: "mining_rig_update",
      detail: `${id}: ${sets.map(([k, v]) => `${k}=${v}`).join(", ")}`,
    });
    return { ok: true };
  }));

  // ---- Boosters (CRUD) — priced in POINTS ----------------------------------
  app.get("/staff/mining/boosters", staffGuard(["admin"], async () => ({
    boosters: await sql.all("SELECT * FROM boosters ORDER BY price_points"),
  })));

  const boosterSchema = z.object({
    name: z.string().min(1).max(60),
    pricePoints: z.number().int().positive(),
    multiplierPct: z.number().int().min(1).max(1000),
    hours: z.number().int().min(1).max(720),
    status: z.enum(["active", "disabled"]).default("disabled"),
  });

  app.post("/staff/mining/boosters", staffGuard(["admin"], async ({ userId, role }, req) => {
    const b = boosterSchema.parse(req.body);
    const id = newId();
    await sql.run(
      "INSERT INTO boosters (id, name, price_points, multiplier_pct, hours, status, created_at) VALUES (?,?,?,?,?,?,?)",
      id, b.name, b.pricePoints, b.multiplierPct, b.hours, b.status, now(),
    );
    await logAudit({ actorUserId: userId, actorRole: role, action: "mining_booster_create", detail: `${b.name} @ ${b.pricePoints}pts` });
    return { ok: true, id };
  }));

  app.patch("/staff/mining/boosters/:id", staffGuard(["admin"], async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    const b = boosterSchema.partial().parse(req.body);
    const cols: Record<string, unknown> = {
      name: b.name, price_points: b.pricePoints, multiplier_pct: b.multiplierPct,
      hours: b.hours, status: b.status,
    };
    const sets = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (!sets.length) return { ok: true };
    await sql.run(
      `UPDATE boosters SET ${sets.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`,
      ...sets.map(([, v]) => v), id,
    );
    await logAudit({ actorUserId: userId, actorRole: role, action: "mining_booster_update", detail: id });
    return { ok: true };
  }));

  // ---- Conversion windows --------------------------------------------------
  app.get("/staff/mining/conversion", staffGuard(["admin"], async () => {
    const s = await loadMiningSettings();
    const windows = await sql.all<Record<string, unknown>>(
      "SELECT * FROM conversion_windows ORDER BY opens_at DESC LIMIT 20");

    // SUGGESTED POT, computed from the margin we actually earned. The founder
    // cannot see this number and accidentally commit money the business did not
    // make — which is the single easiest way to go insolvent here.
    //
    // Margin = what networks paid us, minus what we paid users. We do not store
    // gross network revenue directly, so we derive it from the commission split:
    // if users get 60% of net payout, our margin is (userPoints / 0.60) * 0.40.
    const paid = await sql.get<{ t: number }>(
      `SELECT COALESCE(SUM(amount), 0)::int AS t FROM ledger_entries
       WHERE source_type = 'task_completion' AND direction = 'credit' AND created_at > ?`,
      new Date(Date.now() - 7 * 86_400_000).toISOString(),
    );
    const split = await sql.get<{ pct: number }>(
      "SELECT commission_split_pct AS pct FROM networks WHERE status = 'active' ORDER BY id LIMIT 1");
    const userPct = (split?.pct ?? 60) / 100;
    const marginPoints = userPct > 0
      ? Math.floor((Number(paid?.t ?? 0) / userPct) * (1 - userPct))
      : 0;

    return {
      enabled: Boolean(s.conversionEnabled),
      conversionSharePct: s.conversionSharePct,
      marginPointsLast7Days: marginPoints,
      suggestedPotPoints: Math.floor((marginPoints * s.conversionSharePct) / 100),
      windows: windows.map((w) => ({ ...w, total_burned: Number(w.total_burned) })),
    };
  }));

  app.post("/staff/mining/conversion/open", staffGuard(["admin"], async ({ userId, role }, req) => {
    const b = z.object({
      potPoints: z.number().int().positive(),
      hours: z.number().int().min(1).max(720).default(168), // a week
    }).parse(req.body);

    const open = await sql.get<{ id: string }>(
      "SELECT id FROM conversion_windows WHERE status = 'open' LIMIT 1");
    if (open) throw { statusCode: 400, message: "A conversion window is already open. Settle it first." };

    const id = newId();
    await sql.run(
      `INSERT INTO conversion_windows (id, pot_points, opens_at, closes_at, status, created_by)
       VALUES (?,?,?,?, 'open', ?)`,
      id, b.potPoints, now(),
      new Date(Date.now() + b.hours * 3600_000).toISOString(), userId,
    );
    await logAudit({
      actorUserId: userId, actorRole: role, action: "mining_conversion_open",
      detail: `pot=${b.potPoints} points, ${b.hours}h, window ${id}`,
    });
    return { ok: true, id };
  }));

  app.post("/staff/mining/conversion/:id/settle", staffGuard(["admin"], async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    const result = await settleConversionWindow(id);
    await logAudit({
      actorUserId: userId, actorRole: role, action: "mining_conversion_settle",
      detail: `window ${id}: ${result.pointsPaid} points to ${result.users} users for ${result.totalBurned} ROZI burned`,
    });
    return { ok: true, ...result };
  }));

  // ---- Manual ROZI adjustment ----------------------------------------------
  // Capped and audit-logged, exactly like the Points adjustment is. ROZI is not
  // directly redeemable, but it IS a claim on future conversion pots — so an
  // unbounded mint here still dilutes every honest miner.
  app.post("/staff/mining/users/:id/adjust", staffGuard(["admin"], async ({ userId: actorId, role }, req) => {
    const targetId = (req.params as { id: string }).id;
    const b = z.object({
      rozi: z.number().int(),
      note: z.string().min(3).max(200),
    }).parse(req.body);

    const s = await loadMiningSettings();
    const magnitude = Math.abs(b.rozi);
    if (magnitude === 0) throw { statusCode: 400, message: "Amount cannot be zero." };
    if (magnitude > s.adminAdjustMaxRozi) {
      throw {
        statusCode: 400,
        message: `A single adjustment is limited to ${s.adminAdjustMaxRozi} ROZI. Raise the limit deliberately if you really mean it.`,
      };
    }

    const target = await sql.get<{ id: string }>("SELECT id FROM users WHERE id = ?", targetId);
    if (!target) throw { statusCode: 404, message: "No such user." };

    await postRozi({
      userId: targetId, rozi: magnitude,
      direction: b.rozi > 0 ? "credit" : "debit",
      sourceType: "admin_adjustment", note: b.note,
    });
    await logAudit({
      actorUserId: actorId, actorRole: role, action: "mining_rozi_adjust",
      targetUserId: targetId, detail: `${b.rozi > 0 ? "+" : ""}${b.rozi} ROZI — ${b.note}`,
    });
    return { ok: true };
  }));
}
