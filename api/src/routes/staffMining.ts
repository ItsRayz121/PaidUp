// Admin control surface for the ROZI economy (docs/MINING_SPEC.md § 10).
//
// Every number in the mining system is tunable here at runtime — emission,
// halving, hashrate, boosts, rigs, boosters, transfers, conversion — with NO
// redeploy, exactly like the `networks` commission split already works. Every
// write goes through the existing admin_audit_log: an Admin can now mint ROZI
// and commit real Points to a conversion pot, so this panel is a treasury key.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  sql, now, newId, postRozi, postUsdt, usdtBalanceMicroOf,
  usdtFromMicro, usdtToMicro, logAudit,
} from "../db.ts";
import { chainById, validateAddress } from "../chains.ts";
import { rpcHealth, endpointsFor } from "../rpc.ts";
import { requireStaff, type Role } from "../roles.ts";
import { settleConversionWindow } from "./mining.ts";
import {
  loadMiningSettings, setMiningSetting, isMiningKey, totalEmittedMicro, MINING_DEFAULTS,
} from "../mining/settings.ts";
import {
  settleEpoch, settleDueEpochs, minerPopulation, effectivePiRate,
} from "../mining/engine.ts";
import {
  emissionMicroAt, epochOf, parseMilestones, toMicro, fromMicro,
} from "../mining/core.ts";

// UNITS, and they differ from the earner API on purpose. The ledger is micro
// everywhere, but this panel deals in aggregates (a 650M cap, a 14-day emission
// history) where six decimal places are noise, and an Admin types "50 ROZI", not
// "50000000". So the staff surface converts to WHOLE ROZI at its edge with
// fromMicro() / toMicro(). The earner API (routes/mining.ts) does the opposite and
// speaks micro, because there the decimals ARE the number.

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
      // The model is chosen by string equality at settlement, so a typo here
      // ("Pi", "pool ", "pie") would not error — it would silently settle every
      // future day under the OTHER model. That is a change to how everyone is
      // paid, arriving as a spelling mistake. Refuse anything but the two.
      if (k === "emissionModel" && v !== "pi" && v !== "pool") {
        return reply.code(400).send({
          error: `emissionModel must be exactly "pi" or "pool" (got "${v}").`,
        });
      }
      // An empty milestone list means the rate NEVER halves, which turns the only
      // throttle on the pi model off and lets growth drain the pool. Refused: if
      // that is really wanted, it should be a deliberate single huge milestone.
      if (k === "piHalvingUsers" && parseMilestones(String(v)).length === 0) {
        return reply.code(400).send({
          error: "piHalvingUsers needs at least one positive number (e.g. \"10000,50000\"). " +
            "With no milestones the base rate never halves and growth drains the pool.",
        });
      }
      // The treasury address is where users are told to send real money. A typo
      // here is not a bad setting, it is a stream of deposits into an address
      // nobody controls — unrecoverable, and discovered only when the first user
      // asks where their USDT went. So it gets the same validator the withdrawal
      // side uses on user-supplied addresses. Empty is allowed: that is how the
      // feature is switched off.
      //
      // DEPOSITS ARE BEP20-ONLY (founder, 2026-07-29), and it is enforced here
      // rather than left as a default, because the two halves of this feature
      // cannot disagree. The deposit screen's copy hard-codes "BNB Smart Chain
      // (BEP20)" as the network to send on — deliberately, so that the word BNB
      // appears only in the list of coins NOT to send. An Admin quietly moving
      // the treasury to Base or Aptos would leave that copy telling every user
      // to deposit on a network the address is not on, and those deposits are
      // gone. One chain, named in one place, matching the address.
      //
      // Withdrawals are unaffected and still offer all three chains: paying
      // money OUT to an address the user chose carries none of this risk.
      if (k === "usdtTreasuryChain" && String(v) !== "bep20") {
        return reply.code(400).send({
          error: "Deposits are BEP20 only. The top-up screen tells every user to send " +
            "on BNB Smart Chain (BEP20), so the treasury address must be on that chain. " +
            "Change the deposit copy first if this must ever move.",
        });
      }
      if (k === "usdtTreasuryAddress" && String(v).trim() !== "") {
        // Validate against the chain being set IN THIS SAME REQUEST if there is
        // one, falling back to the stored value. Reading only the stored chain
        // would validate a new address against the OLD chain whenever the panel
        // sends both keys and the address happens to come first in the object —
        // and "address saved, wrong chain" is a stream of deposits nobody can
        // recover.
        const stored = await loadMiningSettings();
        const chainId = String(body.usdtTreasuryChain ?? stored.usdtTreasuryChain);
        const chain = chainById(chainId);
        if (!chain) {
          return reply.code(400).send({ error: "Set usdtTreasuryChain to a known chain first." });
        }
        const check = validateAddress(chain.id, String(v));
        if (!check.ok) return reply.code(400).send({ error: check.error });
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
        totalEmittedMicro(),
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

    // All four are MICRO here — they come straight off the ledger.
    const emittedMicro = Number(emitted);
    const burnedMicro = Number(sinkBurns?.t ?? 0) + Number(feeBurns?.t ?? 0);
    const circulatingMicro = Number(circulatingRow?.t ?? 0);

    // POOL COVERAGE: what the entire circulating ROZI float would cost, in
    // Points, at the last window's clearing rate. This is the number that tells
    // you whether the economy is healthy — if it is drifting toward the size of
    // your actual margin, the next conversion window will be brutal and you
    // should be shrinking emission, not growing it.
    //
    // Computed in MICRO on both sides: total_burned is micro, so the rate is
    // points-per-micro, and multiplying it by a micro float gives points. The unit
    // cancels — converting to whole ROZI first would inflate this by 1e6.
    let poolCoverage: number | null = null;
    if (lastWindow && Number(lastWindow.total_burned) > 0) {
      const pointsPerMicro = lastWindow.pot_points / Number(lastWindow.total_burned);
      poolCoverage = Math.round(circulatingMicro * pointsPerMicro);
    }

    // Under the pi model there is no fixed daily emission to report — the daily
    // total floats with however many people mine. What the Admin needs instead is
    // the number that actually drives every payout: the effective rate right now,
    // after however many milestone halvings the user base has triggered.
    const population = await minerPopulation();
    const milestones = parseMilestones(s.piHalvingUsers);
    const piRate = effectivePiRate(s, population);
    const nextMilestone = milestones.find((m) => m > population) ?? null;

    return {
      epoch,
      emissionModel: s.emissionModel,
      pi: {
        population,
        baseRate: s.piBaseRate,
        effectiveRate: piRate,
        halvingsSoFar: milestones.filter((m) => population >= m).length,
        nextMilestone,
        // This used to warn at `piRate < 10`, because the ledger held WHOLE ROZI
        // and a single-digit rate meant a partial day floored to zero — the app
        // silently paying nothing for real work. The ledger now holds millionths
        // (ROZI_SCALE), so that failure mode is gone, and a rate of 10 is the
        // deliberate launch setting rather than an alarm.
        //
        // The alarm is kept, re-aimed at what is still genuinely broken: a rate so
        // small that even a FULL day of baseline mining rounds away to nothing.
        // Below a thousandth of a ROZI a day, the tap has effectively been turned
        // off and somebody should know.
        rateTooLow: piRate > 0 && piRate < 0.001,
      },
      todayEmission: fromMicro(emissionMicroAt(epoch, s)),
      supply: {
        cap: s.supplyCap,
        emitted: fromMicro(emittedMicro),
        burned: fromMicro(burnedMicro),
        circulating: fromMicro(circulatingMicro),
        remaining: Math.max(0, s.supplyCap - fromMicro(emittedMicro)),
      },
      today: {
        miners: Number(hashRow?.n ?? 0),
        totalShares: Number(hashRow?.t ?? 0),
        activeSessions: Number(activeMiners?.n ?? 0),
      },
      poolCoveragePoints: poolCoverage,
      epochs: epochs.map((e: Record<string, unknown>) => ({
        ...e,
        emission: fromMicro(Number(e.emission)),
        total_shares: Number(e.total_shares),
        emitted: fromMicro(Number(e.emitted)),
        withheld: fromMicro(Number(e.withheld)),
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
      .map((r) => ({
        ...r,
        base_cost: Number(r.base_cost),
        // Whole USDT for the panel (an Admin types "10", not "10000000"), null
        // when this rig cannot be bought with money at all.
        base_cost_usdt: r.base_cost_usdt == null ? null : usdtFromMicro(Number(r.base_cost_usdt)),
      })),
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
    // Whole USDT. 0 or null means "ROZI only", which is the shipped default for
    // every rig. See the base_cost_usdt comment in db.ts before setting one:
    // publishing a USDT price for a machine that also has a ROZI price publishes
    // an implied ROZI exchange rate, for a token we say has no price.
    baseCostUsdt: z.number().min(0).max(100_000).nullable().optional(),
  });

  // Whole USDT in, micro-USDT (or null) out, in one place so create and update
  // cannot disagree about what 0 means.
  const usdtPriceCol = (v: number | null | undefined) =>
    v === undefined ? undefined : (v === null || v <= 0 ? null : usdtToMicro(v));

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
      `INSERT INTO rigs (id, name, icon, base_cost, cost_growth, base_power, power_growth, max_level, sort, status, base_cost_usdt, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, b.name, b.icon, b.baseCost, b.costGrowth, b.basePower, b.powerGrowth,
      b.maxLevel, b.sort, b.status, usdtPriceCol(b.baseCostUsdt) ?? null, now(),
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
      sort: b.sort, status: b.status, base_cost_usdt: usdtPriceCol(b.baseCostUsdt),
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

  // ---- USDT top-up claims (review queue) -----------------------------------
  //
  // A user says "I sent you USDT, here is the transaction". A HUMAN opens the
  // block explorer, checks that the transaction exists, that it landed at OUR
  // treasury address, and that the amount matches — then confirms. Only that
  // click posts credit.
  //
  // This is the manual posture on purpose: no hot wallet, no chain listener, no
  // private key in this system. Same shape as the payout side, which has been
  // manual since launch. The reviewer types the amount THEY saw on-chain, not
  // the one the user claimed — see below, it is the whole point of the screen.
  app.get("/staff/mining/topups", staffGuard(["manager", "admin"], async (_ctx, req) => {
    const q = z.object({ status: z.enum(["pending", "confirmed", "rejected"]).default("pending") })
      .parse((req.query as Record<string, unknown>) ?? {});
    const rows = await sql.all<Record<string, unknown>>(
      `SELECT t.*, u.email, u.username FROM usdt_topups t
       JOIN users u ON u.id = t.user_id
       WHERE t.status = ? ORDER BY t.created_at LIMIT 200`,
      q.status,
    );
    const s = await loadMiningSettings();
    return {
      treasuryAddress: s.usdtTreasuryAddress,
      treasuryChain: s.usdtTreasuryChain,
      topups: rows.map((r) => ({ ...r, amount: usdtFromMicro(Number(r.amount)) })),
    };
  }));

  app.post("/staff/mining/topups/:id/confirm", staffGuard(["admin"], async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    // THE AMOUNT IS THE REVIEWER'S, NOT THE USER'S. The claim carries what the
    // user typed; this carries what the reviewer actually read off the chain.
    // Crediting the claimed number would make the entire review theatre — a user
    // could send $1 and claim $500, and the reviewer would be clicking "yes, a
    // transaction exists" while the amount went unchecked.
    const b = z.object({ amount: z.number().positive() }).parse(req.body);

    return sql.tx(async (t) => {
      // Claim the row FIRST, and only if it is still pending. Two admins on the
      // queue at the same moment would otherwise both see 'pending', both post
      // credit, and pay one deposit twice.
      const claimed = await t.get<{ user_id: string; tx_hash: string }>(
        `UPDATE usdt_topups SET status = 'confirmed', reviewed_by = ?, reviewed_at = ?
         WHERE id = ? AND status = 'pending' RETURNING user_id, tx_hash`,
        userId, now(), id,
      );
      if (!claimed) throw { statusCode: 409, message: "That top-up was already handled." };

      await postUsdt({
        userId: claimed.user_id, micro: usdtToMicro(b.amount), direction: "credit",
        sourceType: "topup", sourceRefId: id, note: `Deposit ${claimed.tx_hash.slice(0, 16)}`,
      }, t);
      await logAudit({
        actorUserId: userId, actorRole: role, action: "usdt_topup_confirm",
        detail: `${id} -> ${claimed.user_id}: ${b.amount} USDT`,
      }, t);
      return { ok: true, balanceMicro: await usdtBalanceMicroOf(claimed.user_id, t) };
    });
  }));

  app.post("/staff/mining/topups/:id/reject", staffGuard(["admin"], async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    const b = z.object({ reason: z.string().min(3).max(300) }).parse(req.body);
    const claimed = await sql.get<{ user_id: string }>(
      `UPDATE usdt_topups SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = ?
       WHERE id = ? AND status = 'pending' RETURNING user_id`,
      b.reason, userId, now(), id,
    );
    if (!claimed) throw { statusCode: 409, message: "That top-up was already handled." };
    // No ledger row at all: nothing was ever credited, so there is nothing to
    // reverse. A rejection is a claim we declined, not a refund we owe.
    await logAudit({
      actorUserId: userId, actorRole: role, action: "usdt_topup_reject",
      detail: `${id}: ${b.reason}`,
    });
    return { ok: true };
  }));

  // ---- USDT refund queue (founder, 2026-08-01) ------------------------------
  //
  // A user asked for their own unspent deposit back. The money was ALREADY
  // debited from their credit when they asked (routes/mining.ts) — that is what
  // stops them spending it on a rig while this queues — so:
  //
  //   • marking it paid records the tx hash and posts NO ledger row, because
  //     the debit already happened;
  //   • rejecting it posts the compensating CREDIT to give the balance back.
  //
  // Getting that backwards in either direction is a double-debit or a free
  // top-up, so the two handlers below say which one they are doing out loud.
  app.get("/staff/mining/refunds", staffGuard(["manager", "admin"], async (_ctx, req) => {
    const q = z.object({ status: z.enum(["pending", "paid", "rejected"]).default("pending") })
      .parse((req.query as Record<string, unknown>) ?? {});
    const rows = await sql.all<Record<string, unknown>>(
      `SELECT r.*, u.email, u.username FROM usdt_refund_requests r
       JOIN users u ON u.id = r.user_id
       WHERE r.status = ? ORDER BY r.created_at LIMIT 200`,
      q.status,
    );
    return {
      refunds: rows.map((r) => ({
        ...r,
        amount: usdtFromMicro(Number(r.amount)),
        feeAmount: usdtFromMicro(Number(r.fee_micro ?? 0)),
        // What staff should ACTUALLY send by hand — the gas fee (founder,
        // 2026-08-08) is snapshotted on the row and comes out of what's sent,
        // never out of what was debited from the user.
        netAmount: usdtFromMicro(Number(r.amount) - Number(r.fee_micro ?? 0)),
        chainLabel: chainById(String(r.chain))?.label ?? r.chain,
        // Same signal the withdrawal queue shows: did the user prove this exact
        // address with a wallet signature, or did they type it in?
        addressVerified: Boolean(r.address_verified),
      })),
    };
  }));

  app.post("/staff/mining/refunds/:id/paid", staffGuard(["admin"], async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    const b = z.object({ txHash: z.string().trim().min(6).max(200) }).parse(req.body);

    // Claim the row first and only if still pending — two admins on the queue
    // would otherwise both mark one refund paid and it would be sent twice.
    const claimed = await sql.get<{ user_id: string; amount: string; fee_micro: string }>(
      `UPDATE usdt_refund_requests SET status = 'paid', tx_hash = ?, reviewed_by = ?, reviewed_at = ?
       WHERE id = ? AND status = 'pending' RETURNING user_id, amount, fee_micro`,
      b.txHash.trim(), userId, now(), id,
    );
    if (!claimed) throw { statusCode: 409, message: "That refund was already handled." };

    // NO LEDGER ROW HERE. The debit was written when the user asked; writing
    // another one now would take the money twice.
    const net = Number(claimed.amount) - Number(claimed.fee_micro ?? 0);
    await logAudit({
      actorUserId: userId, actorRole: role, action: "usdt_refund_paid",
      detail: `${id} -> ${claimed.user_id}: ${usdtFromMicro(net)} USDT sent (of ${usdtFromMicro(Number(claimed.amount))} requested), tx ${b.txHash.trim()}`,
    });
    return { ok: true };
  }));

  app.post("/staff/mining/refunds/:id/reject", staffGuard(["admin"], async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    const b = z.object({ reason: z.string().min(3).max(300) }).parse(req.body);

    return sql.tx(async (t) => {
      const claimed = await t.get<{ user_id: string; amount: string }>(
        `UPDATE usdt_refund_requests SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = ?
         WHERE id = ? AND status = 'pending' RETURNING user_id, amount`,
        b.reason, userId, now(), id,
      );
      if (!claimed) throw { statusCode: 409, message: "That refund was already handled." };

      // GIVE THE MONEY BACK. Unlike a rejected top-up (where nothing was ever
      // credited, so there is nothing to reverse), a rejected refund is undoing
      // a debit we already took.
      await postUsdt({
        userId: claimed.user_id, micro: Number(claimed.amount), direction: "credit",
        sourceType: "refund", sourceRefId: id, note: "Refund declined — money returned to your balance",
      }, t);
      await logAudit({
        actorUserId: userId, actorRole: role, action: "usdt_refund_reject",
        detail: `${id}: ${b.reason}`,
      }, t);
      return { ok: true, balanceMicro: await usdtBalanceMicroOf(claimed.user_id, t) };
    });
  }));

  // ---- RPC endpoint health -------------------------------------------------
  //
  // The chain endpoints default to PUBLIC nodes, which rate-limit and disappear
  // without notice. This is how an operator finds that out on a quiet afternoon
  // instead of at the moment a deposit needs checking. Read-only: it asks each
  // endpoint for the current block height and reports who answered.
  //
  // Admin-only because it discloses the endpoint URLs, which may carry a paid
  // provider's API key in the path once one is configured.
  app.get("/staff/mining/rpc", staffGuard(["admin"], async (_ctx, req) => {
    const q = z.object({ chain: z.string().min(1).max(20).default("bep20") })
      .parse((req.query as Record<string, unknown>) ?? {});
    const endpoints = endpointsFor(q.chain);
    if (!endpoints.length) {
      return { chain: q.chain, endpoints: [], results: [], note: "No RPC endpoints are configured for this network." };
    }
    return { chain: q.chain, endpoints, results: await rpcHealth(q.chain) };
  }));

  // Reconciliation timeline (CUSTODY_SPEC.md § 5 step 3 / § 3.5) — treasury +
  // unswept on-chain balance vs what the ledger says we owe, one row per
  // scheduled check. There is no paging in this codebase; this endpoint IS
  // the alerting — someone has to open it to see a mismatch.
  app.get("/staff/mining/reconciliation", staffGuard(["manager", "admin"], async (_ctx, req) => {
    const q = z.object({ chain: z.string().min(1).max(20).default("bep20"), limit: z.number().int().min(1).max(200).default(50) })
      .parse((req.query as Record<string, unknown>) ?? {});
    const rows = await sql.all<Record<string, unknown>>(
      `SELECT * FROM treasury_balance_snapshots WHERE chain = ? ORDER BY checked_at DESC LIMIT ?`,
      q.chain, q.limit,
    );
    return {
      chain: q.chain,
      snapshots: rows.map((r) => ({
        ...r,
        onchainBalance: usdtFromMicro(Number(r.onchain_balance)),
        ledgerTotal: usdtFromMicro(Number(r.ledger_total)),
        delta: usdtFromMicro(Number(r.delta)),
      })),
    };
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
      // total_burned is stored in MICRO (the boot migration rescaled it). Convert
      // to whole ROZI here, at the staff edge, so the admin panel shows "5 ROZI
      // burned" and not "5000000" — the same rule the rest of this file follows.
      windows: windows.map((w) => ({ ...w, total_burned: fromMicro(Number(w.total_burned)) })),
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
      detail: `window ${id}: ${result.pointsPaid} points to ${result.users} users for ${fromMicro(result.totalBurnedMicro)} ROZI burned`,
    });
    // Expose `totalBurned` in whole ROZI, not the raw micro field, so the web's
    // settle-confirmation message reads in ROZI. (`totalBurnedMicro` is dropped.)
    const { totalBurnedMicro, ...rest } = result;
    return { ok: true, ...rest, totalBurned: fromMicro(totalBurnedMicro) };
  }));

  // ---- Manual ROZI adjustment ----------------------------------------------
  // Capped and audit-logged, exactly like the Points adjustment is. ROZI is not
  // directly redeemable, but it IS a claim on future conversion pots — so an
  // unbounded mint here still dilutes every honest miner.
  app.post("/staff/mining/users/:id/adjust", staffGuard(["admin"], async ({ userId: actorId, role }, req) => {
    const targetId = (req.params as { id: string }).id;
    // Whole ROZI, and no longer .int(): ROZI is divisible, so an Admin correcting
    // a 0.104 mining payout has to be able to type 0.104.
    const b = z.object({
      rozi: z.number(),
      note: z.string().min(3).max(200),
    }).parse(req.body);

    const s = await loadMiningSettings();
    const magnitude = Math.abs(b.rozi);
    const magnitudeMicro = toMicro(magnitude);
    // Checked in MICRO: a 0.0000001 adjustment is non-zero as a decimal but rounds
    // to zero micro, and would post an empty ledger row.
    if (magnitudeMicro === 0) throw { statusCode: 400, message: "Amount cannot be zero." };
    if (magnitude > s.adminAdjustMaxRozi) {
      throw {
        statusCode: 400,
        message: `A single adjustment is limited to ${s.adminAdjustMaxRozi} ROZI. Raise the limit deliberately if you really mean it.`,
      };
    }

    const target = await sql.get<{ id: string }>("SELECT id FROM users WHERE id = ?", targetId);
    if (!target) throw { statusCode: 404, message: "No such user." };

    await postRozi({
      userId: targetId, micro: magnitudeMicro,
      direction: b.rozi > 0 ? "credit" : "debit",
      sourceType: "admin_adjustment", note: b.note,
    });
    await logAudit({
      actorUserId: actorId, actorRole: role, action: "mining_rozi_adjust",
      targetUserId: targetId, detail: `${b.rozi > 0 ? "+" : ""}${b.rozi} ROZI — ${b.note}`,
    });
    return { ok: true };
  }));

  // ---- ROZI store: the catalogue -------------------------------------------
  // Admin owns this list at runtime. Prices are in WHOLE ROZI (this panel's unit
  // — see the note at the top of the file) and `stock` is the hard ceiling on
  // what the whole feature can ever cost the business.
  app.get("/staff/mining/store", staffGuard(["admin", "manager"], async () => {
    const items = await sql.all<Record<string, unknown>>(
      "SELECT * FROM rozi_store_items ORDER BY sort, cost_rozi");
    return {
      items: items.map((i) => ({
        id: i.id, title: i.title, description: i.description,
        costRozi: Number(i.cost_rozi), inputLabel: i.input_label,
        stock: i.stock, status: i.status, sort: i.sort,
      })),
    };
  }));

  const itemSchema = z.object({
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).optional(),
    costRozi: z.number().int().positive().max(1_000_000_000),
    inputLabel: z.string().trim().max(60).optional(),
    stock: z.number().int().min(0).max(1_000_000),
    status: z.enum(["active", "hidden"]).optional(),
    sort: z.number().int().min(0).max(9999).optional(),
  });

  app.post("/staff/mining/store", staffGuard(["admin"], async ({ userId, role }, req) => {
    const b = itemSchema.parse(req.body);
    const id = newId();
    await sql.run(
      `INSERT INTO rozi_store_items (id, title, description, cost_rozi, input_label, stock, status, sort, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      id, b.title, b.description ?? null, b.costRozi, b.inputLabel ?? null,
      b.stock, b.status ?? "active", b.sort ?? 0, now(),
    );
    await logAudit({
      actorUserId: userId, actorRole: role, action: "store_item_create",
      detail: `${b.title} — ${b.costRozi} ROZI, stock ${b.stock}`,
    });
    return { ok: true, id };
  }));

  app.patch("/staff/mining/store/:id", staffGuard(["admin"], async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    const b = itemSchema.partial().parse(req.body);
    const map: [string, unknown][] = [
      ["title", b.title], ["description", b.description], ["cost_rozi", b.costRozi],
      ["input_label", b.inputLabel], ["stock", b.stock], ["status", b.status], ["sort", b.sort],
    ];
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [col, v] of map) if (v !== undefined) { cols.push(`${col} = ?`); vals.push(v); }
    if (!cols.length) throw { statusCode: 400, message: "Nothing to change." };

    const res = await sql.run(`UPDATE rozi_store_items SET ${cols.join(", ")} WHERE id = ?`, ...vals, id);
    if (!res.rowCount) throw { statusCode: 404, message: "No such item." };
    await logAudit({
      actorUserId: userId, actorRole: role, action: "store_item_update",
      detail: `${id}: ${JSON.stringify(b)}`,
    });
    return { ok: true };
  }));

  // ---- ROZI store: the fulfilment queue ------------------------------------
  // A redemption is a human job, like a withdrawal. The ROZI was already taken
  // when the user asked, so the only two outcomes here are "done" and "give it
  // back" — there is no third state where we keep the ROZI and deliver nothing.
  app.get("/staff/mining/redemptions", staffGuard(["admin", "manager", "agent"], async (_ctx, req) => {
    const q = z.object({ status: z.enum(["pending", "fulfilled", "rejected"]).optional() })
      .parse(req.query ?? {});
    // Built conditionally rather than with a "(? IS NULL OR status = ?)" trick:
    // Postgres cannot infer the type of a bare parameter on its own in `$1 IS
    // NULL` and errors out. The filter value is from a zod enum, never raw input.
    const rows = await sql.all<Record<string, unknown>>(
      `SELECT r.*, i.title, u.email
       FROM rozi_redemptions r
       JOIN rozi_store_items i ON i.id = r.item_id
       JOIN users u ON u.id = r.user_id
       ${q.status ? "WHERE r.status = ?" : ""}
       ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.created_at DESC
       LIMIT 200`,
      ...(q.status ? [q.status] : []),
    );
    return {
      redemptions: rows.map((r) => ({
        id: r.id, userId: r.user_id, email: r.email, title: r.title,
        costRozi: fromMicro(Number(r.cost_micro)), target: r.target,
        status: r.status, staffNote: r.staff_note, at: r.created_at, decidedAt: r.decided_at,
      })),
    };
  }));

  app.post("/staff/mining/redemptions/:id", staffGuard(["admin", "manager"], async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    const b = z.object({
      action: z.enum(["fulfil", "reject"]),
      note: z.string().trim().max(500).optional(),
    }).parse(req.body);

    return sql.tx(async (t) => {
      // The status flip is CONDITIONAL on it still being pending, and the row
      // count is the only authority. Two staff members opening the same queue and
      // both clicking Reject would otherwise refund the same ROZI twice.
      const r = await t.get<{ user_id: string; cost_micro: string; item_id: string }>(
        "SELECT user_id, cost_micro, item_id FROM rozi_redemptions WHERE id = ?", id);
      if (!r) throw { statusCode: 404, message: "No such redemption." };

      const done = await t.run(
        `UPDATE rozi_redemptions SET status = ?, staff_note = ?, decided_by = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`,
        b.action === "fulfil" ? "fulfilled" : "rejected", b.note ?? null, userId, now(), id,
      );
      if (!done.rowCount) throw { statusCode: 400, message: "This one has already been decided." };

      if (b.action === "reject") {
        // Give back exactly what was taken — the snapshot on the row, never a
        // recomputed price. An admin who raised the price meanwhile must not
        // change what this user gets back.
        await postRozi({
          userId: r.user_id, micro: Number(r.cost_micro), direction: "credit",
          sourceType: "store_redemption", sourceRefId: id, note: "Order refunded",
        }, t);
        // And put the item back on the shelf.
        await t.run("UPDATE rozi_store_items SET stock = stock + 1 WHERE id = ?", r.item_id);
      }

      await logAudit({
        actorUserId: userId, actorRole: role, action: `store_redemption_${b.action}`,
        targetUserId: r.user_id, detail: `${id}${b.note ? ` — ${b.note}` : ""}`,
      }, t);
      return { ok: true };
    });
  }));
}
