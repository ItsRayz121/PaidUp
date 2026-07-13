// KYC — the earner side. Submit a selfie + both sides of an ID; check the status.
//
// Founder decision (2026-07-13): review is MANUAL, by staff, in /staff. There is
// no vendor, no ID number, no name field, no date of birth. A human looks at a
// picture and decides. Every field we do not collect is a field that cannot leak.
//
// Being approved makes an account a VALID user, and that word is doing real work:
//   • only valid users count toward a mining halving milestone
//   • only valid invitees earn their inviter anything (the anti-farm line)
//   • only valid users can withdraw money
//
// Mining is deliberately NOT gated on it. A new user mines from minute one.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { sql, now, newId } from "../db.ts";
import { getUserId, requireActiveUser } from "../auth.ts";
import { encryptImage, parseDataUrl } from "../kyc.ts";

function guard(
  handler: (userId: string, req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = getUserId(req);
      await requireActiveUser(userId);
      return await handler(userId, req, reply);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Something went wrong" });
    }
  };
}

export async function kycRoutes(app: FastifyInstance) {
  // What the user sees on their own /kyc screen.
  app.get("/kyc", guard(async (userId) => {
    const u = await sql.get<{ kyc_status: string }>(
      "SELECT kyc_status FROM users WHERE id = ?", userId);
    const latest = await sql.get<{ status: string; reject_reason: string | null; created_at: string }>(
      `SELECT status, reject_reason, created_at FROM kyc_submissions
       WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, userId);

    return {
      status: u?.kyc_status ?? "none",
      // Only ever the reason for a REJECTION. There is nothing else in the
      // submission a user needs back from us, and the photos are never returned
      // to the browser — not even to their owner. Once they are in, they are in.
      rejectReason: latest?.status === "rejected" ? latest.reject_reason : null,
      submittedAt: latest?.created_at ?? null,
    };
  }));

  // Submit (or re-submit after a rejection).
  //
  // bodyLimit is raised HERE and nowhere else. Three photos at the 4MB cap, base64
  // encoded (+33%), is ~16MB, which is far over Fastify's 1MB default. Raising the
  // limit globally would hand every other endpoint — including the unauthenticated
  // postback and login routes — a cheap memory-exhaustion surface. So exactly one
  // route, behind auth, gets the big body.
  app.post("/kyc", {
    bodyLimit: 20 * 1024 * 1024,
    // A 20MB body plus three AES passes per call is the most expensive request
    // on the API. A real user submits once (twice after a rejection); ten an
    // hour per IP is family-on-one-NAT headroom, not a real constraint.
    config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    handler: guard(async (userId, req) => {
    const body = z.object({
      selfie: z.string().min(1),
      idFront: z.string().min(1),
      idBack: z.string().min(1),
    }).parse(req.body);

    const u = await sql.get<{ kyc_status: string }>(
      "SELECT kyc_status FROM users WHERE id = ?", userId);
    if (u?.kyc_status === "approved") {
      throw { statusCode: 400, message: "You are already verified." };
    }
    if (u?.kyc_status === "pending") {
      throw { statusCode: 400, message: "We are already checking your documents. Please wait." };
    }

    // Validate and sniff BEFORE encrypting, so a junk upload costs us a parse and
    // not three AES passes. parseDataUrl throws user-safe messages.
    const selfie = parseDataUrl(body.selfie, "selfie");
    const front = parseDataUrl(body.idFront, "ID front");
    const back = parseDataUrl(body.idBack, "ID back");

    const id = newId();
    await sql.tx(async (t) => {
      // The partial unique index on (user_id) WHERE status='pending' is what
      // actually stops a double submit — two concurrent POSTs would both pass the
      // status check above, and only one can win this insert.
      await t.run(
        `INSERT INTO kyc_submissions (id, user_id, selfie, id_front, id_back, status, created_at)
         VALUES (?,?,?,?,?,'pending',?)`,
        id, userId,
        encryptImage(selfie.bytes), encryptImage(front.bytes), encryptImage(back.bytes),
        now(),
      );
      await t.run("UPDATE users SET kyc_status = 'pending' WHERE id = ?", userId);
    });

    return { ok: true, status: "pending" };
    }),
  });
}
