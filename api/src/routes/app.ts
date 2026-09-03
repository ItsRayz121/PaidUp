import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { sql, now, newId, balanceOf, getSetting, usdtBalanceMicroOf, earnedUsdtBalanceMicroOf, usdtToMicro } from "../db.ts";
import { config } from "../config.ts";
import { getUserId, requireActiveUser } from "../auth.ts";
import { loadMiningSettings } from "../mining/settings.ts";
import { getGasFeeRate } from "../fees.ts";
import { relayAvailable, hasEnoughGasForDisplay } from "../payoutRelay.ts";
import { pointsToUsdt } from "../payout.ts";
import { enabled as flagEnabled, requireFeature, allFlags } from "../flags.ts";
import { minWithdrawPointsNow, welcomeRepeatDaysNow } from "../settingsRuntime.ts";
import { loadLeaderboard, maskName } from "../leaderboard.ts";
import { fieldsForTask, publicField, validateAnswers } from "../taskFields.ts";
import { eligibility, userContext, type TargetingRow } from "../taskTargeting.ts";
import { campaignState, unavailableMessage } from "../taskLifecycle.ts";
import { recordDevice } from "../fraud.ts";
import { parseDataUrl } from "../kyc.ts";

// Wraps a handler so a thrown {statusCode,message} becomes a clean JSON error.
function guard(
  handler: (userId: string, req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = getUserId(req);
      await requireActiveUser(userId); // a suspended account is locked out here
      return await handler(userId, req, reply);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Something went wrong" });
    }
  };
}

type UserRow = { id: string; country: string; referral_code: string };

export async function appRoutes(app: FastifyInstance) {
  // Which features are switched on right now (flags.ts, brief part 44).
  //
  // The app reads this to HIDE what is off, so a user does not tap a button
  // that then refuses. It is not the security boundary — every route enforces
  // its own flag server-side, and this endpoint only saves the user a wasted
  // tap. Deliberately unauthenticated-shaped (still behind `guard`, but the
  // answer is the same for everyone): there is nothing per-user here.
  //
  // `welcomeRepeatDays` rides along on this same call for the same reason —
  // one more piece of "what should the app show right now" config with a
  // single global answer, and the home screen (its only reader) already
  // needs a request like this before deciding whether to mount the
  // first-run welcome overlay (WelcomeExperience.tsx).
  app.get("/features", guard(async () => ({
    features: await allFlags(),
    welcomeRepeatDays: await welcomeRepeatDaysNow(),
  })));

  // Offer feed for the user's country
  app.get("/tasks", guard(async (userId, req) => {
    const q = z.object({
      view: z.enum(["available", "mine", "history"]).catch("available"),
      cursor: z.coerce.number().int().min(0).catch(0),
      limit: z.coerce.number().int().min(1).max(100).catch(12),
    }).parse(req.query ?? {});
    // Feature flag (flags.ts). Returning an EMPTY LIST rather than a 403: the
    // task screen is a normal part of the app and a hard error there reads as a
    // broken app, whereas an empty feed with the usual "nothing right now"
    // state is exactly what a user sees on a quiet day anyway.
    if (!(await flagEnabled("tasks"))) return { tasks: [] };
    // Hide offers from a network the Admin has disabled. A task whose network
    // has no row yet (predates the networks table) still shows — absence = active.
    // Surveys (CPX) are not in this table at all: that wall is targeted by the
    // user's IP, so it is already worldwide.
    //
    // ⚠️ TARGETING IS NOT IN THIS SQL, ON PURPOSE. Country used to be a WHERE
    // clause here and nowhere else, which made it a display filter — the submit
    // path never checked it, so a task hidden from a user was still claimable by
    // one who had its id. Every targeting rule now lives in taskTargeting.ts and
    // is applied below AND on submit, from one definition. The catalog is tens
    // of rows, so filtering in JS costs nothing and buys that guarantee.
    const rows = await sql.all<Record<string, unknown>>(
      `SELECT t.* FROM tasks t
       LEFT JOIN networks n ON n.id = t.network
       WHERE (n.status IS NULL OR n.status = 'active')
       ORDER BY t.featured DESC, t.priority DESC, t.created_at DESC, t.id DESC`,
    );
    const ctx = await userContext(userId);
    // For our own 'proof' tasks, tell the user where they stand: have they
    // already submitted, was it approved, was it rejected? One query, not N.
    const proofRows = await sql.all<{ task_id: string; status: string; review_note: string | null; reward_status: string | null }>(
      `SELECT DISTINCT ON (task_id) task_id, status, review_note, reward_status
       FROM task_proofs WHERE user_id = ? ORDER BY task_id, created_at DESC`,
      userId,
    );
    const proofByTask = new Map(proofRows.map((p) => [p.task_id, p]));
    const completed = new Set((await sql.all<{ task_id: string }>(
      "SELECT DISTINCT task_id FROM task_completions WHERE user_id = ? AND status = 'credited' AND task_id IS NOT NULL",
      userId,
    )).map((r) => r.task_id));
    const started = new Set((await sql.all<{ task_id: string }>(
      "SELECT task_id FROM task_participation WHERE user_id = ?", userId,
    )).map((r) => r.task_id));

    // How many input fields each custom task asks for. One query, not one per
    // task — the card needs it only to say "3 questions" before you tap in.
    const fieldCounts = new Map<string, number>();
    for (const r of await sql.all<{ task_id: string; n: string | number }>(
      "SELECT task_id, COUNT(*) AS n FROM task_fields GROUP BY task_id",
    )) fieldCounts.set(r.task_id, Number(r.n));

    const visible = rows.flatMap((t) => {
        const lifecycle = campaignState(t as { status: string; starts_at?: string | null; ends_at?: string | null });
        // A soft-deleted task is gone from every earner view, even for a user
        // who had already started it.
        if (lifecycle === "deleted") return [];
        const gate = eligibility(t as unknown as TargetingRow, ctx);
        // Never qualifies => not shown at all. Can qualify later => shown with
        // the reason, so the rule is something to work towards rather than a
        // task that silently appears one day. See taskTargeting.ts.
        if (!gate.ok && gate.hide) return [];
        const proof = proofByTask.get(t.id as string);
        // Two-step release (2026-09-01): an approved proof is 'reward on the
        // way' until it is released. Only a SENT reward counts as done.
        const rewardPending = proof?.status === "approved" && proof?.reward_status === "pending";
        const rewardSent = proof?.status === "approved" && proof?.reward_status === "sent";
        const isDone = completed.has(t.id as string) || rewardSent;
        const isMine = started.has(t.id as string) || proof?.status === "pending" || proof?.status === "rejected" || rewardPending;
        if (q.view === "available" && (lifecycle !== "active" || isDone || proof?.status === "pending" || rewardPending)) return [];
        if (q.view === "mine" && (!isMine || isDone)) return [];
        if (q.view === "history" && !isDone && !(lifecycle === "ended" && isMine)) return [];
        return [{
          id: t.id, type: t.type, title: t.title, points: t.points,
          rewardType: t.reward_type ?? "points",
          rewardRoziMicro: Number(t.reward_rozi_micro ?? 0),
          rewardUsdtMicro: Number(t.reward_usdt_micro ?? 0),
          network: t.network, advertiser: t.advertiser, minutes: t.minutes,
          requirement: t.requirement ?? undefined,
          // Custom-task fields (undefined for ordinary network tasks).
          source: t.source ?? "network",
          verifyMode: t.verify_mode ?? undefined,
          instructions: t.instructions ?? undefined,
          proofLabel: t.proof_label ?? undefined,
          // Does this task ask the user to type evidence, or just to confirm they
          // did it? Either way a staff member still approves before anything is
          // credited — see the proof_required note in db.ts.
          proofRequired: t.proof_required !== 0,
          actionUrl: t.action_url ?? undefined,
          icon: t.icon ?? undefined,
          logoAssetId: t.logo_asset_id ?? undefined,
          buttonLabel: t.button_label ?? undefined,
          proofHeading: t.proof_heading ?? undefined,
          proofHelp: t.proof_help ?? undefined,
          startsAt: t.starts_at ?? undefined,
          endsAt: t.ends_at ?? undefined,
          campaignStatus: lifecycle,
          userState: isDone ? "completed" : rewardPending ? "reward_pending"
            : proof?.status === "pending" ? "pending_review"
            : proof?.status === "rejected" ? "rejected_retryable" : isMine ? "started" : "not_started",
          proofStatus: proof?.status ?? undefined,
          rewardStatus: proof?.reward_status ?? undefined,
          proofNote: proof?.review_note ?? undefined,
          // ---- Stage 7 ----------------------------------------------------
          category: t.category ?? undefined,
          fieldCount: fieldCounts.get(t.id as string) ?? 0,
          // Set only when the user has not met a gate they still CAN meet. The
          // card renders locked and the detail page refuses to submit.
          lockedReason: gate.ok ? undefined : gate.reason,
        }];
      });
    const page = visible.slice(q.cursor, q.cursor + q.limit);
    const nextCursor = q.cursor + page.length < visible.length ? q.cursor + page.length : null;
    return { tasks: page, nextCursor, total: visible.length, view: q.view };
  }));

  // Record an intentional start so unfinished work can live under My tasks.
  // This never credits a reward and is idempotent per user/task.
  app.post("/tasks/:id/start", guard(async (userId, req) => {
    await requireFeature("tasks");
    const taskId = (req.params as { id: string }).id;
    const task = await sql.get<Record<string, unknown>>("SELECT * FROM tasks WHERE id = ?", taskId);
    if (!task) return { ok: false, error: "This task is not available." };
    const state = campaignState(task as { status: string; starts_at?: string | null; ends_at?: string | null });
    if (state !== "active") return { ok: false, error: unavailableMessage(state) };
    const gate = eligibility(task as unknown as TargetingRow, await userContext(userId));
    if (!gate.ok) return { ok: false, error: gate.reason };
    const at = now();
    await sql.run(
      `INSERT INTO task_participation (user_id, task_id, started_at, updated_at) VALUES (?,?,?,?)
       ON CONFLICT (user_id, task_id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
      userId, taskId, at, at,
    );
    return { ok: true, status: "started" };
  }));

  // ---- One task, with its input fields (Stage 7) ---------------------------
  //
  // The task detail page. It exists because a task can now ask several
  // questions, and a bottom sheet is the wrong shape for a form — but the
  // reason it is a SERVER route rather than the feed row the client already
  // has is that the fields must be read fresh: they are what the answers are
  // checked against on submit, and a stale copy means a user filling in a
  // question that no longer exists.
  app.get("/tasks/:id", guard(async (userId, req) => {
    const id = (req.params as { id: string }).id;
    const t = await sql.get<Record<string, unknown>>(
      `SELECT t.* FROM tasks t LEFT JOIN networks n ON n.id = t.network
       WHERE t.id = ? AND (n.status IS NULL OR n.status = 'active')`, id,
    );
    if (!t || !(await flagEnabled("tasks"))) return { ok: false, error: "This task is not available." };
    const lifecycle = campaignState(t as { status: string; starts_at?: string | null; ends_at?: string | null });
    if (lifecycle !== "active") {
      // 'exhausted' is a real, common state (a campaign that hit its budget) and
      // it deserves better than "not available": the user did nothing wrong and
      // the task may well come back.
      return {
        ok: false,
        error: unavailableMessage(lifecycle),
        campaignStatus: lifecycle,
      };
    }

    const ctx = await userContext(userId);
    const gate = eligibility(t as unknown as TargetingRow, ctx);
    // A hidden task 404s from here too — the feed hid it, and a detail page that
    // renders it anyway is exactly the hole this route would otherwise open.
    if (!gate.ok && gate.hide) return { ok: false, error: gate.reason };

    // Record the open — a view-level signal for per-task analytics, SEPARATE
    // from task_participation (which is a START and is what drives "My tasks").
    // Fire-and-forget: an analytics write must never delay or fail this read.
    const openAt = now();
    void sql.run(
      `INSERT INTO task_opens (task_id, user_id, opens, first_at, last_at) VALUES (?,?,1,?,?)
       ON CONFLICT (task_id, user_id) DO UPDATE SET opens = task_opens.opens + 1, last_at = EXCLUDED.last_at`,
      id, userId, openAt, openAt,
    ).catch(() => {});

    const proof = await sql.get<{
      status: string; reward_status: string | null; review_note: string | null; created_at: string;
      reward_points: number | null; reward_rozi_micro: string | number | null; reward_usdt_micro: string | number | null;
    }>(
      `SELECT status, reward_status, review_note, created_at, reward_points, reward_rozi_micro, reward_usdt_micro FROM task_proofs
       WHERE task_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1`, id, userId,
    );

    return {
      ok: true,
      task: {
        id: t.id, type: t.type, title: t.title,
        points: proof?.reward_points ?? t.points,
        rewardType: t.reward_type ?? "points",
        rewardRoziMicro: Number(proof?.reward_rozi_micro ?? t.reward_rozi_micro ?? 0),
        rewardUsdtMicro: Number(proof?.reward_usdt_micro ?? t.reward_usdt_micro ?? 0),
        network: t.network, advertiser: t.advertiser, minutes: t.minutes,
        requirement: t.requirement ?? undefined,
        source: t.source ?? "network",
        verifyMode: t.verify_mode ?? undefined,
        instructions: t.instructions ?? undefined,
        proofLabel: t.proof_label ?? undefined,
        proofRequired: t.proof_required !== 0,
        actionUrl: t.action_url ?? undefined,
        icon: t.icon ?? undefined,
        logoAssetId: t.logo_asset_id ?? undefined,
        buttonLabel: t.button_label ?? undefined,
        proofHeading: t.proof_heading ?? undefined,
        proofHelp: t.proof_help ?? undefined,
        startsAt: t.starts_at ?? undefined,
        endsAt: t.ends_at ?? undefined,
        campaignStatus: lifecycle,
        category: t.category ?? undefined,
        proofStatus: proof?.status ?? undefined,
        rewardStatus: proof?.reward_status ?? undefined,
        proofNote: proof?.review_note ?? undefined,
        lockedReason: gate.ok ? undefined : gate.reason,
      },
      fields: (await fieldsForTask(id)).map(publicField),
    };
  }));

  // Submit proof for one of OUR OWN 'proof' custom tasks. This does NOT credit
  // anything (guardrail #1) — it only files evidence into the staff review
  // queue. A staff member approves it, and THAT credits the points.
  app.post("/tasks/:id/proof", guard(async (userId, req) => {
    // The WRITE side does refuse outright — unlike the feed above, there is no
    // sensible empty state for "submit", and silently accepting a proof that
    // will never be reviewed would be worse than an error.
    await requireFeature("tasks");
    const taskId = (req.params as { id: string }).id;
    // Optional at the schema level, then required (or not) against the TASK
    // below. It cannot be decided here: whether this task asks for evidence is a
    // per-task Admin setting, and a fixed min(1) would refuse the tap-to-confirm
    // tasks outright.
    const { proof, answers: rawAnswers } = z.object({
      proof: z.string().trim().max(2000).optional(),
      // fieldId -> what they typed. Checked against the task's CURRENT fields
      // below (taskFields.ts) — the client's own validation is a courtesy and
      // does not survive a curl.
      answers: z.record(z.string().max(64), z.string().max(4000)).optional(),
    }).parse(req.body ?? {});

    const task = await sql.get<Record<string, unknown>>(
      "SELECT * FROM tasks WHERE id = ?", taskId,
    );
    if (!task || task.source !== "custom") {
      return { ok: false, error: "This task is not available." };
    }
    const lifecycle = campaignState(task as { status: string; starts_at?: string | null; ends_at?: string | null });
    if (lifecycle !== "active") return { ok: false, error: unavailableMessage(lifecycle) };
    if (task.verify_mode !== "proof") {
      return { ok: false, error: "This task is checked automatically — you do not need to send proof." };
    }

    // ⚠️ THE TARGETING GATE, ON THE WRITE PATH. The feed hiding a task is a
    // display decision; this is the one that actually stops a claim. Both ask
    // the same function (taskTargeting.ts) — see the note on the feed above for
    // why the country rule was moved out of that SQL.
    const gate = eligibility(task as unknown as TargetingRow, await userContext(userId));
    if (!gate.ok) return { ok: false, error: gate.reason };
    // Asked for → must be there. Not asked for → a stored placeholder, so the
    // reviewer's screen never shows an empty grey box that reads as a bug.
    //
    // ⚠️ THE ROW IS STILL 'pending' AND A HUMAN STILL APPROVES IT. Nothing about
    // this branch credits anything; it only decides what text goes in the queue.
    // A task with configured fields is answered through them; one without keeps
    // the single free-text box exactly as before. Both end in the same pending
    // row for the same human to approve.
    const fields = await fieldsForTask(taskId);
    let proofText: string;
    let answersJson: string | null = null;
    if (fields.length > 0) {
      const checked = validateAnswers(fields, rawAnswers ?? {});
      if (!checked.ok) return { ok: false, error: checked.error };
      proofText = checked.text;
      answersJson = JSON.stringify(checked.answers);
    } else {
      const text = (proof ?? "").trim();
      if (task.proof_required !== 0 && text.length === 0) {
        return { ok: false, error: "Please write your proof first." };
      }
      proofText = text.length > 0 ? text : "The user says they finished this task.";
    }

    // Already approved (reward sent OR still on the way)? Nothing to do — don't
    // let them farm a second payout.
    const approved = await sql.get<{ reward_status: string | null }>(
      "SELECT reward_status FROM task_proofs WHERE task_id = ? AND user_id = ? AND status = 'approved'", taskId, userId,
    );
    if (approved) {
      return {
        ok: false,
        error: approved.reward_status === "sent"
          ? "You already finished this task."
          : "We already accepted your answer — your reward is on the way.",
      };
    }

    // Replace any earlier pending/rejected attempt so the queue holds one row
    // per user per task. The partial unique index enforces one pending row.
    await sql.tx(async (tx) => {
      await tx.run(
        "DELETE FROM task_proofs WHERE task_id = ? AND user_id = ? AND status IN ('pending','rejected')",
        taskId, userId,
      );
      const at = now();
      await tx.run(
        `INSERT INTO task_proofs
          (id, task_id, user_id, proof_text, answers, status, reward_points, reward_rozi_micro, reward_usdt_micro,
           task_title_snapshot, task_icon_snapshot, task_logo_asset_snapshot, created_at)
         VALUES (?,?,?,?,?, 'pending', ?,?,?,?,?,?,?)`,
        newId(), taskId, userId, proofText, answersJson,
        Number(task.points ?? 0), Number(task.reward_rozi_micro ?? 0), Number(task.reward_usdt_micro ?? 0),
        String(task.title ?? "Task"),
        task.icon ?? null, task.logo_asset_id ?? null, at,
      );
      await tx.run(
        `INSERT INTO task_participation (user_id, task_id, started_at, updated_at) VALUES (?,?,?,?)
         ON CONFLICT (user_id, task_id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
        userId, taskId, at, at,
      );
    });
    return { ok: true, status: "pending" };
  }));

  // Balance = SUM(ledger). Never a stored field. Also returns the current
  // withdrawal fee (points) so the withdraw screen can show fee + net.
  app.get("/wallet/balance", guard(async (userId) => {
    const gasFeeRate = await getGasFeeRate();
    // "ONE CHAIN IN, ONE CHAIN OUT" — bep20 is the only chain ever offered
    // (chains.ts), so this preview endpoint can check it directly without
    // waiting for the user to pick one.
    const relayReady = relayAvailable("bep20");
    const gas = relayReady ? await hasEnoughGasForDisplay(userId, "bep20") : null;
    const points = await balanceOf(userId);
    // ---- Wallet Total Balance (founder, un-blended 2026-09-03, same day) -----
    // The wallet's headline USDT number is ONLY money that actually exists
    // somewhere real: real deposited USDT (usdt_ledger) and task USDT paid
    // directly in USDT (earned_usdt_ledger, e.g. a USDT-denominated task
    // credit). Both of those trace to an actual on-chain send or a network
    // postback that specified USDT — they can be paid from a real balance
    // without the platform ever being on the hook for more than it took in.
    //
    // ⚠️ TASK/REFERRAL POINTS ARE DELIBERATELY NOT FOLDED IN HERE ANY MORE.
    // A brief 2026-09-03 change (this same file, same day) blended points into
    // this figure at the real 1000pts=$1 rate — technically correct (points
    // already have a fixed, real payout rate, so it wasn't the guardrail #7
    // problem), but the founder reviewed it live and reversed it: points settle
    // from the TREASURY, not from anything the user (or a network) actually
    // deposited, and the wallet's headline "you have X USDT" must never imply
    // money is sitting somewhere it isn't. Points are still fully withdrawable
    // — see POST /withdrawals (source_kind "points"), a separate flow with its
    // own queue — this endpoint just stops describing them as USDT already in
    // the wallet. `pointsAsUsdtMicro` is still returned, but as its own
    // informational field, never summed into usdtAvailableMicro/usdtTotalMicro.
    const pointsAsUsdtMicro = usdtToMicro(Number(pointsToUsdt(points)));
    const depositUsdtMicro = await usdtBalanceMicroOf(userId);
    const earnedUsdtMicro = await earnedUsdtBalanceMicroOf(userId);
    const usdtAvailableMicro = depositUsdtMicro + earnedUsdtMicro;
    const usdtLockedMicro = 0;
    const minWithdraw = await minWithdrawPointsNow();
    return {
      points,
      pointsAsUsdtMicro,
      earnedUsdtMicro,
      usdtAvailableMicro,
      usdtLockedMicro,
      usdtTotalMicro: usdtAvailableMicro + usdtLockedMicro,
      minWithdrawPoints: minWithdraw,
      // The same floor, in USDT — the unit /wallet/withdraw actually thinks
      // in now that a withdrawal can be a blend of all three sources.
      minWithdrawUsdtMicro: usdtToMicro(Number(pointsToUsdt(minWithdraw))),
      withdrawalFeePoints: Number(await getSetting("withdrawal_fee_points", "0")) || 0,
      // The gas fee (founder, 2026-08-08; DROPPED same day, second pass, when
      // the relay can sign from the user's own address — see personalGasWei
      // below). Percent + a fixed floor, sent as RATES rather than a
      // pre-computed points figure because the amount it is charged on is
      // whatever the user is about to type, which the server does not know
      // yet. The web computes a PREVIEW from these; the amount actually
      // charged is re-computed and snapshotted server-side at request time
      // (see POST /withdrawals), never trusted from the client.
      gasFeePercent: relayReady ? 0 : gasFeeRate.percent,
      gasFeeFixedMicro: relayReady ? 0 : gasFeeRate.fixedMicro,
      // The user's own gas wallet — present only when the relay is wired up.
      // Null means "can't check yet", not "no BNB" — the withdraw screen
      // must not show a false warning on a deployment where this isn't
      // configured at all (the direct-treasury fallback pays its own gas).
      personalGasWei: gas ? gas.balanceWei.toString() : null,
      personalGasRequiredWei: gas ? gas.requiredWei.toString() : null,
      personalGasReady: gas ? gas.ok : null,
    };
  }));

  // Full ledger history for the user. A withdrawal's status comes from the
  // withdrawal_requests row (pending/paid/rejected) — NEVER hard-coded, or a
  // just-requested payout would falsely read as "paid".
  app.get("/wallet/ledger", guard(async (userId) => {
    const rows = await sql.all<Record<string, unknown>>(
      `SELECT le.*, w.status AS w_status
       FROM ledger_entries le
       LEFT JOIN withdrawal_requests w
         ON w.id = le.source_ref_id AND le.source_type = 'withdrawal'
       WHERE le.user_id = ? ORDER BY le.created_at DESC`,
      userId,
    );
    return {
      entries: rows.map((e) => ({
        id: e.id,
        label: (e.note as string) || labelFor(e.source_type as string),
        points: e.amount,
        status: statusFor(e.source_type as string, e.w_status as string | null),
        kind: kindFor(e.source_type as string),
        at: e.created_at,
      })),
    };
  }));

  app.get("/wallet/usdt-task-rewards", guard(async (userId) => {
    const rows = await sql.all<{
      id: string; amount: string | number; source_ref_id: string | null; note: string | null;
      created_at: string; task_title: string | null;
    }>(
      `SELECT u.id, u.amount, u.source_ref_id, u.note, u.created_at, t.title AS task_title
       FROM earned_usdt_ledger u
       LEFT JOIN task_completions c ON c.id = u.source_ref_id
       LEFT JOIN tasks t ON t.id = c.task_id
       WHERE u.user_id = ? AND u.source_type = 'task_reward'
       ORDER BY u.created_at DESC`, userId,
    );
    return { rewards: rows.map((r) => ({
      id: r.id, amountMicro: Number(r.amount), completionId: r.source_ref_id,
      label: r.task_title ? `Task reward — ${r.task_title}` : r.note ?? "Task reward",
      at: r.created_at,
    })) };
  }));

  // "What you've earned from the platform" — a lifetime summary for the earner
  // app, DERIVED from the ledgers (no counter). Built ahead of real USDT
  // payouts and gated behind the earnings_view flag, which ships OFF: turning it
  // on early shows a number the user cannot yet act on. See flagsCore.ts.
  app.get("/me/earnings", guard(async (userId) => {
    if (!(await flagEnabled("earnings_view"))) {
      throw { statusCode: 403, message: "This is turned off right now." };
    }
    const pointsPerUsdt = config.pointsPerUsdt;
    const one = async (q: string, ...a: unknown[]) =>
      Number((await sql.get<{ v: number }>(q, ...a))?.v ?? 0);

    const [taskPoints, referralPoints, adjustPoints,
      withdrawnPoints, earnedUsdtMicro, minedRoziMicro, taskRoziMicro] = await Promise.all([
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM ledger_entries WHERE user_id = ? AND source_type = 'task_completion' AND amount > 0", userId),
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM ledger_entries WHERE user_id = ? AND source_type = 'referral_bonus' AND amount > 0", userId),
      // The Points ledger's only positive non-task, non-referral source is a
      // staff adjustment (ledger_entries.source_type CHECK — there is no 'bonus'
      // value on this ledger; the first-task invite bonus is a 'referral_bonus').
      one("SELECT COALESCE(SUM(amount),0)::int AS v FROM ledger_entries WHERE user_id = ? AND source_type = 'admin_adjustment' AND amount > 0", userId),
      one("SELECT COALESCE(SUM(ABS(le.amount)),0)::int AS v FROM ledger_entries le JOIN withdrawal_requests w ON w.id = le.source_ref_id WHERE le.user_id = ? AND le.source_type = 'withdrawal' AND w.status = 'paid'", userId),
      one("SELECT COALESCE(SUM(amount),0)::bigint AS v FROM earned_usdt_ledger WHERE user_id = ? AND direction = 'credit'", userId),
      one("SELECT COALESCE(SUM(amount),0)::bigint AS v FROM rozi_ledger WHERE user_id = ? AND source_type = 'mining' AND amount > 0", userId),
      one("SELECT COALESCE(SUM(amount),0)::bigint AS v FROM rozi_ledger WHERE user_id = ? AND source_type = 'task_reward' AND amount > 0", userId),
    ]);

    const pointsToUsdtMicro = (p: number) => Math.round((p / pointsPerUsdt) * 1e6);
    const totalPoints = taskPoints + referralPoints + adjustPoints;
    return {
      pointsPerUsdt,
      // Points-denominated earnings, and the same figures as USDT at the real
      // payout rate.
      points: {
        tasks: taskPoints, referrals: referralPoints, bonuses: adjustPoints,
        total: totalPoints, withdrawn: withdrawnPoints,
      },
      usdtMicro: {
        fromPoints: pointsToUsdtMicro(totalPoints),
        earnedUsdt: earnedUsdtMicro,
        withdrawn: pointsToUsdtMicro(withdrawnPoints),
        // The single "you have earned" number: points-as-USDT + real earned USDT.
        total: pointsToUsdtMicro(totalPoints) + earnedUsdtMicro,
      },
      roziMicro: {
        mined: minedRoziMicro,
        fromTasks: taskRoziMicro,
        total: minedRoziMicro + taskRoziMicro,
      },
    };
  }));

  // Referral earnings kept SEPARATE from task earnings (user story).
  //
  // This also serves the REWARD RATES themselves, because the invite screens have
  // to state what a friend is worth before anyone will send a link. Those numbers
  // are Admin-tunable per network (and, for mining speed, in the mining settings),
  // so hard-coding "15%" into the frontend copy would mean the app quietly lies
  // the first time an Admin edits a row. Everything the invite screens print
  // comes from here.
  app.get("/referrals/me", guard(async (userId) => {
    const user = (await sql.get<{ referral_code: string; referred_by: string | null }>(
      "SELECT referral_code, referred_by FROM users WHERE id = ?", userId))!;
    // ::int — Postgres returns COUNT()/SUM() of integers as bigint, i.e. a string.
    const joined = await sql.get<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM referrals WHERE referrer_user_id = ?", userId,
    );
    // Friends of friends. The second level is paid by credit.ts, so it was always
    // being earned — it just had no number anywhere a user could see it.
    const joined2 = await sql.get<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM referrals r2
       JOIN referrals r1 ON r1.referred_user_id = r2.referrer_user_id
       WHERE r1.referrer_user_id = ?`,
      userId,
    );
    const earned = await sql.get<{ s: number }>(
      "SELECT COALESCE(SUM(amount),0)::int AS s FROM ledger_entries WHERE user_id = ? AND source_type = 'referral_bonus'",
      userId,
    );

    // Rates are per-network and an Admin can set them differently on each row, so
    // there is no single true "the" rate. We advertise the MINIMUM across the
    // active networks: a floor we always meet on every offer. Taking the max (or
    // an average) would print a number some networks do not pay, which is the one
    // failure mode that matters here — an invite promise we break on the user's
    // first survey is worse than a modest one we always keep.
    const rates = await sql.get<{
      l1: number | null; l2: number | null; first: number | null;
    }>(
      `SELECT MIN(referral_bonus_pct)::int AS l1,
              MIN(referral_bonus_pct_l2)::int AS l2,
              MIN(referral_first_task_bonus)::int AS first
       FROM networks WHERE status = 'active'`,
    );
    const m = await loadMiningSettings();

    return {
      code: user.referral_code,
      // Whether the "add a friend's code" box is offered on the invite screen —
      // only for a user nobody has invited yet. Checks BOTH the column and the
      // edge table: signup writes both, but either one present means a bind
      // would be refused, so the box must not be shown. Once set, a referrer is
      // permanent (see POST /referrals/bind).
      canBind: !user.referred_by && !(await sql.get(
        "SELECT 1 FROM referrals WHERE referred_user_id = ?", userId,
      )),
      joined: joined?.n ?? 0,
      joined2: joined2?.n ?? 0,
      earnedPoints: earned?.s ?? 0,
      rewards: {
        // Fallbacks are the config defaults, used only before any network row
        // exists (fresh database) — never to paper over a disabled network.
        l1Pct: rates?.l1 ?? Math.round(config.referralCommissionPct * 100),
        l2Pct: rates?.l2 ?? Math.round(config.referralCommissionL2Pct * 100),
        firstTaskBonus: rates?.first ?? config.referralFirstTaskBonusPoints,
        // Mining speed inherited from invitees who are actively mining (§ 4.5).
        miningL1Pct: m.referralL1Pct,
        miningL2Pct: m.referralL2Pct,
      },
    };
  }));

  // Bind a friend's referral code AFTER signup.
  //
  // For a user nobody invited (no `referred_by`). From here on the inviter earns
  // their configured share of this user's task points — out of margin, never out
  // of this user's balance (credit.ts). It is NOT retroactive: tasks already
  // credited stay as they were, and the first-task bonus only fires on a future
  // credited task (see credit.ts).
  //
  // Binding is one-time and permanent: `referred_by` is never cleared, exactly
  // as if the code had been used on the signup link.
  app.post("/referrals/bind", guard(async (userId, req) => {
    if (!(await flagEnabled("referrals"))) {
      throw { statusCode: 403, message: "Invites are turned off right now." };
    }
    const parsed = z.object({ code: z.string().trim().min(1).max(64) })
      .safeParse((req.body ?? {}) as unknown);
    if (!parsed.success) throw { statusCode: 400, message: "Enter a referral code." };
    const code = parsed.data.code.toUpperCase();

    const me = await sql.get<{ referred_by: string | null; referral_code: string }>(
      "SELECT referred_by, referral_code FROM users WHERE id = ?", userId,
    );
    if (!me) throw { statusCode: 404, message: "Account not found." };
    const alreadyEdge = await sql.get("SELECT 1 FROM referrals WHERE referred_user_id = ?", userId);
    if (me.referred_by || alreadyEdge) {
      throw { statusCode: 409, message: "You have already added a referral code." };
    }
    if (code === me.referral_code.toUpperCase()) {
      throw { statusCode: 400, message: "That is your own code." };
    }

    // Look up by referral_code ONLY — never by username/handle. A handle can be
    // the lowercase twin of someone else's published invite code (see
    // routes/profile.ts), and "send ROZI to" already had to be hardened against
    // exactly that. Binding a referrer must not inherit the ambiguity.
    const inviter = await sql.get<{ id: string }>(
      "SELECT id FROM users WHERE referral_code = ?", code,
    );
    if (!inviter) throw { statusCode: 404, message: "That code does not match anyone." };
    if (inviter.id === userId) throw { statusCode: 400, message: "That is your own code." };

    // Cycle guard: the inviter must not already sit below you in the invite tree,
    // or you would each be earning a share of the other's tasks forever. Walk up
    // from the inviter following `referred_by`; if it reaches you, refuse.
    let cursor: string | null = inviter.id;
    for (let hops = 0; cursor && hops < 64; hops++) {
      const up: { referred_by: string | null } | undefined = await sql.get(
        "SELECT referred_by FROM users WHERE id = ?", cursor,
      );
      if (!up) break;
      if (up.referred_by === userId) {
        throw { statusCode: 409, message: "That person was invited by you." };
      }
      cursor = up.referred_by;
    }

    // users.referred_by and the referrals edge are written together, exactly as
    // signup does it. referred_user_id is UNIQUE, so a race to bind twice fails
    // the second INSERT and rolls back the whole transaction — the caught error
    // is that race, not a bug.
    try {
      await sql.tx(async (t) => {
        await t.run("UPDATE users SET referred_by = ? WHERE id = ?", inviter.id, userId);
        await t.run(
          "INSERT INTO referrals (id, referrer_user_id, referred_user_id, created_at, bonus_paid) VALUES (?,?,?,?,0)",
          newId(), inviter.id, userId, now(),
        );
      });
    } catch {
      throw { statusCode: 409, message: "You have already added a referral code." };
    }

    // Re-run device/IP detection now that this user has a referrer — a
    // late-bound self-referral must still raise a referral_ring flag
    // (fraud.ts § 3), the same as one bound on the signup link.
    const rawDev = req.headers["x-device-id"];
    const deviceId = Array.isArray(rawDev) ? rawDev[0] : rawDev;
    await recordDevice(userId, deviceId ? String(deviceId).slice(0, 100) : undefined, req.ip);

    return { ok: true as const };
  }));

  // ---- CPX Research survey wall -------------------------------------------
  // Builds the signed survey-wall URL for THIS user. The secure_hash is
  // md5(`${ext_user_id}-${APP_SECURE_HASH}`) — it must be computed on the SERVER,
  // because putting the app secure hash in browser JS would hand anyone the key
  // to forge postbacks and drain the treasury. The browser only ever sees the
  // finished URL (which contains a hash valid for that one user).
  app.get("/surveys/cpx", guard(async (userId) => {
    // Two independent off switches, and they mean different things: the network
    // row is "this partner is disabled", the flag is "surveys are off". Either
    // closes the wall. Postbacks for surveys already completed keep crediting
    // in both cases — that money was earned, and CPX's reversal window runs for
    // weeks after the fact.
    const net = await sql.get<{ status: string }>("SELECT status FROM networks WHERE id = 'cpx'");
    if (net?.status === "disabled" || !(await flagEnabled("surveys"))) {
      return { enabled: false as const, url: null };
    }
    const user = await sql.get<{ email: string }>("SELECT email FROM users WHERE id = ?", userId);
    const secureHash = createHash("md5")
      .update(`${userId}-${config.postbackSecrets.cpx}`)
      .digest("hex");

    const url = new URL("https://offers.cpx-research.com/index.php");
    url.searchParams.set("app_id", config.cpxAppId);
    url.searchParams.set("ext_user_id", userId);
    url.searchParams.set("secure_hash", secureHash);
    // CPX uses the email to de-duplicate users across publishers; if we don't
    // send it they prompt the user for it before any survey can start.
    if (user?.email) url.searchParams.set("email", user.email);

    return { enabled: true as const, url: url.toString() };
  }));

  // ---- Leaderboard --------------------------------------------------------
  // Social proof + friendly competition to drive referrals (founder request).
  // Two boards: top EARNERS (most points earned from tasks + referrals) and top
  // REFERRERS (most points earned from their invites). Names are masked for
  // privacy; the caller's own row is flagged so the UI can highlight it.
  app.get("/leaderboard", guard(async (userId) => {
    if (!(await flagEnabled("leaderboard"))) return { topEarners: [], topReferrers: [] };
    const { earners, referrers } = await loadLeaderboard();
    return {
      topEarners: earners.map((r, i) => ({
        rank: i + 1, name: maskName(r.email), points: r.earned, isMe: r.id === userId,
      })),
      topReferrers: referrers.map((r, i) => ({
        rank: i + 1, name: maskName(r.email), points: r.ref_points, invites: r.invites, isMe: r.id === userId,
      })),
    };
  }));

  // ---- Notifications: my inbox (brief part 39) ----------------------------
  //
  // Staff announcements and one-to-one messages land here. Deliberately NOT a
  // push by default — see notify.ts's header: a browser subscription is revoked
  // once, permanently, and the message it exists for is "your withdrawal was
  // paid". An inbox interrupts nobody.
  app.get("/notifications", guard(async (userId) => {
    // A LEFT JOIN, not a rewrite of every `notifications` row at pause/delete
    // time: `b.id IS NULL` covers the (majority) one-to-one messages, which
    // have no broadcast row to pause. See db.ts's comment on
    // notification_broadcasts.paused_at/deleted_at.
    const rows = await sql.all<Record<string, unknown>>(
      `SELECT n.id, n.title, n.body, n.url, n.read_at, n.created_at FROM notifications n
       LEFT JOIN notification_broadcasts b ON b.id = n.broadcast_id
       WHERE n.user_id = ? AND (b.id IS NULL OR (b.paused_at IS NULL AND b.deleted_at IS NULL))
       ORDER BY n.created_at DESC LIMIT 50`,
      userId,
    );
    // Counted separately from the page above rather than from its length: the
    // badge must stay right when someone has more than 50 unread.
    const unread = await sql.get<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM notifications n
       LEFT JOIN notification_broadcasts b ON b.id = n.broadcast_id
       WHERE n.user_id = ? AND n.read_at IS NULL
         AND (b.id IS NULL OR (b.paused_at IS NULL AND b.deleted_at IS NULL))`,
      userId);
    return {
      unread: unread?.n ?? 0,
      notifications: rows.map((r) => ({
        id: r.id, title: r.title, body: r.body, url: r.url,
        read: r.read_at !== null, at: r.created_at,
      })),
    };
  }));

  // Mark one as read, or all of them. Scoped by user_id, so knowing another
  // person's notification id does nothing.
  app.post("/notifications/read", guard(async (userId, req) => {
    const id = (req.body as { id?: string } | undefined)?.id;
    if (id) {
      await sql.run(
        "UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL",
        now(), id, userId);
    } else {
      await sql.run(
        "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", now(), userId);
    }
    return { ok: true };
  }));

  // ---- Home content (brief part 43) ---------------------------------------
  //
  // Announcement cards an admin writes in /staff, with no deploy. The window is
  // checked HERE, at read time, so an expired card stops appearing without
  // anything having to run on a timer and remember.
  app.get("/content/home", guard(async () => {
    const at = now();
    const rows = await sql.all<Record<string, unknown>>(
      `SELECT id, title, body, icon, link_url, link_label, tone FROM content_blocks
       WHERE status = 'live'
         AND (starts_at IS NULL OR starts_at <= ?)
         AND (ends_at   IS NULL OR ends_at   >= ?)
       ORDER BY sort, created_at DESC LIMIT 5`,
      at, at,
    );
    return {
      blocks: rows.map((r) => ({
        id: r.id, title: r.title, body: r.body, icon: r.icon, tone: r.tone,
        linkUrl: r.link_url, linkLabel: r.link_label,
        // Told to the client rather than re-derived there, so the "leaves the
        // app" marker cannot disagree with what the link actually does.
        external: typeof r.link_url === "string" && !r.link_url.startsWith("/"),
      })),
    };
  }));

  // ---- Support: earner-facing help tickets --------------------------------
  // Simple English, one screen. A ticket is a subject + a thread of messages;
  // staff answer from the Agent queue.
  //
  // A message may carry ONE image (founder, 2026-09-02: "upload of the
  // images, so that on both sides"). MAGIC-BYTE SNIFFED via the same
  // parseDataUrl() the avatar and KYC uploads already use — a ticket photo is
  // served straight back into the page, so a file claiming to be a JPEG and
  // actually being an SVG script is exactly the stored-XSS risk avatar.ts's
  // own comment warns about, not a lesser one on a "less important" screen.
  const TICKET_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
  function parseTicketImage(image: string | undefined | null): string | null {
    if (!image) return null;
    const { bytes, mime } = parseDataUrl(image, "ticket");
    if (bytes.length > TICKET_IMAGE_MAX_BYTES) {
      throw { statusCode: 413, message: "That photo is too big. Try a smaller one." };
    }
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }

  const newTicketSchema = z.object({
    subject: z.string().min(1).max(120),
    message: z.string().min(1).max(2000),
    image: z.string().max(3_000_000).optional().nullable(),
  });
  app.post("/support/tickets", guard(async (userId, req, reply) => {
    const parsed = newTicketSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Add a short subject and your message." });
    const id = newId();
    const image = parseTicketImage(parsed.data.image);
    await sql.tx(async (t) => {
      await t.run(
        "INSERT INTO support_tickets (id, user_id, subject, status, created_at, updated_at) VALUES (?,?,?, 'open', ?, ?)",
        id, userId, parsed.data.subject, now(), now(),
      );
      await t.run(
        "INSERT INTO ticket_messages (id, ticket_id, author_role, author_id, body, image, created_at) VALUES (?,?, 'user', ?,?,?,?)",
        newId(), id, userId, parsed.data.message, image, now(),
      );
    });
    return { ticket: { id, subject: parsed.data.subject, status: "open" } };
  }));

  // My tickets, newest first, each with its full message thread. One query for
  // the tickets + one for ALL their messages — not one query per ticket.
  app.get("/support/tickets", guard(async (userId) => {
    const tickets = await sql.all<Record<string, unknown>>(
      "SELECT id, subject, status, rating, created_at, updated_at FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC",
      userId,
    );
    const messages = tickets.length === 0 ? [] : await sql.all<{
      ticket_id: string; author_role: string; body: string; image: string | null; created_at: string;
    }>(
      // ⚠️ `author_role <> 'internal'` IS THE ONLY THING PROTECTING A STAFF
      // NOTE FROM THE PERSON IT IS ABOUT (brief part 40). An internal note is
      // where an agent writes "third refund request this week, check the device
      // list before paying" — the CHECK constraint in db.ts permits the value,
      // it does not hide it. This filter does. There is a regression test that
      // posts one and then reads the ticket back as the user.
      `SELECT m.ticket_id, m.author_role, m.body, m.image, m.created_at
       FROM ticket_messages m JOIN support_tickets s ON s.id = m.ticket_id
       WHERE s.user_id = ? AND m.author_role <> 'internal'
       ORDER BY m.created_at ASC`,
      userId,
    );
    const byTicket = new Map<string, { author_role: string; body: string; image: string | null; created_at: string }[]>();
    for (const m of messages) {
      const list = byTicket.get(m.ticket_id) ?? [];
      list.push({ author_role: m.author_role, body: m.body, image: m.image, created_at: m.created_at });
      byTicket.set(m.ticket_id, list);
    }
    return {
      tickets: tickets.map((t) => ({
        id: t.id, subject: t.subject, status: t.status, at: t.created_at,
        updatedAt: t.updated_at, rating: t.rating,
        messages: byTicket.get(t.id as string) ?? [],
      })),
    };
  }));

  // Add a message to my own ticket (reopens it so staff see it again).
  const replySchema = z.object({
    message: z.string().min(1).max(2000),
    image: z.string().max(3_000_000).optional().nullable(),
  });
  app.post("/support/tickets/:id/messages", guard(async (userId, req, reply) => {
    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Type your message first." });
    const id = (req.params as { id: string }).id;
    // Ownership check — a user may only post to their own ticket.
    const ticket = await sql.get<{ id: string }>("SELECT id FROM support_tickets WHERE id = ? AND user_id = ?", id, userId);
    if (!ticket) return reply.code(404).send({ error: "Ticket not found." });
    const image = parseTicketImage(parsed.data.image);
    await sql.tx(async (t) => {
      await t.run(
        "INSERT INTO ticket_messages (id, ticket_id, author_role, author_id, body, image, created_at) VALUES (?,?, 'user', ?,?,?,?)",
        newId(), id, userId, parsed.data.message, image, now(),
      );
      await t.run("UPDATE support_tickets SET status = 'open', updated_at = ? WHERE id = ?", now(), id);
    });
    return { ok: true };
  }));

  // ---- Support as ONE CHAT (founder, 2026-09-03) --------------------------
  // The two endpoints above are a ticket system: pick a subject, open a
  // ticket, then find it again in a list. The founder's ask was the opposite —
  // "user just come, type the message, get the reply, be happy" — so the app
  // now shows a single continuous conversation with RoziPay Official and these
  // two endpoints serve it.
  //
  // ⚠️ THIS IS A CONVERSATION LAYER OVER THE EXISTING TICKETS, NOT A NEW TABLE.
  // A ticket becomes an invisible SEGMENT of the thread: staff still assign,
  // close, and get rated per segment, the auto-close timer still runs, and the
  // `author_role <> 'internal'` filter below is still the only thing standing
  // between a staff note and the person it is about. Replacing the tables
  // would have thrown all of that away to change what the screen looks like.

  // A subject the user never typed. Staff screens and the ticket list are keyed
  // on it, so it cannot be blank — the first line of what they actually wrote is
  // the most useful thing available.
  function subjectFromMessage(message: string): string {
    const line = message.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
    // Reachable: a photo with no words is a valid message (see chatSchema).
    if (!line) return "New chat";
    return line.length > 80 ? `${line.slice(0, 79)}…` : line;
  }

  // The whole thread, oldest first, plus one `segments` row per ticket so the
  // client can draw a "Chat closed" divider and a rating prompt exactly where
  // the conversation was actually closed.
  // ⚠️ `since` IS NOT AN OPTIMISATION, IT IS WHAT MAKES POLLING AFFORDABLE.
  // ticket_messages.image holds a whole data: URL — up to 2MB, typically a few
  // hundred KB for a phone screenshot. The chat screen polls every 15 seconds,
  // so without a delta a user who has sent three photos re-downloads a megabyte
  // every tick, on mobile data, in the markets this app is built for. The
  // client loads the thread once and then asks only for what is new.
  //
  // MESSAGE_CAP is the other half: a years-old thread must not be one response.
  const MESSAGE_CAP = 300;
  app.get("/support/chat", guard(async (userId, req) => {
    const since = typeof (req.query as { since?: unknown })?.since === "string"
      ? (req.query as { since: string }).since
      : null;

    const segments = await sql.all<Record<string, unknown>>(
      `SELECT id, subject, status, rating, created_at, updated_at
       FROM support_tickets WHERE user_id = ? ORDER BY created_at ASC`,
      userId,
    );

    // Same internal-note filter as GET /support/tickets, and for the same
    // reason. See that endpoint's comment — do not "simplify" it away here
    // just because this query looks new.
    //
    // Newest-first + LIMIT, then reversed, so the cap keeps the RECENT end of
    // a long thread. Ordering it oldest-first with a LIMIT would show someone
    // the start of a conversation from last year and hide today's reply.
    const rows = segments.length === 0 ? [] : await sql.all<Record<string, unknown>>(
      `SELECT m.id, m.ticket_id, m.author_role, m.body, m.image, m.created_at
       FROM ticket_messages m JOIN support_tickets s ON s.id = m.ticket_id
       WHERE s.user_id = ? AND m.author_role <> 'internal'
         ${since ? "AND m.created_at > ?" : ""}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?`,
      ...(since ? [userId, since] : [userId]), MESSAGE_CAP,
    );
    rows.reverse();

    return {
      // Always the full list — a segment row is a handful of short fields, and
      // the client needs every one of them to draw the dividers.
      segments: segments.map((s) => ({
        id: s.id, subject: s.subject, status: s.status, rating: s.rating,
        at: s.created_at, closedAt: s.status === "closed" ? s.updated_at : null,
      })),
      // Says whether this response is a delta, so the client knows to append
      // rather than replace. Never inferred from the request on the client.
      delta: Boolean(since),
      messages: rows.map((m) => ({
        id: m.id, ticketId: m.ticket_id, author_role: m.author_role,
        body: m.body, image: m.image, created_at: m.created_at,
      })),
    };
  }));

  // Send a message. No subject, ever. Appends to the newest still-open segment;
  // opens a new one when the last was closed (which is what makes a closed chat
  // re-openable by simply typing again).
  // `message` is OPTIONAL when a photo is attached. A screenshot of the error
  // IS the message for most of the people using this — refusing to send one
  // without also typing something would make the attach button a trap.
  const chatSchema = z.object({
    message: z.string().max(2000).optional(),
    image: z.string().max(3_000_000).optional().nullable(),
  });
  app.post("/support/chat", guard(async (userId, req, reply) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Type your message first." });
    const body = (parsed.data.message ?? "").trim();
    const image = parseTicketImage(parsed.data.image);
    if (!body && !image) return reply.code(400).send({ error: "Type your message, or add a photo." });

    let ticketId: string;
    let opened = false;
    await sql.tx(async (t) => {
      // ⚠️ ONE LIVE CONVERSATION PER USER, ENFORCED HERE. The read below is a
      // plain SELECT, so two sends racing (a double-tap; Enter and the button
      // together; a retry) would both see "nothing open" and both INSERT,
      // splitting one question across two tickets and showing the user a
      // "New chat" divider mid-sentence. Serialising on the user is the same
      // tool guardrail #8 uses for balances, for the same reason: a read
      // followed by a conditional write is not atomic without it.
      await t.run("SELECT pg_advisory_xact_lock(hashtext(?))", userId);
      const live = await t.get<{ id: string }>(
        `SELECT id FROM support_tickets WHERE user_id = ? AND status <> 'closed'
         ORDER BY updated_at DESC LIMIT 1`,
        userId,
      );
      if (live) {
        ticketId = live.id;
      } else {
        ticketId = newId();
        opened = true;
        await t.run(
          "INSERT INTO support_tickets (id, user_id, subject, status, created_at, updated_at) VALUES (?,?,?, 'open', ?, ?)",
          ticketId, userId, subjectFromMessage(body), now(), now(),
        );
      }
      await t.run(
        "INSERT INTO ticket_messages (id, ticket_id, author_role, author_id, body, image, created_at) VALUES (?,?, 'user', ?,?,?,?)",
        newId(), ticketId, userId, body, image, now(),
      );
      // 'answered' back to 'open' — the user has said something new, so it is
      // waiting on staff again. Identical to what the reply endpoint does.
      await t.run("UPDATE support_tickets SET status = 'open', updated_at = ? WHERE id = ?", now(), ticketId);
    });
    return { ok: true, ticketId: ticketId!, opened };
  }));

  // "...get the reply, be happy, and then close the chat" (founder,
  // 2026-09-03). Closing was staff-only, which left a satisfied user with no
  // way to end the conversation — and, because the rating prompt only appears
  // on a CLOSED segment, no way to say the answer was good either.
  //
  // Closing is not destructive here: typing again opens a new segment (see
  // POST /support/chat), so this is "I'm done", never "I can't ask again".
  app.post("/support/chat/close", guard(async (userId, _req, reply) => {
    // One statement does the find AND the close, so two taps racing each other
    // cannot close two segments — the same reason the rating route is written
    // as a conditional UPDATE rather than a read followed by a write.
    const closed = await sql.get<{ id: string }>(
      `UPDATE support_tickets SET status = 'closed', updated_at = ?
       WHERE id = (
         SELECT id FROM support_tickets
         WHERE user_id = ? AND status <> 'closed'
         ORDER BY updated_at DESC LIMIT 1
       )
       RETURNING id`,
      now(), userId,
    );
    if (!closed) return reply.code(400).send({ error: "There is no open chat to close." });
    return { ok: true, ticketId: closed.id };
  }));

  // "How was our support?" — one rating, ever, per ticket (founder, 2026-09-02).
  // Only accepted once the ticket is CLOSED and has never been rated: the WHERE
  // clause does the enforcement (not a pre-read + separate write), so two
  // taps racing each other can only ever have one of them actually change a row.
  const ratingSchema = z.object({ rating: z.enum(["bad", "okay", "great"]) });
  app.post("/support/tickets/:id/rating", guard(async (userId, req, reply) => {
    const parsed = ratingSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Pick Bad, Okay or Great." });
    const id = (req.params as { id: string }).id;
    const res = await sql.run(
      `UPDATE support_tickets SET rating = ?, rated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'closed' AND rating IS NULL`,
      parsed.data.rating, now(), id, userId,
    );
    if (!res.rowCount) {
      return reply.code(400).send({ error: "This ticket cannot be rated right now." });
    }
    return { ok: true };
  }));
}

// Display status for a ledger row. Withdrawals track their request; everything
// else is a settled credit ("earned").
function statusFor(source: string, withdrawalStatus: string | null): string {
  if (source !== "withdrawal") return "earned";
  if (withdrawalStatus === "paid") return "paid";
  if (withdrawalStatus === "rejected") return "rejected";
  // 'sending' = payoutRelay.ts's job is in flight (signed by the user's own
  // address, a few blocks from 'paid') — distinct from a request still
  // sitting in a queue, which is what plain "pending" means below.
  if (withdrawalStatus === "sending") return "sending";
  return "pending"; // pending / agent_approved / manager_approved
}

function labelFor(source: string): string {
  switch (source) {
    case "task_completion": return "Task reward";
    case "referral_bonus": return "Referral bonus";
    case "withdrawal": return "Money sent";
    case "admin_adjustment": return "Adjustment";
    default: return "Points";
  }
}
function kindFor(source: string): string {
  if (source === "referral_bonus") return "referral";
  if (source === "withdrawal") return "withdrawal";
  return "task";
}

