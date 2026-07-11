// Device fingerprinting + referral-ring detection (guardrail #5, and
// docs/ARCHITECTURE.md § Fraud & risk layer). Called from the auth flow with a
// client-computed device hash (no PII) and the request IP. Nothing here bans a
// user; it only records devices and raises fraud_flags that surface to staff.
import { sql, now, newId } from "./db.ts";
import { config } from "./config.ts";

// How many distinct accounts may share one device before we flag device reuse.
const DEVICE_REUSE_THRESHOLD = 3;

// Raise a flag only if an unresolved one of the same (type, scope key) doesn't
// already exist — so repeated logins from the same device/IP don't spam the
// queue. `scopeKey` is stored in the device_id column: a real device hash for
// device-scoped flags, or `ip:<addr>` for IP-scoped ones (kept distinct so a
// device flag and an IP flag on the same cluster dedupe independently).
async function flagOnce(
  flagType: string,
  scopeKey: string,
  userId: string | null,
  severity: string,
  detail: string,
): Promise<void> {
  const existing = await sql.get<{ id: string }>(
    "SELECT id FROM fraud_flags WHERE flag_type = ? AND device_id = ? AND resolved_by IS NULL LIMIT 1",
    flagType, scopeKey,
  );
  if (existing) return;
  await sql.run(
    "INSERT INTO fraud_flags (id, user_id, device_id, flag_type, severity, detail, created_at) VALUES (?,?,?,?,?,?,?)",
    newId(), userId, scopeKey, flagType, severity, detail, now(),
  );
}

// Record that `userId` was seen on `deviceId` from `ip`, then run detection.
// Safe to call on every login/verify — the (user, device) row is upserted and
// flags are deduped. Best-effort: never throws into the auth path.
export async function recordDevice(
  userId: string,
  deviceId: string | undefined,
  ip: string | undefined,
): Promise<void> {
  if (!deviceId) return; // client didn't send a fingerprint; nothing to record
  try {
    const existing = await sql.get<{ id: string }>(
      "SELECT id FROM user_devices WHERE user_id = ? AND device_id = ?", userId, deviceId,
    );
    if (existing) {
      await sql.run("UPDATE user_devices SET last_seen = ?, ip = ? WHERE id = ?", now(), ip ?? null, existing.id);
    } else {
      await sql.run(
        "INSERT INTO user_devices (id, user_id, device_id, ip, first_seen, last_seen) VALUES (?,?,?,?,?,?)",
        newId(), userId, deviceId, ip ?? null, now(), now(),
      );
    }

    // 1. Device reuse: many accounts on one physical device.
    const users = await sql.all<{ user_id: string }>(
      "SELECT DISTINCT user_id FROM user_devices WHERE device_id = ?", deviceId,
    );
    if (users.length >= DEVICE_REUSE_THRESHOLD) {
      await flagOnce(
        "device_reuse", deviceId, userId, "medium",
        `${users.length} accounts share this device.`,
      );
    }

    // 2. IP reuse: many accounts from one IP. Softer than device reuse —
    // carrier-grade NAT in our markets makes many users legitimately share an
    // IP — so the threshold is higher and severity only medium (staff review).
    if (ip) {
      const ipUsers = await sql.all<{ user_id: string }>(
        "SELECT DISTINCT user_id FROM user_devices WHERE ip = ?", ip,
      );
      if (ipUsers.length >= config.ipReuseThreshold) {
        await flagOnce(
          "ip_reuse", `ip:${ip}`, userId, "medium",
          `${ipUsers.length} accounts seen from this IP.`,
        );
      }
    }

    // 3. Referral ring: the account was invited by someone it shares hardware
    // or network with — classic self-referral / farm signal. Sharing a DEVICE
    // is strong (high); sharing only an IP is a weaker fallback (medium).
    const me = await sql.get<{ referred_by: string | null }>(
      "SELECT referred_by FROM users WHERE id = ?", userId,
    );
    if (me?.referred_by) {
      const sharesDevice = await sql.get<{ id: string }>(
        "SELECT id FROM user_devices WHERE user_id = ? AND device_id = ? LIMIT 1",
        me.referred_by, deviceId,
      );
      if (sharesDevice) {
        await flagOnce(
          "referral_ring", deviceId, userId, "high",
          `Invited account shares a device with its referrer (${me.referred_by}).`,
        );
      } else if (ip) {
        const sharesIp = await sql.get<{ id: string }>(
          "SELECT id FROM user_devices WHERE user_id = ? AND ip = ? LIMIT 1",
          me.referred_by, ip,
        );
        if (sharesIp) {
          await flagOnce(
            "referral_ring", `ip:${ip}`, userId, "medium",
            `Invited account shares an IP with its referrer (${me.referred_by}).`,
          );
        }
      }
    }
  } catch {
    // Fraud recording must never block a legitimate login.
  }
}
