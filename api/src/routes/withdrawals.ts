import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { parseEther } from "viem";
import {
  sql, now, newId, balanceOf, postLedger, getSetting, earnedUsdtBalanceMicroOf, postEarnedUsdt,
  getOrCreateDepositAddress, usdtBalanceMicroOf, postUsdt, usdtToMicro,
} from "../db.ts";
import { config } from "../config.ts";
import { custodyEnabled } from "../custody.ts";
import { fetchBnbAddressHistory } from "../bscscan.ts";
import { getUserId, requireActiveUser, issueCode, consumeCode } from "../auth.ts";
import { validateAddress, chainIsOffered, chainById, type ChainId } from "../chains.ts";
import { checkPayoutAddressReuse } from "../fraud.ts";
import { checkWithdrawalVelocity, requestedLast24hPoints } from "../velocity.ts";
import { kycSatisfied } from "../kyc.ts";
import { buildWalletMessage, recoverSigner, toChecksumAddress } from "../wallet.ts";
import { tryAutoSettle } from "../autoWithdraw.ts";
import { tryAutoSettleRefund } from "../autoRefund.ts";
import { getGasFeeRate, gasFeePoints, gasFeeMicro } from "../fees.ts";
import { relayAvailable, hasEnoughGas, requiredGasWei } from "../payoutRelay.ts";
import { sendPushToUser } from "../push.ts";
import { requireFeature } from "../flags.ts";
import { minWithdrawPointsNow } from "../settingsRuntime.ts";
import { pointsToUsdt } from "../payout.ts";

// Upsert a user's saved payout address for a chain (set once, reuse). Best-effort.
//
// ⚠️ A PROOF BELONGS TO ONE ADDRESS. `verified` is only ever true on the path
// that actually checked a signature (POST /withdrawals/addresses/verify). Every
// other write clears it — but ONLY when the address really changed, because this
// function also runs on the auto-save after a withdrawal, and a user withdrawing
// to the wallet they proved last week must not silently lose the badge for it.
async function saveAddress(
  userId: string, chain: string, address: string, verified = false,
): Promise<void> {
  try {
    const at = now();
    await sql.run(
      `INSERT INTO payout_addresses (user_id, chain, address, verified_at, verify_method, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT (user_id, chain) DO UPDATE SET
         address = EXCLUDED.address,
         updated_at = EXCLUDED.updated_at,
         verified_at = CASE
           WHEN EXCLUDED.verified_at IS NOT NULL THEN EXCLUDED.verified_at
           WHEN LOWER(payout_addresses.address) = LOWER(EXCLUDED.address) THEN payout_addresses.verified_at
           ELSE NULL END,
         verify_method = CASE
           WHEN EXCLUDED.verified_at IS NOT NULL THEN EXCLUDED.verify_method
           WHEN LOWER(payout_addresses.address) = LOWER(EXCLUDED.address) THEN payout_addresses.verify_method
           ELSE NULL END`,
      userId, chain, address, verified ? at : null, verified ? "signature" : null, at,
    );
  } catch {
    // Saving is a convenience; never let it break a withdrawal.
  }
}

// The name the user sees inside their wallet app when they are asked to sign.
// Taken from OUR configured web origin, never from anything the request carried
// — a host the client could influence would let a phishing page produce a
// message that names us and a signature we would then accept.
function siteHost(): string {
  try {
    return new URL(config.webOrigins[0]).host;
  } catch {
    return "rozipay.xyz";
  }
}

const CHALLENGE_TTL_MS = 10 * 60 * 1000;

function guard(handler: (userId: string, req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = getUserId(req);
      await requireActiveUser(userId, req); // suspended accounts cannot move money
      return await handler(userId, req, reply);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Something went wrong" });
    }
  };
}

const createSchema = z.object({
  amountPoints: z.number().int().positive().optional(),
  amountUsdtMicro: z.number().int().positive().optional(),
  chain: z.enum(["bep20", "base", "aptos"]),
  address: z.string().min(1).max(120),
  // Only required once amountPoints >= config.stepUpMinPoints — see the check
  // below. A 6-digit code from POST /withdrawals/request-step-up.
  stepUpCode: z.string().trim().optional(),
}).refine((v) => Number(Boolean(v.amountPoints)) + Number(Boolean(v.amountUsdtMicro)) === 1);

const addressSchema = z.object({
  chain: z.enum(["bep20", "base", "aptos"]),
  address: z.string().min(1).max(120),
});

export async function withdrawalRoutes(app: FastifyInstance) {
  // Request a payout. We DEBIT the ledger now to hold the funds, so the same
  // points can't be withdrawn twice while the request is pending. A rejection
  // writes a compensating credit (see staff route).
  app.post("/withdrawals", guard(async (userId, req, reply) => {
    // Feature flag (flags.ts). Only NEW requests are refused — anything already
    // in the queue still pays out, because switching cash-out off must never
    // strand money people are already owed and waiting on.
    await requireFeature("usdt_withdrawals");
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter a valid amount, network, and wallet address." });
    const { chain, address: addressRaw, stepUpCode } = parsed.data;
    const sourceKind = parsed.data.amountUsdtMicro ? "earned_usdt" : "points";
    const earnedAmountMicro = parsed.data.amountUsdtMicro ?? 0;
    // Risk thresholds and staff approval limits remain denominated in the
    // platform's internal points unit. The actual earned-USDT payout below is
    // never rounded through this equivalent.
    const amountPoints = parsed.data.amountPoints
      ?? Math.ceil((earnedAmountMicro * config.pointsPerUsdt) / 1_000_000);

    // Read from settings, not straight from config: an Admin can tune this in
    // /staff, and the wallet screen reads the SAME helper. If the two ever
    // disagree the app tells a user they can cash out and then refuses them.
    const minWithdraw = await minWithdrawPointsNow();
    if (amountPoints < minWithdraw) {
      return reply.code(400).send({
        error: `You need at least ${minWithdraw} points to get money.`,
      });
    }

    // STEP-UP AUTH (docs/CUSTODY_SPEC.md § 3.3): now that most withdrawals
    // settle with no human ever looking at them, a large one gets one more
    // proof of control over the account before it's even created — reusing
    // the exact email_codes machinery every login/reset already relies on,
    // not a new channel. Below the threshold, nothing changes.
    //
    // ⚠️ TRIGGERED ON THE ROLLING 24H TOTAL, NOT JUST THIS REQUEST. A single
    // request under the threshold is not the actual risk being defended
    // against — "no human review, so prove you control the account" applies
    // exactly as much to five 900-point requests as to one 4000-point one.
    // Checking only amountPoints would make the threshold a suggestion:
    // structure around it once and never need the code again that day.
    const priorRequested = await requestedLast24hPoints(userId);
    if (priorRequested + amountPoints >= config.stepUpMinPoints) {
      // `email` is NOT NULL — even a Telegram-only account has a row, just a
      // synthetic, never-read @telegram.local one (auth.ts). That is the real
      // "no usable email" case here, not a null column.
      const user = await sql.get<{ email: string }>("SELECT email FROM users WHERE id = ?", userId);
      if (!user || user.email.endsWith("@telegram.local")) {
        return reply.code(400).send({ error: "Add an email to your account before a withdrawal this large." });
      }
      if (!stepUpCode) {
        return reply.code(400).send({
          error: `For ${config.stepUpMinPoints} points or more in a day, confirm with the code we email you.`,
          stepUpRequired: true,
        });
      }
      const result = await consumeCode(user.email, stepUpCode, "withdraw");
      if (!result.ok) return reply.code(result.statusCode).send({ error: result.error, stepUpRequired: true });
    }

    // KYC GATE (founder decision, 2026-07-13). You should know who you are sending
    // money to. Checked here, at REQUEST time, rather than at approval: a user who
    // cannot be paid should be told so before their points are held, not after
    // they have sat in a queue for two days waiting for a payout that will not come.
    //
    // `kycSatisfied` returns true when an Admin has switched the ID check off
    // entirely, so a hidden /kyc screen can never leave a user permanently unable
    // to withdraw with a message telling them to go and verify — see kyc.ts.
    if (config.kycRequiredForWithdrawal) {
      const u = await sql.get<{ kyc_status: string }>(
        "SELECT kyc_status FROM users WHERE id = ?", userId);
      if (!(await kycSatisfied(u?.kyc_status))) {
        return reply.code(403).send({
          error: u?.kyc_status === "pending"
            ? "We are still checking your ID. You can withdraw as soon as that is done."
            : "Verify your ID first, then you can withdraw.",
          // The web uses this to send them straight to /kyc instead of showing a
          // dead end.
          kycRequired: true,
          kycStatus: u?.kyc_status ?? "none",
        });
      }
    }

    // The chain must be one we currently OFFER, not merely one we can parse.
    // chainById still resolves Base and Aptos so historical rows keep their
    // labels (see chains.ts), which means a stale client could otherwise still
    // open a request on a chain we no longer pay out on — and it would validate
    // cleanly, hold the user's money, and sit in the queue unpayable.
    if (!chainIsOffered(chain)) {
      return reply.code(400).send({
        error: "We pay out in USDT on BNB Smart Chain (BEP20). Please use a BEP20 address.",
      });
    }

    // Validate the destination address for the chosen chain BEFORE holding funds
    // — a payout to a malformed address is unrecoverable.
    const addrCheck = validateAddress(chain as ChainId, addressRaw);
    if (!addrCheck.ok) return reply.code(400).send({ error: addrCheck.error });
    const address = addressRaw.trim();

    // GAS IS THE USER'S OWN RESPONSIBILITY (founder, 2026-08-08, second pass).
    // When the relay can sign from the user's own derived address, that
    // address must hold enough BNB BEFORE anything else happens — no debit,
    // no request row, no fallback to treasury or a manual queue. This is
    // checked here, not just inside the relay job later, because the whole
    // point is that nothing gets held while the user cannot actually be paid.
    if (relayAvailable(chain)) {
      const gas = await hasEnoughGas(userId, chain as "bep20");
      if (!gas.ok) {
        return reply.code(400).send({
          error: "You need BNB in your wallet to pay the network fee. Please deposit BNB to your RoziPay wallet before withdrawing USDT.",
          gasRequired: true,
          walletAddress: gas.address,
        });
      }
    }

    // Snapshot the current withdrawal fee onto the request, so a later Admin
    // change can't alter an in-flight payout. The user must have more than the
    // fee, or the net USDT would be zero/negative.
    //
    // The pre-existing flat fee (unchanged, a business decision) always
    // applies. The gas-cost fee (founder, 2026-08-08; DROPPED same day,
    // second pass) does NOT apply when the relay can sign from the user's
    // own address — gas is now checked and paid for real, in BNB, by the
    // user's own wallet (the gate above), not itemized as a USDT surcharge
    // the platform used to add "because the platform pretends to provide
    // gas." Only the direct-treasury fallback (relay unavailable) still
    // recovers real treasury gas cost this way.
    const flatFee = Math.max(0, Number(await getSetting("withdrawal_fee_points", "0")) || 0);
    const gasRate = await getGasFeeRate();
    const fee = flatFee + (relayAvailable(chain) ? 0 : gasFeePoints(amountPoints, gasRate));
    if (amountPoints <= fee) {
      return reply.code(400).send({ error: `The withdrawal fee is ${fee} points. Ask for more than that.` });
    }

    // Snapshot whether THIS destination was proved by the user (they signed for
    // it — see src/wallet.ts), for the same reason the fee is snapshotted: the
    // person approving an irreversible on-chain payout must see what was true
    // when the user asked, not a value that can move while the request queues.
    //
    // ⚠️ The match is on the ADDRESS, not merely "this user has some proved
    // wallet". A user who proved wallet A and is now withdrawing to wallet B has
    // proved nothing about B — and B is exactly where a scammer's address would
    // be. Compared case-insensitively because the proved copy is stored in
    // EIP-55 mixed case and a typed one may not be.
    const proved = await sql.get<{ n: number }>(
      `SELECT 1 AS n FROM payout_addresses
       WHERE user_id = ? AND chain = ? AND verified_at IS NOT NULL AND LOWER(address) = LOWER(?)`,
      userId, chain, address,
    );
    const addressVerified = proved ? 1 : 0;

    const id = newId();
    try {
      await sql.tx(async (t) => {
        // Serialize all money moves for this user. Without this, two concurrent
        // requests both read the same balance under READ COMMITTED, both pass
        // the check, and both debit — draining more than the user has. The lock
        // is held until this transaction commits, so the second request waits
        // and then sees the balance the first one already reduced.
        await t.run("SELECT pg_advisory_xact_lock(hashtext(?))", userId);
        if (sourceKind === "points" && amountPoints > (await balanceOf(userId, t)))
          throw { statusCode: 400, message: "You do not have that many points yet." };
        if (sourceKind === "earned_usdt" && earnedAmountMicro > (await earnedUsdtBalanceMicroOf(userId, t)))
          throw { statusCode: 400, message: "You do not have that much task USDT yet." };
        await t.run(
          `INSERT INTO withdrawal_requests (id, user_id, amount, payout_rail, payout_address, fee_points, address_verified,
             source_kind, earned_usdt_micro, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?, 'pending', ?)`,
          id, userId, amountPoints, chain, address, fee, addressVerified,
          sourceKind, earnedAmountMicro, now(),
        );
        // Hold the funds.
        if (sourceKind === "earned_usdt") {
          await postEarnedUsdt({ userId, micro: earnedAmountMicro, direction: "debit",
            sourceType: "withdrawal", sourceRefId: id, note: `Task USDT withdrawal (${chain})` }, t);
        } else {
          await postLedger({
            userId, points: amountPoints, direction: "debit",
            sourceType: "withdrawal", sourceRefId: id, note: `Withdrawal (USDT ${chain})`,
          }, t);
        }
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
    await checkWithdrawalVelocity(userId);

    // Fully automatic withdrawal (founder, 2026-08-05): try to settle right
    // now. Never blocks or fails the request either way — see the guarantee
    // on tryAutoSettle. Below the auto ceiling and the account isn't held?
    // The user gets "paid" back immediately. Otherwise this is a no-op and
    // the request sits in the same manual queue as always.
    const auto = await tryAutoSettle(id);
    if (auto.settled === true) {
      // autoWithdraw.ts sends its own "paid" push — sending a second
      // "submitted" one here would be a redundant notification for money
      // that already landed.
      return { request: { id, amount: amountPoints, chain, address, status: "paid", txHash: auto.txHash, usdt: auto.usdt } };
    }
    if (auto.settled === "processing") {
      // Routed through the user's own derived address (payoutRelay.ts) — a
      // few blocks away from 'paid', not instant, but not the manual queue.
      void sendPushToUser(userId, {
        title: "Withdrawal submitted", body: "We're sending your USDT now.", url: "/wallet",
      });
      return { request: { id, amount: amountPoints, chain, address, status: "sending" } };
    }

    void sendPushToUser(userId, {
      title: "Withdrawal submitted", body: "We got your request and will send it soon.", url: "/wallet",
    });
    return { request: { id, amount: amountPoints, amountUsdtMicro: earnedAmountMicro, sourceKind, chain, address, status: "pending" } };
  }));

  // Send a step-up code for a large withdrawal (see stepUpMinPoints above).
  // No amount is taken here — the amount only decides whether POST
  // /withdrawals requires the code, not whether one can be requested.
  app.post("/withdrawals/request-step-up", guard(async (userId, _req, reply) => {
    const user = await sql.get<{ email: string }>("SELECT email FROM users WHERE id = ?", userId);
    if (!user || user.email.endsWith("@telegram.local")) {
      return reply.code(400).send({ error: "Add an email to your account first." });
    }
    await issueCode(user.email, "withdraw");
    return { sent: true };
  }));

  // Saved payout addresses — a user sets a USDT address per chain ONCE and the
  // withdraw screen pre-fills it every time after.
  app.get("/withdrawals/addresses", guard(async (userId) => {
    const rows = await sql.all<{ chain: string; address: string; verified_at: string | null }>(
      "SELECT chain, address, verified_at FROM payout_addresses WHERE user_id = ?", userId,
    );
    const addresses: Record<string, string> = {};
    // Whether the user proved they hold each address by signing with the wallet.
    // A separate map rather than a field on `addresses`, so the shape every
    // existing caller reads is unchanged.
    const verified: Record<string, boolean> = {};
    for (const r of rows) {
      addresses[r.chain] = r.address;
      verified[r.chain] = r.verified_at != null;
    }
    return { addresses, verified };
  }));

  // ---- Connect a wallet, instead of pasting an address ----------------------
  //
  // Two steps, because a signature is only worth anything if WE chose what was
  // signed. Step one hands out a one-time message; step two takes the signature
  // of that exact message back and works out which address produced it.
  //
  // The address is not trusted from the request at any point. It is RECOVERED
  // from the signature, and the claim recorded in step one only has to match it.

  const challengeSchema = z.object({
    chain: z.enum(["bep20", "base", "aptos"]),
    address: z.string().min(1).max(120),
  });

  app.post("/withdrawals/addresses/challenge", {
    // Each call writes a row. The endpoint is authenticated, so this is not an
    // open door — it is a cap on how fast one account can fill the table.
    config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
  }, guard(async (userId, req, reply) => {
    const parsed = challengeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Pick a network and connect a wallet." });
    const { chain, address: addressRaw } = parsed.data;

    if (!chainIsOffered(chain)) {
      return reply.code(400).send({
        error: "We pay out in USDT on BNB Smart Chain (BEP20). Please use a BEP20 address.",
      });
    }
    // Only an EVM chain can produce a signature we can check this way. Aptos
    // uses Ed25519 with a different message format; if it is ever offered again
    // it needs its own verifier, not this one quietly accepting nothing.
    if (chainById(chain)?.kind !== "evm") {
      return reply.code(400).send({ error: "This network cannot connect a wallet yet. Paste your address instead." });
    }
    const check = validateAddress(chain as ChainId, addressRaw);
    if (!check.ok) return reply.code(400).send({ error: check.error });

    const address = addressRaw.trim().toLowerCase();
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
    const message = buildWalletMessage({
      host: siteHost(),
      address,
      chainLabel: chainById(chain)!.label,
      nonce,
      expiresAt,
    });

    await sql.run(
      `INSERT INTO wallet_link_nonces (nonce, user_id, chain, address, message, expires_at, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      nonce, userId, chain, address, message, expiresAt, now(),
    );
    return { nonce, message, expiresAt };
  }));

  const verifySchema = z.object({
    nonce: z.string().min(1).max(64),
    // 0x + 130 hex. Bounded here so a megabyte of "signature" never reaches the
    // recovery code.
    signature: z.string().min(1).max(200),
  });

  app.post("/withdrawals/addresses/verify", guard(async (userId, req, reply) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "That did not work. Please try connecting again." });
    const { nonce, signature } = parsed.data;

    const row = await sql.get<{
      user_id: string; chain: string; address: string; message: string;
      expires_at: string; used_at: string | null;
    }>("SELECT user_id, chain, address, message, expires_at, used_at FROM wallet_link_nonces WHERE nonce = ?", nonce);

    // One error for every way the challenge can be unusable — wrong owner,
    // already spent, expired, never existed. Telling an attacker WHICH of those
    // it was is telling them whether the code exists and whose it is.
    if (!row || row.user_id !== userId || row.used_at || row.expires_at <= now()) {
      return reply.code(400).send({ error: "That request has expired. Please connect your wallet again." });
    }

    // Re-check the chain, even though the challenge only exists because it
    // passed this same check ten minutes ago. A chain retired inside that
    // window would otherwise leave a saved address on a chain we no longer pay
    // out on — which is the exact failure PUT /withdrawals/addresses guards
    // against above, and the two paths must not disagree about it.
    if (!chainIsOffered(row.chain)) {
      return reply.code(400).send({
        error: "We pay out in USDT on BNB Smart Chain (BEP20). Please use a BEP20 address.",
      });
    }

    const signer = recoverSigner(row.message, signature);
    if (!signer || signer !== row.address) {
      // Deliberately does NOT burn the challenge. A wallet that signed with the
      // wrong account (people have several) should let the user switch and try
      // again inside the same 10 minutes, not send them back to the start.
      return reply.code(400).send({ error: "That signature is from a different wallet. Please try again." });
    }

    // Claim the challenge BEFORE saving anything. `WHERE used_at IS NULL` is
    // what makes it single-use: two taps arriving together both read the row as
    // unused above, and exactly one of them updates a row here.
    const claimed = await sql.get<{ nonce: string }>(
      `UPDATE wallet_link_nonces SET used_at = ?
       WHERE nonce = ? AND used_at IS NULL AND expires_at > ?
       RETURNING nonce`,
      now(), nonce, now(),
    );
    if (!claimed) {
      return reply.code(400).send({ error: "That request has expired. Please connect your wallet again." });
    }

    // Store the EIP-55 mixed-case form: it is what the user's wallet app shows
    // them, so the address on our screen and the address in their wallet are
    // the same string, character for character.
    const address = toChecksumAddress(signer);
    await saveAddress(userId, row.chain, address, true);
    await checkPayoutAddressReuse(userId, address);

    return { ok: true, chain: row.chain, address, verified: true };
  }));

  app.put("/withdrawals/addresses", guard(async (userId, req, reply) => {
    const parsed = addressSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Pick a network and enter a wallet address." });
    const { chain, address: addressRaw } = parsed.data;
    // Same gate as the request path. Saving an address on a chain we no longer
    // pay out on would let the withdraw screen pre-fill an address that is then
    // refused at the moment the user tries to use it.
    if (!chainIsOffered(chain)) {
      return reply.code(400).send({
        error: "We pay out in USDT on BNB Smart Chain (BEP20). Please use a BEP20 address.",
      });
    }
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
        addressVerified: Boolean(r.address_verified),
      })),
    };
  }));

  // ---- ONE WALLET, TWO REAL SOURCES (founder, 2026-09-03, un-blended same day) --
  //
  // Originally shipped as "ONE WALLET, ONE WITHDRAWAL" — deposit, task USDT
  // AND task/referral points all drawn from one combined total. The founder
  // reviewed it live the same day and cut points back out: this route now
  // only ever draws on money that actually exists somewhere real — a deposit
  // the user made, or task USDT paid directly in USDT. Points settle from the
  // TREASURY, not from anything deposited, so blending them into "how much
  // USDT do you have" misrepresented where the money actually was. Points cash
  // out through the separate, untouched POST /withdrawals flow instead (its
  // own queue, its own screen — /wallet/earnings/withdraw on the web).
  //
  // The platform minimum ($1) now applies to the combined deposit+earned-USDT
  // total, not to either alone — a user with $0.20 of task USDT can still add
  // $0.80 of real deposit and withdraw the full $1.00 in one request.
  //
  // Under the hood both ledgers are UNCHANGED (usdt_ledger / earned_usdt_ledger),
  // and so are their separate staff queues, auto-settle ceilings and
  // reject/refund-back logic (staff.ts, autoWithdraw.ts, autoRefund.ts,
  // payoutRelay.ts all still key off source_kind exactly as before). This route
  // only ADDS an orchestrator: one lock, one combined minimum check, then a
  // waterfall that draws deposit -> task USDT, creating exactly as many rows
  // as sources are actually needed (usually one; both only when neither alone
  // covers the amount). The old single-source endpoints above (/withdrawals,
  // /usdt/refunds) are untouched — staff tooling, disbursements, the
  // task-marketplace flow, and now the points cash-out screen all use them
  // directly.
  const walletWithdrawSchema = z.object({
    amountUsdtMicro: z.number().int().positive(),
    chain: z.enum(["bep20", "base", "aptos"]),
    address: z.string().min(1).max(120),
    stepUpCode: z.string().trim().optional(),
  });

  app.post("/wallet/withdraw", guard(async (userId, req, reply) => {
    const parsed = walletWithdrawSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter a valid amount, network, and wallet address." });
    const { amountUsdtMicro, chain, address: addressRaw, stepUpCode } = parsed.data;

    if (!chainIsOffered(chain)) {
      return reply.code(400).send({
        error: "We pay out in USDT on BNB Smart Chain (BEP20). Please use a BEP20 address.",
      });
    }
    const addrCheck = validateAddress(chain as ChainId, addressRaw);
    if (!addrCheck.ok) return reply.code(400).send({ error: addrCheck.error });
    const address = addressRaw.trim();

    // KYC applies uniformly here, even to a request that turns out to draw
    // purely from deposit — the split below isn't known until the balances
    // are locked, and /usdt/refunds already requires the same check on its
    // own money.
    if (config.kycRequiredForWithdrawal) {
      const u = await sql.get<{ kyc_status: string }>("SELECT kyc_status FROM users WHERE id = ?", userId);
      if (!(await kycSatisfied(u?.kyc_status))) {
        return reply.code(403).send({
          error: u?.kyc_status === "pending"
            ? "We are still checking your ID. You can withdraw as soon as that is done."
            : "Verify your ID first, then you can withdraw.",
          kycRequired: true,
          kycStatus: u?.kyc_status ?? "none",
        });
      }
    }

    // Gas is the user's own responsibility (founder, 2026-08-08) — every leg
    // below signs from this same derived address, so one check up front
    // covers all of them.
    if (relayAvailable(chain)) {
      const gas = await hasEnoughGas(userId, chain as "bep20");
      if (!gas.ok) {
        return reply.code(400).send({
          error: "You need BNB in your wallet to pay the network fee. Please deposit BNB to your RoziPay wallet before withdrawing USDT.",
          gasRequired: true,
          walletAddress: gas.address,
        });
      }
    }

    const minWithdraw = await minWithdrawPointsNow();
    const minMicro = usdtToMicro(Number(pointsToUsdt(minWithdraw)));
    if (amountUsdtMicro < minMicro) {
      return reply.code(400).send({
        error: `You need at least ${(minMicro / 1_000_000).toFixed(2)} USDT in total to get money. Add more first.`,
      });
    }

    // STEP-UP AUTH — same rule as /withdrawals, checked on the FULL amount
    // rather than whichever source ends up paying it: a large combined
    // withdrawal deserves the same proof of account control regardless of
    // which ledger it is drawn from.
    const equivPoints = Math.ceil((amountUsdtMicro * config.pointsPerUsdt) / 1_000_000);
    const priorRequested = await requestedLast24hPoints(userId);
    if (priorRequested + equivPoints >= config.stepUpMinPoints) {
      const user = await sql.get<{ email: string }>("SELECT email FROM users WHERE id = ?", userId);
      if (!user || user.email.endsWith("@telegram.local")) {
        return reply.code(400).send({ error: "Add an email to your account before a withdrawal this large." });
      }
      if (!stepUpCode) {
        return reply.code(400).send({
          error: "For a withdrawal this large, confirm with the code we email you.",
          stepUpRequired: true,
        });
      }
      const result = await consumeCode(user.email, stepUpCode, "withdraw");
      if (!result.ok) return reply.code(result.statusCode).send({ error: result.error, stepUpRequired: true });
    }

    const flatFeePoints = Math.max(0, Number(await getSetting("withdrawal_fee_points", "0")) || 0);
    const gasRate = await getGasFeeRate();
    const relayReady = relayAvailable(chain);

    let depositId: string | null = null;
    let earnedId: string | null = null;
    let mixedId: string | null = null;

    try {
      await sql.tx(async (t) => {
        // Serialize every ledger this request might touch (guardrail #8) —
        // one lock covers both.
        await t.run("SELECT pg_advisory_xact_lock(hashtext(?))", userId);

        const depositAvail = await usdtBalanceMicroOf(userId, t);
        const earnedAvail = await earnedUsdtBalanceMicroOf(userId, t);
        const totalAvail = depositAvail + earnedAvail;

        if (amountUsdtMicro > totalAvail) {
          throw { statusCode: 400, message: "You do not have that much yet." };
        }

        // Draw from whichever single source covers it first (money you added,
        // then task USDT) — the common case ends up identical to today's
        // single-source withdrawal, one row, one on-chain send. Only when
        // neither alone is enough does this fall back to drawing from both —
        // the "top up to reach $1" case.
        let depositTake = 0, earnedTake = 0;
        if (amountUsdtMicro <= depositAvail) {
          depositTake = amountUsdtMicro;
        } else if (amountUsdtMicro <= earnedAvail) {
          earnedTake = amountUsdtMicro;
        } else {
          depositTake = depositAvail;
          earnedTake = amountUsdtMicro - depositTake;
        }

        // The admin kill switch for cash-out (requireFeature("usdt_withdrawals"))
        // only ever gated /withdrawals — a request this route routes ENTIRELY
        // through the deposit leg must not trip it (deposit refunds have never
        // been gated on it, /usdt/refunds says so explicitly), but the moment
        // the task-USDT leg is drawn, the same rule has to apply here too, or
        // the switch stops doing anything the instant this endpoint exists.
        if (earnedTake > 0) {
          await requireFeature("usdt_withdrawals");
        }

        const earnedPoints = earnedTake > 0 ? Math.ceil((earnedTake * config.pointsPerUsdt) / 1_000_000) : 0;

        const proved = await t.get<{ n: number }>(
          `SELECT 1 AS n FROM payout_addresses
           WHERE user_id = ? AND chain = ? AND verified_at IS NOT NULL AND LOWER(address) = LOWER(?)`,
          userId, chain, address,
        );
        const addressVerified = proved ? 1 : 0;

        // The flat platform fee is charged once per submission, not once per
        // leg — it lands on the earned-USDT leg when one is drawn; the
        // deposit leg only ever carries its own gas-cost fee, same as
        // /usdt/refunds.
        const flatFeeHolder: "earned" | "none" = earnedTake > 0 ? "earned" : "none";

        if (depositTake > 0 && earnedTake > 0) {
          // ---- ONE WITHDRAWAL, ONE TRANSACTION (founder, 2026-09-05) --------
          // Both legs are needed to cover the request — a single combined
          // withdrawal_requests row instead of a deposit-shaped row AND an
          // earned-shaped row, so the user sees (and the relay sends) exactly
          // ONE payout instead of two. See payoutRelay.ts's prefund_micro for
          // how the on-chain side does this in one forward transaction.
          const depositFeeMicro = relayReady ? 0 : gasFeeMicro(depositTake, gasRate);
          const gasInPoints = relayReady ? 0 : gasFeePoints(earnedPoints, gasRate);
          const feePoints = gasInPoints + (flatFeeHolder === "earned" ? flatFeePoints : 0);
          if (feePoints >= earnedPoints || depositFeeMicro >= depositTake) {
            throw { statusCode: 400, message: "The withdrawal fee is too large for this amount. Ask for more." };
          }
          mixedId = newId();
          await t.run(
            `INSERT INTO withdrawal_requests (id, user_id, amount, payout_rail, payout_address, fee_points, address_verified,
               source_kind, earned_usdt_micro, deposit_component_micro, deposit_fee_micro, status, created_at)
             VALUES (?,?,?,?,?,?,?, 'mixed', ?,?,?, 'pending', ?)`,
            // `amount` (points) reuses equivPoints — the SAME combined-total
            // points-equivalent already computed above for the step-up check —
            // rather than a second, possibly slightly different rounding of
            // the two legs summed separately.
            mixedId, userId, equivPoints, chain, address, feePoints, addressVerified,
            earnedTake, depositTake, depositFeeMicro, now(),
          );
          await postEarnedUsdt({
            userId, micro: earnedTake, direction: "debit",
            sourceType: "withdrawal", sourceRefId: mixedId, note: `Task USDT withdrawal (${chain})`,
          }, t);
          await postUsdt({
            userId, micro: depositTake, direction: "debit", sourceType: "refund",
            sourceRefId: mixedId, note: "Money sent back", chain,
          }, t);
          return;
        }

        // ---- Leg: money the user added (deposit) alone -----------------------
        if (depositTake > 0) {
          const feeMicro = relayReady ? 0 : gasFeeMicro(depositTake, gasRate);
          if (feeMicro >= depositTake) {
            throw { statusCode: 400, message: "The withdrawal fee is too large for this amount. Ask for more." };
          }
          depositId = newId();
          await t.run(
            `INSERT INTO usdt_refund_requests (id, user_id, chain, address, amount, fee_micro, address_verified, status, created_at)
             VALUES (?,?,?,?,?,?,?, 'pending', ?)`,
            depositId, userId, chain, address, depositTake, feeMicro, addressVerified, now(),
          );
          await postUsdt({
            userId, micro: depositTake, direction: "debit", sourceType: "refund",
            sourceRefId: depositId, note: "Money sent back", chain,
          }, t);
        }

        // ---- Leg: task USDT already earned, alone -----------------------------
        if (earnedTake > 0) {
          const gasInPoints = relayReady ? 0 : gasFeePoints(earnedPoints, gasRate);
          const feePoints = gasInPoints + (flatFeeHolder === "earned" ? flatFeePoints : 0);
          if (feePoints >= earnedPoints) {
            throw { statusCode: 400, message: "The withdrawal fee is too large for this amount. Ask for more." };
          }
          earnedId = newId();
          await t.run(
            `INSERT INTO withdrawal_requests (id, user_id, amount, payout_rail, payout_address, fee_points, address_verified,
               source_kind, earned_usdt_micro, status, created_at)
             VALUES (?,?,?,?,?,?,?, 'earned_usdt', ?, 'pending', ?)`,
            earnedId, userId, earnedPoints, chain, address, feePoints, addressVerified, earnedTake, now(),
          );
          await postEarnedUsdt({
            userId, micro: earnedTake, direction: "debit",
            sourceType: "withdrawal", sourceRefId: earnedId, note: `Task USDT withdrawal (${chain})`,
          }, t);
        }
      });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      if (err.statusCode === 400) return reply.code(400).send({ error: err.message });
      throw e;
    }

    if (earnedId || mixedId) {
      await saveAddress(userId, chain, address);
      await checkPayoutAddressReuse(userId, address);
      await checkWithdrawalVelocity(userId);
    }

    // Try to settle every request that was created. Never throws (see the
    // guarantee on tryAutoSettle / tryAutoSettleRefund) — a request that
    // can't auto-settle just falls into its own existing manual queue.
    // At most ONE of these three is ever set — mixed handles both legs at
    // once, so it is never combined with depositId/earnedId in the same call.
    const legStatuses: ("paid" | "sending" | "pending")[] = [];
    if (depositId) {
      const r = await tryAutoSettleRefund(depositId);
      legStatuses.push(r.settled === true ? "paid" : r.settled === "processing" ? "sending" : "pending");
    }
    if (earnedId || mixedId) {
      const r = await tryAutoSettle((earnedId ?? mixedId)!);
      legStatuses.push(r.settled === true ? "paid" : r.settled === "processing" ? "sending" : "pending");
    }

    // Worst-case status wins: "pending" if anything is still waiting on
    // staff, else "sending" if anything is mid-relay, else "paid".
    const status = legStatuses.includes("pending") ? "pending" : legStatuses.includes("sending") ? "sending" : "paid";

    // Each auto-settled leg already sent its own push (autoWithdraw.ts /
    // autoRefund.ts). Only send one more, combined, when something is still
    // sitting in the manual queue waiting on staff.
    if (status === "pending") {
      void sendPushToUser(userId, {
        title: "Withdrawal submitted", body: "We got your request and will send it soon.", url: "/wallet",
      });
    }

    return { ok: true, amountUsdtMicro, status };
  }));

  // ---- BNB withdraw (wallet overhaul) ---------------------------------------
  //
  // A user pulling their OWN gas balance back out of their derived custody
  // address. ZERO treasury involvement, ZERO ledger entry — see bnbWithdraw.ts's
  // header. There is no fallback path when the relay isn't wired up: unlike
  // USDT (which has the old direct-treasury payout.ts path), BNB has never had
  // any other way to leave, so this is refused outright rather than queued.
  const bnbWithdrawSchema = z.object({
    address: z.string().min(1).max(120),
    amountBnb: z.string().trim().min(1).max(40),
  });

  app.post("/wallet/bnb/withdraw", guard(async (userId, req, reply) => {
    await requireFeature("bnb_withdrawals");
    const parsed = bnbWithdrawSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter a valid amount and wallet address." });
    const { address: addressRaw, amountBnb } = parsed.data;

    // No manual fallback exists for this route, unlike USDT (which always has
    // a staff-sent path) — a BNB withdrawal is signed from the user's own
    // derived address, and only the on-chain relay can do that. Refuse
    // outright rather than accept a request that would sit forever: see the
    // matching guard inside advanceBnbWithdrawal (bnbWithdraw.ts).
    if (!relayAvailable("bep20") || config.payoutMode !== "onchain") {
      return reply.code(400).send({ error: "Sending BNB out is not available yet." });
    }

    const addrCheck = validateAddress("bep20", addressRaw);
    if (!addrCheck.ok) return reply.code(400).send({ error: addrCheck.error });
    const address = addressRaw.trim();

    let amountWei: bigint;
    try {
      amountWei = parseEther(amountBnb);
      if (amountWei <= 0n) throw new Error("not positive");
    } catch {
      return reply.code(400).send({ error: "Enter a valid BNB amount." });
    }

    const gas = await hasEnoughGas(userId, "bep20");
    if (amountWei + requiredGasWei() > gas.balanceWei) {
      return reply.code(400).send({
        error: "You do not have enough BNB to cover this amount and its own network fee.",
        walletAddress: gas.address,
      });
    }

    const id = newId();
    try {
      await sql.run(
        `INSERT INTO bnb_withdrawal_requests (id, user_id, chain, address, amount_wei, status, created_at)
         VALUES (?,?, 'bep20', ?, ?, 'pending', ?)`,
        id, userId, address, amountWei.toString(), now(),
      );
    } catch {
      // The partial unique index refuses a second in-flight request per user.
      return reply.code(409).send({ error: "You already have a BNB withdrawal in progress." });
    }

    void sendPushToUser(userId, {
      title: "BNB withdrawal submitted", body: "We're sending your BNB now.", url: "/wallet/bnb",
    });

    // Deliberately NOT kicked off synchronously here — signing reaches the
    // real chain over the network, and every other relay path in this
    // codebase (payoutRelay.ts) leaves that entirely to the background tick
    // (server.ts's tickBnbWithdrawals) rather than firing it from inside a
    // request handler. Same reason: it keeps the route itself free of
    // network calls, and it is what lets the e2e suite prove the decision
    // logic here without ever reaching BSC (see payoutRelay.e2e.ts's header).
    return { ok: true, id, status: "pending" };
  }));

  app.get("/wallet/bnb/withdrawals", guard(async (userId) => {
    const rows = await sql.all<Record<string, unknown>>(
      "SELECT * FROM bnb_withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC", userId,
    );
    return {
      requests: rows.map((r) => ({
        id: r.id, address: r.address, amountWei: r.amount_wei, status: r.status,
        txHash: r.tx_hash ?? undefined, at: r.created_at, completedAt: r.completed_at ?? undefined,
      })),
    };
  }));

  // On-demand BNB history for /wallet/bnb (founder, 2026-08-29). The native BNB
  // deposit scanner is off (it cost real money running 24/7), so incoming BNB
  // never lands in native_deposits and the screen looked empty even with a
  // balance. This reads the chain HERE — only when the user opens that screen —
  // for their own derived address, cached 60s, never throws (see bscscan.ts).
  app.get("/wallet/bnb/history", guard(async (userId) => {
    if (!custodyEnabled("bep20")) return { rows: [] };
    const address = await getOrCreateDepositAddress(userId, "bep20");
    const rows = await fetchBnbAddressHistory(address);
    return {
      rows: rows.map((r) => ({
        hash: r.hash, from: r.from, to: r.to, amountWei: r.valueWei,
        at: r.at, direction: r.direction,
      })),
    };
  }));
}
