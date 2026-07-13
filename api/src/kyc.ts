// KYC — encrypting and decrypting the identity photos.
//
// We hold a selfie and both sides of a Pakistani national ID card for every user
// who wants to withdraw. That is the most sensitive data in this product by a
// wide margin, and a plaintext leak of it would be far worse than a leak of the
// money ledger: a balance can be restored, an identity cannot.
//
// So the photos are encrypted with AES-256-GCM before they touch Postgres, under
// a key that lives only in the environment (KYC_ENCRYPTION_KEY). A stolen database
// backup — the realistic breach for a small team on managed infrastructure —
// therefore decrypts to nothing at all.
//
// GCM, not CBC: it is authenticated, so a tampered ciphertext fails loudly on
// decrypt instead of silently returning garbage bytes that we would then hand to
// a reviewer as if they were a real ID.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { config } from "./config.ts";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;   // 96-bit nonce, the size GCM is defined for
const TAG_BYTES = 16;

// The dev fallback. It is derived from a fixed string and is PUBLIC — it is in
// the git history you are reading right now. That is fine for a laptop with fake
// IDs on it, and catastrophic in production, which is why boot() below refuses to
// start without a real key when NODE_ENV is production.
const DEV_KEY = createHash("sha256").update("rozipay-dev-kyc-key-not-for-production").digest();

function key(): Buffer {
  const raw = config.kycEncryptionKey;
  if (!raw) return DEV_KEY;
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) {
    throw new Error(
      "KYC_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate one with:\n" +
      `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return buf;
}

// True when we are running on the public dev key. Used by the boot check.
export function usingDevKycKey(): boolean {
  return !config.kycEncryptionKey;
}

// Encrypt raw image bytes. The IV is random per image (never reused — reusing a
// nonce under the same key is the one thing that breaks GCM outright), and it is
// stored alongside the ciphertext because it is not secret.
//
// Layout: base64( iv[12] || tag[16] || ciphertext )
export function encryptImage(plain: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key(), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString("base64");
}

export function decryptImage(stored: string): Buffer {
  const raw = Buffer.from(stored, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("KYC image is corrupt.");
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  // Throws if the tag does not verify — i.e. if the row was tampered with, or if
  // the key changed. Failing loudly is the point; a reviewer must never be shown
  // bytes we cannot vouch for.
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

// ---- Upload parsing ---------------------------------------------------------

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

// Magic bytes. The data: URL's declared MIME type is attacker-controlled, so it
// is a hint, not evidence — we check what the file actually IS. This is what stops
// someone storing an HTML or SVG payload that a future reviewer's browser would
// happily execute when the image is served back.
function sniff(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF"
    && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export type ParsedImage = { bytes: Buffer; mime: string };

// Takes a `data:image/jpeg;base64,...` URL from the browser and returns the real
// bytes, or throws a message safe to show a user.
export function parseDataUrl(input: string, label: string): ParsedImage {
  const m = /^data:([a-z/+.-]+);base64,(.+)$/i.exec(input ?? "");
  if (!m) throw { statusCode: 400, message: `The ${label} photo is not a valid image.` };

  const declared = m[1].toLowerCase();
  if (!ALLOWED_MIME.has(declared)) {
    throw { statusCode: 400, message: `The ${label} photo must be a JPG, PNG or WEBP.` };
  }

  // Reject on the ENCODED length first. Decoding a 100MB base64 string to find out
  // it is too big means we already allocated 100MB — this is the cheap check, and
  // it runs before we do any work an attacker could make us pay for.
  const maxEncoded = Math.ceil(config.kycMaxImageBytes * 4 / 3) + 64;
  if (m[2].length > maxEncoded) {
    throw { statusCode: 413, message: `The ${label} photo is too big. Try again with a smaller photo.` };
  }

  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length === 0) throw { statusCode: 400, message: `The ${label} photo is empty.` };
  if (bytes.length > config.kycMaxImageBytes) {
    throw { statusCode: 413, message: `The ${label} photo is too big. Try again with a smaller photo.` };
  }

  // The real test. A declared image/jpeg whose bytes are actually `<svg onload=…>`
  // is rejected here, not stored and served back to an admin later.
  const actual = sniff(bytes);
  if (!actual || actual !== declared) {
    throw { statusCode: 400, message: `The ${label} photo is not a real image file.` };
  }

  return { bytes, mime: actual };
}
