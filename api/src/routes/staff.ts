import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  sql, now, newId, balanceOf, roziBalanceMicroOf, usdtBalanceMicroOf,
  postLedger, postEarnedUsdt, logAudit, getSetting, setSetting,
} from "../db.ts";
import { config } from "../config.ts";
import { requirePermission, canApproveAmount, hasPermission, type Role, type Permission } from "../roles.ts";
import { ROLES, ROLE_LABELS, ROLE_PERMISSIONS, isRole, permissionsOf } from "../permissions.ts";
import { getPayoutProvider, pointsToUsdt } from "../payout.ts";
import { relayAvailable, createRelayJob } from "../payoutRelay.ts";
import { validateAddress, type ChainId } from "../chains.ts";
import { sendPushToUser } from "../push.ts";
import { kycFeatureEnabled } from "../kyc.ts";
import { getAutoWithdrawMaxPoints, getAutoRefundMaxMicro } from "../autoSettleSettings.ts";
import { FLAGS, FLAG_IDS, isFlagId, allFlags, setFlag, enabled as flagEnabled } from "../flags.ts";
import { loadAnalytics } from "../analytics.ts";

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
  app.get("/staff/withdrawals", staffGuard("withdrawals.view", async ({ role }, req) => {
    const status = (req.query as { status?: string }).status ?? "pending";
    // LEFT JOIN payout_relay_jobs so a 'sending' row (the relay pass-through
    // routing THROUGH the user's own address — see payoutRelay.ts) shows its
    // in-flight phase and tx hashes instead of looking stuck to staff.
    let rows = await sql.all<Record<string, unknown>>(
      `SELECT w.*, u.email AS user_email,
              j.status AS relay_status, j.from_address AS relay_from_address,
              j.gas_tx_hash AS relay_gas_tx_hash, j.prefund_tx_hash AS relay_prefund_tx_hash,
              j.forward_tx_hash AS relay_forward_tx_hash, j.last_error AS relay_last_error
       FROM withdrawal_requests w
       JOIN users u ON u.id = w.user_id
       LEFT JOIN payout_relay_jobs j ON j.purpose = 'withdrawal' AND j.request_id = w.id
       WHERE w.status = ? ORDER BY w.created_at ASC`,
      status,
    );

    // A capped approver (agent, support) only sees what they could act on.
    // Asked as a PERMISSION, not as `role === "agent"`: the cap belongs to
    // whoever lacks `withdrawals.decide_any`, and hardcoding the one role that
    // happened to lack it in 2026 is how a new role silently gets shown — and
    // then allowed to approve — payouts above its limit.
    if (!hasPermission(role, "withdrawals.decide_any")) {
      rows = rows.filter((r) => (r.amount as number) <= config.agentApprovalMaxPoints);
    }
    return {
      // The hot wallet each chain's payouts are sent FROM (admin sets it in
      // Settings). Shown beside the queue so whoever is paying sends from the
      // right wallet. Public information once a payout has ever been made.
      treasury: {
        bep20: await getSetting("treasury_address_bep20", ""),
        base: await getSetting("treasury_address_base", ""),
        aptos: await getSetting("treasury_address_aptos", ""),
      },
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
      pendingTotal: OWED_STATUSES.includes(status) ? {
        count: rows.length,
        points: rows.reduce((a, r) => a + Number(r.amount), 0),
        usdt: pointsToUsdt(rows.reduce((a, r) => a + (Number(r.amount) - Number(r.fee_points ?? 0)), 0)),
      } : null,
      requests: rows.map((r) => ({
        id: r.id, userId: r.user_id, userEmail: r.user_email, amount: r.amount,
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

  // One-screen dispute view: user's balance, ledger, and fraud flags.
  app.get("/staff/users/:id", staffGuard("users.view", async (_ctx, req, reply) => {
    const id = (req.params as { id: string }).id;
    const user = await sql.get<Record<string, unknown>>(
      `SELECT id, email, username, display_name, country, referral_code, status, created_at,
              kyc_status, telegram_id,
              withdrawal_hold_reason, withdrawal_hold_until, withdrawal_hold_at
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
    const invitedBy = await sql.get<{ id: string; email: string; referral_code: string }>(
      `SELECT u.id, u.email, u.referral_code FROM users u
         WHERE u.id = (SELECT referred_by FROM users WHERE id = ?)`, id,
    );
    const invitees = await sql.all(
      `SELECT id, email, status, created_at FROM users
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
      },
      ledger, fraudFlags: flags, usdtRefunds, usdtTopups, withdrawals,
      paidSummary: { count: Number(paid?.n ?? 0), totalPoints: Number(paid?.total ?? 0) },
      invitedBy: invitedBy ?? null,
      invitees,
      inviteeCount,
      tickets,
      devices,
    };
  }));

  // Open fraud flags — managers/admins only.
  app.get("/staff/fraud", staffGuard("fraud.view", async () => {
    const flags = await sql.all(
      `SELECT f.*, u.email AS user_email FROM fraud_flags f
       LEFT JOIN users u ON u.id = f.user_id WHERE f.resolved_by IS NULL ORDER BY f.created_at DESC`,
    );
    return { flags };
  }));

  // Resolve a flag (managers/admins). Append-only spirit: we don't delete, we
  // stamp who cleared it and why, leaving the trail (docs/ARCHITECTURE.md).
  app.post("/staff/fraud/:id/resolve", staffGuard("fraud.resolve", async ({ userId }, req, reply) => {
    const note = (req.body as { note?: string })?.note;
    const id = (req.params as { id: string }).id;
    const res = await sql.run(
      "UPDATE fraud_flags SET resolved_by = ?, resolution_note = ? WHERE id = ? AND resolved_by IS NULL",
      userId, note ?? null, id,
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
    const q = req.query as { status?: string; q?: string; mine?: string };
    const status = q.status ?? "open";

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

    const rows = await sql.all<Record<string, unknown>>(
      `SELECT ti.*, u.email AS user_email, a.email AS assignee_email,
         (SELECT COUNT(*)::int FROM ticket_messages m
           WHERE m.ticket_id = ti.id AND m.author_role <> 'internal') AS message_count
       FROM support_tickets ti
       JOIN users u ON u.id = ti.user_id
       LEFT JOIN users a ON a.id = ti.assigned_to
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY ti.updated_at ASC LIMIT 200`,
      ...params,
    );

    // Counts per status, always over ALL tickets — never over the current
    // filter, or the tabs would each report the number of tickets matching
    // themselves and the badge would always read the same as the list.
    const counts = await sql.all<{ status: string; n: number }>(
      "SELECT status, COUNT(*)::int AS n FROM support_tickets GROUP BY status",
    );

    return {
      counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      tickets: rows.map((t) => ({
        id: t.id, userId: t.user_id, userEmail: t.user_email, subject: t.subject,
        status: t.status, messageCount: t.message_count,
        assignedTo: t.assigned_to, assigneeEmail: t.assignee_email,
        at: t.created_at, updatedAt: t.updated_at,
      })),
    };
  }));

  app.get("/staff/tickets/:id", staffGuard("support.view", async (_ctx, req, reply) => {
    const id = (req.params as { id: string }).id;
    const ticket = await sql.get<Record<string, unknown>>(
      `SELECT ti.*, u.email AS user_email, u.status AS user_status,
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
      `SELECT m.id, m.author_role, m.body, m.created_at, au.email AS author_email
       FROM ticket_messages m LEFT JOIN users au ON au.id = m.author_id
       WHERE m.ticket_id = ? ORDER BY m.created_at ASC`, id,
    );
    return {
      ticket: {
        id: ticket.id, userId: ticket.user_id, userEmail: ticket.user_email,
        userStatus: ticket.user_status, kycStatus: ticket.kyc_status, country: ticket.country,
        subject: ticket.subject, status: ticket.status, at: ticket.created_at,
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
  });
  app.post("/staff/tickets/:id/reply", staffGuard("support.reply", async ({ userId }, req, reply) => {
    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Type a reply first." });
    const id = (req.params as { id: string }).id;
    const internal = parsed.data.internal === true;

    const ticket = await sql.get<{ id: string; user_id: string; status: string }>(
      "SELECT id, user_id, status FROM support_tickets WHERE id = ?", id);
    if (!ticket) return reply.code(404).send({ error: "Ticket not found." });

    await sql.tx(async (t) => {
      await t.run(
        "INSERT INTO ticket_messages (id, ticket_id, author_role, author_id, body, created_at) VALUES (?,?,?,?,?,?)",
        newId(), id, internal ? "internal" : "staff", userId, parsed.data.message, now(),
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

  // ---- Admin: find users --------------------------------------------------
  // Search by email or id. Balance is summed from the ledger, never stored.
  // ⚠️ PAGINATED, DEFAULT PAGE SIZE 10 (founder, 2026-08-27): the dashboard
  // list used to hand back up to 200 rows in one screen. `offset` + `total`
  // let the panel show a short first page with a real "See more" rather than
  // a wall of rows — OFFSET is fine here (unlike the audit log) because this
  // list is read interactively, one page at a time, never scanned end to end.
  app.get("/staff/users", staffGuard("users.list", async (_ctx, req) => {
    const q = ((req.query as { q?: string }).q ?? "").trim().toLowerCase();
    const query = req.query as { limit?: string; offset?: string };
    const limit = Math.min(Number(query.limit ?? 10) || 10, 200);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);

    const [rows, totalRow] = await Promise.all([
      sql.all<{
        id: string; email: string; country: string; status: string; created_at: string; balance: number;
        openFlags: number; held: boolean;
      }>(
        `SELECT u.id, u.email, u.country, u.status, u.created_at,
                COALESCE((SELECT SUM(amount) FROM ledger_entries l WHERE l.user_id = u.id), 0)::int AS balance,
                COALESCE((SELECT COUNT(*) FROM fraud_flags f WHERE f.user_id = u.id AND f.resolved_by IS NULL), 0)::int AS "openFlags",
                (u.withdrawal_hold_reason IS NOT NULL
                  AND (u.withdrawal_hold_until IS NULL OR u.withdrawal_hold_until > ?)) AS held
         FROM users u
         WHERE (? = '' OR LOWER(u.email) LIKE ? OR LOWER(u.id) = ?)
         ORDER BY u.created_at DESC
         LIMIT ? OFFSET ?`,
        now(), q, `%${q}%`, q, limit, offset,
      ),
      sql.get<{ n: string | number }>(
        `SELECT COUNT(*) AS n FROM users u WHERE (? = '' OR LOWER(u.email) LIKE ? OR LOWER(u.id) = ?)`,
        q, `%${q}%`, q,
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

    const target = await sql.get<{ id: string; status: string }>("SELECT id, status FROM users WHERE id = ?", targetId);
    if (!target) return reply.code(404).send({ error: "User not found." });

    // Locking yourself out of your own product is a bad afternoon.
    if (targetId === actorId && parsed.data.status === "suspended") {
      return reply.code(400).send({ error: "You cannot suspend your own account." });
    }

    await sql.tx(async (t) => {
      await t.run("UPDATE users SET status = ? WHERE id = ?", parsed.data.status, targetId);
      await logAudit({
        actorUserId: actorId, actorRole: role,
        action: parsed.data.status === "suspended" ? "user_suspended" : "user_restored",
        targetUserId: targetId, detail: parsed.data.reason,
        previousValue: target.status, newValue: parsed.data.status,
        actorIp: req.ip,
      }, t);
    });
    return { ok: true, status: parsed.data.status };
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
