// KYC — the staff side. The review queue, the photos, approve/reject.
//
// ADMIN ONLY, and that is a deliberate narrowing rather than a copy of the other
// staff panels. Agents handle support tickets and managers approve withdrawals,
// but neither of them needs to look at a stranger's national ID card, and the
// smallest possible number of people who can is the correct number. Every view of
// a photo is written to the audit log, because "who looked at my ID" is a question
// we must be able to answer.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { sql, now, logAudit } from "../db.ts";
import { requireStaff, type Role } from "../roles.ts";
import { decryptImage } from "../kyc.ts";

function staffGuard(
  allowed: Role[],
  handler: (ctx: { userId: string; role: Role }, req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await handler(await requireStaff(req, allowed), req, reply);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? "Something went wrong" });
    }
  };
}

export async function staffKycRoutes(app: FastifyInstance) {
  // The queue. Note what is NOT here: the photos. Listing them would mean
  // decrypting and shipping every pending ID card on every poll of the panel.
  // The list is metadata; the images are fetched one at a time, on purpose.
  app.get("/staff/kyc", staffGuard(["admin"], async (_ctx, req) => {
    const q = z.object({
      status: z.enum(["pending", "approved", "rejected"]).default("pending"),
    }).parse(req.query ?? {});

    const rows = await sql.all<{
      id: string; user_id: string; email: string; country: string;
      status: string; created_at: string; reviewed_at: string | null;
    }>(
      `SELECT k.id, k.user_id, u.email, u.country, k.status, k.created_at, k.reviewed_at
       FROM kyc_submissions k JOIN users u ON u.id = k.user_id
       WHERE k.status = ? ORDER BY k.created_at ASC LIMIT 100`,
      q.status,
    );
    return { submissions: rows };
  }));

  // One photo, decrypted, streamed back as raw image bytes.
  //
  // Served with `no-store` and a nosniff header: an ID card must never sit in a
  // browser cache or a CDN, and must never be interpreted as anything but an
  // image. The service worker is already navigation-only and never caches API
  // responses, so the door is shut on that side too.
  app.get("/staff/kyc/:id/:which", staffGuard(["admin"], async ({ userId, role }, req, reply) => {
    const p = z.object({
      id: z.string().min(1),
      which: z.enum(["selfie", "front", "back"]),
    }).parse(req.params);

    const row = await sql.get<{
      user_id: string; selfie: string; id_front: string; id_back: string;
    }>("SELECT user_id, selfie, id_front, id_back FROM kyc_submissions WHERE id = ?", p.id);
    if (!row) throw { statusCode: 404, message: "No such submission." };

    const stored = p.which === "selfie" ? row.selfie
      : p.which === "front" ? row.id_front : row.id_back;

    // Every look at an identity document is recorded. If a user ever asks who saw
    // their ID, this is the answer, and it is the reason the log entry is written
    // BEFORE the bytes go out.
    await logAudit({
      actorUserId: userId, actorRole: role, action: "kyc_view_document",
      detail: `viewed ${p.which} of submission ${p.id} (user ${row.user_id})`,
    });

    const bytes = decryptImage(stored);
    return reply
      .header("Content-Type", "image/jpeg")
      .header("Cache-Control", "no-store, private")
      .header("X-Content-Type-Options", "nosniff")
      // Belt and braces: even if a browser were talked into treating this as a
      // document, a restrictive CSP means nothing in it can execute.
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .send(bytes);
  }));

  app.post("/staff/kyc/:id/decide", staffGuard(["admin"], async ({ userId, role }, req) => {
    const id = (req.params as { id: string }).id;
    const b = z.object({
      decision: z.enum(["approved", "rejected"]),
      reason: z.string().max(300).optional(),
    }).parse(req.body);

    if (b.decision === "rejected" && !b.reason?.trim()) {
      throw { statusCode: 400, message: "Give a reason so the user knows what to fix." };
    }

    const result = await sql.tx(async (t) => {
      const row = await t.get<{ user_id: string; status: string }>(
        "SELECT user_id, status FROM kyc_submissions WHERE id = ?", id);
      if (!row) throw { statusCode: 404, message: "No such submission." };

      // The conditional UPDATE is the authority, not the read above: two admins
      // clicking approve at the same moment must not both write, and rowCount is
      // how we know which one of us won.
      const done = await t.run(
        `UPDATE kyc_submissions SET status = ?, reject_reason = ?, reviewed_by = ?, reviewed_at = ?
         WHERE id = ? AND status = 'pending'`,
        b.decision, b.reason ?? null, userId, now(), id,
      );
      if (done.rowCount === 0) {
        throw { statusCode: 400, message: "That submission has already been reviewed." };
      }

      if (b.decision === "approved") {
        // Stamp the approval time (COALESCE so a re-approval never moves it). This
        // is what the referral first-task bonus anchors to — see credit.ts.
        await t.run(
          "UPDATE users SET kyc_status = 'approved', kyc_approved_at = COALESCE(kyc_approved_at, ?) WHERE id = ?",
          now(), row.user_id,
        );
      } else {
        await t.run("UPDATE users SET kyc_status = ? WHERE id = ?", b.decision, row.user_id);
      }
      return row;
    });

    await logAudit({
      actorUserId: userId, actorRole: role, action: `kyc_${b.decision}`,
      detail: `submission ${id} (user ${result.user_id})${b.reason ? `: ${b.reason}` : ""}`,
    });

    // Approving a user changes the mining economy: they now count toward a halving
    // milestone, and they start earning their inviter referral hashrate. Both are
    // read live at settlement, so there is nothing to recompute here — but it is
    // worth knowing that this button moves the token supply.
    return { ok: true, status: b.decision };
  }));
}
