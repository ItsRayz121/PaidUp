// E2E for the "image" task-field kind (founder, 2026-09-07): a user attaches
// a screenshot as proof, staff view it decrypted on demand, and the
// admin-tunable retention job deletes only the photo bytes, never the rest of
// the proof.
//
//   npm run test:taskproofimages
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import sharp from "sharp";
import { initDb, sql, now, newId, setSetting } from "../db.ts";
import { config } from "../config.ts";
import { appRoutes } from "../routes/app.ts";
import { staffTaskRoutes } from "../routes/staffTasks.ts";
import { tickTaskProofRedaction } from "../taskProofRedaction.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(appRoutes);
await app.register(staffTaskRoutes);

const TAG = newId().slice(0, 8);
const authOf = (id: string) => ({ authorization: `Bearer ${jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: "1h" })}` });

let seq = 0;
async function mkUser(label: string) {
  const id = newId();
  await sql.run(
    `INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at, kyc_status)
     VALUES (?,?,1,'Pakistan',?,'active',?, 'approved')`,
    id, `${TAG}-${label}@t.test`, `${TAG}${(seq++).toString(36)}`.toUpperCase().slice(0, 12), now(),
  );
  return id;
}
async function mkStaff(label: string, role: string) {
  const id = await mkUser(label);
  await sql.run("INSERT INTO admin_users (user_id, role, created_at) VALUES (?,?,?)", id, role, now());
  return id;
}

const admin = await mkStaff("admin", "admin");
const outsider = await mkUser("outsider");

const createTask = async (payload: Record<string, unknown>) => {
  const r = await app.inject({ method: "POST", url: "/staff/tasks", headers: authOf(admin), payload });
  return (r.json() as { ok: boolean; id?: string; error?: string });
};

// A GENUINELY DECODABLE JPEG, not just magic-byte-prefixed garbage — the
// server now actually decompresses and re-encodes every upload (taskFields.ts),
// so a fixture that only satisfies the magic-byte sniff (like kyc.e2e.ts's,
// which is never handed to sharp) would fail at the compression step here.
// 2000px on the long side, ON PURPOSE — bigger than
// TASK_PROOF_IMAGE_MAX_DIMENSION (1600), so the tests below can prove the
// downscale actually happens, not just that SOME webp comes back.
const JPEG = await sharp({
  create: { width: 2000, height: 1000, channels: 3, background: { r: 200, g: 30, b: 30 } },
}).jpeg().toBuffer();
const jpegUrl = `data:image/jpeg;base64,${JPEG.toString("base64")}`;
const fakeJpegUrl = `data:image/jpeg;base64,${Buffer.from("<svg onload=alert(1)>").toString("base64")}`;

const task = await createTask({
  title: `${TAG} screenshot proof`, points: 100, verifyMode: "proof", countries: ["ALL"],
});
const taskId = task.id!;

const put = await app.inject({
  method: "PUT", url: `/staff/tasks/${taskId}/fields`, headers: authOf(admin),
  payload: { fields: [{ label: "Upload a screenshot", kind: "image", required: true }] },
});
const fieldId = (put.json() as { fields: { id: string }[] }).fields[0].id;

const user = await mkUser("earner");

console.log("\n-- validation, before anything is ever stored --");
{
  const missing = await app.inject({
    method: "POST", url: `/tasks/${taskId}/proof`, headers: authOf(user), payload: {},
  });
  check("a missing required photo is refused",
    (missing.json() as { ok: boolean; error?: string }).error?.includes("photo") ?? false,
    JSON.stringify(missing.json()));

  const fake = await app.inject({
    method: "POST", url: `/tasks/${taskId}/proof`, headers: authOf(user),
    payload: { images: { [fieldId]: fakeJpegUrl } },
  });
  check("a real magic-byte check — a fake 'jpeg' (really an SVG) is refused",
    (fake.json() as { ok: boolean }).ok === false, JSON.stringify(fake.json()));

  // Refused either by Fastify's own request-body-size limit or by
  // taskFields.ts's own byte cap, depending on which layer sees it first —
  // both are a real refusal, so the assertion is on the outcome (never a
  // 2xx, never a stored row), not on which layer's error shape wins.
  const oversized = await app.inject({
    method: "POST", url: `/tasks/${taskId}/proof`, headers: authOf(user),
    payload: { images: { [fieldId]: `data:image/jpeg;base64,${Buffer.alloc(config.kycMaxImageBytes + 1000, 0xff).toString("base64")}` } },
  });
  check("an oversized photo is refused, not accepted",
    oversized.statusCode !== 200 || (oversized.json() as { ok: boolean }).ok === false,
    `status=${oversized.statusCode} body=${oversized.body.slice(0, 200)}`);

  const noRowsYet = await sql.get<{ n: string }>("SELECT COUNT(*) AS n FROM task_proof_images");
  check("none of the refused attempts left a row behind", Number(noRowsYet?.n ?? -1) === 0);
}

console.log("\n-- a real submission stores the photo encrypted, in its OWN table --");
let proofId = "";
let imageId = "";
{
  const submit = await app.inject({
    method: "POST", url: `/tasks/${taskId}/proof`, headers: authOf(user),
    payload: { images: { [fieldId]: jpegUrl } },
  });
  check("submit succeeds", (submit.json() as { ok: boolean }).ok === true, JSON.stringify(submit.json()));

  const proofRow = await sql.get<{ id: string; answers: string }>(
    "SELECT id, answers FROM task_proofs WHERE task_id = ? AND user_id = ?", taskId, user,
  );
  proofId = proofRow!.id;
  const answers = JSON.parse(proofRow!.answers) as { kind: string; value: string }[];
  check("the answer is a reference token, never the photo itself",
    answers[0].kind === "image" && /^img:[a-z0-9-]+$/i.test(answers[0].value), JSON.stringify(answers));
  imageId = answers[0].value.slice(4);

  const imgRow = await sql.get<{ mime: string; encrypted_value: string }>(
    "SELECT mime, encrypted_value FROM task_proof_images WHERE id = ? AND proof_id = ?", imageId, proofId,
  );
  check("a task_proof_images row exists", !!imgRow);
  check("it was re-encoded to webp, whatever format was uploaded", imgRow?.mime === "image/webp");
  check("the stored value is ENCRYPTED — the plaintext base64 does not appear in it",
    !imgRow!.encrypted_value.includes(JPEG.toString("base64").slice(0, 40)));
  // The actual cost claim, checked directly: an encrypted, base64-doubled
  // WEBP of a downscaled 1600px image should still land well under the
  // original 2000px JPEG's own size.
  check("compression genuinely shrank what gets stored, not just re-labelled it",
    Buffer.byteLength(imgRow!.encrypted_value, "base64") < JPEG.length,
    `stored~${Buffer.byteLength(imgRow!.encrypted_value, "base64")} original=${JPEG.length}`);
}

console.log("\n-- staff can view it decrypted; nobody else can --");
{
  const asStaff = await app.inject({
    method: "GET", url: `/staff/task-proofs/${proofId}/images/${imageId}`, headers: authOf(admin),
  });
  const body = asStaff.json() as { ok: boolean; deleted: boolean; dataUrl?: string };
  check("staff read succeeds", asStaff.statusCode === 200 && body.ok === true);
  check("not marked deleted", body.deleted === false);
  const decoded = Buffer.from((body.dataUrl ?? "").split(",")[1] ?? "", "base64");
  const meta = await sharp(decoded).metadata();
  check("it decrypts back to a real, decodable webp image", meta.format === "webp");
  check("the longer side was capped at the configured max dimension",
    Math.max(meta.width ?? 0, meta.height ?? 0) <= 1600, JSON.stringify(meta));
  check("aspect ratio survived the resize (2:1 in, 2:1 out)",
    Math.abs((meta.width ?? 0) / (meta.height ?? 1) - 2) < 0.05, JSON.stringify(meta));
  check("the data URL carries the real (re-encoded) mime",
    (body.dataUrl ?? "").startsWith("data:image/webp;base64,"));

  const asOutsider = await app.inject({
    method: "GET", url: `/staff/task-proofs/${proofId}/images/${imageId}`, headers: authOf(outsider),
  });
  check("a non-staff caller is refused", asOutsider.statusCode === 403);

  const wrongProof = await app.inject({
    method: "GET", url: `/staff/task-proofs/${newId()}/images/${imageId}`, headers: authOf(admin),
  });
  check("a mismatched proof id finds nothing (the id pair is checked, not just the image id)",
    wrongProof.statusCode === 404);
}

console.log("\n-- retention: only the photo bytes are deleted, everything else survives --");
{
  // Force this row old enough to be swept, and set a real, short retention
  // window rather than trusting the config default.
  await setSetting("task_proof_image_retention_days", "7");
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  await sql.run("UPDATE task_proof_images SET created_at = ? WHERE id = ?", old, imageId);

  const before = await sql.get<Record<string, unknown>>(
    "SELECT proof_text, status, answers FROM task_proofs WHERE id = ?", proofId,
  );

  const result = await tickTaskProofRedaction();
  check("the sweep reports exactly one row redacted", result.redacted === 1, JSON.stringify(result));

  const row = await sql.get<{ encrypted_value: string | null; redacted_at: string | null; mime: string; field_id: string }>(
    "SELECT encrypted_value, redacted_at, mime, field_id FROM task_proof_images WHERE id = ?", imageId,
  );
  check("the photo bytes are gone", row?.encrypted_value === null);
  check("redacted_at is stamped", !!row?.redacted_at);
  check("field_id and mime survive — this was a targeted null, not a row wipe",
    row?.field_id === fieldId && row?.mime === "image/webp");

  const after = await sql.get<Record<string, unknown>>(
    "SELECT proof_text, status, answers FROM task_proofs WHERE id = ?", proofId,
  );
  check("the owning task_proofs row is COMPLETELY untouched",
    JSON.stringify(before) === JSON.stringify(after));

  const viewAfter = await app.inject({
    method: "GET", url: `/staff/task-proofs/${proofId}/images/${imageId}`, headers: authOf(admin),
  });
  const viewBody = viewAfter.json() as { ok: boolean; deleted: boolean; note?: string };
  check("the staff view now says the photo was deleted, not an error",
    viewBody.ok === true && viewBody.deleted === true && !!viewBody.note, JSON.stringify(viewBody));

  const again = await tickTaskProofRedaction();
  check("re-running the sweep does not touch an already-redacted row",
    again.redacted === 0, JSON.stringify(again));
}

console.log("\n-- retention set to 0 means the sweep is a no-op --");
{
  await setSetting("task_proof_image_retention_days", "0");
  const u2 = await mkUser("earner2");
  await app.inject({
    method: "POST", url: `/tasks/${taskId}/proof`, headers: authOf(u2),
    payload: { images: { [fieldId]: jpegUrl } },
  });
  const row = await sql.get<{ id: string }>(
    "SELECT tpi.id FROM task_proof_images tpi JOIN task_proofs tp ON tp.id = tpi.proof_id WHERE tp.user_id = ?", u2,
  );
  await sql.run("UPDATE task_proof_images SET created_at = ? WHERE id = ?",
    new Date(Date.now() - 999 * 24 * 60 * 60 * 1000).toISOString(), row!.id);
  const result = await tickTaskProofRedaction();
  check("0 days means never delete, even for a very old row", result.redacted === 0, JSON.stringify(result));
}

console.log("\n-- a resubmission cascades away the old photo --");
{
  await setSetting("task_proof_image_retention_days", "30");
  const u3 = await mkUser("earner3");
  const first = await app.inject({
    method: "POST", url: `/tasks/${taskId}/proof`, headers: authOf(u3),
    payload: { images: { [fieldId]: jpegUrl } },
  });
  const firstProofId = (await sql.get<{ id: string }>(
    "SELECT id FROM task_proofs WHERE task_id = ? AND user_id = ?", taskId, u3,
  ))!.id;
  check("first submit ok", (first.json() as { ok: boolean }).ok === true);

  const secondJpeg = await sharp({
    create: { width: 300, height: 300, channels: 3, background: { r: 30, g: 30, b: 200 } },
  }).jpeg().toBuffer();
  await app.inject({
    method: "POST", url: `/tasks/${taskId}/proof`, headers: authOf(u3),
    payload: { images: { [fieldId]: `data:image/jpeg;base64,${secondJpeg.toString("base64")}` } },
  });

  const orphan = await sql.get<{ id: string }>("SELECT id FROM task_proof_images WHERE proof_id = ?", firstProofId);
  check("the old proof row (and its cascade-deleted image) is gone", !orphan);

  const newProof = await sql.get<{ id: string }>(
    "SELECT id FROM task_proofs WHERE task_id = ? AND user_id = ?", taskId, u3,
  );
  const newImages = await sql.all<{ id: string }>("SELECT id FROM task_proof_images WHERE proof_id = ?", newProof!.id);
  check("exactly one image row exists for the resubmission", newImages.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
