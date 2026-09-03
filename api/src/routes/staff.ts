import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  sql, now, newId, balanceOf, roziBalanceMicroOf, usdtBalanceMicroOf,
  postLedger, postEarnedUsdt, postUsdt, logAudit, getSetting, setSetting,
} from "../db.ts";
import { config } from "../config.ts";
import { requirePermission, requireStaff, canApproveAmount, hasPermission, type Role, type Permission } from "../roles.ts";
import { ROLES, ROLE_LABELS, ROLE_PERMISSIONS, isRole, permissionsOf } from "../permissions.ts";
import { getPayoutProvider, pointsToUsdt } from "../payout.ts";
import { relayAvailable, createRelayJob, hasEnoughGasForDisplay } from "../payoutRelay.ts";
import { validateAddress, type ChainId } from "../chains.ts";
import { sendPushToUser } from "../push.ts";
import { kycFeatureEnabled, parseDataUrl } from "../kyc.ts";
import { getAutoWithdrawMaxPoints, getAutoRefundMaxMicro } from "../autoSettleSettings.ts";
import { ticketAutoCloseHoursNow } from "../settingsRuntime.ts";
import { FLAGS, FLAG_IDS, isFlagId, allFlags, setFlag, enabled as flagEnabled } from "../flags.ts";
import { loadAnalytics } from "../analytics.ts";
import { fetchTelegramChatIdentity } from "../telegram.ts";
import { fetchTreasuryLedger, bscscanReady } from "../bscscan.ts";

// Gate a route on ONE named permission (see permissions.ts). The old form took
// a list of roles; a permission is the same gate stated as what it protects
// rather than who happens to hold it today, so adding a role never edits a route.
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

const READY = ["agent_approved", "manager_approved"];
// The statuses where the treasury still owes the money. `paid` has already left
// and `rejected` never will, so a "to send" total over either is a wrong
// instruction to whoever funds the wallet. See pendingTotal below.
const OWED_STATUSES = ["pending", ...READY];
const decisionSchema = z.object({
  action: z.enum(["approve", "reject", "pay"]),
  note: z.string().max(500).optional(),
  // Manual payout: the on-chain hash of the USDT the staff member sent by hand.
  // Required to mark paid in manual mode; ignored when auto-send is on.
  txHash: z.string().max(120).optional(),
});

export async function staffRoutes(app: FastifyInstance) {
  // Withdrawal queue. Agents only see requests within their approval limit.
  //
  // ⚠️ SERVER-SIDE SEARCH / SORT / PAGINATION (admin rebuild, Phase C). Same
  // idiom as GET /staff/users: `sort`/`dir` map through a fixed whitelist to a
  // column literal (never interpolated), and one WHERE clause drives the row
  // page, the COUNT, and the pendingTotal aggregate so all three agree. The
  // agent approval cap is pushed INTO that WHERE, not a JS filter after the
  // fetch — otherwise `total` and the page size would be wrong for a capped
  // approver. Existing fields (`treasury`, `pendingTotal`, `requests`) are
  // unchanged; `total`/`offset`/`limit` are additive.
  app.get("/staff/withdrawals", staffGuard("withdrawals.view", async ({ role }, req) => {
    const query = req.query as Record<string, string | undefined>;
    const status = query.status ?? "pending";
    const q = (query.q ?? "").trim().toLowerCase();
    const limit = Math.min(Number(query.limit ?? 25) || 25, 200);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);

    // status=all drops the filter (founder, 2026-09-01: an "All" tab on every
    // money queue). pendingTotal below is only computed for OWED_STATUSES, so
    // "all" gets a null total — a "to send" figure over a mixed set is a wrong
    // instruction to whoever funds the wallet.
    const where: string[] = [];
    const wp: unknown[] = [];
    if (status !== "all") { where.push("w.status = ?"); wp.push(status); }
    if (q) {
      where.push("(LOWER(u.email) LIKE ? OR LOWER(w.id) = ? OR LOWER(w.user_id) = ? OR LOWER(w.payout_address) LIKE ? OR LOWER(w.tx_hash) LIKE ?)");
      wp.push(`%${q}%`, q, q, `%${q}%`, `%${q}%`);
    }
    // The capped-approver cap, as a bound WHERE condition. See the note above
    // on why this cannot be a post-fetch filter.
    if (!hasPermission(role, "withdrawals.decide_any")) {
      where.push("w.amount <= ?");
      wp.push(config.agentApprovalMaxPoints);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const SORTS: Record<string, string> = {
      created_at: "w.created_at", amount: "w.amount", status: "w.status",
    };
    const sortCol = SORTS[query.sort ?? ""] ?? "w.created_at";
    const dir = query.dir === "asc" ? "ASC" : "DESC";

    // LEFT JOIN payout_relay_jobs so a 'sending' row (the relay pass-through
    // routing THROUGH the user's own address — see payoutRelay.ts) shows its
    // in-flight phase and tx hashes instead of looking stuck to staff.
    const [rows, totalRow, owed, treasuryB, treasuryBa, treasuryAp] = await Promise.all([
      sql.all<Record<string, unknown>>(
        `SELECT w.*, u.email AS user_email,
                u.username AS user_username, u.display_name AS user_display_name,
                u.telegram_username AS user_telegram_username, u.telegram_name AS user_telegram_name,
                j.status AS relay_status, j.from_address AS relay_from_address,
                j.gas_tx_hash AS relay_gas_tx_hash, j.prefund_tx_hash AS relay_prefund_tx_hash,
                j.forward_tx_hash AS relay_forward_tx_hash, j.last_error AS relay_last_error
         FROM withdrawal_requests w
         JOIN users u ON u.id = w.user_id
         LEFT JOIN payout_relay_jobs j ON j.purpose = 'withdrawal' AND j.request_id = w.id
         ${whereSql}
         ORDER BY ${sortCol} ${dir}
         LIMIT ? OFFSET ?`,
        ...wp, limit, offset,
      ),
      sql.get<{ n: string | number }>(
        `SELECT COUNT(*) AS n FROM withdrawal_requests w JOIN users u ON u.id = w.user_id ${whereSql}`, ...wp,
      ),
      // pendingTotal is over the WHOLE filtered set, not the current page.
      OWED_STATUSES.includes(status)
        ? sql.get<{ c: string | number; pts: string | number; net: string | number }>(
            `SELECT COUNT(*) AS c, COALESCE(SUM(w.amount), 0) AS pts,
                    COALESCE(SUM(w.amount - COALESCE(w.fee_points, 0)), 0) AS net
             FROM withdrawal_requests w JOIN users u ON u.id = w.user_id ${whereSql}`, ...wp,
          )
        : Promise.resolve(null),
      getSetting("treasury_address_bep20", ""),
      getSetting("treasury_address_base", ""),
      getSetting("treasury_address_aptos", ""),
    ]);

    return {
      // The hot wallet each chain's payouts are sent FROM (admin sets it in
      // Settings). Shown beside the queue so whoever is paying sends from the
      // right wallet. Public information once a payout has ever been made.
      treasury: { bep20: treasuryB, base: treasuryBa, aptos: treasuryAp },
      total: Number(totalRow?.n ?? rows.length),
      offset,
      limit,
      // What this queue will cost the treasury if every row is paid. Whoever
      // funds the wallet is otherwise adding up a column by hand, and NET is
      // the figure that matters — see netUsdt on each row below.
      //
      // ⚠️ ONLY FOR STATUSES THAT ARE STILL OWED. This endpoint takes a status
      // filter and the panel renders the figure as "to send" — so on the `paid`
      // tab it read as an instruction to fund money that has already left, and
      // on `rejected` as an instruction to send money nobody is owed. A total
      // is only a funding number while the rows are unpaid; served as null
      // otherwise so there is nothing for the panel to mislabel.
      pendingTotal: owed ? {
        count: Number(owed.c),
        points: Number(owed.pts),
        usdt: pointsToUsdt(Number(owed.net)),
      } : null,
      requests: rows.map((r) => ({
        id: r.id, userId: r.user_id, userEmail: r.user_email,
        userUsername: r.user_username ?? null, userDisplayName: r.user_display_name ?? null,
        userTelegramUsername: r.user_telegram_username ?? null, userTelegramName: r.user_telegram_name ?? null,
        amount: r.amount,
        // ⚠️ THE FEE, AND WHAT IS ACTUALLY SENT. Both are snapshotted on the
        // row at request time, and manual payout is a human reading this screen
        // and sending USDT by hand. Showing only the gross `amount` — which is
        // all this endpoint returned before — means that human sends the gross
        // and the platform pays the fee it just charged, on every withdrawal.
        // The refund queue already states its net for exactly this reason.
        feePoints: Number(r.fee_points ?? 0),
        sourceKind: r.source_kind ?? "points",
        earnedUsdtMicro: Number(r.earned_usdt_micro ?? 0),
        netUsdt: r.source_kind === "earned_usdt"
          ? ((Math.max(0, Number(r.earned_usdt_micro) - Math.round(Number(r.fee_points ?? 0) * 1_000_000 / config.pointsPerUsdt))) / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")
          : pointsToUsdt(Number(r.amount) - Number(r.fee_points ?? 0)),
        chain: r.payout_rail, address: r.payout_address ?? null,
        // Did the user PROVE this exact address is theirs, by signing for it
        // with the wallet? Snapshotted at request time (see routes/withdrawals
        // .ts). The single most useful thing on this card: an on-chain payout
        // cannot be undone, and the common way users lose money here is being
        // talked into pasting somebody else's address.
        addressVerified: Boolean(r.address_verified),
        status: r.status, at: r.created_at,
        // The proof that this payout really happened. `withdrawal_requests
        // .tx_hash` has been written by every mark-paid and every auto-settle
        // since payouts existed — it was simply never served, so the queue
        // could not show it and a "paid" row had nothing to check against the
        // chain (founder, 2026-09-03: "make sure you are showing the
        // transaction hash").
        txHash: r.tx_hash ?? null,
        withinAgentLimit: (r.amount as number) <= config.agentApprovalMaxPoints,
        relay: r.relay_status ? {
          phase: r.relay_status, fromAddress: r.relay_from_address,
          gasTxHash: r.relay_gas_tx_hash, prefundTxHash: r.relay_prefund_tx_hash,
          forwardTxHash: r.relay_forward_tx_hash, lastError: r.relay_last_error,
        } : null,
      })),
    };
  }));

  // Approve / reject / mark paid. Enforces the Agent->Manager threshold chain.
  app.post("/staff/withdrawals/:id/decision", staffGuard("withdrawals.decide", async ({ userId, role }, req, reply) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Pick approve, reject, or pay." });
    const { action, note, txHash } = parsed.data;

    const id = (req.params as { id: string }).id;

    const stampSql = (status: string, extra: Record<string, string> = {}) => {
      const cols = ["status = ?", "reviewed_by = ?", "reviewed_at = ?", "review_note = ?"];
      const vals: (string | null)[] = [status, userId, now(), note ?? null];
      for (const [k, v] of Object.entries(extra)) { cols.push(`${k} = ?`); vals.push(v); }
      return { text: `UPDATE withdrawal_requests SET ${cols.join(", ")} WHERE id = ?`, vals: [...vals, id] };
    };

    // The whole decision runs in one transaction that locks the request row
    // (FOR UPDATE). Two staff acting on the same request at once serialize: the
    // second waits, then re-reads the status the first set and bails — so a
    // reject can never refund twice. staffGuard maps a thrown {statusCode} to
    // JSON, so throwing here rolls the transaction back cleanly.
    // Set inside the transaction, sent AFTER it commits: a push cannot be
    // rolled back, so we never announce money the transaction then un-pays.
    // (A box, not a plain `let`: TS narrows a let assigned only inside the
    // closure to `never` at the read below.)
    const notify: { job: { userId: string; note: Parameters<typeof sendPushToUser>[1] } | null } = { job: null };

    const outcome = await sql.tx(async (t) => {
      const w = await t.get<{ id: string; user_id: string; amount: number; status: string; payout_rail: string; payout_address: string; fee_points: number; source_kind: "points" | "earned_usdt"; earned_usdt_micro: string | number }>(
        "SELECT * FROM withdrawal_requests WHERE id = ? FOR UPDATE", id,
      );
      if (!w) throw { statusCode: 404, message: "Request not found." };
      // ⚠️ 'sending' MUST be blocked here too, not just 'paid'/'rejected' —
      // a relay job (payoutRelay.ts) is actively signing/broadcasting for
      // this request. Letting 'reject' through would credit the points back
      // while the on-chain send still completes (a real double payment);
      // letting 'approve' through would overwrite the status away from
      // 'sending', so completeRequest()'s `WHERE status = 'sending'` would
      // never match once the relay finishes, leaving money sent but the
      // request stuck showing 'agent_approved' forever — payable again later.
      if (w.status === "paid" || w.status === "rejected" || w.status === "sending") {
        throw {
          statusCode: 409,
          message: w.status === "sending"
            ? "This request is already being sent — wait for it to finish."
            : `This request is already ${w.status}.`,
        };
      }

      if (action === "approve") {
        if (!canApproveAmount(role, w.amount)) {
          throw { statusCode: 403, message: "This is above your limit. A Manager must approve it." };
        }
        // The two-step chain: a capped approver's yes is only the FIRST yes.
        // Same reasoning as the queue filter above — it is the missing
        // `decide_any` that makes an approval provisional, not the job title.
        const status = hasPermission(role, "withdrawals.decide_any")
          ? "manager_approved" : "agent_approved";
        const s = stampSql(status);
        await t.run(s.text, ...s.vals);
        return { ok: true, status };
      }

      if (action === "reject") {
        // Return the held points to the user (compensating credit — the ledger
        // stays append-only; we never delete the original debit).
        if (w.source_kind === "earned_usdt") {
          await postEarnedUsdt({ userId: w.user_id, micro: Number(w.earned_usdt_micro), direction: "credit",
            sourceType: "withdrawal_return", sourceRefId: id, note: "Withdrawal not approved — task USDT returned" }, t);
        } else await postLedger({
          userId: w.user_id, points: w.amount, direction: "credit",
          sourceType: "admin_adjustment", sourceRefId: id,
          note: "Withdrawal not approved — points returned",
        }, t);
        const s = stampSql("rejected");
        await t.run(s.text, ...s.vals);
        notify.job = {
          userId: w.user_id,
          note: {
            title: "About your withdrawal",
            body: w.source_kind === "earned_usdt"
              ? "We could not send this one. Your task USDT is back in your wallet."
              : "We could not send this one. Your points are back in your wallet.",
            url: "/wallet",
          },
        };
        return { ok: true, status: "rejected", refunded: w.amount };
      }

      // action === "pay"
      if (!READY.includes(w.status)) {
        throw { statusCode: 409, message: "Approve this request before marking it paid." };
      }
      if (!canApproveAmount(role, w.amount)) {
        throw { statusCode: 403, message: "This is above your limit. A Manager must pay it." };
      }
      // The USDT amount is on the NET (amount minus the fee snapshotted at
      // request time), derived from one conversion rule.
      const net = Math.max(0, w.amount - (w.fee_points ?? 0));
      const earnedFeeMicro = Math.round((w.fee_points ?? 0) * 1_000_000 / config.pointsPerUsdt);
      const netEarnedMicro = Math.max(0, Number(w.earned_usdt_micro ?? 0) - earnedFeeMicro);
      const usdt = w.source_kind === "earned_usdt"
        ? (netEarnedMicro / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")
        : pointsToUsdt(net);

      // Only in onchain mode — payoutMode is the founder's manual/automatic
      // switch, and relayAvailable() alone does NOT respect it (it only
      // checks whether the signing key material exists). Gating here is what
      // keeps a staff "pay" click from silently broadcasting a real relay
      // send while the founder has deliberately left payoutMode on "manual".
      if (config.payoutMode === "onchain" && relayAvailable(w.payout_rail)) {
        // "Approve & Send" -> the backend does the rest automatically, THROUGH
        // the user's own derived address (payoutRelay.ts), not a manual wallet
        // operation and not a pasted hash.
        await createRelayJob("withdrawal", w.id, {
          chain: "bep20", userId: w.user_id, toAddress: w.payout_address,
          amountMicro: w.source_kind === "earned_usdt" ? netEarnedMicro : Math.round(Number(usdt) * 1_000_000), needsPrefund: true,
        }, t);
        const s = stampSql("sending");
        await t.run(s.text, ...s.vals);
        return { ok: true, status: "sending" };
      }

      // Settle the payout directly: manual mode records the hash the staff
      // member sent by hand; onchain mode without a relay path available
      // signs and broadcasts from treasury here, same as before this feature.
      const provider = getPayoutProvider();
      const result = await provider.send({
        requestId: w.id,
        chain: w.payout_rail as ChainId,
        address: w.payout_address,
        points: net,
        usdt,
        providedTxHash: txHash,
      });
      const s = stampSql("paid", { paid_at: now(), tx_hash: result.txHash, usdt_amount: usdt });
      await t.run(s.text, ...s.vals);
      notify.job = {
        userId: w.user_id,
        note: {
          title: "Your money is sent",
          body: `We sent ${usdt} USDT to your wallet. Check it now.`,
          url: "/wallet",
        },
      };
      return { ok: true, status: "paid", txHash: result.txHash, usdt };
    });

    // Committed — now it is safe (and fire-and-forget) to tell the user.
    if (notify.job) void sendPushToUser(notify.job.userId, notify.job.note);
    return outcome;
  }));

  // ---- BNB withdrawal queue (admin rebuild, Phase C) ---------------------
  //
  // A user pulling their OWN on-chain gas balance out of their derived custody
  // address (routes/withdrawals.ts). It has never had a staff screen — the
  // dashboard only ever counted the `failed` rows. Read-only on purpose: a
  // failed native send is terminal and needs a human to check the chain, not a
  // retry button that could double-spend a live balance (db.ts's note on this
  // table). Same server-side search/sort/paginate shape as the withdrawal
  // queue above.
  const BNB_STATUSES = ["pending", "sending", "paid", "failed"];
  app.get("/staff/bnb-withdrawals", staffGuard("withdrawals.view", async (_ctx, req) => {
    const query = req.query as Record<string, string | undefined>;
    const q = (query.q ?? "").trim().toLowerCase();
    const limit = Math.min(Number(query.limit ?? 25) || 25, 200);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);

    // No status = the "needs attention" view: failed jobs only. An explicit
    // unknown value (e.g. "all") drops the filter and shows every status.
    const status = query.status ?? "failed";
    const where: string[] = [];
    const wp: unknown[] = [];
    if (BNB_STATUSES.includes(status)) { where.push("b.status = ?"); wp.push(status); }
    if (q) {
      where.push("(LOWER(u.email) LIKE ? OR LOWER(b.id) = ? OR LOWER(b.user_id) = ? OR LOWER(b.address) LIKE ? OR LOWER(b.tx_hash) LIKE ?)");
      wp.push(`%${q}%`, q, q, `%${q}%`, `%${q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sortCol = query.sort === "status" ? "b.status" : "b.created_at";
    const dir = query.dir === "asc" ? "ASC" : "DESC";

    const [rows, totalRow] = await Promise.all([
      sql.all<Record<string, unknown>>(
        `SELECT b.*, u.email AS user_email,
                u.username AS user_username, u.display_name AS user_display_name,
                u.telegram_username AS user_telegram_username, u.telegram_name AS user_telegram_name
         FROM bnb_withdrawal_requests b
         JOIN users u ON u.id = b.user_id
         ${whereSql} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`,
        ...wp, limit, offset,
      ),
      sql.get<{ n: string | number }>(
        `SELECT COUNT(*) AS n FROM bnb_withdrawal_requests b JOIN users u ON u.id = b.user_id ${whereSql}`, ...wp,
      ),
    ]);
    return {
      total: Number(totalRow?.n ?? rows.length), offset, limit,
      rows: rows.map((r) => ({
        id: r.id, userId: r.user_id, userEmail: r.user_email,
        userUsername: r.user_username ?? null, userDisplayName: r.user_display_name ?? null,
        userTelegramUsername: r.user_telegram_username ?? null, userTelegramName: r.user_telegram_name ?? null,
        chain: r.chain, address: r.address, amountWei: String(r.amount_wei),
        status: r.status, txHash: r.tx_hash ?? null, attempts: Number(r.attempts ?? 0),
        lastError: r.last_error ?? null, at: r.created_at, completedAt: r.completed_at ?? null,
        handledAt: r.handled_at ?? null, handledBy: r.handled_by ?? null, handledNote: r.handled_note ?? null,
        // A native BNB send never debits an internal balance, so there is
        // nothing to credit back. It can be re-queued while nothing has been
        // broadcast (tx_hash still null).
        owedBack: false,
        retryable: r.status === "failed" && !r.tx_hash,
      })),
    };
  }));

  // Mark a FAILED BNB withdrawal as handled — a staff acknowledgement, not a
  // money move. A failed native send is terminal (db.ts): the money was never
  // taken from an internal balance, so there is nothing to return; this just
  // records that a human checked it and takes the row out of the dashboard's
  // red "needs attention" count.
  app.post("/staff/bnb-withdrawals/:id/handled", staffGuard("withdrawals.decide", async ({ userId, role }, req, reply) => {
    const id = (req.params as { id: string }).id;
    const note = z.object({ note: z.string().trim().max(500).optional() }).safeParse(req.body).data?.note ?? null;
    const row = await sql.get<{ status: string; handled_at: string | null }>(
      "SELECT status, handled_at FROM bnb_withdrawal_requests WHERE id = ?", id);
    if (!row) return reply.code(404).send({ error: "Request not found." });
    if (row.status !== "failed") return reply.code(400).send({ error: "Only a failed request can be marked handled." });
    if (row.handled_at) return reply.code(400).send({ error: "Already marked handled." });
    await sql.run(
      "UPDATE bnb_withdrawal_requests SET handled_at = ?, handled_by = ?, handled_note = ? WHERE id = ?",
      now(), userId, note, id,
    );
    await logAudit({
      actorUserId: userId, actorRole: role, action: "bnb_withdrawal_handled",
      detail: `request ${id}${note ? ` — ${note}` : ""}`, actorIp: req.ip,
    });
    return { ok: true };
  }));

  // Resolve a FAILED BNB withdrawal from the queue (founder, 2026-09-01).
  // Only two actions — there is no internal debit to credit back:
  //   • acknowledge — a human checked the chain, take it off the red count.
  //   • retry       — re-queue (status→pending, attempts→0) so the background
  //                   tick re-attempts the native send. Only while nothing has
  //                   been broadcast (tx_hash null), and only if the user has
  //                   no other BNB request in flight (the partial unique index).
  const bnbResolveSchema = z.object({
    action: z.enum(["acknowledge", "retry"]),
    note: z.string().trim().min(1, "Say what you did.").max(500),
  });
  app.post("/staff/bnb-withdrawals/:id/resolve", staffGuard("withdrawals.decide", async ({ userId, role }, req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = bnbResolveSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Pick an action and add a note." });
    const { action, note } = parsed.data;

    const row = await sql.get<{ status: string; handled_at: string | null; tx_hash: string | null; user_id: string }>(
      "SELECT status, handled_at, tx_hash, user_id FROM bnb_withdrawal_requests WHERE id = ?", id);
    if (!row) return reply.code(404).send({ error: "Request not found." });
    if (row.status !== "failed") return reply.code(400).send({ error: "Only a failed request can be resolved here." });

    if (action === "acknowledge") {
      if (row.handled_at) return reply.code(400).send({ error: "Already marked handled." });
      await sql.run(
        "UPDATE bnb_withdrawal_requests SET handled_at = ?, handled_by = ?, handled_note = ? WHERE id = ?",
        now(), userId, note, id,
      );
      await logAudit({
        actorUserId: userId, actorRole: role, action: "bnb_withdrawal_handled",
        detail: `request ${id} — ${note}`, actorIp: req.ip,
      });
      return { ok: true, status: "failed", handledAt: now() };
    }

    // action === "retry"
    if (row.tx_hash) return reply.code(409).send({ error: "A transaction was already broadcast for this — check the chain, then Acknowledge." });
    const other = await sql.get<{ id: string }>(
      "SELECT id FROM bnb_withdrawal_requests WHERE user_id = ? AND status IN ('pending','sending') AND id <> ?",
      row.user_id, id,
    );
    if (other) return reply.code(409).send({ error: "This user already has another BNB withdrawal in flight — resolve that first." });
    await sql.run(
      `UPDATE bnb_withdrawal_requests
         SET status = 'pending', attempts = 0, last_error = NULL,
             handled_at = NULL, handled_by = NULL, handled_note = NULL
       WHERE id = ? AND status = 'failed'`,
      id,
    );
    await logAudit({
      actorUserId: userId, actorRole: role, action: "bnb_withdrawal_retry",
      detail: `request ${id} re-queued — ${note}`, actorIp: req.ip,
    });
    return { ok: true, status: "pending", handledAt: null };
  }));

  // ---- Payout relay job queue (admin rebuild, Phase C) ------------------
  //
  // The per-user signing jobs behind an on-chain withdrawal or refund
  // (payoutRelay.ts). Also never had a staff screen — the dashboard only
  // counted `failed`. Read-only: a failed relay job is terminal (db.ts) and
  // the compensating action (return the held money / re-check the chain) is
  // decided per case, not by a button here.
  const RELAY_STATUSES = [
    "pending", "gas_sent", "gas_confirmed", "prefund_sent", "prefund_confirmed",
    "forward_sent", "forward_confirmed", "failed",
  ];
  app.get("/staff/relay-jobs", staffGuard("withdrawals.view", async (_ctx, req) => {
    const query = req.query as Record<string, string | undefined>;
    const q = (query.q ?? "").trim().toLowerCase();
    const limit = Math.min(Number(query.limit ?? 25) || 25, 200);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);

    // No status = failed jobs only (the "needs attention" view). "active" = the
    // in-flight jobs; an unknown value drops the filter.
    const status = query.status ?? "failed";
    const where: string[] = [];
    const wp: unknown[] = [];
    if (RELAY_STATUSES.includes(status)) { where.push("j.status = ?"); wp.push(status); }
    else if (status === "active") where.push("j.status NOT IN ('forward_confirmed', 'failed')");
    if (query.purpose === "withdrawal" || query.purpose === "refund") { where.push("j.purpose = ?"); wp.push(query.purpose); }
    if (q) {
      where.push("(LOWER(u.email) LIKE ? OR LOWER(j.id) = ? OR LOWER(j.request_id) = ? OR LOWER(j.to_address) LIKE ?)");
      wp.push(`%${q}%`, q, q, `%${q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sortCol = query.sort === "status" ? "j.status" : "j.created_at";
    const dir = query.dir === "asc" ? "ASC" : "DESC";

    const [rows, totalRow] = await Promise.all([
      sql.all<Record<string, unknown>>(
        `SELECT j.*, u.email AS user_email,
                u.username AS user_username, u.display_name AS user_display_name,
                u.telegram_username AS user_telegram_username, u.telegram_name AS user_telegram_name,
                COALESCE(wr.status, rr.status) AS req_status
         FROM payout_relay_jobs j
         JOIN users u ON u.id = j.user_id
         LEFT JOIN withdrawal_requests wr ON j.purpose = 'withdrawal' AND wr.id = j.request_id
         LEFT JOIN usdt_refund_requests rr ON j.purpose = 'refund' AND rr.id = j.request_id
         ${whereSql} ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`,
        ...wp, limit, offset,
      ),
      sql.get<{ n: string | number }>(
        `SELECT COUNT(*) AS n FROM payout_relay_jobs j JOIN users u ON u.id = j.user_id ${whereSql}`, ...wp,
      ),
    ]);
    return {
      total: Number(totalRow?.n ?? rows.length), offset, limit,
      rows: rows.map((r) => {
        // The money is still owed only while the underlying request sits at
        // 'sending' — failJob's SAFE path already flips it to 'rejected' and
        // credits back. "Safe" here mirrors payoutRelay.ts failJob: for a
        // withdrawal, nothing has left treasury while prefund_tx_hash is null;
        // for a refund, while forward_tx_hash is null.
        const reqStatus = (r.req_status as string | null) ?? null;
        const safe = r.purpose === "withdrawal" ? !r.prefund_tx_hash : !r.forward_tx_hash;
        const owedBack = r.status === "failed" && reqStatus === "sending" && Boolean(safe);
        return {
          id: r.id, purpose: r.purpose, requestId: r.request_id,
          userId: r.user_id, userEmail: r.user_email,
          userUsername: r.user_username ?? null, userDisplayName: r.user_display_name ?? null,
          userTelegramUsername: r.user_telegram_username ?? null, userTelegramName: r.user_telegram_name ?? null,
          chain: r.chain, fromAddress: r.from_address, toAddress: r.to_address,
          amountMicro: Number(r.amount_micro), needsPrefund: Boolean(r.needs_prefund),
          status: r.status, gasTxHash: r.gas_tx_hash ?? null, prefundTxHash: r.prefund_tx_hash ?? null,
          forwardTxHash: r.forward_tx_hash ?? null, attempts: Number(r.attempts ?? 0),
          lastError: r.last_error ?? null, at: r.created_at, completedAt: r.completed_at ?? null,
          handledAt: r.handled_at ?? null, handledBy: r.handled_by ?? null, handledNote: r.handled_note ?? null,
          reqStatus,
          // Both actions are offered under exactly the same condition: a failed
          // job whose money is still owed and safe to touch.
          owedBack, retryable: owedBack,
        };
      }),
    };
  }));

  // Mark a FAILED relay job as handled — a staff acknowledgement, not a retry
  // and not a money move. A failed job is terminal (db.ts): a refund that gave
  // up before any value moved has already been auto-credited back by the
  // background tick, and a withdrawal whose prefund leg confirmed is settled on
  // the chain. This records that a human checked which case it was and takes
  // the row out of the dashboard's red "needs attention" count. It never signs
  // or broadcasts anything.
  app.post("/staff/relay-jobs/:id/handled", staffGuard("withdrawals.decide", async ({ userId, role }, req, reply) => {
    const id = (req.params as { id: string }).id;
    const note = z.object({ note: z.string().trim().max(500).optional() }).safeParse(req.body).data?.note ?? null;
    const row = await sql.get<{ status: string; handled_at: string | null }>(
      "SELECT status, handled_at FROM payout_relay_jobs WHERE id = ?", id);
    if (!row) return reply.code(404).send({ error: "Relay job not found." });
    if (row.status !== "failed") return reply.code(400).send({ error: "Only a failed job can be marked handled." });
    if (row.handled_at) return reply.code(400).send({ error: "Already marked handled." });
    await sql.run(
      "UPDATE payout_relay_jobs SET handled_at = ?, handled_by = ?, handled_note = ? WHERE id = ?",
      now(), userId, note, id,
    );
    await logAudit({
      actorUserId: userId, actorRole: role, action: "relay_job_handled",
      detail: `job ${id}${note ? ` — ${note}` : ""}`, actorIp: req.ip,
    });
    return { ok: true };
  }));

  // Resolve a FAILED relay job from the queue (founder, 2026-09-01: "if
  // something is flagged, there must be a button that actually clears it").
  // Three actions, each a real outcome — not a second "mark handled":
  //   • acknowledge  — same as /handled: a human checked it, take it off the
  //                     dashboard's red count. No money moves.
  //   • credit_back  — the money is still owed (request at 'sending') and safe
  //                     to return: reject the request and post the compensating
  //                     credit, exactly as payoutRelay.ts failJob would have on
  //                     its SAFE path. Advisory-locked on the user (guardrail #8).
  //   • retry        — re-queue the job (status→pending, attempts→0) so the
  //                     background tick picks it up again. Only when nothing has
  //                     left treasury yet.
  const relayResolveSchema = z.object({
    action: z.enum(["acknowledge", "credit_back", "retry"]),
    note: z.string().trim().min(1, "Say what you did.").max(500),
  });
  app.post("/staff/relay-jobs/:id/resolve", staffGuard("withdrawals.decide", async ({ userId, role }, req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = relayResolveSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Pick an action and add a note." });
    const { action, note } = parsed.data;

    const job = await sql.get<{
      id: string; purpose: "withdrawal" | "refund"; request_id: string; user_id: string;
      amount_micro: string | number; status: string; handled_at: string | null;
      prefund_tx_hash: string | null; forward_tx_hash: string | null;
    }>("SELECT * FROM payout_relay_jobs WHERE id = ?", id);
    if (!job) return reply.code(404).send({ error: "Relay job not found." });
    if (job.status !== "failed") return reply.code(400).send({ error: "Only a failed job can be resolved here." });

    const safe = job.purpose === "withdrawal" ? !job.prefund_tx_hash : !job.forward_tx_hash;

    if (action === "acknowledge") {
      if (job.handled_at) return reply.code(400).send({ error: "Already marked handled." });
      await sql.run(
        "UPDATE payout_relay_jobs SET handled_at = ?, handled_by = ?, handled_note = ? WHERE id = ?",
        now(), userId, note, id,
      );
      await logAudit({
        actorUserId: userId, actorRole: role, action: "relay_job_handled",
        detail: `job ${id} — ${note}`, actorIp: req.ip,
      });
      return { ok: true, status: "failed", handledAt: now() };
    }

    if (action === "retry") {
      if (!safe) return reply.code(409).send({ error: "This job has already moved value on-chain — check the chain, then use Acknowledge." });
      // The underlying request must still be waiting to be sent.
      const req0 = job.purpose === "withdrawal"
        ? await sql.get<{ status: string }>("SELECT status FROM withdrawal_requests WHERE id = ?", job.request_id)
        : await sql.get<{ status: string }>("SELECT status FROM usdt_refund_requests WHERE id = ?", job.request_id);
      if (req0?.status !== "sending") {
        return reply.code(409).send({ error: `The ${job.purpose} is '${req0?.status ?? "gone"}', not 'sending' — nothing to retry.` });
      }
      await sql.run(
        `UPDATE payout_relay_jobs
           SET status = 'pending', attempts = 0, last_error = NULL,
               handled_at = NULL, handled_by = NULL, handled_note = NULL
         WHERE id = ? AND status = 'failed'`,
        id,
      );
      await logAudit({
        actorUserId: userId, actorRole: role, action: "relay_job_retry",
        detail: `job ${id} (${job.purpose} ${job.request_id}) re-queued — ${note}`, actorIp: req.ip,
      });
      return { ok: true, status: "pending", handledAt: null };
    }

    // action === "credit_back"
    if (!safe) return reply.code(409).send({ error: "This job has already moved value on-chain — crediting back would double-pay. Check the chain, then Acknowledge." });
    const outcome = await sql.tx(async (t) => {
      await t.run("SELECT pg_advisory_xact_lock(hashtext(?))", job.user_id);
      if (job.purpose === "withdrawal") {
        const w = await t.get<{ user_id: string; amount: number }>(
          `UPDATE withdrawal_requests SET status = 'rejected', review_note = ?, reviewed_by = 'system:manual', reviewed_at = ?
           WHERE id = ? AND status = 'sending' RETURNING user_id, amount`,
          `Relay job failed — resolved by staff: ${note}`, now(), job.request_id,
        );
        if (!w) return { changed: false as const };
        await postLedger({
          userId: w.user_id, points: w.amount, direction: "credit",
          sourceType: "admin_adjustment", sourceRefId: job.request_id,
          note: "Withdrawal could not be sent — points returned",
        }, t);
      } else {
        const r = await t.get<{ user_id: string; amount: string | number; chain: string }>(
          `UPDATE usdt_refund_requests SET status = 'rejected', reject_reason = ?, reviewed_by = 'system:manual', reviewed_at = ?
           WHERE id = ? AND status = 'sending' RETURNING user_id, amount, chain`,
          `Relay job failed — resolved by staff: ${note}`, now(), job.request_id,
        );
        if (!r) return { changed: false as const };
        await postUsdt({
          userId: r.user_id, micro: Number(r.amount), direction: "credit",
          sourceType: "refund", sourceRefId: job.request_id,
          note: "Refund could not be sent — money returned to your balance", chain: r.chain,
        }, t);
      }
      await t.run(
        "UPDATE payout_relay_jobs SET handled_at = ?, handled_by = ?, handled_note = ? WHERE id = ?",
        now(), userId, `credited back: ${note}`, id,
      );
      await logAudit({
        actorUserId: userId, actorRole: role, action: "relay_job_credit_back",
        targetUserId: job.user_id,
        detail: `job ${id} (${job.purpose} ${job.request_id}) — ${note}`, actorIp: req.ip,
      }, t);
      return { changed: true as const };
    });
    if (!outcome.changed) {
      return reply.code(409).send({ error: "The request is no longer at 'sending' — it was already resolved. Use Acknowledge." });
    }
    return { ok: true, status: "failed", handledAt: now() };
  }));

  // One-screen dispute view: user's balance, ledger, and fraud flags.
  app.get("/staff/users/:id", staffGuard("users.view", async (_ctx, req, reply) => {
    const id = (req.params as { id: string }).id;
    const user = await sql.get<Record<string, unknown>>(
      `SELECT id, email, username, display_name, country, referral_code, status, created_at,
              kyc_status, telegram_id, telegram_username, telegram_name,
              withdrawal_hold_reason, withdrawal_hold_until, withdrawal_hold_at,
              under_review_reason, under_review_at,
              (SELECT email FROM users r WHERE r.id = users.under_review_by) AS under_review_by_email
         FROM users WHERE id = ?`, id,
    );
    if (!user) return reply.code(404).send({ error: "User not found." });

    const ledger = await sql.all("SELECT amount, source_type, note, created_at FROM ledger_entries WHERE user_id = ? ORDER BY created_at DESC LIMIT 100", id);
    const flags = await sql.all("SELECT flag_type, severity, detail, created_at, resolution_note FROM fraud_flags WHERE user_id = ? ORDER BY created_at DESC", id);
    // The points ledger above already shows a withdrawal's DEBIT (it's a
    // `ledger_entries` row like any other), but nothing about a deposit
    // refund or top-up — those live on the separate usdt_ledger and never
    // touch `ledger_entries` at all. Staff looking up a user for a dispute
    // need both money trails in one place, not two separate screens.
    const usdtRefunds = await sql.all(
      "SELECT amount, fee_micro, chain, address, status, tx_hash, reject_reason, created_at FROM usdt_refund_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
      id,
    );
    const usdtTopups = await sql.all(
      "SELECT amount, chain, tx_hash, status, reject_reason, created_at FROM usdt_topups WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
      id,
    );

    // Brief part 34 — one screen that answers "who is this and what have they
    // done", instead of a balance and a ledger and four other tabs. Every
    // number below is DERIVED from a table that already exists (analytics.ts's
    // rule): nothing here is a new counter that could drift from the ledger.
    //
    // ⚠️ ALL THREE BALANCES, ALWAYS. A user in a dispute holds points, ROZI and
    // possibly USDT deposit credit, and showing one of the three is how a
    // support agent tells someone their money is gone while it is sitting on a
    // ledger the screen did not read. They are separate ledgers by guardrail
    // #7 — shown side by side, never summed.
    const [balancePoints, roziMicro, usdtMicro] = await Promise.all([
      balanceOf(id), roziBalanceMicroOf(id), usdtBalanceMicroOf(id),
    ]);

    // ⚠️ The column names here are payout_rail / payout_address / review_note,
    // NOT chain / address / note — those are the names this row is SERVED
    // under (see the withdrawal queue above, which aliases the same way).
    // Guessing the served name is how `networks.label` shipped: TypeScript
    // cannot see inside a SQL string, so only a live query catches it.
    const withdrawals = await sql.all(
      `SELECT id, amount, fee_points, payout_rail AS chain, payout_address AS address,
              address_verified, status, tx_hash, review_note AS note, created_at
         FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, id,
    );
    // What they have actually been paid, ever — the question a dispute always
    // comes down to. Counted from `paid` rows only, never from the request total.
    const paid = await sql.get<{ n: string | number; total: string | number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount - COALESCE(fee_points,0)), 0) AS total
         FROM withdrawal_requests WHERE user_id = ? AND status = 'paid'`, id,
    );

    // Who invited them, and who they invited. Both directions, because a
    // referral-ring flag is unreadable without them.
    const invitedBy = await sql.get<{
      id: string; email: string; referral_code: string; username: string | null;
      display_name: string | null; telegram_username: string | null; telegram_name: string | null;
    }>(
      `SELECT u.id, u.email, u.referral_code, u.username, u.display_name, u.telegram_username, u.telegram_name
         FROM users u WHERE u.id = (SELECT referred_by FROM users WHERE id = ?)`, id,
    );
    const invitees = await sql.all(
      `SELECT id, email, status, created_at, username, display_name, telegram_username, telegram_name FROM users
         WHERE referred_by = ? ORDER BY created_at DESC LIMIT 50`, id,
    );
    // ⚠️ COUNTED SEPARATELY, BECAUSE THE LIST IS CAPPED AT 50 AND THE COUNT IS
    // THE FRAUD SIGNAL. "How many people did this account invite" is the whole
    // question a referral-ring flag asks, and reading it off `invitees.length`
    // answers "312 invites" with "50" — the one number a reviewer would have
    // acted on, silently clamped to the page size.
    const inviteeCount = Number(
      (await sql.get<{ n: string | number }>(
        "SELECT COUNT(*) AS n FROM users WHERE referred_by = ?", id,
      ))?.n ?? 0,
    );

    const tickets = await sql.all(
      "SELECT id, subject, status, created_at FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
      id,
    );

    // Devices + IPs this account has signed in from (user_devices, the same
    // table the device-reuse / IP-reuse fraud rules read). A support agent
    // resolving "is this really them" or a fraud review both need this, and
    // today it lived nowhere on this screen.
    const devices = await sql.all(
      "SELECT device_id, ip, first_seen, last_seen FROM user_devices WHERE user_id = ? ORDER BY last_seen DESC LIMIT 20",
      id,
    );

    // ---- Phase B additions: the tabbed User 360 -------------------------
    // The full ROZI + USDT ledgers (points ledger is `ledger` above), an admin
    // audit slice for THIS user, and a merged activity timeline. The timeline
    // is the founder's "only if cheap" ask — built as a JS merge of a handful
    // of small already-indexed queries, no new table and no write path
    // (analytics.ts's rule).
    const [roziLedger, usdtLedger, auditRows, tl] = await Promise.all([
      sql.all("SELECT amount, direction, source_type, note, created_at FROM rozi_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 80", id),
      sql.all("SELECT amount, direction, source_type, note, created_at FROM usdt_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 80", id),
      sql.all<{ action: string; detail: string | null; previous_value: string | null; new_value: string | null; created_at: string; actor_email: string | null }>(
        `SELECT a.action, a.detail, a.previous_value, a.new_value, a.created_at,
                (SELECT email FROM users u WHERE u.id = a.actor_user_id) AS actor_email
           FROM admin_audit_log a WHERE a.target_user_id = ? ORDER BY a.created_at DESC LIMIT 60`, id),
      Promise.all([
        sql.all<{ amount: number; source_type: string; note: string | null; created_at: string }>("SELECT amount, source_type, note, created_at FROM ledger_entries WHERE user_id = ? ORDER BY created_at DESC LIMIT 40", id),
        sql.all<{ amount: number; status: string; created_at: string }>("SELECT amount, status, created_at FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 20", id),
        sql.all<{ amount: number; status: string; created_at: string }>("SELECT amount, status, created_at FROM usdt_topups WHERE user_id = ? ORDER BY created_at DESC LIMIT 20", id),
        sql.all<{ amount: number; status: string; created_at: string }>("SELECT amount, status, created_at FROM usdt_refund_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 20", id),
        sql.all<{ amount: number; direction: string; source_type: string; created_at: string }>("SELECT amount, direction, source_type, created_at FROM rozi_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 30", id),
        sql.all<{ status: string; network: string; created_at: string }>("SELECT status, network, created_at FROM task_completions WHERE user_id = ? ORDER BY created_at DESC LIMIT 30", id),
      ]),
    ]);
    const [lgP, lgW, lgTu, lgRr, lgRz, lgTc] = tl;
    const activity = [
      ...lgP.map((r) => ({ at: r.created_at, kind: "points", detail: `${r.amount >= 0 ? "+" : ""}${r.amount} pts · ${r.source_type}${r.note ? ` · ${r.note}` : ""}` })),
      ...lgW.map((r) => ({ at: r.created_at, kind: "withdrawal", detail: `${r.status} · ${r.amount} pts` })),
      ...lgTu.map((r) => ({ at: r.created_at, kind: "deposit", detail: `${r.status} · ${(r.amount / 1e6).toFixed(2)} USDT` })),
      ...lgRr.map((r) => ({ at: r.created_at, kind: "refund", detail: `${r.status} · ${(r.amount / 1e6).toFixed(2)} USDT` })),
      ...lgRz.map((r) => ({ at: r.created_at, kind: "rozi", detail: `${r.direction} ${(r.amount / 1e6).toFixed(3)} ROZI · ${r.source_type}` })),
      ...lgTc.map((r) => ({ at: r.created_at, kind: "task", detail: `task ${r.status} · ${r.network}` })),
      ...auditRows.map((r) => ({ at: r.created_at, kind: "admin", detail: `${r.action}${r.detail ? ` · ${r.detail}` : ""}${r.actor_email ? ` — by ${r.actor_email}` : ""}` })),
    ].filter((x) => x.at).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 80);

    // Referral picture: points this account has EARNED from referral bonuses
    // (derived from the points ledger, not a counter), and the L2 count
    // (friends of friends) that the earner's own /referrals/me also surfaces.
    const refEarned = Number((await sql.get<{ n: string | number }>(
      "SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE user_id = ? AND source_type LIKE 'referral%'", id,
    ))?.n ?? 0);
    const joined2Count = Number((await sql.get<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM users WHERE referred_by IN (SELECT id FROM users WHERE referred_by = ?)`, id,
    ))?.n ?? 0);

    return {
      user: {
        ...user,
        balancePoints,
        roziMicro,
        usdtMicro,
        // Stated as a boolean so the panel never has to re-derive "is this hold
        // still in force" from a date string and get it wrong.
        withdrawalHeld: Boolean(user.withdrawal_hold_reason)
          && (!user.withdrawal_hold_until || String(user.withdrawal_hold_until) > now()),
        // Same treatment for the review mark: a decided boolean, never a raw
        // column, so the panel can't get "is this still marked" wrong either.
        underReview: Boolean(user.under_review_reason),
      },
      ledger, fraudFlags: flags, usdtRefunds, usdtTopups, withdrawals,
      paidSummary: { count: Number(paid?.n ?? 0), totalPoints: Number(paid?.total ?? 0) },
      invitedBy: invitedBy ?? null,
      invitees,
      inviteeCount,
      tickets,
      devices,
      roziLedger, usdtLedger, audit: auditRows, activity,
      referral: { earnedPoints: refEarned, joined2Count },
    };
  }));

  // A user's own derived on-chain BNB balance (gas for their custody address —
  // see CUSTODY_SPEC.md § 5, the same read `/wallet/bnb` already does via
  // hasEnoughGasForDisplay). Split out of GET /staff/users/:id on purpose: a
  // live RPC call must never make the rest of a User 360 page wait on chain
  // reachability, and hasEnoughGasForDisplay already never throws — it
  // returns null on any RPC failure, which the panel renders as "can't check
  // right now" rather than a blank tab.
  app.get("/staff/users/:id/bnb-balance", staffGuard("users.view", async (_ctx, req) => {
    const id = (req.params as { id: string }).id;
    const relayReady = relayAvailable("bep20");
    const gas = relayReady ? await hasEnoughGasForDisplay(id, "bep20") : null;
    return {
      available: relayReady,
      balanceWei: gas ? gas.balanceWei.toString() : null,
      address: gas ? gas.address : null,
    };
  }));

  // Open fraud flags — managers/admins only.
  app.get("/staff/fraud", staffGuard("fraud.view", async () => {
    // Only genuinely-open flags on active accounts. A suspended user's flags are
    // auto-closed on suspend (setUserStatusOne), but this belt-and-braces check
    // also hides flags for accounts suspended before that behaviour existed.
    // System flags with no user (reconciliation_mismatch) always pass.
    const flags = await sql.all(
      `SELECT f.*, u.email AS user_email,
              u.username AS user_username, u.display_name AS user_display_name,
              u.telegram_username AS user_telegram_username, u.telegram_name AS user_telegram_name
       FROM fraud_flags f
       LEFT JOIN users u ON u.id = f.user_id
       WHERE f.resolved_by IS NULL AND (f.user_id IS NULL OR u.status <> 'suspended')
       ORDER BY f.created_at DESC`,
    );
    return { flags };
  }));

  // Resolve a flag (managers/admins). Append-only spirit: we don't delete, we
  // stamp who cleared it and why, leaving the trail (docs/ARCHITECTURE.md).
  app.post("/staff/fraud/:id/resolve", staffGuard("fraud.resolve", async ({ userId }, req, reply) => {
    const note = (req.body as { note?: string })?.note;
    const id = (req.params as { id: string }).id;
    const res = await sql.run(
      "UPDATE fraud_flags SET resolved_by = ?, resolution_note = ?, resolved_at = ? WHERE id = ? AND resolved_by IS NULL",
      userId, note ?? null, now(), id,
    );
    if (!res.rowCount) return reply.code(404).send({ error: "Flag not found or already resolved." });
    return { ok: true };
  }));

  // ---- Admin: ad-network config ------------------------------------------
  // Commission split + referral bonus live here, never in code (guardrail /
  // docs/ARCHITECTURE.md § Commission split). Admin can disable a network,
  // which stops its postbacks crediting and hides its offers, with no redeploy.
  const networkPatchSchema = z.object({
    status: z.enum(["active", "disabled"]).optional(),
    commissionSplitPct: z.number().int().min(0).max(100).optional(),
    referralBonusPct: z.number().int().min(0).max(100).optional(),
    // Level-2 (indirect) referral share. 0 turns the second level off.
    referralBonusPctL2: z.number().int().min(0).max(100).optional(),
    // Flat one-time bonus (points) when an invited user finishes their 1st task.
    referralFirstTaskBonus: z.number().int().min(0).max(1_000_000).optional(),
    // Referral window in days (0 = lifetime). Up to ~10 years.
    referralBonusDays: z.number().int().min(0).max(3650).optional(),
  });

  app.get("/staff/networks", staffGuard("networks.manage", async () => {
    const rows = await sql.all<Record<string, unknown>>(
      `SELECT n.*,
         (SELECT COUNT(*)::int FROM tasks t WHERE t.network = n.id) AS task_count,
         (SELECT COUNT(*)::int FROM task_completions c WHERE c.network = n.id AND c.status = 'credited') AS credited_count
       FROM networks n ORDER BY n.type, n.name`,
    );
    return {
      networks: rows.map((n) => ({
        id: n.id, name: n.name, type: n.type, status: n.status,
        commissionSplitPct: n.commission_split_pct, referralBonusPct: n.referral_bonus_pct,
        referralBonusPctL2: n.referral_bonus_pct_l2, referralFirstTaskBonus: n.referral_first_task_bonus,
        referralBonusDays: n.referral_bonus_days,
        taskCount: n.task_count, creditedCount: n.credited_count, updatedAt: n.updated_at,
      })),
    };
  }));

  app.patch("/staff/networks/:id", staffGuard("networks.manage", async (_ctx, req, reply) => {
    const parsed = networkPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter a valid status or a split between 0 and 100." });
    const id = (req.params as { id: string }).id;

    const cols: string[] = [];
    const vals: unknown[] = [];
    if (parsed.data.status !== undefined) { cols.push("status = ?"); vals.push(parsed.data.status); }
    if (parsed.data.commissionSplitPct !== undefined) { cols.push("commission_split_pct = ?"); vals.push(parsed.data.commissionSplitPct); }
    if (parsed.data.referralBonusPct !== undefined) { cols.push("referral_bonus_pct = ?"); vals.push(parsed.data.referralBonusPct); }
    if (parsed.data.referralBonusPctL2 !== undefined) { cols.push("referral_bonus_pct_l2 = ?"); vals.push(parsed.data.referralBonusPctL2); }
    if (parsed.data.referralFirstTaskBonus !== undefined) { cols.push("referral_first_task_bonus = ?"); vals.push(parsed.data.referralFirstTaskBonus); }
    if (parsed.data.referralBonusDays !== undefined) { cols.push("referral_bonus_days = ?"); vals.push(parsed.data.referralBonusDays); }
    if (!cols.length) return reply.code(400).send({ error: "Nothing to change." });
    cols.push("updated_at = ?"); vals.push(now());

    const res = await sql.run(`UPDATE networks SET ${cols.join(", ")} WHERE id = ?`, ...vals, id);
    if (!res.rowCount) return reply.code(404).send({ error: "Network not found." });
    return { ok: true };
  }));

  // Set the referral rewards on EVERY network at once.
  //
  // This exists because raising referral pay one network at a time does not
  // actually raise it: the invite screens advertise the MINIMUM across active
  // networks (see /referrals/me — we never promise a rate some offer does not
  // pay), so a founder who bumps CPX to 25% and forgets surveyx has changed
  // nothing a user can see, and has no way to tell. One control, all rows.
  //
  // Deliberately NOT touching commission_split_pct. That is the margin, it is
  // negotiated per network, and a bulk write is exactly how you would flatten
  // three different deals into one wrong number by accident.
  app.patch("/staff/networks/referrals/all", staffGuard("referrals.manage", async ({ userId, role }, req, reply) => {
    const parsed = z.object({
      referralBonusPct: z.number().int().min(0).max(100).optional(),
      referralBonusPctL2: z.number().int().min(0).max(100).optional(),
      referralFirstTaskBonus: z.number().int().min(0).max(1_000_000).optional(),
      referralBonusDays: z.number().int().min(0).max(3650).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter valid referral numbers." });

    const cols: string[] = [];
    const vals: unknown[] = [];
    const d = parsed.data;
    if (d.referralBonusPct !== undefined) { cols.push("referral_bonus_pct = ?"); vals.push(d.referralBonusPct); }
    if (d.referralBonusPctL2 !== undefined) { cols.push("referral_bonus_pct_l2 = ?"); vals.push(d.referralBonusPctL2); }
    if (d.referralFirstTaskBonus !== undefined) { cols.push("referral_first_task_bonus = ?"); vals.push(d.referralFirstTaskBonus); }
    if (d.referralBonusDays !== undefined) { cols.push("referral_bonus_days = ?"); vals.push(d.referralBonusDays); }
    if (!cols.length) return reply.code(400).send({ error: "Nothing to change." });

    // L1 + L2 together come out of our margin on every credited task. At a 60/40
    // split we keep 40 points per 100 credited, so paying out more than that
    // means every referred task LOSES money — silently, on every completion,
    // until someone reads a P&L. Refuse it here rather than discover it there.
    // Read the rows first: a request that sets only L2 still has to be checked
    // against whatever L1 each row already holds.
    const rows = await sql.all<{ id: string; l1: number; l2: number; split: number }>(
      `SELECT id, referral_bonus_pct AS l1, referral_bonus_pct_l2 AS l2,
              commission_split_pct AS split FROM networks`,
    );
    for (const r of rows) {
      const l1 = d.referralBonusPct ?? r.l1;
      const l2 = d.referralBonusPctL2 ?? r.l2;
      const margin = 100 - r.split;
      if (l1 + l2 > margin) {
        return reply.code(400).send({
          error: `${l1}% + ${l2}% is more than the ${margin}% margin on "${r.id}". Referral pay comes out of our cut, so this would lose money on every task.`,
        });
      }
    }

    cols.push("updated_at = ?"); vals.push(now());
    const res = await sql.run(`UPDATE networks SET ${cols.join(", ")}`, ...vals);
    await logAudit({
      actorUserId: userId, actorRole: role, action: "networks_referrals_bulk",
      detail: `${res.rowCount} networks: ${JSON.stringify(d)}`,
    });
    return { ok: true, updated: res.rowCount };
  }));

  // ---- Admin: global settings (withdrawal fee + treasury wallet) ----------
  // The treasury wallet is the HOT WALLET: the founder funds it with USDT, and
  // every manual payout is sent FROM it. One address per chain, stored in
  // app_settings. Display/reference only — the API never holds a private key
  // for these addresses (on-chain auto-send has its own env-gated signer, see
  // payout.ts), so a leaked admin session cannot move treasury funds from here.
  app.get("/staff/settings", staffGuard("settings.manage", async () => ({
    withdrawalFeePoints: Number(await getSetting("withdrawal_fee_points", "0")) || 0,
    // The gas fee (founder, 2026-08-08): sending USDT on BEP20 costs real
    // gas, and this is what recovers it — on BOTH withdrawals (added on top
    // of the flat fee above) and deposit refunds (routes/mining.ts), the two
    // flows the founder wants it on. See fees.ts.
    gasFeePercent: Math.max(0, Number(await getSetting("gas_fee_percent", "0")) || 0),
    gasFeeFixedMicro: Math.max(0, Number(await getSetting("gas_fee_fixed_micro", "0")) || 0),
    // Ceilings for FULLY AUTOMATIC settlement (founder, 2026-08-08): a
    // withdrawal/refund AT OR UNDER this amount settles itself with no staff
    // click; above it (or above the fixed rolling-24h cap, or an account
    // hold) drops into the unchanged manual queue. See autoSettleSettings.ts.
    autoWithdrawMaxPoints: await getAutoWithdrawMaxPoints(),
    autoRefundMaxMicro: await getAutoRefundMaxMicro(),
    // ⚠️ Neither ceiling above does ANYTHING while this is false — automatic
    // settlement is still gated on PAYOUT_MODE=onchain AND a real treasury
    // signer key, neither of which is a /staff setting (CUSTODY_SPEC.md §
    // 5c: needs a NEW funded wallet, proven on testnet first). The panel
    // uses this to say so plainly instead of implying a ceiling alone turns
    // anything on.
    autoSendLive: config.payoutMode === "onchain" && Boolean(config.treasuryKeyEncrypted),
    kycEnabled: await kycFeatureEnabled(),
    treasury: {
      bep20: await getSetting("treasury_address_bep20", ""),
      base: await getSetting("treasury_address_base", ""),
      aptos: await getSetting("treasury_address_aptos", ""),
    },
    // ---- Global settings (brief part 45) ----------------------------------
    // Only the ones with no home yet. Fees, treasury, mining rates, network
    // config and referral rates all already have their own panels; restating
    // them here would be a second control for the same value, which is the
    // exact failure the feature-flag registry avoids (flags.ts).
    //
    // ⚠️ NOTHING SECRET LIVES HERE. Part 45 asks for "token contracts" and
    // "network" on this screen; those stay in environment variables
    // (config.ts, RPC_BEP20, the signer keys) precisely as the brief's own
    // last line says they should. A contract address editable from a stolen
    // admin session is a way to redirect every payout.
    appName: await getSetting("app_name", "RoziPay"),
    supportEmail: await getSetting("support_email", ""),
    supportTelegram: await getSetting("support_telegram", ""),
    // A minimum that can be tuned without a redeploy. Falls back to the
    // env-configured value, so an untouched instance behaves exactly as before.
    minWithdrawPoints: Number(await getSetting("min_withdraw_points", "")) || config.minWithdrawPoints,
    // How long an "answered" ticket waits with no reply before it auto-closes
    // (founder, 2026-09-02: "professional support chat" — hours, not the old
    // days-based default). 0 = never auto-close.
    ticketAutoCloseHours: await ticketAutoCloseHoursNow(),
    // Maintenance mode: earners see a "back soon" screen and every earning or
    // money route refuses. Staff routes are deliberately UNAFFECTED — the
    // reason you turn this on is usually so staff can go and fix something.
    maintenanceMode: (await getSetting("maintenance_mode", "0")) === "1",
    maintenanceMessage: await getSetting("maintenance_message", ""),
  })));

  const settingsSchema = z.object({
    // Flat fee (points) taken out of every withdrawal. 0 = no fee.
    withdrawalFeePoints: z.number().int().min(0).max(1_000_000).optional(),
    // Gas-cost fee: percent of the amount (0-100) + a fixed floor in
    // micro-USDT. Applies to withdrawals (on top of the flat fee above) and
    // to deposit refunds. 0/0 = off, the default.
    gasFeePercent: z.number().min(0).max(100).optional(),
    gasFeeFixedMicro: z.number().int().min(0).max(1_000_000).optional(),
    // Auto-settle ceilings — see the GET handler's comment. Generous upper
    // bounds (not a real cap on money movement: the ceiling only matters once
    // PAYOUT_MODE=onchain is separately turned on, and that path has its own
    // per-request/24h/hold checks regardless of what this is set to).
    autoWithdrawMaxPoints: z.number().int().min(0).max(10_000_000).optional(),
    autoRefundMaxMicro: z.number().int().min(0).max(10_000_000_000).optional(),
    // The ID check, on or off. OFF hides the tab ("Coming soon") AND waives the
    // requirement everywhere it is enforced — see kycFeatureEnabled() in kyc.ts
    // for why the alternative (hidden but still required) is a dead end.
    kycEnabled: z.boolean().optional(),
    // ---- Global settings (brief part 45) ---------------------------------
    appName: z.string().trim().min(1).max(40).optional(),
    supportEmail: z.string().trim().max(120).optional(),
    supportTelegram: z.string().trim().max(120).optional(),
    minWithdrawPoints: z.number().int().min(1).max(10_000_000).optional(),
    // 0 turns auto-close off. A support chat, not a week-long queue — see
    // settingsRuntime.ts's ticketAutoCloseHoursNow().
    ticketAutoCloseHours: z.number().int().min(0).max(720).optional(),
    maintenanceMode: z.boolean().optional(),
    maintenanceMessage: z.string().trim().max(300).optional(),
    // Treasury (hot wallet) address per chain. Empty string clears it.
    treasury: z.object({
      bep20: z.string().trim().max(120).optional(),
      base: z.string().trim().max(120).optional(),
      aptos: z.string().trim().max(120).optional(),
    }).optional(),
  });
  app.patch("/staff/settings", staffGuard("settings.manage", async ({ userId, role }, req, reply) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Check the values and try again." });

    if (parsed.data.withdrawalFeePoints !== undefined) {
      await setSetting("withdrawal_fee_points", String(parsed.data.withdrawalFeePoints));
    }
    if (parsed.data.gasFeePercent !== undefined) {
      await setSetting("gas_fee_percent", String(parsed.data.gasFeePercent));
    }
    if (parsed.data.gasFeeFixedMicro !== undefined) {
      await setSetting("gas_fee_fixed_micro", String(parsed.data.gasFeeFixedMicro));
    }
    if (parsed.data.autoWithdrawMaxPoints !== undefined) {
      await setSetting("auto_withdraw_max_points", String(parsed.data.autoWithdrawMaxPoints));
    }
    if (parsed.data.autoRefundMaxMicro !== undefined) {
      await setSetting("auto_refund_max_micro", String(parsed.data.autoRefundMaxMicro));
    }
    if (parsed.data.appName !== undefined) {
      await setSetting("app_name", parsed.data.appName);
    }
    if (parsed.data.supportEmail !== undefined) {
      await setSetting("support_email", parsed.data.supportEmail);
    }
    if (parsed.data.supportTelegram !== undefined) {
      await setSetting("support_telegram", parsed.data.supportTelegram);
    }
    if (parsed.data.minWithdrawPoints !== undefined) {
      const wasMin = Number(await getSetting("min_withdraw_points", "")) || config.minWithdrawPoints;
      await setSetting("min_withdraw_points", String(parsed.data.minWithdrawPoints));
      // Guardrail #4 in the project memory: "never design a payout threshold to
      // be effectively unreachable". Raising this is the one setting on this
      // screen that can quietly make the whole product unusable for the people
      // it is for, so it is on the record with its old value beside it.
      await logAudit({
        actorUserId: userId, actorRole: role, action: "min_withdraw_change",
        detail: "minimum points needed to cash out",
        previousValue: wasMin, newValue: parsed.data.minWithdrawPoints,
        actorIp: req.ip,
      });
    }
    if (parsed.data.ticketAutoCloseHours !== undefined) {
      await setSetting("ticket_auto_close_hours", String(parsed.data.ticketAutoCloseHours));
    }
    if (parsed.data.maintenanceMessage !== undefined) {
      await setSetting("maintenance_message", parsed.data.maintenanceMessage);
    }
    if (parsed.data.maintenanceMode !== undefined) {
      const wasMaint = (await getSetting("maintenance_mode", "0")) === "1";
      await setSetting("maintenance_mode", parsed.data.maintenanceMode ? "1" : "0");
      await logAudit({
        actorUserId: userId, actorRole: role, action: "maintenance_mode",
        detail: parsed.data.maintenanceMode ? "app closed to earners" : "app reopened",
        previousValue: wasMaint ? "on" : "off",
        newValue: parsed.data.maintenanceMode ? "on" : "off",
        actorIp: req.ip,
      });
    }
    if (parsed.data.kycEnabled !== undefined) {
      const wasKyc = await getSetting("kyc_enabled", "1");
      await setSetting("kyc_enabled", parsed.data.kycEnabled ? "1" : "0");
      // Audit-logged for the same reason a treasury change is: this switch
      // relaxes an identity requirement on every money path in the product, and
      // "who turned it off, and when" is the first question after an incident.
      await logAudit({
        actorUserId: userId, actorRole: role, action: "kyc_feature_toggle",
        detail: parsed.data.kycEnabled ? "on" : "off — ID check waived everywhere",
        previousValue: wasKyc === "1" ? "on" : "off",
        newValue: parsed.data.kycEnabled ? "on" : "off",
        actorIp: req.ip,
      });
    }
    if (parsed.data.treasury) {
      for (const [chain, address] of Object.entries(parsed.data.treasury)) {
        if (address === undefined) continue;
        // Same validator users' payout addresses go through — a typo'd treasury
        // address on the staff screen would misdirect every manual payout.
        if (address !== "") {
          const check = validateAddress(chain as ChainId, address);
          if (!check.ok) return reply.code(400).send({ error: `${chain}: ${check.error}` });
        }
        // Read BEFORE the write: the whole point of the audit row is the
        // address this replaced, and after setSetting it is gone for good.
        const wasAddress = await getSetting(`treasury_address_${chain}`, "");
        await setSetting(`treasury_address_${chain}`, address);
        // A treasury address swap is exactly what an attacker with a stolen
        // admin session would do (payouts start flowing to THEIR wallet), so
        // every change lands in the append-only audit log — with the address it
        // replaced, which is what makes the row actionable rather than merely
        // alarming.
        await logAudit({
          actorUserId: userId, actorRole: role, action: "treasury_address_change",
          detail: chain,
          previousValue: wasAddress || "(none)", newValue: address || "(cleared)",
          actorIp: req.ip,
        });
      }
    }
    return { ok: true };
  }));

  // ---- Support tickets (brief part 40) ------------------------------------
  //
  // A queue is only as good as what it can be narrowed to. Before this it
  // served one status and nothing else: no counts, so there was no way to tell
  // "nothing open" from "the filter is on the wrong tab"; no search, so finding
  // the ticket a user is on the phone about meant paging; and no owner, so two
  // agents answered the same person twice.
  app.get("/staff/tickets", staffGuard("support.view", async (_ctx, req) => {
    const q = req.query as { status?: string; q?: string; mine?: string; sort?: string; dir?: string; limit?: string; offset?: string };
    const status = q.status ?? "open";
    // Pagination (admin rebuild, Phase E). Same idiom as GET /staff/users: the
    // `where` clause drives the row page AND the count so `total` matches the
    // filter; `counts` stays over ALL tickets regardless. `sort` maps through a
    // whitelist to a column literal, never interpolated.
    const limit = Math.min(Number(q.limit ?? 25) || 25, 200);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    const SORTS: Record<string, string> = {
      updated_at: "ti.updated_at", created_at: "ti.created_at", status: "ti.status",
    };
    const sortCol = SORTS[q.sort ?? ""] ?? "ti.updated_at";
    const dir = q.dir === "desc" ? "DESC" : "ASC";

    const where: string[] = [];
    const params: unknown[] = [];
    // "all" is a real choice: a ticket someone closed by mistake is invisible
    // under any single-status view, which is when people start asking whether
    // the panel is broken.
    if (status !== "all") { where.push("ti.status = ?"); params.push(status); }
    if (q.q?.trim()) {
      // Subject or email. Case-insensitive because nobody types an address the
      // way it was stored, and a search that misses on capitalisation reads as
      // "this user does not exist".
      const like = `%${q.q.trim().toLowerCase()}%`;
      where.push("(LOWER(ti.subject) LIKE ? OR LOWER(u.email) LIKE ?)");
      params.push(like, like);
    }
    if (q.mine) { where.push("ti.assigned_to = ?"); params.push(q.mine); }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows, totalRow] = await Promise.all([
      sql.all<Record<string, unknown>>(
        `SELECT ti.*, u.email AS user_email, a.email AS assignee_email,
                u.username AS user_username, u.display_name AS user_display_name,
                u.telegram_username AS user_telegram_username, u.telegram_name AS user_telegram_name,
           (SELECT COUNT(*)::int FROM ticket_messages m
             WHERE m.ticket_id = ti.id AND m.author_role <> 'internal') AS message_count,
           -- A preview line for the list (founder, 2026-09-02: "how the actual
           -- support chat should look" — a real inbox shows the last message,
           -- not just a subject). Internal notes are excluded here too — this
           -- is staff's own queue, but a note is written FOR staff, not as a
           -- stand-in for what the conversation actually said.
           (SELECT m.body FROM ticket_messages m
             WHERE m.ticket_id = ti.id AND m.author_role <> 'internal'
             ORDER BY m.created_at DESC LIMIT 1) AS last_message
         FROM support_tickets ti
         JOIN users u ON u.id = ti.user_id
         LEFT JOIN users a ON a.id = ti.assigned_to
         ${whereSql}
         ORDER BY ${sortCol} ${dir} LIMIT ? OFFSET ?`,
        ...params, limit, offset,
      ),
      sql.get<{ n: string | number }>(
        `SELECT COUNT(*) AS n FROM support_tickets ti JOIN users u ON u.id = ti.user_id ${whereSql}`,
        ...params,
      ),
    ]);

    // Counts per status, always over ALL tickets — never over the current
    // filter, or the tabs would each report the number of tickets matching
    // themselves and the badge would always read the same as the list.
    const counts = await sql.all<{ status: string; n: number }>(
      "SELECT status, COUNT(*)::int AS n FROM support_tickets GROUP BY status",
    );

    return {
      counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      total: Number(totalRow?.n ?? rows.length),
      offset,
      limit,
      tickets: rows.map((t) => ({
        id: t.id, userId: t.user_id, userEmail: t.user_email, subject: t.subject,
        userUsername: t.user_username ?? null, userDisplayName: t.user_display_name ?? null,
        userTelegramUsername: t.user_telegram_username ?? null, userTelegramName: t.user_telegram_name ?? null,
        status: t.status, messageCount: t.message_count,
        lastMessage: t.last_message,
        assignedTo: t.assigned_to, assigneeEmail: t.assignee_email,
        at: t.created_at, updatedAt: t.updated_at,
      })),
    };
  }));

  app.get("/staff/tickets/:id", staffGuard("support.view", async (_ctx, req, reply) => {
    const id = (req.params as { id: string }).id;
    const ticket = await sql.get<Record<string, unknown>>(
      `SELECT ti.*, u.email AS user_email, u.status AS user_status,
              u.username AS user_username, u.display_name AS user_display_name,
              u.telegram_username AS user_telegram_username, u.telegram_name AS user_telegram_name,
              u.kyc_status, u.country, a.email AS assignee_email
       FROM support_tickets ti
       JOIN users u ON u.id = ti.user_id
       LEFT JOIN users a ON a.id = ti.assigned_to
       WHERE ti.id = ?`, id,
    );
    if (!ticket) return reply.code(404).send({ error: "Ticket not found." });
    // Internal notes ARE returned here — this is the staff view, and hiding
    // them from the people who wrote them would defeat the point. The earner
    // endpoint is where they are filtered out (routes/app.ts).
    const messages = await sql.all(
      `SELECT m.id, m.author_role, m.body, m.image, m.created_at, au.email AS author_email
       FROM ticket_messages m LEFT JOIN users au ON au.id = m.author_id
       WHERE m.ticket_id = ? ORDER BY m.created_at ASC`, id,
    );
    return {
      ticket: {
        id: ticket.id, userId: ticket.user_id, userEmail: ticket.user_email,
        userUsername: ticket.user_username ?? null, userDisplayName: ticket.user_display_name ?? null,
        userTelegramUsername: ticket.user_telegram_username ?? null, userTelegramName: ticket.user_telegram_name ?? null,
        userStatus: ticket.user_status, kycStatus: ticket.kyc_status, country: ticket.country,
        subject: ticket.subject, status: ticket.status, at: ticket.created_at,
        updatedAt: ticket.updated_at, rating: ticket.rating,
        assignedTo: ticket.assigned_to, assigneeEmail: ticket.assignee_email,
      },
      messages,
    };
  }));

  const replySchema = z.object({
    message: z.string().min(1).max(2000),
    close: z.boolean().optional(),
    // ⚠️ AN INTERNAL NOTE IS NEVER SENT TO THE USER, AND NEVER PUSHED.
    // It is where an agent writes what they would say to a colleague, on the
    // ticket, so the next person to open it does not start from nothing.
    internal: z.boolean().optional(),
    // One optional image, same magic-byte-sniffed shape as the earner side —
    // see routes/app.ts's parseTicketImage comment for why this is checked as
    // strictly as an avatar upload, not more loosely because it's "internal".
    image: z.string().max(3_000_000).optional().nullable(),
  });
  const TICKET_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
  app.post("/staff/tickets/:id/reply", staffGuard("support.reply", async ({ userId }, req, reply) => {
    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Type a reply first." });
    const id = (req.params as { id: string }).id;
    const internal = parsed.data.internal === true;
    let image: string | null = null;
    if (parsed.data.image) {
      const parsedImg = parseDataUrl(parsed.data.image, "ticket");
      if (parsedImg.bytes.length > TICKET_IMAGE_MAX_BYTES) {
        return reply.code(413).send({ error: "That photo is too big. Try a smaller one." });
      }
      image = `data:${parsedImg.mime};base64,${parsedImg.bytes.toString("base64")}`;
    }

    const ticket = await sql.get<{ id: string; user_id: string; status: string }>(
      "SELECT id, user_id, status FROM support_tickets WHERE id = ?", id);
    if (!ticket) return reply.code(404).send({ error: "Ticket not found." });

    await sql.tx(async (t) => {
      await t.run(
        "INSERT INTO ticket_messages (id, ticket_id, author_role, author_id, body, image, created_at) VALUES (?,?,?,?,?,?,?)",
        newId(), id, internal ? "internal" : "staff", userId, parsed.data.message, image, now(),
      );
      // A note changes nothing the user can see, so it must not move the
      // status either: marking a ticket "answered" because someone wrote a
      // note to themselves is how a person waiting for a reply drops out of
      // the open queue and is never answered.
      const nextStatus = internal
        ? ticket.status
        : (parsed.data.close ? "closed" : "answered");
      await t.run(
        "UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?",
        nextStatus, now(), id,
      );
    });
    // After commit: tell the user someone answered (fire-and-forget). Never for
    // an internal note — the whole point is that the user is not part of it.
    if (!internal) {
      void sendPushToUser(ticket.user_id, {
        title: "We replied to your question",
        body: "Open the app to read our answer.",
        url: "/help",
      });
    }
    return { ok: true };
  }));

  // Assignment and status, separately from replying — because both happen
  // without a reply. Picking up a ticket you have not answered yet is exactly
  // how two agents stop answering the same person twice.
  const ticketPatchSchema = z.object({
    // "" clears the assignment; omitted leaves it alone. Both are needed —
    // handing a ticket back to the pool is a real action.
    assignedTo: z.string().max(80).nullable().optional(),
    status: z.enum(["open", "answered", "closed"]).optional(),
  });
  app.patch("/staff/tickets/:id", staffGuard("support.reply", async ({ userId }, req, reply) => {
    const parsed = ticketPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Nothing valid to change." });
    const id = (req.params as { id: string }).id;
    const d = parsed.data;

    const cols: string[] = [];
    const vals: unknown[] = [];
    if (d.assignedTo !== undefined) {
      // "me" resolves server-side rather than the client sending its own id:
      // one less thing a stale session can get wrong, and the only assignment
      // anyone actually makes from the queue.
      const to = d.assignedTo === "me" ? userId : (d.assignedTo || null);
      if (to) {
        const exists = await sql.get<{ user_id: string }>(
          "SELECT user_id FROM admin_users WHERE user_id = ?", to);
        if (!exists) return reply.code(400).send({ error: "That is not a staff account." });
      }
      cols.push("assigned_to = ?"); vals.push(to);
    }
    if (d.status !== undefined) { cols.push("status = ?"); vals.push(d.status); }
    if (!cols.length) return reply.code(400).send({ error: "Nothing to change." });
    cols.push("updated_at = ?"); vals.push(now());

    const res = await sql.run(`UPDATE support_tickets SET ${cols.join(", ")} WHERE id = ?`, ...vals, id);
    if (!res.rowCount) return reply.code(404).send({ error: "Ticket not found." });
    return { ok: true };
  }));

  // ---- Manager: KPI dashboard --------------------------------------------
  // All figures derived from the ledger and request tables — no stored
  // aggregates to drift out of sync (guardrail #2 in spirit).
  app.get("/staff/kpis", staffGuard("analytics.view", async () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);

    const one = async (text: string, ...params: unknown[]) =>
      (await sql.get<{ v: number }>(text, ...params))?.v ?? 0;

    const [
      totalUsers, newUsers7d, pendingCount, pendingPoints,
      paidCount7d, paidPoints7d, paidPointsAll,
      taskPointsAll, referralPointsAll, completionsToday,
      openFraud, openTickets,
    ] = await Promise.all([
      one("SELECT COUNT(*)::int AS v FROM users WHERE email_verified = 1"),
      one("SELECT COUNT(*)::int AS v FROM users WHERE email_verified = 1 AND created_at >= ?", sevenDaysAgo),
      one("SELECT COUNT(*)::int AS v FROM withdrawal_requests WHERE status IN ('pending','agent_approved','manager_approved')"),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM withdrawal_requests WHERE status IN ('pending','agent_approved','manager_approved')"),
      one("SELECT COUNT(*)::int AS v FROM withdrawal_requests WHERE status = 'paid' AND paid_at >= ?", sevenDaysAgo),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM withdrawal_requests WHERE status = 'paid' AND paid_at >= ?", sevenDaysAgo),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM withdrawal_requests WHERE status = 'paid'"),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM ledger_entries WHERE source_type = 'task_completion'"),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM ledger_entries WHERE source_type = 'referral_bonus'"),
      one("SELECT COUNT(*)::int AS v FROM task_completions WHERE status = 'credited' AND created_at >= ?", startOfToday.toISOString()),
      one("SELECT COUNT(*)::int AS v FROM fraud_flags WHERE resolved_by IS NULL"),
      one("SELECT COUNT(*)::int AS v FROM support_tickets WHERE status != 'closed'"),
    ]);

    // 7-day activity series (completions + points credited per day). Reads points
    // off the completion itself, so dynamic-amount networks (CPX surveys, which
    // have no task row) are included too.
    const series = await sql.all<{ day: string; completions: number; points: number }>(
      `SELECT to_char(created_at::timestamp, 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS completions,
              COALESCE(SUM(COALESCE(points,0)),0)::int AS points
       FROM task_completions
       WHERE status = 'credited' AND created_at >= ?
       GROUP BY day ORDER BY day ASC`,
      sevenDaysAgo,
    );

    return {
      users: { total: totalUsers, new7d: newUsers7d },
      withdrawals: { pendingCount, pendingPoints, paidCount7d, paidPoints7d, paidPointsAll },
      earning: { taskPointsAll, referralPointsAll, completionsToday },
      risk: { openFraud, openTickets },
      series,
    };
  }));

  // ==========================================================================
  // SUPER-ADMIN capabilities. `admin` was always the top role, but it had no
  // tools: no way to find a user, credit one, suspend one, or appoint staff.
  // ==========================================================================

  // ---- Console-wide record search (admin rebuild, Phase A) ---------------
  // One box that finds a record by any handle a staff member has: an email, a
  // @handle, an invite code, a full id, a tx hash, a ticket subject, a task
  // title. Open to any staff role, but each RESULT TYPE is filtered by whether
  // the caller can actually open it — searching never surfaces a record the
  // role would be 403'd from. Deep-links are resolved on the client
  // (web/src/components/staff-search.tsx).
  app.get("/staff/search", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { role } = await requireStaff(req);
      const q = ((req.query as { q?: string }).q ?? "").trim().toLowerCase();
      if (q.length < 2) return { results: [] as unknown[] };
      const like = `%${q}%`;
      const may = (p: Permission) => hasPermission(role, p);
      const results: { type: string; id: string; label: string; sub: string; section: string }[] = [];

      if (may("users.view") || may("users.list")) {
        const rows = await sql.all<{ id: string; email: string; username: string | null; status: string; referral_code: string | null }>(
          `SELECT id, email, username, status, referral_code FROM users
           WHERE LOWER(email) LIKE ? OR LOWER(id) = ? OR LOWER(username) = ? OR LOWER(referral_code) = ?
           ORDER BY created_at DESC LIMIT 6`,
          like, q, q, q,
        );
        for (const r of rows) results.push({
          type: "user", id: r.id, label: r.email,
          sub: `${r.username ? "@" + r.username + " · " : ""}${r.status}${r.referral_code ? " · " + r.referral_code : ""}`,
          section: "users",
        });
      }

      if (may("withdrawals.view")) {
        const rows = await sql.all<{ id: string; amount: number; status: string; payout_address: string; email: string }>(
          `SELECT w.id, w.amount, w.status, w.payout_address, u.email
           FROM withdrawal_requests w JOIN users u ON u.id = w.user_id
           WHERE LOWER(w.id) LIKE ? OR LOWER(w.payout_address) = ? OR LOWER(u.email) LIKE ?
           ORDER BY w.created_at DESC LIMIT 5`,
          `${q}%`, q, like,
        );
        for (const r of rows) results.push({
          type: "withdrawal", id: r.id, label: `Withdrawal ${r.amount} pts — ${r.email}`,
          sub: `${r.status} · ${r.payout_address?.slice(0, 12) ?? ""}…`, section: "money",
        });
      }

      if (may("refunds.view")) {
        const rows = await sql.all<{ id: string; amount: number; status: string; email: string }>(
          `SELECT r.id, r.amount, r.status, u.email
           FROM usdt_refund_requests r JOIN users u ON u.id = r.user_id
           WHERE LOWER(r.id) LIKE ? OR LOWER(r.address) = ? OR LOWER(u.email) LIKE ?
           ORDER BY r.created_at DESC LIMIT 5`,
          `${q}%`, q, like,
        );
        for (const r of rows) results.push({
          type: "refund", id: r.id, label: `Refund ${(r.amount / 1e6).toFixed(2)} USDT — ${r.email}`,
          sub: r.status, section: "money",
        });
      }

      if (may("deposits.view")) {
        const rows = await sql.all<{ id: string; amount: number; status: string; tx_hash: string; email: string }>(
          `SELECT t.id, t.amount, t.status, t.tx_hash, u.email
           FROM usdt_topups t JOIN users u ON u.id = t.user_id
           WHERE LOWER(t.id) LIKE ? OR LOWER(t.tx_hash) LIKE ? OR LOWER(u.email) LIKE ?
           ORDER BY t.created_at DESC LIMIT 5`,
          `${q}%`, like, like,
        );
        for (const r of rows) results.push({
          type: "deposit", id: r.id, label: `Deposit ${(r.amount / 1e6).toFixed(2)} USDT — ${r.email}`,
          sub: `${r.status} · ${r.tx_hash?.slice(0, 14) ?? ""}…`, section: "money",
        });
      }

      if (may("support.view")) {
        const rows = await sql.all<{ id: string; subject: string; status: string; email: string }>(
          `SELECT s.id, s.subject, s.status, u.email
           FROM support_tickets s JOIN users u ON u.id = s.user_id
           WHERE LOWER(s.id) LIKE ? OR LOWER(s.subject) LIKE ? OR LOWER(u.email) LIKE ?
           ORDER BY s.created_at DESC LIMIT 5`,
          `${q}%`, like, like,
        );
        for (const r of rows) results.push({
          type: "ticket", id: r.id, label: r.subject, sub: `${r.status} · ${r.email}`, section: "support",
        });
      }

      if (may("tasks.view")) {
        const rows = await sql.all<{ id: string; title: string; status: string }>(
          `SELECT id, title, status FROM tasks
           WHERE LOWER(id) LIKE ? OR LOWER(title) LIKE ?
           ORDER BY created_at DESC LIMIT 5`,
          `${q}%`, like,
        );
        for (const r of rows) results.push({
          type: "task", id: r.id, label: r.title, sub: r.status ?? "", section: "tasks",
        });
      }

      if (may("networks.manage")) {
        const rows = await sql.all<{ id: string; name: string; status: string }>(
          `SELECT id, name, status FROM networks
           WHERE LOWER(id) LIKE ? OR LOWER(name) LIKE ? LIMIT 5`,
          like, like,
        );
        for (const r of rows) results.push({
          type: "network", id: r.id, label: r.name, sub: r.status, section: "tasks",
        });
      }

      return { results };
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Search failed" });
    }
  });

  // ---- Admin: find users --------------------------------------------------
  // Search by email or id. Balance is summed from the ledger, never stored.
  // ⚠️ PAGINATED, DEFAULT PAGE SIZE 10 (founder, 2026-08-27): the dashboard
  // list used to hand back up to 200 rows in one screen. `offset` + `total`
  // let the panel show a short first page with a real "See more" rather than
  // a wall of rows — OFFSET is fine here (unlike the audit log) because this
  // list is read interactively, one page at a time, never scanned end to end.
  // ⚠️ Now takes server-side SORT + FILTERS (admin rebuild, Phase B). The
  // WHERE clause is assembled from a fixed set of conditions with bound
  // params; `sort` / `dir` map through a whitelist to a column literal — never
  // interpolated from the request. Same list is used for the row page and the
  // COUNT, so `total` always matches the filter.
  app.get("/staff/users", staffGuard("users.list", async (_ctx, req) => {
    const query = req.query as Record<string, string | undefined>;
    const q = (query.q ?? "").trim().toLowerCase();
    const limit = Math.min(Number(query.limit ?? 10) || 10, 200);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);

    const where: string[] = [];
    const wp: unknown[] = [];
    if (q) { where.push("(LOWER(u.email) LIKE ? OR LOWER(u.id) = ?)"); wp.push(`%${q}%`, q); }
    if (query.status === "active" || query.status === "suspended") { where.push("u.status = ?"); wp.push(query.status); }
    if (["none", "pending", "approved", "rejected"].includes(query.kyc ?? "")) { where.push("COALESCE(u.kyc_status, 'none') = ?"); wp.push(query.kyc); }
    if (query.country) { where.push("LOWER(u.country) = ?"); wp.push(query.country.toLowerCase()); }
    if (query.flagged === "1") where.push("EXISTS (SELECT 1 FROM fraud_flags f WHERE f.user_id = u.id AND f.resolved_by IS NULL)");
    if (query.held === "1") { where.push("(u.withdrawal_hold_reason IS NOT NULL AND (u.withdrawal_hold_until IS NULL OR u.withdrawal_hold_until > ?))"); wp.push(now()); }
    if (query.review === "1") where.push("u.under_review_reason IS NOT NULL");
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const SORTS: Record<string, string> = {
      created_at: "u.created_at", email: "u.email", status: "u.status", balance: "balance",
    };
    const sortCol = SORTS[query.sort ?? ""] ?? "u.created_at";
    const dir = query.dir === "asc" ? "ASC" : "DESC";

    const [rows, totalRow] = await Promise.all([
      sql.all<{
        id: string; email: string; country: string; status: string; created_at: string; balance: number;
        openFlags: number; held: boolean; underReview: boolean;
      }>(
        `SELECT u.id, u.email, u.country, u.status, u.created_at,
                COALESCE((SELECT SUM(amount) FROM ledger_entries l WHERE l.user_id = u.id), 0)::int AS balance,
                COALESCE((SELECT COUNT(*) FROM fraud_flags f WHERE f.user_id = u.id AND f.resolved_by IS NULL), 0)::int AS "openFlags",
                (u.withdrawal_hold_reason IS NOT NULL
                  AND (u.withdrawal_hold_until IS NULL OR u.withdrawal_hold_until > ?)) AS held,
                (u.under_review_reason IS NOT NULL) AS "underReview"
         FROM users u
         ${whereSql}
         ORDER BY ${sortCol} ${dir}
         LIMIT ? OFFSET ?`,
        now(), ...wp, limit, offset,
      ),
      sql.get<{ n: string | number }>(
        `SELECT COUNT(*) AS n FROM users u ${whereSql}`,
        ...wp,
      ),
    ]);
    return { users: rows, total: Number(totalRow?.n ?? rows.length), offset, limit };
  }));

  // ---- Admin: suspend / restore an account --------------------------------
  // Enforced for real: every earner route re-checks users.status on each call
  // (see requireActiveUser), so an already-issued JWT stops working immediately.
  const statusSchema = z.object({
    status: z.enum(["active", "suspended"]),
    reason: z.string().trim().min(3, "Say why.").max(500),
  });
  app.post("/staff/users/:id/status", staffGuard("users.status", async ({ userId: actorId, role }, req, reply) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Pick a status and give a reason." });
    const targetId = (req.params as { id: string }).id;
    const r = await setUserStatusOne(
      { actorId, role, actorIp: req.ip }, targetId, parsed.data.status, parsed.data.reason,
    );
    if (!r.ok) return reply.code(r.error === "User not found." ? 404 : 400).send({ error: r.error });
    return { ok: true, status: parsed.data.status };
  }));

  // ---- Admin: suspend / restore several accounts at once ------------------
  //
  // ⚠️ A BULK DECISION IS N SEPARATE DECISIONS, NOT ONE — the same rule
  // `/staff/task-proofs/bulk` follows (staffTasks.ts). Each id goes through
  // exactly `setUserStatusOne`, the identical path a single click takes, and
  // gets its own outcome back: one row already suspended, or the actor's own
  // id sitting in the selection, must not silently undo every other row in
  // the batch, and a single ok/error would tell staff a batch succeeded when
  // part of it did not.
  app.post("/staff/users/bulk-status", staffGuard("users.status", async ({ userId: actorId, role }, req, reply) => {
    const parsed = z.object({
      ids: z.array(z.string().max(64)).min(1).max(200),
      status: z.enum(["active", "suspended"]),
      reason: z.string().trim().min(3, "Say why.").max(500),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Pick a status, some users, and give a reason." });

    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of [...new Set(parsed.data.ids)]) {
      const r = await setUserStatusOne(
        { actorId, role, actorIp: req.ip }, id, parsed.data.status, parsed.data.reason,
      );
      results.push({ id, ok: r.ok, error: r.ok ? undefined : r.error });
    }
    return {
      ok: true,
      done: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }));

  // ---- Manager/Admin: hold a user's withdrawals ---------------------------
  // The safety valve for FULLY AUTOMATIC on-chain withdrawal (founder,
  // 2026-08-05, api/src/autoWithdraw.ts). Narrower than suspending the whole
  // account (/staff/users/:id/status above): a held user can still do
  // everything else — mine, earn, receive ROZI — they just can't have a
  // withdrawal auto-pay. A held request doesn't vanish; it drops into the
  // exact same manual Agent->Manager queue every withdrawal used to go
  // through, so staff still see it and can approve it by hand if that's
  // actually the right call.
  const holdSchema = z.object({
    // null clears the hold. A reason is mandatory when SETTING one (same rule
    // as suspend, above) — an unexplained hold on someone's money is the kind
    // of thing that must always have a written "why" attached.
    reason: z.string().trim().max(500).nullable(),
    // Omitted or null = PERMANENT, stays held until a staff member clears it.
    // A date = lifts itself the instant it passes (checked at use, see
    // db.ts's isWithdrawalHeld — nothing to sweep or expire on a schedule).
    until: z.string().datetime().nullable().optional(),
  });
  app.post("/staff/users/:id/withdrawal-hold", staffGuard("users.hold", async ({ userId: actorId, role }, req, reply) => {
    const parsed = holdSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Say why, or clear the hold." });
    const { reason, until } = parsed.data;
    if (reason !== null && reason.length < 3) {
      return reply.code(400).send({ error: "Say why — a few words is enough." });
    }
    const targetId = (req.params as { id: string }).id;

    const target = await sql.get<{ id: string; withdrawal_hold_reason: string | null }>(
      "SELECT id, withdrawal_hold_reason FROM users WHERE id = ?", targetId,
    );
    if (!target) return reply.code(404).send({ error: "User not found." });

    await sql.tx(async (t) => {
      await t.run(
        `UPDATE users SET
           withdrawal_hold_reason = ?, withdrawal_hold_until = ?,
           withdrawal_hold_by = ?, withdrawal_hold_at = ?
         WHERE id = ?`,
        reason, until ?? null, reason ? actorId : null, reason ? now() : null, targetId,
      );
      await logAudit({
        actorUserId: actorId, actorRole: role,
        action: reason ? "withdrawal_held" : "withdrawal_hold_cleared",
        targetUserId: targetId, detail: reason ?? undefined,
        previousValue: target.withdrawal_hold_reason ? "held" : "not held",
        newValue: reason ? "held" : "not held",
        actorIp: req.ip,
      }, t);
    });
    return { ok: true, held: reason !== null, reason, until: until ?? null };
  }));

  // ---- Manager/Admin: mark/clear an account for staff review --------------
  // Replaces the Users panel's "suspect (N)" badge as the way to say "we are
  // looking into this account" — that badge is a live COUNT of open fraud
  // flags, so it clears itself the instant every flag happens to resolve, even
  // mid-investigation. This is the opposite: a deliberate, staff-SET label that
  // stays exactly where a person left it.
  //
  // ⚠️ THIS GATES NOTHING. Same shape as the withdrawal-hold route just above,
  // and the same reason: a status column already exists for locking an account
  // out (users.status), and re-using this one for that would silently suspend
  // people the moment they were flagged for review, which is precisely what
  // "distinct from active/suspended" rules out.
  const reviewSchema = z.object({
    // null clears the mark. A reason is mandatory when SETTING one — same rule
    // as the hold and the suspend routes: an unexplained "why is this person
    // flagged" is the thing a review mark exists to prevent.
    reason: z.string().trim().max(500).nullable(),
  });
  app.post("/staff/users/:id/review", staffGuard("users.review", async ({ userId: actorId, role }, req, reply) => {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Say why, or clear the mark." });
    const { reason } = parsed.data;
    if (reason !== null && reason.length < 3) {
      return reply.code(400).send({ error: "Say why — a few words is enough." });
    }
    const targetId = (req.params as { id: string }).id;

    const target = await sql.get<{ id: string; under_review_reason: string | null }>(
      "SELECT id, under_review_reason FROM users WHERE id = ?", targetId,
    );
    if (!target) return reply.code(404).send({ error: "User not found." });

    await sql.tx(async (t) => {
      await t.run(
        `UPDATE users SET under_review_reason = ?, under_review_by = ?, under_review_at = ? WHERE id = ?`,
        reason, reason ? actorId : null, reason ? now() : null, targetId,
      );
      await logAudit({
        actorUserId: actorId, actorRole: role,
        action: reason ? "user_marked_under_review" : "user_review_cleared",
        targetUserId: targetId, detail: reason ?? undefined,
        previousValue: target.under_review_reason ? "under review" : "not under review",
        newValue: reason ? "under review" : "not under review",
        actorIp: req.ip,
      }, t);
    });
    return { ok: true, underReview: reason !== null, reason };
  }));

  // ---- Backfill Telegram identities (founder, 2026-09-03) ------------------
  // "Instead of Telegram user, show his username." The username IS captured at
  // login — but two populations never had it written: accounts that connected
  // Telegram from the website (bindTelegramToUser wrote only telegram_id until
  // this same date), and accounts created before the columns existed. Nothing
  // a normal login does can fix an account that is not logging in right now,
  // so this asks the Bot API directly, per account, on demand.
  //
  // Gated on users.review — a manager-tier write that changes only how a person
  // is LABELLED on staff screens. It touches no money, no status, and nothing a
  // user can see.
  //
  // ⚠️ CAPPED PER CALL, AND IT NEVER THROWS. One getChat per account is a real
  // outbound request each; a full-table walk behind one click is how you turn a
  // staff button into an incident. `pending` tells the caller how many are
  // still left so the button can simply be pressed again.
  const TELEGRAM_REFRESH_MAX = 50;
  app.post("/staff/users/telegram/refresh", staffGuard("users.review", async ({ userId: actorId, role }) => {
    const rows = await sql.all<{ id: string; telegram_id: string }>(
      `SELECT id, telegram_id FROM users
       WHERE telegram_id IS NOT NULL
         AND (telegram_username IS NULL OR telegram_username = '')
         AND (telegram_name IS NULL OR telegram_name = '')
       ORDER BY created_at ASC
       LIMIT ?`,
      TELEGRAM_REFRESH_MAX,
    );

    let updated = 0;
    let notFound = 0;
    for (const r of rows) {
      const id = await fetchTelegramChatIdentity(r.telegram_id);
      if (!id || (!id.username && !id.name)) { notFound += 1; continue; }
      await sql.run(
        "UPDATE users SET telegram_username = ?, telegram_name = ? WHERE id = ? AND telegram_id = ?",
        id.username, id.name, r.id, r.telegram_id,
      );
      updated += 1;
    }

    const left = await sql.get<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM users
       WHERE telegram_id IS NOT NULL
         AND (telegram_username IS NULL OR telegram_username = '')
         AND (telegram_name IS NULL OR telegram_name = '')`,
    );
    await logAudit({
      actorUserId: actorId, actorRole: role, action: "telegram_identity_refresh",
      detail: `checked ${rows.length}, updated ${updated}, no answer ${notFound}`,
    });
    return { checked: rows.length, updated, notFound, pending: Number(left?.n ?? 0) };
  }));

  // ---- Treasury wallet: every in and out (founder, 2026-09-03) ------------
  // "Show me all the in and out of this particular wallet ... whether it could
  // be to the platform users, whether it could be to any other place."
  //
  // ⚠️ THE CHAIN IS THE SOURCE, OUR TABLES ARE ONLY THE LABELS. A ledger built
  // from withdrawal_requests / usdt_topups / sweep_jobs could only ever show
  // movement WE started — and a treasury screen exists precisely to surface the
  // movement we did not. So the rows come from the block explorer, and each is
  // then annotated where we recognise its hash. A row with no label is the
  // interesting one.
  //
  // ⚠️ ON DEMAND, NEVER POLLED. See bscscan.ts's header, and the two real
  // billing incidents in CLAUDE.md that rule comes from.
  app.get("/staff/treasury/wallet", staffGuard("treasury.view", async (_ctx, req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse((req.query as Record<string, unknown>) ?? {});
    const address = await getSetting("treasury_address_bep20", "");
    if (!address) {
      return { chain: "bep20", address: "", explorerReady: bscscanReady(), rows: [], totals: null };
    }
    if (!bscscanReady()) {
      // Not an error — a deployment without the free explorer key simply has
      // nothing to show here, and saying so beats an empty table that reads as
      // "no money has ever moved".
      return { chain: "bep20", address, explorerReady: false, rows: [], totals: null };
    }

    const txs = await fetchTreasuryLedger(address, q.limit);
    const hashes = txs.map((t) => t.hash.toLowerCase());
    const labels = hashes.length === 0 ? new Map<string, string>() : await labelTreasuryHashes(hashes);

    const self = address.toLowerCase();
    let inMicro = 0n;
    let outMicro = 0n;
    for (const t of txs) {
      if (t.asset !== "USDT") continue;
      // Base units -> micro-USDT, the unit every other money figure in this API
      // is already in. BSC USDT is 18 decimals, NOT the 6 most deployments use.
      const micro = BigInt(t.value) / 10n ** BigInt(Math.max(0, t.decimals - 6));
      if (t.direction === "out") outMicro += micro; else inMicro += micro;
    }

    return {
      chain: "bep20",
      address,
      explorerReady: true,
      totals: { inMicro: Number(inMicro), outMicro: Number(outMicro), rows: txs.length },
      rows: txs.map((t) => ({
        hash: t.hash,
        at: t.at,
        asset: t.asset,
        direction: t.direction,
        // The other side of the transfer — who we paid, or who paid us.
        counterparty: t.direction === "out" ? t.to : t.from,
        value: t.value,
        decimals: t.decimals,
        micro: t.asset === "USDT"
          ? Number(BigInt(t.value) / 10n ** BigInt(Math.max(0, t.decimals - 6)))
          : null,
        self,
        label: labels.get(t.hash.toLowerCase()) ?? null,
      })),
    };
  }));

  // What each hash was, according to our own records. Five small IN-lookups
  // rather than one union view: each table stores its hash in its own column,
  // and a row we do not recognise must come back unlabelled rather than
  // silently matched to the wrong thing.
  async function labelTreasuryHashes(hashes: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ph = hashes.map(() => "?").join(",");
    const put = (h: unknown, label: string) => {
      const key = String(h ?? "").toLowerCase();
      if (key && !out.has(key)) out.set(key, label);
    };

    const [withdrawals, topups, refunds, sweeps, relays] = await Promise.all([
      sql.all<{ tx_hash: string; email: string }>(
        `SELECT w.tx_hash, u.email FROM withdrawal_requests w JOIN users u ON u.id = w.user_id
         WHERE LOWER(w.tx_hash) IN (${ph})`, ...hashes),
      sql.all<{ tx_hash: string; email: string }>(
        `SELECT t.tx_hash, u.email FROM usdt_topups t JOIN users u ON u.id = t.user_id
         WHERE LOWER(t.tx_hash) IN (${ph})`, ...hashes),
      sql.all<{ tx_hash: string; email: string }>(
        `SELECT r.tx_hash, u.email FROM usdt_refund_requests r JOIN users u ON u.id = r.user_id
         WHERE LOWER(r.tx_hash) IN (${ph})`, ...hashes),
      sql.all<{ sweep_tx_hash: string }>(
        `SELECT sweep_tx_hash FROM sweep_jobs WHERE LOWER(sweep_tx_hash) IN (${ph})`, ...hashes),
      sql.all<{ gas_tx_hash: string | null; prefund_tx_hash: string | null; forward_tx_hash: string | null }>(
        `SELECT gas_tx_hash, prefund_tx_hash, forward_tx_hash FROM payout_relay_jobs
         WHERE LOWER(gas_tx_hash) IN (${ph}) OR LOWER(prefund_tx_hash) IN (${ph})
            OR LOWER(forward_tx_hash) IN (${ph})`, ...hashes, ...hashes, ...hashes),
    ]);

    for (const r of withdrawals) put(r.tx_hash, `Withdrawal paid · ${r.email}`);
    for (const r of topups) put(r.tx_hash, `Deposit confirmed · ${r.email}`);
    for (const r of refunds) put(r.tx_hash, `Deposit refunded · ${r.email}`);
    for (const r of sweeps) put(r.sweep_tx_hash, "Deposit swept to treasury");
    for (const r of relays) {
      put(r.gas_tx_hash, "Payout relay · gas sent");
      put(r.prefund_tx_hash, "Payout relay · USDT prefund");
      put(r.forward_tx_hash, "Payout relay · forwarded to the user");
    }
    return out;
  }

  // How many accounts the button above would touch — so it can say so before
  // it is pressed, and disappear when there is nothing left to do.
  app.get("/staff/users/telegram/pending", staffGuard("users.list", async () => {
    const left = await sql.get<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM users
       WHERE telegram_id IS NOT NULL
         AND (telegram_username IS NULL OR telegram_username = '')
         AND (telegram_name IS NULL OR telegram_name = '')`,
    );
    return { pending: Number(left?.n ?? 0), batchSize: TELEGRAM_REFRESH_MAX };
  }));

  // ---- Admin: adjust a user's points by hand ------------------------------
  // This MINTS MONEY. Points are redeemable for real USDT, so a credit here is a
  // withdrawal from the treasury with extra steps. Constraints, all deliberate:
  //   - admin only (not manager, not agent)
  //   - a written reason is mandatory — it lands in the user's own ledger note
  //   - capped per adjustment (config.adminAdjustMaxPoints) so one stolen session
  //     or one extra zero cannot drain the treasury in a single call
  //   - written through postLedger, so it is an append-only entry like every
  //     other movement (guardrail #2) — never a mutable balance edit
  //   - a debit cannot push a user below zero
  //   - recorded in admin_audit_log against the staff member who did it
  const adjustSchema = z.object({
    points: z.number().int().refine((n) => n !== 0, "Enter a non-zero amount."),
    reason: z.string().trim().min(3, "Say why.").max(500),
  });
  app.post("/staff/users/:id/adjust", staffGuard("users.adjust", async ({ userId: actorId, role }, req, reply) => {
    const parsed = adjustSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Enter an amount (not zero) and a reason." });
    }
    const { points, reason } = parsed.data;
    const targetId = (req.params as { id: string }).id;

    if (Math.abs(points) > config.adminAdjustMaxPoints) {
      return reply.code(400).send({
        error: `One adjustment cannot be more than ${config.adminAdjustMaxPoints} points.`,
      });
    }

    const target = await sql.get<{ id: string }>("SELECT id FROM users WHERE id = ?", targetId);
    if (!target) return reply.code(404).send({ error: "User not found." });

    const result = await sql.tx(async (t) => {
      // Lock the row so a concurrent withdrawal can't race a debit past zero.
      await t.run("SELECT pg_advisory_xact_lock(hashtext(?))", targetId);
      const before = await balanceOf(targetId, t);
      if (points < 0 && before + points < 0) {
        throw { statusCode: 400, message: `That would take the balance below zero (they have ${before}).` };
      }
      const entryId = await postLedger({
        userId: targetId,
        points: Math.abs(points),
        direction: points > 0 ? "credit" : "debit",
        sourceType: "admin_adjustment",
        note: reason,
      }, t);
      // previous/new are the BALANCE, not the delta — the delta is already in
      // `detail`, and "they went from 400 to 1400" is the sentence anyone
      // reviewing a minted-points row is actually trying to reconstruct.
      await logAudit({
        actorUserId: actorId, actorRole: role, action: "points_adjusted",
        targetUserId: targetId,
        detail: `${points > 0 ? "+" : ""}${points} points — ${reason}`,
        previousValue: before, newValue: before + points,
        actorIp: req.ip,
      }, t);
      return { entryId, before, after: before + points };
    });
    return { ok: true, ...result };
  }));

  // ---- Admin: adjust a user's USDT deposit-credit balance by hand ---------
  // Built for reconciliation. When usdt_ledger holds a credit no real on-chain
  // USDT ever backed (the 2026-08-12 double-credit residue), the hourly
  // treasury check (deposits/reconcile.ts) flags a shortfall EVERY hour and
  // never stops — and every hour it re-creates the fraud flag you just
  // resolved. A correcting debit here brings the books back to what the chain
  // actually holds, which is what makes both stop.
  //
  // Same guardrails as the points adjust: admin only, mandatory reason,
  // capped, append-only (postUsdt — guardrail #2), advisory lock, audit-logged.
  // UNLIKE the points adjust, a debit MAY take the balance negative — that is
  // the point: the recorded balance was wrong and the true entitlement is
  // lower. The resulting balance is returned so the caller sees it.
  const usdtAdjustSchema = z.object({
    usdt: z.number().refine((n) => n !== 0, "Enter a non-zero amount."),
    chain: z.string().trim().min(1).max(20).optional(),
    reason: z.string().trim().min(3, "Say why.").max(500),
  });
  const MAX_USDT_ADJUST_MICRO = 200_000_000; // $200 per single call
  app.post("/staff/users/:id/usdt-adjust", staffGuard("users.adjust", async ({ userId: actorId, role }, req, reply) => {
    const parsed = usdtAdjustSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Enter an amount and a reason." });
    }
    const { usdt, reason } = parsed.data;
    const chain = parsed.data.chain ?? "bep20";
    const targetId = (req.params as { id: string }).id;
    const micro = Math.round(usdt * 1_000_000);
    if (micro === 0) return reply.code(400).send({ error: "That rounds to zero USDT." });
    if (Math.abs(micro) > MAX_USDT_ADJUST_MICRO) {
      return reply.code(400).send({ error: `One adjustment cannot be more than $${MAX_USDT_ADJUST_MICRO / 1e6}.` });
    }

    const target = await sql.get<{ id: string }>("SELECT id FROM users WHERE id = ?", targetId);
    if (!target) return reply.code(404).send({ error: "User not found." });

    const result = await sql.tx(async (t) => {
      // Lock the row so a concurrent rig purchase / refund can't race this.
      await t.run("SELECT pg_advisory_xact_lock(hashtext(?))", targetId);
      const beforeRow = await t.get<{ bal: string | number }>(
        "SELECT COALESCE(SUM(amount), 0) AS bal FROM usdt_ledger WHERE user_id = ?", targetId,
      );
      const beforeMicro = Number(beforeRow?.bal ?? 0);
      const entryId = await postUsdt({
        userId: targetId,
        micro: Math.abs(micro),
        direction: micro > 0 ? "credit" : "debit",
        sourceType: "admin_adjustment",
        note: reason,
        chain,
      }, t);
      await logAudit({
        actorUserId: actorId, actorRole: role, action: "usdt_adjusted",
        targetUserId: targetId,
        detail: `${micro > 0 ? "+" : ""}${(micro / 1e6).toFixed(6)} USDT (${chain}) — ${reason}`,
        previousValue: (beforeMicro / 1e6).toFixed(6),
        newValue: ((beforeMicro + micro) / 1e6).toFixed(6),
        actorIp: req.ip,
      }, t);
      return { entryId, beforeMicro, afterMicro: beforeMicro + micro };
    });
    return { ok: true, ...result };
  }));

  // ---- Admin: appoint / remove staff --------------------------------------
  app.get("/staff/staff", staffGuard("staff.manage", async () => {
    const rows = await sql.all<{ user_id: string; email: string; role: Role; created_at: string }>(
      `SELECT a.user_id, u.email, a.role, a.created_at
       FROM admin_users a JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at ASC`,
    );
    return {
      staff: rows.map((r) => ({
        userId: r.user_id, email: r.email, role: r.role, at: r.created_at,
        roleLabel: ROLE_LABELS[r.role] ?? r.role,
      })),
      // The picker's options come from the server, so a role added in
      // permissions.ts appears in the panel without a web deploy — and, more to
      // the point, the panel can never offer a role the API would then refuse.
      roles: ROLES.map((id) => ({
        id, label: ROLE_LABELS[id],
        permissions: [...ROLE_PERMISSIONS[id]],
      })),
    };
  }));

  // Every role permissions.ts knows about, plus "none" to strip access. Built
  // from ROLES rather than typed out, so the two cannot disagree.
  const roleSchema = z.object({
    role: z.string().refine((r) => r === "none" || isRole(r), "Pick a role."),
  });
  app.put("/staff/staff/:id", staffGuard("staff.manage", async ({ userId: actorId, role: actorRole }, req, reply) => {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Pick a role." });
    const targetId = (req.params as { id: string }).id;
    const next = parsed.data.role as Role | "none";

    const target = await sql.get<{ id: string }>("SELECT id FROM users WHERE id = ?", targetId);
    if (!target) return reply.code(404).send({ error: "User not found." });

    const previous = await sql.get<{ role: Role }>(
      "SELECT role FROM admin_users WHERE user_id = ?", targetId,
    );

    // Lockout protection: never let the last admin demote or remove themselves.
    // Without this, one click can leave the product with no one who can appoint
    // anyone — recoverable only by editing the database by hand.
    //
    // ⚠️ THE TEST IS `staff.manage`, NOT the literal role 'admin'. With nine
    // roles, "is there another admin?" is the wrong question — what must never
    // reach zero is the number of accounts that can still HAND OUT ROLES. Any
    // future role granting staff.manage counts, and counting only 'admin' would
    // both refuse a legitimate demotion and, worse, allow the real last
    // key-holder to be removed if they ever held that permission under another
    // role name.
    if (next === "none" || !permissionsOf(next).includes("staff.manage")) {
      const keyHolders = ROLES.filter((r) => ROLE_PERMISSIONS[r].includes("staff.manage"));
      const others = await sql.get<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM admin_users
          WHERE user_id <> ? AND role = ANY(?)`,
        targetId, keyHolders,
      );
      const targetHeldKeys = previous && permissionsOf(previous.role).includes("staff.manage");
      if (targetHeldKeys && (others?.n ?? 0) === 0) {
        return reply.code(400).send({
          error: "This is the last account that can appoint staff. Appoint another one first.",
        });
      }
    }

    await sql.tx(async (t) => {
      if (next === "none") {
        await t.run("DELETE FROM admin_users WHERE user_id = ?", targetId);
      } else {
        await t.run(
          "INSERT INTO admin_users (user_id, role, created_at) VALUES (?,?,?) " +
          "ON CONFLICT(user_id) DO UPDATE SET role = EXCLUDED.role",
          targetId, next, now(),
        );
      }
      await logAudit({
        actorUserId: actorId, actorRole,
        action: next === "none" ? "staff_removed" : "staff_role_set",
        targetUserId: targetId, detail: next,
        previousValue: previous?.role ?? "none", newValue: next,
        actorIp: req.ip,
      }, t);
    });
    return { ok: true, role: next };
  }));

  // ---- Money & payouts: the overview screen ------------------------------
  // Founder, 2026-09-01: "make it comprehensive — how much the platform holds
  // right now, and how much flows in vs out over 1h / 24h / 7d / 30d / 1y / all
  // time". Every figure is derived from a ledger or a request table, so it
  // cannot drift. USDT is carried in micro (1e6) end to end; points are
  // converted at config.pointsPerUsdt only where a USDT figure is asked for.
  app.get("/staff/money/overview", staffGuard("withdrawals.view", async () => {
    const scalarM = async (text: string, ...p: unknown[]) =>
      Number((await sql.get<{ v: string | number }>(text, ...p))?.v ?? 0);
    const toMicro = (points: number) => Math.round((points / config.pointsPerUsdt) * 1_000_000);

    // ---- what the platform holds right now ----
    // Latest reconciliation snapshot per chain carries the on-chain balance
    // (treasury hot wallet + known-unswept deposit addresses).
    const snaps = await sql.all<{ chain: string; onchain_balance: string | number; checked_at: string }>(
      `SELECT DISTINCT ON (chain) chain, onchain_balance, checked_at
         FROM treasury_balance_snapshots ORDER BY chain, checked_at DESC`,
    );
    const treasuryMicro: Record<string, number> = {};
    let treasuryTotalMicro = 0;
    for (const s of snaps) {
      treasuryMicro[s.chain] = Number(s.onchain_balance);
      treasuryTotalMicro += Number(s.onchain_balance);
    }
    const [pointsCredited, pointsDebited, usdtDepositLiabilityMicro,
           paidPoints, pendingPoints, feePoints] = await Promise.all([
      scalarM("SELECT COALESCE(SUM(amount),0) AS v FROM ledger_entries WHERE amount > 0"),
      scalarM("SELECT COALESCE(SUM(-amount),0) AS v FROM ledger_entries WHERE amount < 0"),
      scalarM("SELECT COALESCE(SUM(amount),0) AS v FROM usdt_ledger"),
      scalarM("SELECT COALESCE(SUM(amount),0) AS v FROM withdrawal_requests WHERE status = 'paid'"),
      scalarM("SELECT COALESCE(SUM(amount),0) AS v FROM withdrawal_requests WHERE status IN ('pending','agent_approved','manager_approved','sending')"),
      scalarM("SELECT COALESCE(SUM(COALESCE(fee_points,0)),0) AS v FROM withdrawal_requests WHERE status = 'paid'"),
    ]);
    const outstandingPoints = pointsCredited - pointsDebited;

    // ---- inflow / outflow per time window ----
    const WINDOWS: { key: string; since: string | null }[] = [
      { key: "h1", since: new Date(Date.now() - 3_600_000).toISOString() },
      { key: "h24", since: new Date(Date.now() - 24 * 3_600_000).toISOString() },
      { key: "d7", since: new Date(Date.now() - 7 * 86_400_000).toISOString() },
      { key: "d30", since: new Date(Date.now() - 30 * 86_400_000).toISOString() },
      { key: "d365", since: new Date(Date.now() - 365 * 86_400_000).toISOString() },
      { key: "all", since: null },
    ];
    async function flowFor(since: string | null) {
      const g = (col: string) => (since ? ` AND ${col} >= ?` : "");
      const a = since ? [since] : [];
      const [depIn, wdOutPts, rfOutMicro, bnbRow] = await Promise.all([
        // Money IN: confirmed USDT deposit credits.
        scalarM(`SELECT COALESCE(SUM(amount),0) AS v FROM usdt_ledger WHERE direction='credit' AND source_type='topup'${g("created_at")}`, ...a),
        // Money OUT: what was actually SENT — net of the withdrawal fee, keyed
        // on paid_at (when it left), converted to USDT.
        scalarM(`SELECT COALESCE(SUM(amount - COALESCE(fee_points,0)),0) AS v FROM withdrawal_requests WHERE status='paid'${g("paid_at")}`, ...a),
        // Money OUT: deposit refunds, net of the gas fee, keyed on reviewed_at.
        scalarM(`SELECT COALESCE(SUM(amount - COALESCE(fee_micro,0)),0) AS v FROM usdt_refund_requests WHERE status='paid'${g("reviewed_at")}`, ...a),
        // BNB gas sent out. Kept as a STRING all the way — wei is 18-decimal
        // and a running total quickly exceeds Number.MAX_SAFE_INTEGER; a
        // Number round-trip would silently lose precision and then render
        // "0 BNB" once it hit scientific notation.
        sql.get<{ v: string | number }>(
          `SELECT COALESCE(SUM(CAST(amount_wei AS NUMERIC)),0)::text AS v FROM bnb_withdrawal_requests WHERE status='paid'${g("completed_at")}`,
          ...a,
        ),
      ]);
      const withdrawalsOutMicro = toMicro(wdOutPts);
      const outMicro = withdrawalsOutMicro + rfOutMicro;
      return {
        depositsInMicro: depIn,
        withdrawalsOutMicro,
        refundsOutMicro: rfOutMicro,
        outMicro,
        bnbOutWei: String(bnbRow?.v ?? "0"),
        netMicro: depIn - outMicro,
      };
    }
    const flowsArr = await Promise.all(WINDOWS.map((w) => flowFor(w.since)));
    const flows: Record<string, Awaited<ReturnType<typeof flowFor>>> = {};
    WINDOWS.forEach((w, i) => { flows[w.key] = flowsArr[i]; });

    // ---- latest 5 of each stream (a glance; each links to the full queue) ----
    const rows = <T>(t: string, ...p: unknown[]) => sql.all<T>(t, ...p);
    const [lw, ld, lr, lb, lj] = await Promise.all([
      rows<Record<string, unknown>>(`SELECT w.id, u.email, w.amount, w.status, w.created_at AS at FROM withdrawal_requests w JOIN users u ON u.id = w.user_id ORDER BY w.created_at DESC LIMIT 5`),
      rows<Record<string, unknown>>(`SELECT t.id, u.email, t.amount, t.status, t.created_at AS at FROM usdt_topups t JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC LIMIT 5`),
      rows<Record<string, unknown>>(`SELECT r.id, u.email, r.amount, r.status, r.created_at AS at FROM usdt_refund_requests r JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC LIMIT 5`),
      rows<Record<string, unknown>>(`SELECT b.id, u.email, b.amount_wei, b.status, b.created_at AS at FROM bnb_withdrawal_requests b JOIN users u ON u.id = b.user_id ORDER BY b.created_at DESC LIMIT 5`),
      rows<Record<string, unknown>>(`SELECT j.id, u.email, j.amount_micro, j.status, j.created_at AS at FROM payout_relay_jobs j JOIN users u ON u.id = j.user_id WHERE j.status = 'failed' ORDER BY j.created_at DESC LIMIT 5`),
    ]);

    return {
      heldNow: {
        treasuryMicro, treasuryTotalMicro,
        outstandingPoints, pointsLiabilityMicro: toMicro(outstandingPoints),
        usdtDepositLiabilityMicro,
        checkedAt: snaps[0]?.checked_at ?? null,
      },
      windows: WINDOWS.map((w) => w.key),
      flows,
      latest: {
        withdrawals: lw.map((r) => ({ id: r.id, email: r.email, points: Number(r.amount), usdtMicro: toMicro(Number(r.amount)), status: r.status, at: r.at })),
        deposits: ld.map((r) => ({ id: r.id, email: r.email, usdtMicro: Number(r.amount), status: r.status, at: r.at })),
        refunds: lr.map((r) => ({ id: r.id, email: r.email, usdtMicro: Number(r.amount), status: r.status, at: r.at })),
        bnb: lb.map((r) => ({ id: r.id, email: r.email, wei: String(r.amount_wei), status: r.status, at: r.at })),
        relayFailed: lj.map((r) => ({ id: r.id, email: r.email, usdtMicro: Number(r.amount_micro), status: r.status, at: r.at })),
      },
      owed: {
        outstandingPoints, outstandingMicro: toMicro(outstandingPoints),
        paidPoints, paidMicro: toMicro(paidPoints),
        pendingPoints, pendingMicro: toMicro(pendingPoints),
        feePoints,
      },
    };
  }));

  // ---- Admin: the money view ----------------------------------------------
  // Every figure is derived from the ledger, so it cannot drift from reality.
  // `outstanding` is the liability that matters: points users hold that they can
  // still cash out. Compare it against the treasury before you spend.
  app.get("/staff/money", staffGuard("money.view", async (_ctx, req) => {
    const one = async (text: string, ...p: unknown[]) =>
      (await sql.get<{ v: number }>(text, ...p))?.v ?? 0;

    const [credited, debited, paidPoints, pendingPoints, feePoints, adjustments] = await Promise.all([
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM ledger_entries WHERE amount > 0"),
      one("SELECT COALESCE(SUM(-amount),0)::int AS v FROM ledger_entries WHERE amount < 0"),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM withdrawal_requests WHERE status = 'paid'"),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM withdrawal_requests WHERE status IN ('pending','agent_approved','manager_approved')"),
      one("SELECT COALESCE(SUM(COALESCE(fee_points,0)),0)::int AS v FROM withdrawal_requests WHERE status = 'paid'"),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM ledger_entries WHERE source_type = 'admin_adjustment'"),
    ]);

    // ⚠️ Default 10, not the old flat 50 (founder, 2026-08-27): this widget is
    // meant to be a glance, not the log — "See more" on the panel jumps to the
    // full, cursor-paginated Audit section (GET /staff/audit) instead.
    const limit = Math.min(Math.max(Number((req.query as { limit?: string }).limit ?? 10) || 10, 1), 100);
    const [recentAudit, auditTotal] = await Promise.all([
      sql.all(
        `SELECT a.action, a.detail, a.created_at, a.actor_role,
                actor.email AS actor_email, target.email AS target_email
         FROM admin_audit_log a
         JOIN users actor ON actor.id = a.actor_user_id
         LEFT JOIN users target ON target.id = a.target_user_id
         ORDER BY a.created_at DESC LIMIT ?`,
        limit,
      ),
      one("SELECT COUNT(*)::int AS v FROM admin_audit_log"),
    ]);

    return {
      points: {
        credited, debited, adjustments,
        outstanding: credited - debited, // live user liability
        paidPoints, pendingPoints, feePoints,
      },
      usdt: {
        outstanding: pointsToUsdt(credited - debited),
        paid: pointsToUsdt(paidPoints),
        pending: pointsToUsdt(pendingPoints),
      },
      recentAudit,
      auditTotal,
    };
  }));

  // ---- Admin: CSV export --------------------------------------------------
  // Quotes are doubled per RFC 4180 so a comma or quote in an email or a
  // free-text reason cannot shift columns.
  //
  // A leading = + - @ (or tab/CR) makes Excel treat the cell as a FORMULA, and
  // RFC quoting does not stop that — Excel strips the quotes first. Some of
  // these fields are user-supplied (emails), so prefix those cells with a single
  // quote, which Excel renders as plain text.
  const csv = (rows: Record<string, unknown>[]): string => {
    if (!rows.length) return "";
    const cols = Object.keys(rows[0]);
    const cell = (v: unknown) => {
      const s = String(v ?? "");
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
  };

  app.get("/staff/export/:what", staffGuard("export.data", async (_ctx, req, reply) => {
    const what = (req.params as { what: string }).what;
    let rows: Record<string, unknown>[];

    if (what === "ledger") {
      rows = await sql.all(
        `SELECT l.created_at, u.email, l.amount, l.direction, l.source_type, l.note
         FROM ledger_entries l JOIN users u ON u.id = l.user_id
         ORDER BY l.created_at DESC LIMIT 10000`,
      );
    } else if (what === "withdrawals") {
      rows = await sql.all(
        `SELECT w.created_at, u.email, w.amount, w.fee_points, w.payout_rail, w.payout_address,
                w.status, w.tx_hash, w.paid_at
         FROM withdrawal_requests w JOIN users u ON u.id = w.user_id
         ORDER BY w.created_at DESC LIMIT 10000`,
      );
    } else if (what === "audit") {
      rows = await sql.all(
        `SELECT a.created_at, actor.email AS actor, a.actor_role, a.action,
                target.email AS target, a.detail,
                a.previous_value, a.new_value, a.actor_ip
         FROM admin_audit_log a
         JOIN users actor ON actor.id = a.actor_user_id
         LEFT JOIN users target ON target.id = a.target_user_id
         ORDER BY a.created_at DESC LIMIT 10000`,
      );
    } else if (what === "users") {
      // Same search filter as GET /staff/users (email or exact id), so
      // "Export" on the Users panel exports the WHOLE matching set, not just
      // the short page currently on screen. Balance/open-flags/held computed
      // the same way that list endpoint does, for the same reason: a number
      // here that disagrees with the one on screen is worse than no number.
      const q = ((req.query as { q?: string }).q ?? "").trim().toLowerCase();
      rows = await sql.all(
        `SELECT u.created_at, u.email, u.id, u.country, u.status,
                COALESCE((SELECT SUM(amount) FROM ledger_entries l WHERE l.user_id = u.id), 0)::int AS balance,
                COALESCE((SELECT COUNT(*) FROM fraud_flags f WHERE f.user_id = u.id AND f.resolved_by IS NULL), 0)::int AS open_flags,
                (u.withdrawal_hold_reason IS NOT NULL
                  AND (u.withdrawal_hold_until IS NULL OR u.withdrawal_hold_until > ?)) AS payouts_held
         FROM users u
         WHERE (? = '' OR LOWER(u.email) LIKE ? OR LOWER(u.id) = ?)
         ORDER BY u.created_at DESC LIMIT 10000`,
        now(), q, `%${q}%`, q,
      );
    } else {
      return reply.code(404).send({ error: "Unknown export." });
    }

    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${what}.csv"`)
      .send(csv(rows));
  }));

  // ---- Audit log (brief part 46) -------------------------------------------
  // The append-only record of every privileged action, readable in the panel
  // rather than only as a CSV export. Filterable by who did it, what they did,
  // and who it was done to — the three questions anyone actually arrives with.
  //
  // Deliberately readable by MANAGERS and analysts, not just admins: an audit
  // log only one person can read is not an audit log, it is that person's diary.
  app.get("/staff/audit", staffGuard("audit.view", async (_ctx, req) => {
    const q = req.query as {
      actor?: string; action?: string; target?: string;
      since?: string; limit?: string; cursor?: string;
    };
    const where: string[] = [];
    const args: unknown[] = [];
    // Matched against the EMAIL, because that is what a person has in front of
    // them; the ids are internal.
    if (q.actor) { where.push("actor.email ILIKE ?"); args.push(`%${q.actor}%`); }
    if (q.target) { where.push("target.email ILIKE ?"); args.push(`%${q.target}%`); }
    if (q.action) { where.push("a.action = ?"); args.push(q.action); }
    if (q.since) { where.push("a.created_at >= ?"); args.push(q.since); }
    // Keyset pagination on created_at: an audit log only grows, and OFFSET on a
    // growing table silently skips rows as new ones land at the top.
    if (q.cursor) { where.push("a.created_at < ?"); args.push(q.cursor); }

    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const rows = await sql.all<Record<string, unknown>>(
      `SELECT a.id, a.created_at, a.action, a.actor_role, a.detail,
              a.previous_value, a.new_value, a.actor_ip,
              actor.email AS actor_email, a.actor_user_id,
              target.email AS target_email, a.target_user_id
         FROM admin_audit_log a
         JOIN users actor ON actor.id = a.actor_user_id
         LEFT JOIN users target ON target.id = a.target_user_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY a.created_at DESC
        LIMIT ${limit + 1}`,
      ...args,
    );
    const page = rows.slice(0, limit);
    return {
      entries: page.map((r) => ({
        id: r.id, at: r.created_at, action: r.action, actorRole: r.actor_role,
        actorEmail: r.actor_email, actorUserId: r.actor_user_id,
        targetEmail: r.target_email ?? null, targetUserId: r.target_user_id ?? null,
        detail: r.detail ?? null,
        previousValue: r.previous_value ?? null,
        newValue: r.new_value ?? null,
        ip: r.actor_ip ?? null,
      })),
      // Null when this is the last page, so the panel knows to stop asking.
      nextCursor: rows.length > limit ? String(page[page.length - 1].created_at) : null,
    };
  }));

  // ---- Analytics (brief part 48) ------------------------------------------
  // ---- Dashboard "needs attention" + activity feed (admin rebuild, Phase B) --
  // One request the landing page opens with: the size of every work queue, the
  // things that mean money is stuck or unreconciled, and the last few admin
  // actions. All counts, all derived — no new table.
  app.get("/staff/dashboard", staffGuard("analytics.view", async () => {
    const one = async (text: string, ...params: unknown[]) =>
      Number((await sql.get<{ v: number }>(text, ...params))?.v ?? 0);

    // "Cleared" counts look back over this window so a tile can read
    // "5 total · 3 cleared · 2 open" and go green once everything is handled,
    // instead of a red number that only ever climbs (founder, 2026-08-30).
    const clearWindow = new Date(Date.now() - 7 * 86_400_000).toISOString();

    const [
      wPending, wReady, deposits, refunds,
      bnbOpen, bnbCleared, relayOpen, relayCleared,
      fraudOpen, fraudCleared, kycWaiting, openTickets,
    ] = await Promise.all([
      one("SELECT COUNT(*)::int AS v FROM withdrawal_requests WHERE status = 'pending'"),
      one("SELECT COUNT(*)::int AS v FROM withdrawal_requests WHERE status IN ('agent_approved','manager_approved')"),
      one("SELECT COUNT(*)::int AS v FROM usdt_topups WHERE status = 'pending'"),
      one("SELECT COUNT(*)::int AS v FROM usdt_refund_requests WHERE status = 'pending'"),
      one("SELECT COUNT(*)::int AS v FROM bnb_withdrawal_requests WHERE status = 'failed' AND handled_at IS NULL"),
      one("SELECT COUNT(*)::int AS v FROM bnb_withdrawal_requests WHERE status = 'failed' AND handled_at IS NOT NULL AND handled_at > ?", clearWindow),
      one("SELECT COUNT(*)::int AS v FROM payout_relay_jobs WHERE status = 'failed' AND handled_at IS NULL"),
      one("SELECT COUNT(*)::int AS v FROM payout_relay_jobs WHERE status = 'failed' AND handled_at IS NOT NULL AND handled_at > ?", clearWindow),
      // Matches GET /staff/fraud — a suspended user's flags are auto-closed, so
      // they must not keep the tile red with nothing behind it to clear.
      one(`SELECT COUNT(*)::int AS v FROM fraud_flags f LEFT JOIN users u ON u.id = f.user_id
            WHERE f.resolved_by IS NULL AND (f.user_id IS NULL OR u.status <> 'suspended')`),
      one("SELECT COUNT(*)::int AS v FROM fraud_flags WHERE resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolved_at > ?", clearWindow),
      one("SELECT COUNT(*)::int AS v FROM users WHERE kyc_status = 'pending'"),
      one("SELECT COUNT(*)::int AS v FROM support_tickets WHERE status = 'open'"),
    ]);

    // Latest reconciliation snapshot per chain — a negative delta means the
    // treasury holds LESS than the ledger says we owe (CUSTODY_SPEC.md § 3.5).
    const recon = await sql.all<{ chain: string; delta: string | number; checked_at: string }>(
      `SELECT DISTINCT ON (chain) chain, delta, checked_at
         FROM treasury_balance_snapshots ORDER BY chain, checked_at DESC`,
    );
    const reconShortfall = recon.filter((r) => Number(r.delta) < 0);
    // A chain that showed a shortfall in the window but whose latest check is
    // back in the black counts as "cleared" — the books were corrected.
    const reconEverNegInWindow = await one(
      "SELECT COUNT(DISTINCT chain)::int AS v FROM treasury_balance_snapshots WHERE delta < 0 AND checked_at > ?",
      clearWindow,
    );
    const reconCleared = Math.max(0, reconEverNegInWindow - reconShortfall.length);

    // "recentActivity" was removed from this response 2026-09-01 (founder): it
    // duplicated the Audit log, which is its own section and the one place the
    // full record belongs. The dashboard is "what needs doing", not "what just
    // happened".
    return {
      attention: {
        withdrawalsPending: wPending, withdrawalsReady: wReady,
        depositsPending: deposits, refundsPending: refunds,
        // These four carry an open + recently-cleared count so the tile can go
        // green once everything is handled, instead of only ever showing red.
        bnbFailed: { open: bnbOpen, cleared: bnbCleared },
        relayFailed: { open: relayOpen, cleared: relayCleared },
        fraudOpen: { open: fraudOpen, cleared: fraudCleared },
        reconciliationShortfall: { open: reconShortfall.length, cleared: reconCleared },
        kycWaiting, ticketsOpen: openTickets,
      },
      reconciliation: recon.map((r) => ({ chain: r.chain, delta: Number(r.delta), checkedAt: r.checked_at })),
    };
  }));

  // Everything here is derived from tables that already exist — see
  // analytics.ts. Separate from /staff/kpis, which stays as the small
  // at-a-glance strip; this is the full report the dashboard's charts read.
  app.get("/staff/analytics", staffGuard("analytics.view", async (_ctx, req) => {
    // A nonsense value falls back to the DEFAULT, not to the minimum. `days=-5`
    // clamped upward would quietly answer with 7 days, which is a number the
    // caller never asked for and cannot tell apart from a real 7-day window.
    // The clamp still applies to values that are merely out of range — an
    // unbounded `days` is an unbounded generate_series.
    const raw = Number((req.query as { days?: string }).days);
    const days = Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(raw, 7), 90) : 30;
    return await loadAnalytics(days);
  }));

  // ---- Feature flags (brief part 44) --------------------------------------
  // One screen to switch a feature off without a deploy. The panel shows what
  // each flag actually DOES and where it is enforced, because a switch nobody
  // can predict the effect of does not get used in the incident it was built for.
  app.get("/staff/flags", staffGuard("flags.manage", async () => {
    const state = await allFlags();
    return {
      flags: FLAG_IDS.map((id) => ({
        id, enabled: state[id],
        label: FLAGS[id].label,
        effect: FLAGS[id].effect,
        enforcedAt: FLAGS[id].enforcedAt,
        // Honest about the one flag that only hides a screen: a BNB deposit is
        // someone sending to an address on a public chain, and nothing we
        // deploy can stop that.
        displayOnly: Boolean(FLAGS[id].displayOnly),
      })),
    };
  }));

  app.patch("/staff/flags/:id", staffGuard("flags.manage", async ({ userId, role }, req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!isFlagId(id)) return reply.code(404).send({ error: "Unknown feature." });
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Send enabled: true or false." });

    const was = await flagEnabled(id);
    await setFlag(id, parsed.data.enabled);
    // Switching a feature off is exactly the kind of change that gets
    // discovered hours later by someone asking "why can nobody withdraw?".
    await logAudit({
      actorUserId: userId, actorRole: role, action: "feature_flag_toggle",
      detail: `${id} — ${FLAGS[id].label}`,
      previousValue: was ? "on" : "off",
      newValue: parsed.data.enabled ? "on" : "off",
      actorIp: req.ip,
    });
    return { ok: true, id, enabled: parsed.data.enabled };
  }));

  // The distinct action names actually present, for the filter dropdown. Read
  // from the DATA, not a hardcoded list — a new action shows up in the filter
  // the first time it happens, and a list that has to be maintained by hand is
  // one that quietly stops matching what the code writes.
  app.get("/staff/audit/actions", staffGuard("audit.view", async () => {
    const rows = await sql.all<{ action: string; n: number }>(
      `SELECT action, COUNT(*)::int AS n FROM admin_audit_log
        GROUP BY action ORDER BY action ASC`,
    );
    return { actions: rows.map((r) => ({ action: r.action, count: r.n })) };
  }));
}

// One decision, shared by the single-click suspend/restore route and the bulk
// route above, so the two can never drift into different rules about what a
// status change means (same pattern as staffTasks.ts's decideProof).
async function setUserStatusOne(
  ctx: { actorId: string; role: Role; actorIp?: string },
  targetId: string,
  status: "active" | "suspended",
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Locking yourself out of your own product is a bad afternoon — and in a
  // bulk batch, this must reject ONLY the actor's own row, not the whole
  // selection.
  if (targetId === ctx.actorId && status === "suspended") {
    return { ok: false, error: "You cannot suspend your own account." };
  }
  const target = await sql.get<{ id: string; status: string }>("SELECT id, status FROM users WHERE id = ?", targetId);
  if (!target) return { ok: false, error: "User not found." };

  await sql.tx(async (t) => {
    await t.run("UPDATE users SET status = ? WHERE id = ?", status, targetId);
    // Suspending an account closes out its open fraud flags automatically
    // (founder, 2026-09-02: "if I suspend the account you don't need to keep
    // showing its flags"). The trail is kept — resolved_by records it was the
    // suspension, not a manual dismissal — so nothing is lost.
    if (status === "suspended") {
      await t.run(
        `UPDATE fraud_flags
           SET resolved_by = 'system:suspended', resolved_at = ?,
               resolution_note = COALESCE(resolution_note, ?)
         WHERE user_id = ? AND resolved_by IS NULL`,
        now(), `Auto-closed: account suspended — ${reason}`, targetId,
      );
    }
    await logAudit({
      actorUserId: ctx.actorId, actorRole: ctx.role,
      action: status === "suspended" ? "user_suspended" : "user_restored",
      targetUserId: targetId, detail: reason,
      previousValue: target.status, newValue: status,
      actorIp: ctx.actorIp,
    }, t);
  });
  return { ok: true };
}
