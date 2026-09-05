// Admin-driven reward disbursement — the staff endpoints (founder, 2026-09-02).
//
// The data layer is ../disbursements.ts. This file is the HTTP surface plus the
// per-recipient RUN: for every disbursement row, release the approved reward
// through the SAME releaseProof() the manual two-step release already uses
// (routes/staffTasks.ts), and — for on-chain / manual / csv batches — create a
// withdrawal_request to the user's saved address so the existing settle / relay
// / manual-queue machinery carries it the rest of the way.
//
// ⚠️ EACH ROW IS ITS OWN DECISION. The run loops rows and processes each in its
// own transaction; one blocked recipient (velocity cap, exhausted campaign
// budget, no saved address) is recorded 'failed'/'needs_address' and the loop
// carries on. Never one big transaction — the Stage-7 bulk-proof-decide rule.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { sql, now, newId, logAudit, postEarnedUsdt, earnedUsdtBalanceMicroOf } from "../db.ts";
import { config } from "../config.ts";
import { requirePermission, type Role, type Permission } from "../roles.ts";
import { releaseProof } from "./staffTasks.ts";
import { tryAutoSettle } from "../autoWithdraw.ts";
import { looksLikeTxHash, pointsToUsdt } from "../payout.ts";
import { sendPushToUser } from "../push.ts";
import {
  listEligible, createBatch, recomputeBatchTotals, listBatches, getBatch,
  getDisbursements, getDisbursementRow, syncBatchFromRequests, renameBatch, DISBURSE_CHAIN,
  type BatchMode, type DisbursementRow,
} from "../disbursements.ts";

function staffGuard(
  perm: Permission,
  handler: (ctx: { userId: string; role: Role }, req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await handler(await requirePermission(req, perm), req, reply);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Something went wrong" });
    }
  };
}

// The disbursement statuses a run will (re)process. 'released'/'paid'/'skipped'
// are terminal-good; 'sending' is in flight (relay). 'failed' and
// 'needs_address' are retried — an admin who saved an address / raised a budget
// wants the next run to pick the row up.
const RUNNABLE = ["pending", "failed", "needs_address"];

type RowResult = { disbursementId: string; userId: string; status: string; error?: string };

// Process ONE disbursement row for a 'balance' batch: claim it, release the
// reward to the user's in-app balance, record the outcome. Its own
// transaction; returns a result, never throws.
async function runBalanceRow(
  app: FastifyInstance, ctx: { userId: string; role: Role }, row: DisbursementRow,
): Promise<RowResult> {
  // Claim: flip to 'sending' only if still runnable, so two concurrent runs of
  // the same batch cannot both release the same proof. releaseProof() is itself
  // idempotent (creditCompletion keys on the completion's unique index), so the
  // worst a lost race does is a no-op 'duplicate' — this just keeps the row
  // status coherent.
  const claimed = await sql.get<{ id: string }>(
    `UPDATE payout_disbursements SET status = 'sending'
     WHERE id = ? AND status IN ('pending','failed','needs_address') RETURNING id`,
    row.id,
  );
  if (!claimed) return { disbursementId: row.id, userId: row.userId, status: "skipped", error: "already handled" };

  if (!row.proofId) {
    await sql.run("UPDATE payout_disbursements SET status = 'failed', error = ? WHERE id = ?",
      "no proof attached", row.id);
    return { disbursementId: row.id, userId: row.userId, status: "failed", error: "no proof attached" };
  }

  const out = await releaseProof(app, ctx, row.proofId);
  // ok (credited or duplicate) OR "reward already sent" both mean the money is
  // on the user's balance — the row is done either way.
  const landed = out.ok || out.error === "reward already sent";
  if (landed) {
    await sql.run(
      "UPDATE payout_disbursements SET status = 'released', error = NULL, settled_at = ? WHERE id = ?",
      now(), row.id,
    );
    return { disbursementId: row.id, userId: row.userId, status: "released" };
  }
  await sql.run(
    "UPDATE payout_disbursements SET status = 'failed', error = ? WHERE id = ?",
    out.error ?? "release failed", row.id,
  );
  return { disbursementId: row.id, userId: row.userId, status: "failed", error: out.error };
}

// Process ONE disbursement row for an on-chain / manual / csv batch.
//
//   1. Release the reward to the user's in-app balance (releaseProof) — the
//      money must exist as an earned_usdt_ledger credit before we can debit it
//      for a payout.
//   2. Points/ROZI-only reward -> nothing to send on a chain, row = 'released'.
//   3. No saved payout address -> row = 'needs_address', skipped (decision B:
//      an admin push never collects an address; the user sets one when they
//      first withdraw). A later run picks it up once one is saved.
//   4. Create a withdrawal_request (source_kind='earned_usdt') to that address
//      and hold the USDT — reusing the EXACT machinery a user-filed withdrawal
//      uses, minus the user-facing gates (min amount, step-up, KYC): a staff
//      member with disbursements.manage has already decided to pay this.
//   5. 'onchain' -> tryAutoSettle() now (ceiling / 24h cap / hold / relay /
//      provider all still apply). 'manual' / 'csv' -> leave it in the manual
//      Agent->Manager queue, where staff mark it paid.
async function runPayoutRow(
  app: FastifyInstance, ctx: { userId: string; role: Role }, row: DisbursementRow, mode: BatchMode,
): Promise<RowResult> {
  const claimed = await sql.get<{ id: string }>(
    `UPDATE payout_disbursements SET status = 'sending'
     WHERE id = ? AND status IN ('pending','failed','needs_address') RETURNING id`,
    row.id,
  );
  if (!claimed) return { disbursementId: row.id, userId: row.userId, status: "skipped", error: "already handled" };

  if (!row.proofId) {
    await sql.run("UPDATE payout_disbursements SET status = 'failed', error = ? WHERE id = ?", "no proof attached", row.id);
    return { disbursementId: row.id, userId: row.userId, status: "failed", error: "no proof attached" };
  }

  // 1. Release to balance.
  const rel = await releaseProof(app, ctx, row.proofId);
  if (!(rel.ok || rel.error === "reward already sent")) {
    await sql.run("UPDATE payout_disbursements SET status = 'failed', error = ? WHERE id = ?", rel.error ?? "release failed", row.id);
    return { disbursementId: row.id, userId: row.userId, status: "failed", error: rel.error };
  }

  // 2. Nothing to put on a chain.
  if (row.usdtMicro <= 0) {
    await sql.run("UPDATE payout_disbursements SET status = 'released', error = NULL, settled_at = ? WHERE id = ?", now(), row.id);
    return { disbursementId: row.id, userId: row.userId, status: "released" };
  }

  // 3. Saved address only — re-read now (one may have been added since the
  // batch was built).
  const addr = await sql.get<{ address: string; verified_at: string | null }>(
    "SELECT address, verified_at FROM payout_addresses WHERE user_id = ? AND chain = ?",
    row.userId, DISBURSE_CHAIN,
  );
  if (!addr?.address) {
    await sql.run(
      "UPDATE payout_disbursements SET status = 'needs_address', error = ? WHERE id = ?",
      "the user has no saved payout address", row.id,
    );
    return { disbursementId: row.id, userId: row.userId, status: "needs_address", error: "no saved payout address" };
  }

  // 4. Create the payout request + hold the USDT, under the user advisory lock
  // (guardrail #8 — a concurrent user-filed withdrawal must serialize with this).
  const reqId = newId();
  const usdtMicro = row.usdtMicro;
  const amountPoints = Math.ceil((usdtMicro * config.pointsPerUsdt) / 1_000_000);
  try {
    await sql.tx(async (t) => {
      await t.run("SELECT pg_advisory_xact_lock(hashtext(?))", row.userId);
      const bal = await earnedUsdtBalanceMicroOf(row.userId, t);
      if (usdtMicro > bal) throw new Error("not enough task USDT after release");
      await t.run(
        `INSERT INTO withdrawal_requests
           (id, user_id, amount, payout_rail, payout_address, fee_points, address_verified,
            source_kind, earned_usdt_micro, status, reviewed_by, review_note, created_at)
         VALUES (?,?,?,?,?, 0, ?, 'earned_usdt', ?, 'pending', 'system:disbursement', ?, ?)`,
        reqId, row.userId, amountPoints, DISBURSE_CHAIN, addr.address,
        addr.verified_at ? 1 : 0, usdtMicro, `Admin reward disbursement (batch ${row.batchId})`, now(),
      );
      await postEarnedUsdt({
        userId: row.userId, micro: usdtMicro, direction: "debit",
        sourceType: "withdrawal", sourceRefId: reqId,
        note: `Admin reward disbursement (batch ${row.batchId})`,
      }, t);
      await t.run(
        "UPDATE payout_disbursements SET withdrawal_request_id = ?, dest_address = ?, status = 'sending', error = NULL WHERE id = ?",
        reqId, addr.address, row.id,
      );
    });
  } catch (e) {
    await sql.run(
      "UPDATE payout_disbursements SET status = 'failed', error = ? WHERE id = ?",
      (e as Error).message || "could not create the payout", row.id,
    );
    return { disbursementId: row.id, userId: row.userId, status: "failed", error: (e as Error).message };
  }

  // 5. Settle now only for 'onchain'. 'manual'/'csv' stay in the staff queue.
  if (mode === "onchain") {
    const auto = await tryAutoSettle(reqId);
    if (auto.settled === true) {
      await sql.run(
        "UPDATE payout_disbursements SET status = 'paid', tx_hash = ?, settled_at = ? WHERE id = ?",
        auto.txHash, now(), row.id,
      );
      return { disbursementId: row.id, userId: row.userId, status: "paid" };
    }
    // 'processing' (relay) or false (below/at ceiling but manual mode, or held)
    // -> the row stays 'sending'; the queue / relay owns it from here.
  }
  return { disbursementId: row.id, userId: row.userId, status: "sending" };
}

// Dispatch ONE row per the batch's mode. Shared by runBatch's loop and the
// individual "send one recipient" route below, so the two can never drift —
// one pipeline, not two copies of the same decision.
async function dispatchRow(
  app: FastifyInstance, ctx: { userId: string; role: Role }, batch: { mode: BatchMode }, row: DisbursementRow,
): Promise<RowResult> {
  return batch.mode === "balance"
    ? await runBalanceRow(app, ctx, row)
    : await runPayoutRow(app, ctx, row, batch.mode);
}

// Run a whole batch, dispatching per mode.
async function runBatch(
  app: FastifyInstance, ctx: { userId: string; role: Role }, batchId: string,
): Promise<{ processed: number; released: number; failed: number; results: RowResult[] }> {
  const batch = await getBatch(batchId);
  if (!batch) throw { statusCode: 404, message: "Batch not found." };
  if (batch.status === "cancelled") throw { statusCode: 409, message: "This batch was cancelled." };
  if (batch.status === "completed") throw { statusCode: 409, message: "This batch is already done." };

  // Mark it processing before the first row, so a concurrent run / the list
  // screen sees it move.
  await sql.run("UPDATE payout_batches SET status = 'processing' WHERE id = ? AND status IN ('draft','processing','partly_failed')", batchId);

  // Pull in any status changes from underlying withdrawal_requests first (a
  // 'manual' batch's payouts may have been marked paid in the withdrawal queue
  // since the last run), so a re-run does not re-touch a row that is really done.
  await syncBatchFromRequests(batchId);

  // Recover orphans: a row stuck at 'sending' with NO withdrawal_request behind
  // it was claimed by a previous run that then crashed before it resolved. A
  // genuine in-flight payout always gets its withdrawal_request_id set in the
  // same transaction as its 'sending' status, so "sending + null request" can
  // only mean a dead run. Reset it so this run picks it up ('sending' is not in
  // RUNNABLE, by design — a real relay/queue payout must not be re-processed).
  await sql.run(
    "UPDATE payout_disbursements SET status = 'pending' WHERE batch_id = ? AND status = 'sending' AND withdrawal_request_id IS NULL",
    batchId,
  );

  const rows = (await getDisbursements(batchId)).filter((r) => RUNNABLE.includes(r.status));
  const results: RowResult[] = [];
  for (const row of rows) {
    try {
      results.push(await dispatchRow(app, ctx, batch, row));
    } catch (e) {
      // A row processor is meant to catch its own errors and return a 'failed'
      // result — but if one throws anyway (a genuine DB error), the row was
      // already claimed to 'sending' and would be orphaned there, invisible to
      // every future run (RUNNABLE has no 'sending'). Reset it to 'failed' so a
      // retry can pick it up, and keep the loop going.
      await sql.run(
        "UPDATE payout_disbursements SET status = 'failed', error = ? WHERE id = ? AND status = 'sending'",
        (e as Error).message || "run failed", row.id,
      ).catch(() => {});
      results.push({ disbursementId: row.id, userId: row.userId, status: "failed", error: (e as Error).message });
    }
  }

  await recomputeBatchTotals(batchId);
  const released = results.filter((r) => r.status === "released").length;
  const failed = results.filter((r) => r.status === "failed").length;

  await logAudit({
    actorUserId: ctx.userId, actorRole: ctx.role, action: "disbursement_batch_run",
    detail: `batch ${batchId} (${batch.mode}): ${released} released, ${failed} failed of ${results.length}`,
  });

  return { processed: results.length, released, failed, results };
}

const createSchema = z.object({
  mode: z.enum(["balance", "onchain", "manual", "csv"]),
  note: z.string().trim().max(300).optional(),
  name: z.string().trim().max(120).optional(),
  proofIds: z.array(z.string().min(1)).optional(),
  allEligible: z.boolean().optional(),
  q: z.string().trim().max(120).optional(),
  // Scope "batch everything eligible" to one campaign, so the same button on a
  // task's own screen cannot sweep in every other campaign's rewards.
  taskId: z.string().trim().max(64).optional(),
}).refine((v) => (v.proofIds && v.proofIds.length > 0) || v.allEligible, {
  message: "Select rewards to pay, or set allEligible.",
});

export async function staffDisbursementRoutes(app: FastifyInstance) {
  // The pool: approved rewards awaiting release.
  app.get("/staff/disbursements/eligible", staffGuard("disbursements.manage", async (_ctx, req) => {
    const query = req.query as Record<string, string | undefined>;
    return listEligible({
      q: query.q,
      userId: query.userId,
      taskId: query.taskId,
      limit: Number(query.limit ?? 50) || 50,
      offset: Number(query.offset ?? 0) || 0,
      includeInBatch: query.includeInBatch === "1",
    });
  }));

  // Create a batch from selected proof ids (or the whole eligible pool).
  app.post("/staff/disbursements", staffGuard("disbursements.manage", async ({ userId, role }, req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
    }
    const { mode, note, name, allEligible, q, taskId } = parsed.data;

    let proofIds = parsed.data.proofIds ?? [];
    if (allEligible) {
      const pool = await listEligible({ q, taskId, limit: config.disbursementMaxRecipients });
      proofIds = pool.items.map((i) => i.proofId);
      if (proofIds.length === 0) return reply.code(400).send({ error: "Nothing is waiting to be paid." });
    }

    const result = await createBatch({ mode, note, name, createdBy: userId, proofIds });
    await logAudit({
      actorUserId: userId, actorRole: role, action: "disbursement_batch_create",
      detail: `batch ${result.batchId} (${mode}): ${result.added} added, ${result.skipped.length} skipped`,
    });
    return result;
  }));

  // List batches.
  app.get("/staff/disbursements", staffGuard("disbursements.manage", async (_ctx, req) => {
    const query = req.query as Record<string, string | undefined>;
    return listBatches({
      status: query.status,
      q: query.q,
      taskId: query.taskId,
      limit: Number(query.limit ?? 25) || 25,
      offset: Number(query.offset ?? 0) || 0,
    });
  }));

  // One batch + its rows.
  app.get("/staff/disbursements/:id", staffGuard("disbursements.manage", async (_ctx, req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await getBatch(id))) return reply.code(404).send({ error: "Batch not found." });
    // Reflect any withdrawal-queue movement before rendering, and roll the
    // batch status up from it.
    await syncBatchFromRequests(id);
    await recomputeBatchTotals(id);
    return { batch: await getBatch(id), rows: await getDisbursements(id) };
  }));

  // Rename a batch (founder, 2026-09-03). Cosmetic by design — the id is what
  // every other table joins on and it stays visible as a copyable chip; this
  // only changes how the batch reads in a list.
  app.patch("/staff/disbursements/:id", staffGuard("disbursements.manage", async ({ userId, role }, req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Give the batch a name." });
    const before = await getBatch(id);
    if (!before) return reply.code(404).send({ error: "Batch not found." });
    if (!(await renameBatch(id, parsed.data.name))) {
      return reply.code(400).send({ error: "Give the batch a name." });
    }
    await logAudit({
      actorUserId: userId, actorRole: role, action: "disbursement_batch_rename",
      detail: `batch ${id}`, previousValue: before.name ?? "(unnamed)", newValue: parsed.data.name,
    });
    return { ok: true, batch: await getBatch(id) };
  }));

  // Run the batch (Phase 1: balance mode).
  app.post("/staff/disbursements/:id/run", staffGuard("disbursements.manage", async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    return runBatch(app, { userId, role }, id);
  }));

  // Send ONE recipient, not the whole batch (founder, 2026-09-05: "individual
  // sending ... one by one"). Same pipeline as runBatch's loop
  // (dispatchRow), same "each row is its own decision" rule — this never
  // touches any other row in the batch.
  app.post("/staff/disbursements/:id/rows/:rid/send", staffGuard("disbursements.manage", async ({ userId, role }, req, reply) => {
    const { id, rid } = req.params as { id: string; rid: string };
    const batch = await getBatch(id);
    if (!batch) return reply.code(404).send({ error: "Batch not found." });
    if (batch.status === "cancelled") return reply.code(409).send({ error: "This batch was cancelled." });
    if (batch.status === "completed") return reply.code(409).send({ error: "This batch is already done." });

    // Mark it processing before dispatching, same as runBatch — a 'draft'
    // batch's status is otherwise never rolled up by recomputeBatchTotals
    // (which deliberately leaves 'draft' alone), so without this a batch sent
    // one row at a time, never via "Send reward to all", would stay 'draft'
    // forever even once every row is done.
    await sql.run(
      "UPDATE payout_batches SET status = 'processing' WHERE id = ? AND status IN ('draft','processing','partly_failed')",
      id,
    );
    // Pick up any settlement that happened since this row was last read, same
    // as runBatch does before its own loop.
    await syncBatchFromRequests(id);
    // Same orphan recovery runBatch does batch-wide, scoped to this one row: a
    // row stuck 'sending' with no withdrawal_request behind it was claimed by a
    // crashed run and can only mean a dead attempt, never a real in-flight payout.
    await sql.run(
      "UPDATE payout_disbursements SET status = 'pending' WHERE id = ? AND batch_id = ? AND status = 'sending' AND withdrawal_request_id IS NULL",
      rid, id,
    );
    const row = await getDisbursementRow(id, rid);
    if (!row) return reply.code(404).send({ error: "Row not found in this batch." });
    if (!RUNNABLE.includes(row.status)) {
      return reply.code(409).send({ error: `This reward is '${row.status}', not ready to send.` });
    }

    let result: RowResult;
    try {
      result = await dispatchRow(app, { userId, role }, batch, row);
    } catch (e) {
      // Same recovery runBatch's loop uses: a row processor is meant to catch
      // its own errors, but if one throws anyway the row was already claimed
      // to 'sending' and would be orphaned there forever otherwise.
      await sql.run(
        "UPDATE payout_disbursements SET status = 'failed', error = ? WHERE id = ? AND status = 'sending'",
        (e as Error).message || "send failed", row.id,
      ).catch(() => {});
      result = { disbursementId: row.id, userId: row.userId, status: "failed", error: (e as Error).message };
    }

    await recomputeBatchTotals(id);
    await logAudit({
      actorUserId: userId, actorRole: role, action: "disbursement_row_send",
      detail: `row ${rid} (batch ${id}): ${result.status}`,
    });
    return result;
  }));

  // Cancel a batch that has not paid anything out. Frees its proofs back into
  // the eligible pool. Refused once any row has released/paid/sent — those
  // cannot be un-done.
  app.post("/staff/disbursements/:id/cancel", staffGuard("disbursements.manage", async ({ userId, role }, req, reply) => {
    const id = (req.params as { id: string }).id;
    const out = await sql.tx(async (t) => {
      const b = await t.get<{ status: string }>("SELECT status FROM payout_batches WHERE id = ? FOR UPDATE", id);
      if (!b) throw { statusCode: 404, message: "Batch not found." };
      if (b.status === "cancelled") return { ok: true, alreadyCancelled: true };
      const moved = await t.get<{ n: number }>(
        `SELECT 1 AS n FROM payout_disbursements
         WHERE batch_id = ? AND status IN ('released','sending','paid') LIMIT 1`, id,
      );
      if (moved) throw { statusCode: 409, message: "This batch has already paid some rewards — it cannot be cancelled." };
      await t.run("UPDATE payout_batches SET status = 'cancelled', completed_at = ? WHERE id = ?", now(), id);
      return { ok: true };
    });
    if (!(out as { alreadyCancelled?: boolean }).alreadyCancelled) {
      await logAudit({
        actorUserId: userId, actorRole: role, action: "disbursement_batch_cancel", detail: `batch ${id}`,
      });
    }
    return out;
  }));

  // "Send reward now" — one recipient, balance mode, create + run in one call.
  const quickSchema = z.object({ proofId: z.string().min(1), note: z.string().trim().max(300).optional() });
  app.post("/staff/disbursements/quick", staffGuard("disbursements.manage", async ({ userId, role }, req, reply) => {
    const parsed = quickSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Pick a reward to send." });
    const { proofId, note } = parsed.data;
    const created = await createBatch({
      mode: "balance", note: note ?? "Sent one reward", createdBy: userId, proofIds: [proofId],
    });
    if (created.added === 0) {
      return reply.code(409).send({ error: created.skipped[0]?.reason ?? "That reward cannot be sent." });
    }
    const run = await runBatch(app, { userId, role }, created.batchId);
    await logAudit({
      actorUserId: userId, actorRole: role, action: "disbursement_quick_send",
      detail: `proof ${proofId} -> batch ${created.batchId}: ${run.released ? "released" : run.results[0]?.error ?? "failed"}`,
    });
    return { batchId: created.batchId, result: run.results[0] ?? null, released: run.released };
  }));

  // ---- Mark a disbursement paid by hand (manual / csv mode) --------------
  //
  // For an on-chain / manual / csv row sitting at 'sending' with a
  // withdrawal_request behind it: a staff member sent the USDT from the
  // treasury by hand and is recording the tx hash. Stamps BOTH the underlying
  // withdrawal_request and the disbursement row 'paid'. Its own decision per
  // row; never one transaction across a batch.
  async function markRowPaid(
    ctx: { userId: string; role: Role }, disbursementId: string, txHash: string,
  ): Promise<{ ok: true; status: "paid" } | { ok: false; error: string }> {
    const hash = txHash.trim();
    if (!looksLikeTxHash(hash)) return { ok: false, error: "That does not look like a transaction hash (0x + 64 characters)." };

    const box: { push: { userId: string } | null } = { push: null };
    const out = await sql.tx<{ ok: true } | { ok: false; error: string }>(async (t) => {
      const d = await t.get<{
        id: string; status: string; withdrawal_request_id: string | null; user_id: string;
      }>("SELECT id, status, withdrawal_request_id, user_id FROM payout_disbursements WHERE id = ? FOR UPDATE", disbursementId);
      if (!d) return { ok: false, error: "Row not found." };
      if (d.status === "paid") return { ok: false, error: "Already marked paid." };
      if (d.status !== "sending") return { ok: false, error: `This row is '${d.status}', not awaiting payment.` };
      if (!d.withdrawal_request_id) return { ok: false, error: "This row has no payout to mark paid — it was a balance credit." };

      // Refuse if the relay is actively handling this — marking it paid by hand
      // would double-send.
      const liveJob = await t.get<{ id: string }>(
        "SELECT 1 AS id FROM payout_relay_jobs WHERE request_id = ? AND status NOT IN ('failed','forward_confirmed')",
        d.withdrawal_request_id,
      );
      if (liveJob) return { ok: false, error: "This payout is being sent automatically — do not send it by hand." };

      const w = await t.get<{ amount: number; fee_points: number; source_kind: string; earned_usdt_micro: string | number; status: string }>(
        "SELECT amount, fee_points, source_kind, earned_usdt_micro, status FROM withdrawal_requests WHERE id = ? FOR UPDATE",
        d.withdrawal_request_id,
      );
      if (!w) return { ok: false, error: "The payout record is missing." };
      if (w.status === "paid" || w.status === "rejected") return { ok: false, error: `The payout is already ${w.status}.` };

      const net = Math.max(0, w.amount - (w.fee_points ?? 0));
      const usdt = w.source_kind === "earned_usdt"
        ? (Math.max(0, Number(w.earned_usdt_micro)) / 1_000_000).toFixed(6).replace(/\.?0+$/, "")
        : pointsToUsdt(net);

      await t.run(
        `UPDATE withdrawal_requests
         SET status = 'paid', paid_at = ?, tx_hash = ?, usdt_amount = ?,
             reviewed_by = ?, reviewed_at = ?, review_note = ?
         WHERE id = ? AND status NOT IN ('paid','rejected')`,
        now(), hash, usdt, ctx.userId, now(), "Paid by hand from a reward disbursement.", d.withdrawal_request_id,
      );
      await t.run(
        "UPDATE payout_disbursements SET status = 'paid', tx_hash = ?, error = NULL, settled_at = ? WHERE id = ? AND status = 'sending'",
        hash, now(), disbursementId,
      );
      box.push = { userId: d.user_id };
      return { ok: true };
    });

    if ("ok" in out && out.ok && box.push) {
      void sendPushToUser(box.push.userId, {
        title: "Your money is sent", body: "We sent your USDT to your wallet. Check it now.", url: "/wallet",
      });
    }
    return out.ok ? { ok: true, status: "paid" } : out;
  }

  const markPaidSchema = z.object({ txHash: z.string().trim().min(1).max(120) });
  app.post("/staff/disbursements/:id/rows/:rid/mark-paid", staffGuard("disbursements.manage", async ({ userId, role }, req, reply) => {
    const { id, rid } = req.params as { id: string; rid: string };
    const parsed = markPaidSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Paste the transaction hash." });
    const row = await sql.get<{ batch_id: string }>("SELECT batch_id FROM payout_disbursements WHERE id = ?", rid);
    if (!row || row.batch_id !== id) return reply.code(404).send({ error: "Row not found in this batch." });
    const res = await markRowPaid({ userId, role }, rid, parsed.data.txHash);
    if (!res.ok) return reply.code(409).send({ error: res.error });
    await recomputeBatchTotals(id);
    await logAudit({ actorUserId: userId, actorRole: role, action: "disbursement_row_mark_paid", detail: `row ${rid} (batch ${id})` });
    return res;
  }));

  // ---- CSV round-trip (csv mode) ---------------------------------------
  //
  // Export the batch's recipients + saved addresses -> pay them externally ->
  // re-upload a file of (disbursement id, tx hash) to mark them paid and flag
  // anything that doesn't line up. The file is parsed to JSON client-side —
  // no multipart dependency added to the API.
  const CSV_COLS = ["disbursement_id", "user_email", "chain", "address", "usdt_amount", "status"];
  // Injection-safe cell — same rule as the staff.ts export: a leading
  // = + - @ tab or CR gets a literal quote so a spreadsheet never runs it.
  const cell = (v: unknown) => {
    const s = String(v ?? "");
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };

  app.get("/staff/disbursements/:id/export", staffGuard("disbursements.manage", async (_ctx, req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await getBatch(id))) return reply.code(404).send({ error: "Batch not found." });
    await syncBatchFromRequests(id);
    const rows = await getDisbursements(id);
    const body = [
      CSV_COLS.join(","),
      ...rows.map((r) => [
        r.id, r.userEmail ?? "", r.destChain ?? DISBURSE_CHAIN, r.destAddress ?? "",
        (r.usdtMicro / 1_000_000).toFixed(6), r.status,
      ].map(cell).join(",")),
    ].join("\n");
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="disbursement-${id}.csv"`)
      .send(body);
  }));

  const reconcileSchema = z.object({
    rows: z.array(z.object({
      disbursementId: z.string().min(1),
      txHash: z.string().trim().min(1).max(120),
    })).min(1).max(1000),
  });
  app.post("/staff/disbursements/:id/reconcile", staffGuard("disbursements.manage", async ({ userId, role }, req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = reconcileSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Upload rows with a disbursement id and a transaction hash each." });
    if (!(await getBatch(id))) return reply.code(404).send({ error: "Batch not found." });

    const inBatch = new Set(
      (await sql.all<{ id: string }>("SELECT id FROM payout_disbursements WHERE batch_id = ?", id)).map((r) => r.id),
    );
    const report = {
      paid: [] as string[],
      unknown: [] as string[],       // id not in this batch
      notPayable: [] as { id: string; status: string }[], // already paid / not sending
      badHash: [] as string[],
    };
    // Collapse duplicate ids in the upload to the first occurrence.
    const seen = new Set<string>();
    for (const r of parsed.data.rows) {
      if (seen.has(r.disbursementId)) continue;
      seen.add(r.disbursementId);
      if (!inBatch.has(r.disbursementId)) { report.unknown.push(r.disbursementId); continue; }
      if (!looksLikeTxHash(r.txHash)) { report.badHash.push(r.disbursementId); continue; }
      const res = await markRowPaid({ userId, role }, r.disbursementId, r.txHash);
      if (res.ok) { report.paid.push(r.disbursementId); continue; }
      const cur = await sql.get<{ status: string }>("SELECT status FROM payout_disbursements WHERE id = ?", r.disbursementId);
      report.notPayable.push({ id: r.disbursementId, status: cur?.status ?? "unknown" });
    }
    await recomputeBatchTotals(id);
    await logAudit({
      actorUserId: userId, actorRole: role, action: "disbursement_reconcile",
      detail: `batch ${id}: ${report.paid.length} paid, ${report.unknown.length} unknown, `
        + `${report.notPayable.length} not payable, ${report.badHash.length} bad hash`,
    });
    return report;
  }));
}
