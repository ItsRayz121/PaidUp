import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { sql, now, newId, balanceOf, postLedger, getSetting } from "../db.ts";
import { config } from "../config.ts";
import { getUserId, requireActiveUser } from "../auth.ts";
import { validateAddress, chainIsOffered, chainById, type ChainId } from "../chains.ts";
import { checkPayoutAddressReuse } from "../fraud.ts";
import { buildWalletMessage, recoverSigner, toChecksumAddress } from "../wallet.ts";

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
      await requireActiveUser(userId); // suspended accounts cannot move money
      return await handler(userId, req, reply);
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

    // KYC GATE (founder decision, 2026-07-13). You should know who you are sending
    // money to. Checked here, at REQUEST time, rather than at approval: a user who
    // cannot be paid should be told so before their points are held, not after
    // they have sat in a queue for two days waiting for a payout that will not come.
    if (config.kycRequiredForWithdrawal) {
      const u = await sql.get<{ kyc_status: string }>(
        "SELECT kyc_status FROM users WHERE id = ?", userId);
      if (u?.kyc_status !== "approved") {
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

    // Snapshot the current withdrawal fee onto the request, so a later Admin
    // change can't alter an in-flight payout. The user must have more than the
    // fee, or the net USDT would be zero/negative.
    const fee = Math.max(0, Number(await getSetting("withdrawal_fee_points", "0")) || 0);
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
        if (amountPoints > (await balanceOf(userId, t))) {
          throw { statusCode: 400, message: "You do not have that many points yet." };
        }
        await t.run(
          `INSERT INTO withdrawal_requests (id, user_id, amount, payout_rail, payout_address, fee_points, address_verified, status, created_at)
           VALUES (?,?,?,?,?,?,?, 'pending', ?)`,
          id, userId, amountPoints, chain, address, fee, addressVerified, now(),
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
}
