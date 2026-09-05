// The per-user-wallet payout relay (founder, 2026-08-08; gas model rewritten
// 2026-08-08 second pass) — routes a withdrawal or refund's DESTINATION
// transaction through the user's own derived deposit address (custody.ts)
// instead of sending it directly from treasury. Two purposes, two different
// reasons for existing:
//
//   "refund"     — the user's own address genuinely already holds this USDT
//                   (their own prior top-up deposit). Signing from that
//                   address is real: it is the actual money, at the actual
//                   place the user put it. ZERO treasury involvement — the
//                   user's own BNB pays for the forward transaction.
//   "withdrawal" — task/referral earnings have NEVER existed as USDT at any
//                   user's address; they only ever existed as a treasury
//                   balance funded by ad-network revenue. So this is a
//                   deliberate PASS-THROUGH: treasury funds the exact net
//                   USDT amount into the user's own address first (using
//                   treasury's own BNB for that leg — unavoidable, that is
//                   genuinely where the money comes from), which then
//                   forwards it to the destination using the USER'S OWN BNB.
//                   This is the founder's informed choice, not an oversight —
//                   told plainly that it costs 2 on-chain transactions
//                   instead of 1 and does NOT reduce custody risk (the
//                   platform already holds one master key, custodySeeds.ts,
//                   capable of signing for every user address — the same key
//                   that made the old sweep-to-treasury possible makes this
//                   pass-through possible too). Chose it anyway; recorded
//                   here, not hidden.
//
// ⚠️ GAS IS THE USER'S OWN RESPONSIBILITY (founder, 2026-08-08, second pass).
// The original version of this file had TREASURY fund BNB gas into the
// user's derived address before either flow could do anything — which meant
// an empty treasury (as happened in production the same day: 0 BNB, 0 USDT)
// silently blocked REFUNDS TOO, even though a refund has nothing to do with
// treasury's own money. hasEnoughGas() below is checked by the ROUTE, before
// any debit (routes/withdrawals.ts, routes/mining.ts), and again here as a
// defensive re-check immediately before signing the forward leg — BNB can be
// spent out of the address in the gap between request and send.
//
// ⚠️ FAIL CLOSED. Every call site checks relayAvailable(chain) FIRST and
// falls straight back to the pre-existing direct-treasury payout.ts path
// when it's false. Unsetting CUSTODY_SEED_EVM_ENCRYPTED/_SECRET reverts the
// whole feature to today's behaviour with no code change.
//
// State machine, modeled directly on deposits/sweep.ts (same resumability,
// same rpcCall/viem usage, same "never throw — record attempts/last_error,
// retry next tick" posture). Every phase transition is a conditional
// `UPDATE ... WHERE status = <expected>` so two ticks racing the same job
// can never both broadcast the same step.
//
//   refund:     pending -> forward_sent -> forward_confirmed
//   withdrawal: pending -> prefund_sent -> prefund_confirmed ->
//               forward_sent -> forward_confirmed
//
// 'failed' is terminal and NOT auto-retried (same convention as sweep_jobs)
// — a genuine on-chain revert needs a human, not a loop that might resend
// into the same failure. A job also moves to 'failed' once it hits
// config.relayMaxAttempts (see advanceRelayJob) — WITHOUT this, a job that
// can never succeed (e.g. insufficient gas discovered only on-chain) retries
// silently forever, which is exactly the bug a production job hit: 65
// attempts, same "treasury has 0 BNB" error every time, never surfaced to
// staff. The underlying withdrawal_requests / usdt_refund_requests row is
// left at 'sending' (visibly stuck, not silently marked paid) so staff see
// it either way.
import {
  createWalletClient, createPublicClient, http, fallback, parseUnits, erc20Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sql, now, newId, getOrCreateDepositWallet, postLedger, postUsdt, postEarnedUsdt, type TxApi } from "./db.ts";
import { config } from "./config.ts";
import { ONCHAIN_CHAINS } from "./payout.ts";
import { treasurySignerKey } from "./signer.ts";
import { custodyEnabled } from "./custody.ts";
import { deriveChildPrivateKey, sweepSigningEnabled } from "./custodySeeds.ts";
import { rpcCall } from "./rpc.ts";
import { CostCeilingError } from "./costGuard.ts";
import { sendPushToUser } from "./push.ts";

export type RelayPurpose = "withdrawal" | "refund";

// Whether the relay path can be attempted for this chain right now. Checked
// by every call site BEFORE creating a job — false means "do what payout.ts
// already did", never "fail the request".
export function relayAvailable(chain: string): boolean {
  return chain === "bep20" && custodyEnabled(chain) && sweepSigningEnabled("evm") && treasurySignerKey() !== null;
}

// Exact for any integer micro value: dividing a BIGINT by 1e6 and re-fixing
// to 6dp never loses a digit the way an intermediate float sum could,
// because there is exactly one division and no accumulation. Exported so
// autoRefund.ts (which needs the identical conversion for its own preview
// amount) reuses this instead of keeping a second copy that could drift.
export function microToDecimalString(micro: number): string {
  return (micro / 1_000_000).toFixed(6);
}

// This is a DISPLAY read, not the money-moving one: advanceRelayJob's
// defensive re-check before signing (this file, the eth_getBalance call
// inside the job loop) calls rpcCall directly and never goes through this
// cache, so a stale badge here can never cause a wrong on-chain send — worst
// case is a job that discovers the real balance and fails/retries, same as
// it always could. That is what makes it safe to cache: /wallet/balance and
// /usdt were each doing a live chain read on every load of Home, Wallet,
// Mine, and every USDT/BNB sub-screen — real, user-visible lag whenever the
// lead RPC endpoint was slow, for a number that is a "signal, never a gate"
// (see hasEnoughGas's own callers) anyway (2026-08-27, performance pass).
// ⚠️ BOUNDED ON PURPOSE. This is keyed by the user's own derived address, so
// an unbounded Map here is one entry per user who has ever loaded a wallet
// screen, held for the life of the process — a slow leak that only shows up
// once the app is working, and Railway bills memory. Expired entries are
// swept on write, and a hard cap evicts the oldest if the sweep is not enough
// (a burst of distinct users inside one TTL window). Losing an entry only
// costs one extra RPC read; keeping every entry forever costs rent.
const gasBalanceCache = new Map<string, { balanceWei: bigint; expiresAt: number }>();
const GAS_CACHE_MAX_ENTRIES = 5_000;

function rememberGasBalance(key: string, balanceWei: bigint, ttlMs: number): void {
  if (gasBalanceCache.size >= GAS_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of gasBalanceCache) {
      if (v.expiresAt <= now) gasBalanceCache.delete(k);
    }
    // Map iterates in insertion order, so the first keys left are the oldest.
    while (gasBalanceCache.size >= GAS_CACHE_MAX_ENTRIES) {
      const oldest = gasBalanceCache.keys().next();
      if (oldest.done) break;
      gasBalanceCache.delete(oldest.value);
    }
  }
  // delete-then-set, so a REFRESHED key moves to the end of the Map. A plain
  // `set` on an existing key leaves it in its original position, which would
  // make the oldest-first eviction below evict the hottest entries and keep
  // cold ones — the opposite of what a cost cache wants.
  gasBalanceCache.delete(key);
  gasBalanceCache.set(key, { balanceWei, expiresAt: Date.now() + ttlMs });
}

// The user's own derived deposit address for `chain`, and its live native
// balance (wei, as a bigint) — used by routes/withdrawals.ts and
// routes/mining.ts to refuse a request BEFORE any debit when the user has
// not funded their own wallet with gas. Also called defensively inside
// advanceRelayJob immediately before signing the forward leg, since BNB can
// be spent out of the address in the gap between "request accepted" and
// "job actually runs".
export async function userGasWallet(
  userId: string, chain: "bep20",
  // Which spend tier this read belongs to (costGuard.ts). "high" is the
  // default because the request-time gates are the callers that must not be
  // refused by a cost ceiling; only the display callers below opt down.
  priority: "low" | "high" = "high",
): Promise<{ address: string; addrIndex: number; balanceWei: bigint }> {
  const wallet = await getOrCreateDepositWallet(userId, chain);
  const cacheKey = `${chain}:${wallet.address}`;
  const cached = gasBalanceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { address: wallet.address, addrIndex: wallet.addrIndex, balanceWei: cached.balanceWei };
  }
  // A shorter-than-default timeout: this value is only ever a UI signal, so
  // failing fast to "can't check right now" beats making a page load wait
  // out the full failover chain (up to DEFAULT_TIMEOUT_MS per endpoint).
  const raw = (await rpcCall(chain, "eth_getBalance", [wallet.address, "latest"], { timeoutMs: 4_000, priority })) as string;
  const balanceWei = BigInt(raw);
  rememberGasBalance(cacheKey, balanceWei, config.gasBalanceCacheMs);
  return { address: wallet.address, addrIndex: wallet.addrIndex, balanceWei };
}

// Required BNB balance floor for a single ERC-20 transfer, reusing
// evmSweepGasAmountWei — see that config entry's comment for why one number
// serves both purposes.
export function requiredGasWei(): bigint {
  return BigInt(config.evmSweepGasAmountWei);
}

export type GasCheckResult = { ok: boolean; address: string; balanceWei: bigint; requiredWei: bigint };

// Test seam — same shape as this file's own `box` pattern below, not a new
// idea. e2e suites (routes/withdrawals.ts, routes/mining.ts) hit
// hasEnoughGas() through real HTTP requests, and this codebase's own
// convention (see this file's header, and payoutRelay.e2e.ts's) is that
// anything which actually reaches the chain over the network is deliberately
// NOT exercised in the e2e suite — proving that needs BSC testnet, same as
// deposits/sweep.ts always has. Tests set `gasCheckHook.override` to
// exercise the DECISION (refuse before debit / proceed) without making a
// real RPC call for a freshly-generated test address that could never hold
// real BNB anyway. null (the default, and the ONLY thing production ever
// sets) means "ask the chain for real."
export const gasCheckHook: { override: ((userId: string, chain: "bep20") => Promise<GasCheckResult>) | null } = {
  override: null,
};

export async function hasEnoughGas(
  userId: string, chain: "bep20", priority: "low" | "high" = "high",
): Promise<GasCheckResult> {
  if (gasCheckHook.override) return gasCheckHook.override(userId, chain);
  const { address, balanceWei } = await userGasWallet(userId, chain, priority);
  const requiredWei = requiredGasWei();
  return { ok: balanceWei >= requiredWei, address, balanceWei, requiredWei };
}

// For DISPLAY call sites only (GET /wallet/balance, GET /usdt) — a page load
// must never 500 just because the chain was briefly unreachable. Returns
// null on failure, same shape those routes already use for "can't check
// yet". Request-time gates (withdrawals.ts, mining.ts's transfer/refund
// submit paths) deliberately do NOT use this — they must keep failing closed
// on a real RPC outage rather than silently waving a debit through.
export async function hasEnoughGasForDisplay(userId: string, chain: "bep20"): Promise<GasCheckResult | null> {
  try {
    // "low": a screen wanting to render a hint is exactly the call that should
    // give way when the process is near its ceiling, and this function already
    // has a well-defined "could not check" answer for it to fall back to.
    return await hasEnoughGas(userId, chain, "low");
  } catch {
    return null;
  }
}

type CreateJobParams = {
  chain: "bep20";
  userId: string;
  toAddress: string;
  amountMicro: number; // TOTAL forward amount, net, post-fee, micro-USDT
  needsPrefund: boolean; // true = withdrawal pass-through, false = refund
  // How much of amountMicro must first be moved from treasury into the
  // user's own address, when needsPrefund is true. Optional — omitting it
  // (every call site before 2026-09-05) means "prefund the whole amount",
  // exactly today's behaviour: the money never existed anywhere but
  // treasury. A MIXED withdrawal (routes/withdrawals.ts's /wallet/withdraw,
  // drawing on both a real deposit AND task earnings in one request) is the
  // one case that sets this to LESS than amountMicro — only the earned
  // portion needs prefunding; the deposit portion already sits at the
  // user's own address — so the whole combined total forwards in ONE
  // on-chain send instead of the user seeing two separate payouts for one
  // withdrawal (founder, 2026-09-05). Ignored (must be omitted) when
  // needsPrefund is false.
  prefundMicro?: number;
};

// Idempotent — ON CONFLICT (purpose, request_id) DO NOTHING means calling
// this twice for the same request (an auto-settle racing a staff retry) never
// opens a second live job for the same money.
export async function createRelayJob(
  purpose: RelayPurpose, requestId: string, params: CreateJobParams, t: Pick<TxApi, "run"> = sql,
): Promise<void> {
  if (params.amountMicro <= 0) throw new Error("Relay job amount must be positive.");
  if (params.prefundMicro !== undefined) {
    if (!params.needsPrefund) throw new Error("prefundMicro only applies when needsPrefund is true.");
    if (params.prefundMicro <= 0 || params.prefundMicro > params.amountMicro) {
      throw new Error("prefundMicro must be positive and no more than the total amount.");
    }
  }
  const wallet = await getOrCreateDepositWallet(params.userId, params.chain);
  await t.run(
    `INSERT INTO payout_relay_jobs
       (id, purpose, request_id, chain, user_id, from_address, addr_index, to_address, amount_micro, needs_prefund, prefund_micro, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)
     ON CONFLICT (purpose, request_id) DO NOTHING`,
    newId(), purpose, requestId, params.chain, params.userId, wallet.address, wallet.addrIndex,
    params.toAddress, params.amountMicro, params.needsPrefund ? 1 : 0, params.prefundMicro ?? null, now(),
  );
}

type RelayJob = {
  id: string; purpose: RelayPurpose; request_id: string; chain: string; user_id: string;
  from_address: string; addr_index: string | number; to_address: string; amount_micro: string | number;
  needs_prefund: number; prefund_micro: string | number | null; status: string; created_at: string;
  gas_tx_hash: string | null; prefund_tx_hash: string | null; forward_tx_hash: string | null;
  attempts: number; last_error: string | null;
};

const TERMINAL_STATUSES = ["forward_confirmed", "failed"];

async function findRelayWorkIds(): Promise<string[]> {
  const rows = await sql.all<{ id: string }>(
    `SELECT id FROM payout_relay_jobs WHERE status NOT IN ('forward_confirmed','failed') ORDER BY created_at`,
  );
  return rows.map((r) => r.id);
}

async function transition(
  t: Pick<TxApi, "run">, id: string, from: string, to: string, extra: Record<string, string> = {},
): Promise<boolean> {
  const cols = ["status = ?"];
  const vals: string[] = [to];
  for (const [k, v] of Object.entries(extra)) { cols.push(`${k} = ?`); vals.push(v); }
  const claim = await t.run(
    `UPDATE payout_relay_jobs SET ${cols.join(", ")} WHERE id = ? AND status = ?`,
    ...vals, id, from,
  );
  return claim.rowCount > 0;
}

async function markFailed(t: Pick<TxApi, "run">, id: string, error: string): Promise<void> {
  await t.run(
    "UPDATE payout_relay_jobs SET status = 'failed', last_error = ?, attempts = attempts + 1 WHERE id = ? AND status <> 'failed'",
    error, id,
  );
}

// Marks the relay job failed AND, when it is SAFE to, automatically returns
// the held money to the user — the founder's own required test case: "system
// must mark withdrawal failed, release reserved USDT, restore available
// balance ... no money disappears." Without this, a failed job left the
// underlying request stuck at 'sending' forever with no user-visible
// explanation, which is exactly the state two of the three requests in the
// original bug report were rescued from only by a human clicking Reject.
//
// ⚠️ `safe` is NOT a formality — it is the one thing standing between this
// and a double payment. It must be true ONLY when NO value has actually left
// treasury for this job yet:
//   - refund: always safe up to and including a broadcast-but-REVERTED
//     forward tx (a revert moves zero tokens; the user's own gas was spent,
//     but that is the user's own money, not ours to re-credit).
//   - withdrawal: safe only while the job is still 'pending' (the prefund
//     leg has not yet been broadcast) or the prefund tx itself reverted. Once
//     prefund_confirmed, treasury's USDT genuinely sits at the user's own
//     derived address — crediting points back NOW as well would double-pay
//     (points back in the ledger AND real USDT already at an address this
//     same custody system controls). Every call site below passes `safe`
//     explicitly, computed from exactly this reasoning — do not default it.
async function failJob(
  t: TxApi, job: RelayJob, error: string, safe: boolean,
): Promise<PendingPush | null> {
  await markFailed(t, job.id, error);
  if (!safe) return null; // leave the request at 'sending' — a human must check the chain first

  if (job.purpose === "withdrawal") {
    // ⚠️ RETURN THE HELD FUNDS IN THE CURRENCY THEY WERE HELD IN. A withdrawal
    // can hold POINTS (source_kind='points'), TASK USDT (source_kind=
    // 'earned_usdt' — earnings from a USDT-paying task, and the currency an
    // admin reward disbursement pays out in), or BOTH at once (source_kind=
    // 'mixed' — a single combined request drawing on a real deposit AND task
    // earnings, 2026-09-05). Crediting points back for an earned_usdt hold
    // would refund the wrong ledger — the user's points go up for money that
    // came out of their task-USDT balance. staff.ts's manual reject path
    // already branches on source_kind for exactly this reason.
    const w = await t.get<{
      user_id: string; amount: number; source_kind: string; earned_usdt_micro: string | number;
      deposit_component_micro: string | number;
    }>(
      `UPDATE withdrawal_requests SET status = 'rejected', review_note = ?, reviewed_by = 'system:auto', reviewed_at = ?
       WHERE id = ? AND status = 'sending'
       RETURNING user_id, amount, source_kind, earned_usdt_micro, deposit_component_micro`,
      `Could not send automatically: ${error}`, now(), job.request_id,
    );
    if (!w) return null; // already resolved by staff in the meantime — nothing to do
    if (w.source_kind === "mixed") {
      // Both components were debited together at request time (routes/
      // withdrawals.ts's /wallet/withdraw) — both are credited back together.
      if (Number(w.earned_usdt_micro) > 0) {
        await postEarnedUsdt({
          userId: w.user_id, micro: Number(w.earned_usdt_micro), direction: "credit",
          sourceType: "withdrawal_return", sourceRefId: job.request_id,
          note: "Withdrawal could not be sent automatically — task USDT returned",
        }, t);
      }
      if (Number(w.deposit_component_micro) > 0) {
        await postUsdt({
          userId: w.user_id, micro: Number(w.deposit_component_micro), direction: "credit",
          sourceType: "refund", sourceRefId: job.request_id,
          note: "Withdrawal could not be sent automatically — deposit returned", chain: job.chain,
        }, t);
      }
    } else if (w.source_kind === "earned_usdt") {
      await postEarnedUsdt({
        userId: w.user_id, micro: Number(w.earned_usdt_micro), direction: "credit",
        sourceType: "withdrawal_return", sourceRefId: job.request_id,
        note: "Withdrawal could not be sent automatically — task USDT returned",
      }, t);
    } else {
      await postLedger({
        userId: w.user_id, points: w.amount, direction: "credit",
        sourceType: "admin_adjustment", sourceRefId: job.request_id,
        note: "Withdrawal could not be sent automatically — points returned",
      }, t);
    }
    return {
      userId: w.user_id, title: "About your withdrawal",
      body: w.source_kind === "points"
        ? "We could not send this one. Your points are back in your wallet."
        : "We could not send this one. Your money is back in your wallet.",
      url: "/wallet",
    };
  }

  const r = await t.get<{ user_id: string; amount: string; chain: string }>(
    `UPDATE usdt_refund_requests SET status = 'rejected', reject_reason = ?, reviewed_by = 'system:auto', reviewed_at = ?
     WHERE id = ? AND status = 'sending' RETURNING user_id, amount, chain`,
    `Could not send automatically: ${error}`, now(), job.request_id,
  );
  if (!r) return null;
  await postUsdt({
    userId: r.user_id, micro: Number(r.amount), direction: "credit",
    sourceType: "refund", sourceRefId: job.request_id,
    note: "Could not send automatically — money returned to your balance", chain: r.chain,
  }, t);
  return {
    userId: r.user_id, title: "About your refund",
    body: "We could not send this automatically. Your money is back in your balance.", url: "/wallet",
  };
}

type PendingPush = { userId: string; title: string; body: string; url: string };

// The ONE place a completed relay job closes the loop: flips the underlying
// request to 'paid'. Leaves reviewed_by/reviewed_at alone — those were
// stamped when the request moved TO 'sending' (auto-settle or a staff
// click), not now. Returns the push to send rather than sending it —
// a push cannot be rolled back, so it must fire only once the caller's
// transaction has actually committed (same rule staff.ts's "pay"/"reject"
// actions follow with their own `notify` box).
async function completeRequest(t: TxApi, job: RelayJob): Promise<PendingPush | null> {
  const usdt = microToDecimalString(Number(job.amount_micro));
  if (job.purpose === "withdrawal") {
    const updated = await t.get<{ user_id: string }>(
      `UPDATE withdrawal_requests SET status = 'paid', paid_at = ?, tx_hash = ?, usdt_amount = ?
       WHERE id = ? AND status = 'sending' RETURNING user_id`,
      now(), job.forward_tx_hash, usdt, job.request_id,
    );
    if (!updated) return null;
    return {
      userId: updated.user_id, title: "Your money is sent",
      body: `We sent ${usdt} USDT to your wallet. Check it now.`, url: "/wallet",
    };
  }
  const updated = await t.get<{ user_id: string }>(
    `UPDATE usdt_refund_requests SET status = 'paid', tx_hash = ?
     WHERE id = ? AND status = 'sending' RETURNING user_id`,
    job.forward_tx_hash, job.request_id,
  );
  if (!updated) return null;
  return {
    userId: updated.user_id, title: "Your money is sent",
    body: `We sent ${usdt} USDT back to your wallet. Check it now.`, url: "/wallet",
  };
}

// Advances ONE job as far as it can go in one call (possibly several
// phases). Locked PER JOB — `pg_try_advisory_xact_lock(hashtext(jobId))` —
// for the whole call, network calls included.
//
// ⚠️ SECURITY-REVIEW FIX (2026-08-08). This closes a real race the original
// version had: every phase transition was a conditional `UPDATE ... WHERE
// status = <expected>`, which prevents two ticks from both PERSISTING the
// same step, but does nothing to stop them both BROADCASTING it — the
// sendTransaction/writeContract call always happened before that guarded
// UPDATE. tickPayoutRelayJob runs on a bare setInterval with no overlap
// guard; if one tick's RPC round trips (this project's own RPC nodes are
// documented as slow/rate-limited in production) take longer than the
// interval, the next tick fires and findRelayWork() would hand back the
// same job to both — both would broadcast, a real double payment. The
// per-job advisory lock closes this: a second concurrent call for the SAME
// job (this process racing its own timer, or a second server instance)
// finds the lock already held and returns immediately as a no-op, before
// touching the network at all. Scoped to ONE job, not the whole tick, so a
// slow job never blocks any other job's own progress — and a push
// notification only ever fires after ITS OWN job's transaction has
// committed, never entangled with a different job.
export async function advanceRelayJob(jobId: string): Promise<void> {
  // A box, not a plain `let`: TS narrows a let assigned only inside the
  // closure to `never` at the read below (same reason routes/staff.ts's
  // `notify` box exists).
  const box: { push: PendingPush | null } = { push: null };

  await sql.tx(async (t) => {
    const got = await t.get<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext(?)) AS locked", jobId,
    );
    if (!got?.locked) return; // another tick already holds this exact job

    // Re-fetch FRESH under the lock — the copy findRelayWorkIds() saw before
    // the lock was taken could already be stale.
    let job = await t.get<RelayJob>("SELECT * FROM payout_relay_jobs WHERE id = ?", jobId);
    if (!job || TERMINAL_STATUSES.includes(job.status)) return;

    // Give up rather than retry forever. Without this, a job that can never
    // succeed (e.g. treasury has no BNB for a withdrawal's prefund leg)
    // retries silently every tick, indefinitely — the exact bug found in
    // production: 65 attempts, same error, never surfaced to staff.
    //
    // TWO independent conditions, whichever comes first (founder, 2026-09-05):
    // attempts (unchanged) and wall-clock age. Age exists because attempts
    // alone is only as predictable as the tick interval, and that interval is
    // shared with cost-tuning knobs elsewhere (payoutRelayIntervalMs's own
    // comment) — a job should give up in a bounded, known amount of TIME
    // regardless of what the tick cadence happens to be set to.
    //
    // An admin-initiated disbursement gets a LONGER leash than a user's own
    // withdrawal (founder, 2026-09-05, later the same day) — a
    // payout_disbursements row referencing this request is proof of that,
    // independent of withdrawal_requests.reviewed_by (tryAutoSettle overwrites
    // that to 'system:auto' the moment it creates the relay job, so the
    // 'system:disbursement' marker runPayoutRow sets at creation is already
    // gone by the time any tick runs this check).
    const isDisbursementJob = job.purpose === "withdrawal" && !!(await t.get<{ x: number }>(
      "SELECT 1 AS x FROM payout_disbursements WHERE withdrawal_request_id = ?", job.request_id,
    ));
    const maxAttempts = isDisbursementJob ? config.relayMaxAttemptsDisbursement : config.relayMaxAttempts;
    const maxAgeMs = isDisbursementJob ? config.relayMaxAgeMsDisbursement : config.relayMaxAgeMs;
    const ageMs = Date.now() - new Date(job.created_at).getTime();
    if (job.attempts >= maxAttempts || ageMs >= maxAgeMs) {
      // Safe to auto-refund only if this job never got past 'pending' — see
      // failJob's header comment for why that specific line is what matters,
      // not the attempt count. This is exactly the shape the production bug
      // had: 65 attempts, never left 'pending', nothing ever signed.
      box.push = await failJob(
        t, job, job.last_error ?? "Gave up after repeated failures.", job.status === "pending",
      );
      return;
    }

    // Every job-CREATION call site checks payoutMode === "onchain" already —
    // relayAvailable() alone does not know about the mode. That matters here
    // too: without this check, flipping PAYOUT_MODE back to "manual" (the
    // operator's emergency stop) would not stop a job already in flight from
    // continuing to sign and broadcast on the very next tick.
    if (config.payoutMode !== "onchain") return;
    const token = ONCHAIN_CHAINS[job.chain as keyof typeof ONCHAIN_CHAINS];
    if (!token) return;

    const transport = fallback(config.payoutRpc[job.chain].map((url) => http(url)));
    const publicClient = createPublicClient({ chain: token.viemChain, transport });

    try {
      // The decrypted child key. Local for the rest of this call only — never
      // assigned to anything that outlives it. Same posture as sweep.ts.
      const childPkHex = deriveChildPrivateKey("evm", Number(job.addr_index));
      const childAccount = privateKeyToAccount(`0x${childPkHex}`);
      if (childAccount.address.toLowerCase() !== job.from_address.toLowerCase()) {
        // Should be unreachable (both derive from the same account key, same
        // path, as custodySeeds.ts guarantees) — refuse rather than sign from
        // an address that doesn't match what the job says it's paying from.
        box.push = await failJob(
          t, job, "Derived signing key does not match the job's recorded address.", job.status === "pending",
        );
        return;
      }

      // GAS IS THE USER'S OWN RESPONSIBILITY — no more treasury BNB funding
      // hop here. routes/withdrawals.ts and routes/mining.ts already refused
      // the request before any debit if this address didn't hold enough BNB;
      // this is a defensive RE-check immediately before signing the forward
      // leg, since BNB can be spent out of the address in the gap between
      // "request accepted" and "this tick actually runs". `safe` follows
      // failJob's rule: true from the refund/pending call site (nothing has
      // moved yet), false from the withdrawal/prefund_confirmed call site
      // (treasury's USDT already genuinely sits at this address).
      async function requireGasOrFail(safe: boolean): Promise<boolean> {
        const raw = (await rpcCall(job!.chain, "eth_getBalance", [childAccount.address, "latest"], { priority: "high" })) as string;
        if (BigInt(raw) >= requiredGasWei()) return true;
        box.push = await failJob(
          t, job!,
          `Address ${childAccount.address} no longer holds enough BNB for gas. It held enough when this was requested, but does not now.`,
          safe,
        );
        return false;
      }

      if (job.status === "pending" && job.needs_prefund) {
        // Withdrawal pass-through: treasury sends into the user's own
        // address, using TREASURY's own BNB for this leg — that money only
        // ever existed at treasury, so this hop is unavoidable (founder
        // decision, 2026-08-08). Prefunds job.prefund_micro when set (a MIXED
        // withdrawal: only the earned portion needs this, the deposit
        // portion already sits at this address) — null means "prefund the
        // whole thing", the original behaviour, unchanged for every job
        // created before 2026-09-05.
        const treasuryPk = treasurySignerKey();
        if (!treasuryPk) return; // no treasury signer configured — next tick checks again
        const treasuryAccount = privateKeyToAccount(treasuryPk);
        const prefundAmountMicro = job.prefund_micro != null ? Number(job.prefund_micro) : Number(job.amount_micro);
        const amount = parseUnits(microToDecimalString(prefundAmountMicro), token.decimals);
        const treasuryClient = createWalletClient({ account: treasuryAccount, chain: token.viemChain, transport });
        const prefundTx = await treasuryClient.writeContract({
          address: token.usdt, abi: erc20Abi, functionName: "transfer",
          args: [childAccount.address, amount],
        });
        if (await transition(t, job.id, "pending", "prefund_sent", { prefund_tx_hash: prefundTx })) {
          job = { ...job, status: "prefund_sent", prefund_tx_hash: prefundTx };
        } else return;
      } else if (job.status === "pending") {
        // Refund: ZERO treasury involvement. The money should already be
        // here (the user's own prior deposit) — verify on-chain before ever
        // signing, never trust the row — and the user's own BNB pays to
        // forward it. If either check fails, refuse; nothing has been signed.
        const rawBalance = (await publicClient.readContract({
          address: token.usdt, abi: erc20Abi, functionName: "balanceOf", args: [childAccount.address],
        })) as bigint;
        const needed = parseUnits(microToDecimalString(Number(job.amount_micro)), token.decimals);
        if (rawBalance < needed) {
          // Safe: nothing has been signed for this job — this is the ONLY
          // check that runs before anything else in the refund path.
          box.push = await failJob(
            t, job,
            `Address ${childAccount.address} holds less than the refund amount — cannot sign a refund it can't back.`,
            true,
          );
          return;
        }
        if (!(await requireGasOrFail(true))) return;

        const childClient = createWalletClient({ account: childAccount, chain: token.viemChain, transport });
        const forwardTx = await childClient.writeContract({
          address: token.usdt, abi: erc20Abi, functionName: "transfer",
          args: [job.to_address as `0x${string}`, needed],
        });
        if (await transition(t, job.id, "pending", "forward_sent", { forward_tx_hash: forwardTx })) {
          job = { ...job, status: "forward_sent", forward_tx_hash: forwardTx };
        } else return;
      }

      if (job.status === "prefund_sent") {
        const receipt = (await rpcCall(job.chain, "eth_getTransactionReceipt", [job.prefund_tx_hash], { priority: "high" })) as
          { status: string } | null;
        if (!receipt) return;
        if (receipt.status !== "0x1") {
          // Safe: a reverted ERC-20 transfer moves zero tokens — treasury's
          // USDT never actually reached the user's address, so returning the
          // user's points cannot double-pay.
          box.push = await failJob(t, job, `Prefund tx ${job.prefund_tx_hash} reverted.`, true);
          return;
        }
        if (await transition(t, job.id, "prefund_sent", "prefund_confirmed")) {
          job = { ...job, status: "prefund_confirmed" };
        } else return;
      }

      if (job.status === "prefund_confirmed" && job.to_address.toLowerCase() === job.from_address.toLowerCase()) {
        // The destination IS the user's own derived custody address (an admin
        // reward disbursement now always pays into the recipient's own RoziPay
        // wallet, never an external saved address — 2026-09-05). The prefund
        // leg already put the money exactly where it needs to be; a "forward"
        // from this address to itself would be a pointless self-transfer that
        // could only fail (it would need the recipient to already hold BNB gas
        // for nothing) or waste it. Skip straight to done, reusing the prefund
        // hash as the record of the transaction that actually moved the money.
        if (await transition(t, job.id, "prefund_confirmed", "forward_confirmed", {
          forward_tx_hash: job.prefund_tx_hash!, completed_at: now(),
        })) {
          box.push = await completeRequest(t, { ...job, status: "forward_confirmed", forward_tx_hash: job.prefund_tx_hash });
        }
        return;
      }

      if (job.status === "prefund_confirmed") {
        // ⚠️ VERIFY THE FULL FORWARD AMOUNT IS REALLY THERE BEFORE SIGNING —
        // same discipline as the refund path above ("never trust the row").
        // For a plain earned-only job this trivially holds (the prefund we
        // just confirmed WAS the whole amount). For a MIXED job (2026-09-05:
        // one relay job forwarding a real deposit + the just-prefunded earned
        // portion together) the deposit portion is money that has sat at this
        // address since it was originally deposited — exactly the kind of
        // balance that could have drifted from the ledger (a sweep, a prior
        // partial send) if this check were skipped. Checked BEFORE signing;
        // NOT safe on failure — the prefund already confirmed, so treasury's
        // USDT genuinely sits at this address for real, and auto-refunding
        // the whole row would double-pay that portion. Staff must look at
        // the chain, not this code, if this is where a job gets stuck.
        const rawBalance = (await publicClient.readContract({
          address: token.usdt, abi: erc20Abi, functionName: "balanceOf", args: [childAccount.address],
        })) as bigint;
        const neededTotal = parseUnits(microToDecimalString(Number(job.amount_micro)), token.decimals);
        if (rawBalance < neededTotal) {
          box.push = await failJob(
            t, job,
            `Address ${childAccount.address} holds less than the full forward amount even after the prefund confirmed — cannot sign.`,
            false,
          );
          return;
        }

        // NOT safe: the prefund tx already confirmed — treasury's USDT
        // genuinely sits at the user's own derived address right now. Do not
        // auto-refund points here; that would double-pay. Staff must look at
        // the chain, not this code, if this is where a job gets stuck.
        if (!(await requireGasOrFail(false))) return;

        const amount = neededTotal;
        const childClient = createWalletClient({ account: childAccount, chain: token.viemChain, transport });
        const forwardTx = await childClient.writeContract({
          address: token.usdt, abi: erc20Abi, functionName: "transfer",
          args: [job.to_address as `0x${string}`, amount],
        });
        if (await transition(t, job.id, "prefund_confirmed", "forward_sent", { forward_tx_hash: forwardTx })) {
          job = { ...job, status: "forward_sent", forward_tx_hash: forwardTx };
        } else return;
      }

      if (job.status === "forward_sent") {
        const receipt = (await rpcCall(job.chain, "eth_getTransactionReceipt", [job.forward_tx_hash], { priority: "high" })) as
          { status: string } | null;
        if (!receipt) return;
        if (receipt.status !== "0x1") {
          // Safe ONLY for a refund: a reverted forward moves zero tokens, and
          // a refund never had a prefund leg, so nothing has moved anywhere —
          // the deposit balance is exactly restorable. NOT safe for a
          // withdrawal: the prefund already put real USDT at the user's own
          // address for real; crediting points back on top of that would
          // double-pay. Staff must check the chain for that case.
          box.push = await failJob(t, job, `Forward tx ${job.forward_tx_hash} reverted.`, job.purpose === "refund");
          return;
        }
        const moved = await transition(t, job.id, "forward_sent", "forward_confirmed", { completed_at: now() });
        if (moved) box.push = await completeRequest(t, job);
      }
    } catch (err) {
      // ⚠️ A COST-CEILING REFUSAL IS NOT A FAILED ATTEMPT, AND COUNTING IT
      // COULD KILL A LIVE PAYOUT. Nothing was tried, nothing is wrong with this
      // job, and the same work succeeds once the budget window rolls. Spending
      // an attempt on it means a busy hour can walk a job to
      // `relayMaxAttempts` and mark it failed — and past the prefund leg that
      // is not recoverable automatically. Leave it untouched and let the next
      // tick pick it up. (Found in review, 2026-09-04.)
      if (err instanceof CostCeilingError) return;
      await t.run(
        "UPDATE payout_relay_jobs SET attempts = attempts + 1, last_error = ? WHERE id = ?",
        (err as Error)?.message ?? String(err), job.id,
      );
    }
  });

  if (box.push) void sendPushToUser(box.push.userId, { title: box.push.title, body: box.push.body, url: box.push.url });
}

export async function tickPayoutRelay(): Promise<void> {
  const ids = await findRelayWorkIds();
  for (const id of ids) {
    await advanceRelayJob(id);
  }
}
