// Admin-driven reward disbursement — the data layer (founder, 2026-09-02).
//
// Until this, the ONLY way money left the platform was a user-filed withdrawal
// request. This module lets a staff member (finance / admin) group
// approved-but-unreleased rewards into a BATCH and push them out in one action.
//
// WHAT IS "ELIGIBLE"
// -----------------
// An approved custom-task proof whose reward has NOT yet been released
// (`task_proofs.status='approved' AND reward_status='pending'`) — i.e. a real
// human already decided the work is done (guardrail #1), the money just has not
// moved yet. That is exactly the state the existing two-step release
// (routes/staffTasks.ts) created; this makes it batchable.
//
// Network-postback credits (CPX etc.) are deliberately NOT eligible — they
// credit immediately at postback time and must keep doing so, or the
// earn -> withdraw loop breaks.
//
// This file holds NO Fastify import and NO ledger write. The per-recipient run
// (which calls releaseProof() and, for on-chain modes, creates a
// withdrawal_request) lives in routes/staffDisbursements.ts because it needs
// the request-scoped logger. Here: build the pool, create the batch rows, read
// them back, roll up the totals.
import { sql, now, newId } from "./db.ts";
import { config } from "./config.ts";

export type BatchMode = "balance" | "onchain" | "manual" | "csv";
export type BatchStatus =
  | "draft" | "processing" | "completed" | "partly_failed" | "cancelled";
export type DisbursementStatus =
  | "pending" | "needs_address" | "released" | "sending" | "paid" | "failed" | "skipped";

// The chain admin-pushed on-chain payouts go out on. One chain in, one chain
// out (chains.ts) — BEP20 only. Kept as a named constant so a future
// multi-chain change has one place to start.
export const DISBURSE_CHAIN = "bep20";

export type EligibleItem = {
  proofId: string;
  userId: string;
  userEmail: string;
  taskId: string;
  taskTitle: string;
  points: number;
  usdtMicro: number;
  roziMicro: number;
  approvedAt: string | null;
  /** true once this proof is already sitting in a non-cancelled batch. */
  inBatch: boolean;
};

export type BatchRow = {
  id: string;
  mode: BatchMode;
  status: BatchStatus;
  /** Human name. Auto-filled at creation from what is in the batch; editable. */
  name: string | null;
  note: string | null;
  createdBy: string;
  createdByEmail: string | null;
  createdAt: string;
  completedAt: string | null;
  countTotal: number;
  pointsTotal: number;
  usdtMicroTotal: number;
  /** Live per-status tally over payout_disbursements — the source of truth. */
  tally: Record<DisbursementStatus, number>;
};

export type DisbursementRow = {
  id: string;
  batchId: string;
  userId: string;
  userEmail: string | null;
  proofId: string | null;
  taskTitle: string | null;
  amountPoints: number;
  usdtMicro: number;
  roziMicro: number;
  sourceKind: "points" | "earned_usdt";
  destChain: string | null;
  destAddress: string | null;
  status: DisbursementStatus;
  txHash: string | null;
  error: string | null;
  withdrawalRequestId: string | null;
  createdAt: string;
  settledAt: string | null;
  /**
   * True while a live payout_relay_jobs row is actually working this row's
   * withdrawal request right now (founder, 2026-09-05: the screen must say
   * plainly when a payout is already being sent automatically, since that is
   * exactly when "Manual reward send" showing up reads as a double-payment
   * risk). Only ever true for 'onchain'-mode rows — 'manual'/'csv' never
   * create a relay job at all.
   */
  relayInFlight: boolean;
};

const EMPTY_TALLY: Record<DisbursementStatus, number> = {
  pending: 0, needs_address: 0, released: 0, sending: 0, paid: 0, failed: 0, skipped: 0,
};

// ---- The eligible pool ----------------------------------------------------

type EligibleOpts = {
  q?: string; userId?: string; limit?: number; offset?: number; includeInBatch?: boolean;
  /**
   * Scope the pool to ONE campaign (founder, 2026-09-03). The reward is owed
   * because of a task, so paying it is reachable from that task's own screen —
   * same endpoint, same rules, one extra bound predicate.
   */
  taskId?: string;
};

export async function listEligible(
  opts: EligibleOpts = {},
): Promise<{ items: EligibleItem[]; total: number }> {
  const q = (opts.q ?? "").trim().toLowerCase();
  const limit = Math.min(Math.max(Number(opts.limit ?? 50) || 50, 1), 500);
  const offset = Math.max(Number(opts.offset ?? 0) || 0, 0);

  const where: string[] = [
    "p.status = 'approved'",
    "p.reward_status = 'pending'",
    "t.source = 'custom'",
  ];
  const wp: unknown[] = [];
  if (opts.userId) { where.push("p.user_id = ?"); wp.push(opts.userId); }
  if (opts.taskId) { where.push("p.task_id = ?"); wp.push(opts.taskId); }
  if (q) {
    where.push("(LOWER(u.email) LIKE ? OR LOWER(t.title) LIKE ? OR LOWER(p.id) = ?)");
    wp.push(`%${q}%`, `%${q}%`, q);
  }
  // A proof already in a live (non-cancelled) batch is normally hidden — it is
  // spoken for. `includeInBatch` keeps it in the list with a flag, for a screen
  // that wants to show why a proof is unavailable.
  const inBatchExpr =
    `EXISTS (SELECT 1 FROM payout_disbursements d JOIN payout_batches b ON b.id = d.batch_id
             WHERE d.proof_id = p.id AND b.status <> 'cancelled')`;
  if (!opts.includeInBatch) where.push(`NOT ${inBatchExpr}`);
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const [rows, totalRow] = await Promise.all([
    sql.all<Record<string, unknown>>(
      `SELECT p.id AS proof_id, p.user_id, u.email AS user_email,
              p.task_id, t.title AS task_title, p.reviewed_at,
              COALESCE(p.reward_points, t.points, 0) AS points,
              COALESCE(p.reward_usdt_micro, t.reward_usdt_micro, 0) AS usdt_micro,
              COALESCE(p.reward_rozi_micro, t.reward_rozi_micro, 0) AS rozi_micro,
              ${inBatchExpr} AS in_batch
       FROM task_proofs p
       JOIN users u ON u.id = p.user_id
       JOIN tasks t ON t.id = p.task_id
       ${whereSql}
       ORDER BY p.reviewed_at ASC NULLS LAST, p.created_at ASC
       LIMIT ? OFFSET ?`,
      ...wp, limit, offset,
    ),
    sql.get<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM task_proofs p
       JOIN users u ON u.id = p.user_id
       JOIN tasks t ON t.id = p.task_id
       ${whereSql}`,
      ...wp,
    ),
  ]);

  return {
    total: Number(totalRow?.n ?? rows.length),
    items: rows.map((r) => ({
      proofId: String(r.proof_id),
      userId: String(r.user_id),
      userEmail: String(r.user_email ?? ""),
      taskId: String(r.task_id),
      taskTitle: String(r.task_title ?? ""),
      points: Number(r.points ?? 0),
      usdtMicro: Number(r.usdt_micro ?? 0),
      roziMicro: Number(r.rozi_micro ?? 0),
      approvedAt: (r.reviewed_at as string) ?? null,
      inBatch: Boolean(r.in_batch),
    })),
  };
}

// ---- Create a batch -----------------------------------------------------

export type CreateBatchResult = {
  batchId: string;
  added: number;
  skipped: { proofId: string; reason: string }[];
};

// Insert one batch and a disbursement row per still-eligible proof. A proof
// that is no longer 'approved/pending', or that is already in a live batch, is
// skipped and reported — never a hard error, because the pool the admin
// selected from can move under them between load and submit.
export async function createBatch(params: {
  mode: BatchMode;
  note?: string | null;
  /** Optional explicit name; otherwise auto-named from the tasks it pays. */
  name?: string | null;
  createdBy: string;
  proofIds: string[];
}): Promise<CreateBatchResult> {
  // Sorted, not just deduped: two batches sharing several proofs must lock
  // them in the SAME order, or two concurrent creates that pick the overlap
  // in opposite orders can deadlock on the FOR UPDATE below instead of one
  // simply waiting for the other.
  const proofIds = [...new Set(params.proofIds)].sort();
  if (proofIds.length === 0) throw { statusCode: 400, message: "Pick at least one reward to pay." };
  if (proofIds.length > config.disbursementMaxRecipients) {
    throw {
      statusCode: 400,
      message: `A batch can hold at most ${config.disbursementMaxRecipients} recipients. Split it into smaller runs.`,
    };
  }

  const batchId = newId();
  const skipped: { proofId: string; reason: string }[] = [];
  const taskTitles = new Set<string>();
  let added = 0;

  await sql.tx(async (t) => {
    await t.run(
      `INSERT INTO payout_batches (id, mode, status, note, created_by, created_at)
       VALUES (?,?, 'draft', ?, ?, ?)`,
      batchId, params.mode, params.note ?? null, params.createdBy, now(),
    );

    for (const proofId of proofIds) {
      // Lock the proof row FIRST, before the dupe check below reads
      // payout_disbursements. Without this, two createBatch calls racing over
      // an overlapping pool can both pass "not already in a batch" and both
      // insert the same proof into two different batches — the unique index
      // only blocks a duplicate WITHIN one batch. Locking here makes the
      // second call block until the first commits its insert, so its dupe
      // check then correctly sees the row and skips.
      const lock = await t.get<{ id: string }>(
        "SELECT id FROM task_proofs WHERE id = ? FOR UPDATE", proofId,
      );
      if (!lock) { skipped.push({ proofId, reason: "not found" }); continue; }

      const p = await t.get<{
        id: string; user_id: string; task_id: string; status: string; reward_status: string | null;
        reward_points: number | null; reward_usdt_micro: string | number | null;
        reward_rozi_micro: string | number | null;
        task_points: number | null; task_usdt: string | number | null; task_rozi: string | number | null;
        task_source: string | null; task_title: string | null;
      }>(
        `SELECT p.id, p.user_id, p.task_id, p.status, p.reward_status,
                p.reward_points, p.reward_usdt_micro, p.reward_rozi_micro,
                t.points AS task_points, t.reward_usdt_micro AS task_usdt,
                t.reward_rozi_micro AS task_rozi, t.source AS task_source,
                t.title AS task_title
         FROM task_proofs p JOIN tasks t ON t.id = p.task_id
         WHERE p.id = ?`,
        proofId,
      );
      if (!p) { skipped.push({ proofId, reason: "not found" }); continue; }
      if (p.task_source !== "custom") { skipped.push({ proofId, reason: "not a custom task" }); continue; }
      if (p.status !== "approved" || p.reward_status !== "pending") {
        skipped.push({ proofId, reason: `not awaiting release (${p.status}/${p.reward_status ?? "-"})` });
        continue;
      }
      const dupe = await t.get<{ n: number }>(
        `SELECT 1 AS n FROM payout_disbursements d JOIN payout_batches b ON b.id = d.batch_id
         WHERE d.proof_id = ? AND b.status <> 'cancelled'`,
        proofId,
      );
      if (dupe) { skipped.push({ proofId, reason: "already in a batch" }); continue; }

      if (p.task_title) taskTitles.add(String(p.task_title));

      const points = Number(p.reward_points ?? p.task_points ?? 0);
      const usdtMicro = Number(p.reward_usdt_micro ?? p.task_usdt ?? 0);
      const roziMicro = Number(p.reward_rozi_micro ?? p.task_rozi ?? 0);

      // For a non-balance mode, look up the user's saved payout address on the
      // one offered chain. Missing -> the row is created 'needs_address' and
      // the run skips it (decision B: no new forced address-collection step).
      let destAddress: string | null = null;
      if (params.mode !== "balance") {
        const addr = await t.get<{ address: string }>(
          "SELECT address FROM payout_addresses WHERE user_id = ? AND chain = ?",
          p.user_id, DISBURSE_CHAIN,
        );
        destAddress = addr?.address ?? null;
      }
      // needs_address only matters when there is USDT to send on-chain. A
      // points/ROZI-only reward in a non-balance batch still just releases to
      // balance (there is nothing to put on a chain).
      const status: DisbursementStatus =
        params.mode !== "balance" && usdtMicro > 0 && !destAddress ? "needs_address" : "pending";

      await t.run(
        `INSERT INTO payout_disbursements
           (id, batch_id, user_id, proof_id, amount_points, usdt_micro, rozi_micro,
            source_kind, dest_chain, dest_address, status, created_at)
         VALUES (?,?,?,?,?,?,?, 'earned_usdt', ?, ?, ?, ?)`,
        newId(), batchId, p.user_id, proofId, points, usdtMicro, roziMicro,
        params.mode === "balance" ? null : DISBURSE_CHAIN, destAddress, status, now(),
      );
      added += 1;
    }

    if (added === 0) {
      // Nothing landed — cancel the empty shell rather than leave a draft with
      // no rows that a screen would render as "0 recipients, run it".
      await t.run("UPDATE payout_batches SET status = 'cancelled', completed_at = ? WHERE id = ?", now(), batchId);
    } else {
      // Name it after what is actually in it. An explicit name from the caller
      // always wins; otherwise the campaign title when the batch is one
      // campaign (the usual case, and the only one a name can be specific
      // about), else a plain count and date.
      await t.run(
        "UPDATE payout_batches SET name = ? WHERE id = ?",
        params.name?.trim() || autoBatchName([...taskTitles], added), batchId,
      );
    }
  });

  await recomputeBatchTotals(batchId);
  return { batchId, added, skipped };
}

// A name a person can read, derived from what the batch pays (founder,
// 2026-09-03: a uuid prefix "is not looking good ... extract the main word").
// One campaign is the common case and the only one a name can be specific
// about; anything wider gets a count and a date, which is at least true.
export function autoBatchName(titles: string[], recipients: number): string {
  const who = `${recipients} reward${recipients === 1 ? "" : "s"}`;
  if (titles.length === 1) {
    const t = titles[0].trim();
    // Long campaign titles ("Download Bitget Wallet and Get Cash and Rozi
    // Rewards") make a list column unreadable — take the front of it, which is
    // the part that names the thing.
    const short = t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t;
    return `${short} — ${who}`;
  }
  const day = now().slice(0, 10);
  return titles.length > 1 ? `${titles.length} campaigns · ${who} · ${day}` : `${who} · ${day}`;
}

// Rename a batch. The id never changes — it stays on screen as a copyable chip
// — so this is purely how the batch reads in a list.
export async function renameBatch(batchId: string, name: string): Promise<boolean> {
  const clean = name.trim().slice(0, 120);
  if (!clean) return false;
  const r = await sql.run("UPDATE payout_batches SET name = ? WHERE id = ?", clean, batchId);
  return Boolean(r.rowCount);
}

// ---- Roll-up ------------------------------------------------------------

// Recompute the batch's counters and status from its rows. Called after create
// and after every run. status:
//   processing     — has rows, none failed/needs_address, but not all terminal
//   completed      — every row is a clean terminal state (released/paid/skipped)
//   partly_failed  — at least one failed or needs_address row, nothing running
//   (draft stays draft until the first run; cancelled is set elsewhere)
export async function recomputeBatchTotals(batchId: string): Promise<void> {
  const b = await sql.get<{ status: string }>("SELECT status FROM payout_batches WHERE id = ?", batchId);
  if (!b || b.status === "cancelled") return;

  const rows = await sql.all<{ status: DisbursementStatus; c: number; pts: string | number; usd: string | number }>(
    `SELECT status, COUNT(*) AS c,
            COALESCE(SUM(amount_points), 0) AS pts,
            COALESCE(SUM(usdt_micro), 0) AS usd
     FROM payout_disbursements WHERE batch_id = ? GROUP BY status`,
    batchId,
  );
  const tally = { ...EMPTY_TALLY };
  let count = 0, points = 0, usdt = 0;
  for (const r of rows) {
    tally[r.status] = Number(r.c);
    count += Number(r.c);
    points += Number(r.pts);
    usdt += Number(r.usd);
  }

  let status = b.status;
  if (b.status !== "draft") {
    const running = tally.pending + tally.sending;
    const problem = tally.failed + tally.needs_address;
    if (running > 0) status = "processing";
    else if (problem > 0) status = "partly_failed";
    else status = "completed";
  }

  await sql.run(
    `UPDATE payout_batches
     SET count_total = ?, points_total = ?, usdt_micro_total = ?, status = ?,
         completed_at = CASE WHEN ? IN ('completed','partly_failed') THEN ? ELSE completed_at END
     WHERE id = ?`,
    count, points, usdt, status, status, now(), batchId,
  );
}

// ---- Sync from the withdrawal queue ---------------------------------------

// An on-chain / manual / csv disbursement hands the last leg to a
// withdrawal_requests row (auto-settle, relay, or the manual Agent->Manager
// queue). This pulls that row's outcome back onto the disbursement:
//   withdrawal paid     -> disbursement 'paid'   (+ tx hash)
//   withdrawal rejected -> disbursement 'failed'
//   anything else        -> still in flight, leave 'sending'
// Idempotent; safe to call on every read of a batch.
export async function syncBatchFromRequests(batchId: string): Promise<void> {
  const rows = await sql.all<{
    id: string; w_status: string; tx_hash: string | null;
  }>(
    `SELECT d.id, w.status AS w_status, w.tx_hash
     FROM payout_disbursements d
     JOIN withdrawal_requests w ON w.id = d.withdrawal_request_id
     WHERE d.batch_id = ? AND d.status = 'sending'`,
    batchId,
  );
  for (const r of rows) {
    if (r.w_status === "paid") {
      await sql.run(
        "UPDATE payout_disbursements SET status = 'paid', tx_hash = COALESCE(?, tx_hash), settled_at = ? WHERE id = ? AND status = 'sending'",
        r.tx_hash, now(), r.id,
      );
    } else if (r.w_status === "rejected") {
      await sql.run(
        "UPDATE payout_disbursements SET status = 'failed', error = ? WHERE id = ? AND status = 'sending'",
        "the payout was rejected in the withdrawal queue", r.id,
      );
    }
  }
}

// ---- Readers ----------------------------------------------------------

function mapBatch(r: Record<string, unknown>, tally: Record<DisbursementStatus, number>): BatchRow {
  return {
    id: String(r.id),
    mode: r.mode as BatchMode,
    status: r.status as BatchStatus,
    name: (r.name as string) ?? null,
    note: (r.note as string) ?? null,
    createdBy: String(r.created_by),
    createdByEmail: (r.created_by_email as string) ?? null,
    createdAt: String(r.created_at),
    completedAt: (r.completed_at as string) ?? null,
    countTotal: Number(r.count_total ?? 0),
    pointsTotal: Number(r.points_total ?? 0),
    usdtMicroTotal: Number(r.usdt_micro_total ?? 0),
    tally,
  };
}

export async function listBatches(
  opts: { status?: string; q?: string; limit?: number; offset?: number; taskId?: string } = {},
): Promise<{ batches: BatchRow[]; total: number }> {
  const q = (opts.q ?? "").trim().toLowerCase();
  const limit = Math.min(Math.max(Number(opts.limit ?? 25) || 25, 1), 200);
  const offset = Math.max(Number(opts.offset ?? 0) || 0, 0);
  const where: string[] = [];
  const wp: unknown[] = [];
  if (opts.status && opts.status !== "all") { where.push("b.status = ?"); wp.push(opts.status); }
  if (q) {
    where.push("(LOWER(b.id) = ? OR LOWER(b.name) LIKE ? OR LOWER(b.note) LIKE ? OR LOWER(u.email) LIKE ?)");
    wp.push(q, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  // A task's OWN batches: any batch holding at least one row that pays a proof
  // of this task. A batch can legitimately span several campaigns, so this is
  // EXISTS, not a join that would multiply rows.
  if (opts.taskId) {
    where.push(
      `EXISTS (SELECT 1 FROM payout_disbursements d
               JOIN task_proofs pr ON pr.id = d.proof_id
               WHERE d.batch_id = b.id AND pr.task_id = ?)`,
    );
    wp.push(opts.taskId);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows, totalRow] = await Promise.all([
    sql.all<Record<string, unknown>>(
      `SELECT b.*, u.email AS created_by_email
       FROM payout_batches b LEFT JOIN users u ON u.id = b.created_by
       ${whereSql} ORDER BY b.created_at DESC LIMIT ? OFFSET ?`,
      ...wp, limit, offset,
    ),
    sql.get<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM payout_batches b LEFT JOIN users u ON u.id = b.created_by ${whereSql}`,
      ...wp,
    ),
  ]);

  const tallies = await talliesFor(rows.map((r) => String(r.id)));
  return {
    total: Number(totalRow?.n ?? rows.length),
    batches: rows.map((r) => mapBatch(r, tallies[String(r.id)] ?? { ...EMPTY_TALLY })),
  };
}

export async function getBatch(batchId: string): Promise<BatchRow | null> {
  const r = await sql.get<Record<string, unknown>>(
    `SELECT b.*, u.email AS created_by_email
     FROM payout_batches b LEFT JOIN users u ON u.id = b.created_by WHERE b.id = ?`,
    batchId,
  );
  if (!r) return null;
  const tallies = await talliesFor([batchId]);
  return mapBatch(r, tallies[batchId] ?? { ...EMPTY_TALLY });
}

async function talliesFor(batchIds: string[]): Promise<Record<string, Record<DisbursementStatus, number>>> {
  const out: Record<string, Record<DisbursementStatus, number>> = {};
  if (batchIds.length === 0) return out;
  const rows = await sql.all<{ batch_id: string; status: DisbursementStatus; c: number }>(
    `SELECT batch_id, status, COUNT(*) AS c FROM payout_disbursements
     WHERE batch_id IN (${batchIds.map(() => "?").join(",")}) GROUP BY batch_id, status`,
    ...batchIds,
  );
  for (const r of rows) {
    (out[r.batch_id] ??= { ...EMPTY_TALLY })[r.status] = Number(r.c);
  }
  return out;
}

const DISBURSEMENT_SELECT = `
  SELECT d.*, u.email AS user_email, t.title AS task_title,
         EXISTS (
           SELECT 1 FROM payout_relay_jobs j
           WHERE j.request_id = d.withdrawal_request_id
             AND j.status NOT IN ('failed','forward_confirmed')
         ) AS relay_in_flight
  FROM payout_disbursements d
  LEFT JOIN users u ON u.id = d.user_id
  LEFT JOIN task_proofs p ON p.id = d.proof_id
  LEFT JOIN tasks t ON t.id = p.task_id
`;

function mapDisbursement(r: Record<string, unknown>): DisbursementRow {
  return {
    id: String(r.id),
    batchId: String(r.batch_id),
    userId: String(r.user_id),
    userEmail: (r.user_email as string) ?? null,
    proofId: (r.proof_id as string) ?? null,
    taskTitle: (r.task_title as string) ?? null,
    amountPoints: Number(r.amount_points ?? 0),
    usdtMicro: Number(r.usdt_micro ?? 0),
    roziMicro: Number(r.rozi_micro ?? 0),
    sourceKind: (r.source_kind as "points" | "earned_usdt") ?? "earned_usdt",
    destChain: (r.dest_chain as string) ?? null,
    destAddress: (r.dest_address as string) ?? null,
    status: r.status as DisbursementStatus,
    txHash: (r.tx_hash as string) ?? null,
    error: (r.error as string) ?? null,
    withdrawalRequestId: (r.withdrawal_request_id as string) ?? null,
    createdAt: String(r.created_at),
    settledAt: (r.settled_at as string) ?? null,
    relayInFlight: Boolean(r.relay_in_flight),
  };
}

export async function getDisbursements(batchId: string): Promise<DisbursementRow[]> {
  const rows = await sql.all<Record<string, unknown>>(
    `${DISBURSEMENT_SELECT} WHERE d.batch_id = ? ORDER BY d.created_at ASC`,
    batchId,
  );
  return rows.map(mapDisbursement);
}

// A targeted single-row lookup (founder, 2026-09-05: sending ONE recipient
// should not have to pull and re-derive every row in the batch — including
// the payout_relay_jobs EXISTS check above — just to find the one being sent).
export async function getDisbursementRow(batchId: string, rowId: string): Promise<DisbursementRow | null> {
  const r = await sql.get<Record<string, unknown>>(
    `${DISBURSEMENT_SELECT} WHERE d.batch_id = ? AND d.id = ?`,
    batchId, rowId,
  );
  return r ? mapDisbursement(r) : null;
}
