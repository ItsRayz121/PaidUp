import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { sql, now, newId, balanceOf, postLedger, getSetting } from "../db.ts";
import { config } from "../config.ts";
import { getUserId } from "../auth.ts";
import { validateAddress, type ChainId } from "../chains.ts";
import { checkPayoutAddressReuse } from "../fraud.ts";

// Upsert a user's saved payout address for a chain (set once, reuse). Best-effort.
async function saveAddress(userId: string, chain: string, address: string): Promise<void> {
  try {
    await sql.run(
      `INSERT INTO payout_addresses (user_id, chain, address, updated_at) VALUES (?,?,?,?)
       ON CONFLICT (user_id, chain) DO UPDATE SET address = EXCLUDED.address, updated_at = EXCLUDED.updated_at`,
      userId, chain, address, now(),
    );
  } catch {
    // Saving is a convenience; never let it break a withdrawal.
  }
}

function guard(handler: (userId: string, req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await handler(getUserId(req), req, reply);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Something went wrong" });
    }
  };
}

const createSchema = z.object({
  amountPoints: z.number().int().positive(),
  chain: z.enum(["bep20", "base", "aptos"]),
  address: z.string().min(1).max(120),
});

const addressSchema = z.object({
  chain: z.enum(["bep20", "base", "aptos"]),
  address: z.string().min(1).max(120),
});

export async function withdrawalRoutes(app: FastifyInstance) {
  // Request a payout. We DEBIT the ledger now to hold the funds, so the same
  // points can't be withdrawn twice while the request is pending. A rejection
  // writes a compensating credit (see staff route).
  app.post("/withdrawals", guard(async (userId, req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter a valid amount, network, and wallet address." });
    const { amountPoints, chain, address: addressRaw } = parsed.data;

    if (amountPoints < config.minWithdrawPoints) {
      return reply.code(400).send({
        error: `You need at least ${config.minWithdrawPoints} points to get money.`,
      });
    }

    // Validate the destination address for the chosen chain BEFORE holding funds
    // — a payout to a malformed address is unrecoverable.
    const addrCheck = validateAddress(chain as ChainId, addressRaw);
    if (!addrCheck.ok) return reply.code(400).send({ error: addrCheck.error });
    const address = addressRaw.trim();

    // Snapshot the current withdrawal fee onto the request, so a later Admin
    // change can't alter an in-flight payout. The user must have more than the
    // fee, or the net USDT would be zero/negative.
    const fee = Math.max(0, Number(await getSetting("withdrawal_fee_points", "0")) || 0);
    if (amountPoints <= fee) {
      return reply.code(400).send({ error: `The withdrawal fee is ${fee} points. Ask for more than that.` });
    }

    const id = newId();
    try {
      await sql.tx(async (t) => {
        // Serialize all money moves for this user. Without this, two concurrent
        // requests both read the same balance under READ COMMITTED, both pass
        // the check, and both debit — draining more than the user has. The lock
        // is held until this transaction commits, so the second request waits
        // and then sees the balance the first one already reduced.
        await t.run("SELECT pg_advisory_xact_lock(hashtext(?))", userId);
        if (amountPoints > (await balanceOf(userId, t))) {
          throw { statusCode: 400, message: "You do not have that many points yet." };
        }
        await t.run(
          `INSERT INTO withdrawal_requests (id, user_id, amount, payout_rail, payout_address, fee_points, status, created_at)
           VALUES (?,?,?,?,?,?, 'pending', ?)`,
          id, userId, amountPoints, chain, address, fee, now(),
        );
        // Hold the funds.
        await postLedger({
          userId, points: amountPoints, direction: "debit",
          sourceType: "withdrawal", sourceRefId: id, note: `Withdrawal (USDT ${chain})`,
        }, t);
      });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      if (err.statusCode === 400) return reply.code(400).send({ error: err.message });
      throw e;
    }

    // Save this address for the chain so next time it's pre-filled (set once,
    // reuse). Best-effort — a failure here must not undo the withdrawal.
    await saveAddress(userId, chain, address);

    // Flag (never block) if this wallet is shared across accounts — staff see it
    // in the fraud queue before approving the payout. Runs after the hold commits.
    await checkPayoutAddressReuse(userId, address);

    return { request: { id, amount: amountPoints, chain, address, status: "pending" } };
  }));

  // Saved payout addresses — a user sets a USDT address per chain ONCE and the
  // withdraw screen pre-fills it every time after.
  app.get("/withdrawals/addresses", guard(async (userId) => {
    const rows = await sql.all<{ chain: string; address: string }>(
      "SELECT chain, address FROM payout_addresses WHERE user_id = ?", userId,
    );
    const addresses: Record<string, string> = {};
    for (const r of rows) addresses[r.chain] = r.address;
    return { addresses };
  }));

  app.put("/withdrawals/addresses", guard(async (userId, req, reply) => {
    const parsed = addressSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Pick a network and enter a wallet address." });
    const { chain, address: addressRaw } = parsed.data;
    const check = validateAddress(chain as ChainId, addressRaw);
    if (!check.ok) return reply.code(400).send({ error: check.error });
    const address = addressRaw.trim();
    await saveAddress(userId, chain, address);
    return { ok: true, chain, address };
  }));

  // The user's own payout history.
  app.get("/withdrawals", guard(async (userId) => {
    const rows = await sql.all<Record<string, unknown>>(
      "SELECT * FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC", userId,
    );
    return {
      requests: rows.map((r) => ({
        id: r.id, amount: r.amount, chain: r.payout_rail, address: r.payout_address ?? undefined,
        status: r.status, at: r.created_at, reviewNote: r.review_note ?? undefined,
        paidAt: r.paid_at ?? undefined, txHash: r.tx_hash ?? undefined,
        usdtAmount: r.usdt_amount ?? undefined, feePoints: (r.fee_points as number) ?? 0,
      })),
    };
  }));
}
