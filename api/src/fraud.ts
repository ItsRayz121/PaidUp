// Device fingerprinting + referral-ring detection (guardrail #5, and
// docs/ARCHITECTURE.md § Fraud & risk layer). Called from the auth flow with a
// client-computed device hash (no PII) and the request IP. Nothing here bans a
// user; it only records devices and raises fraud_flags that surface to staff.
import { sql, now, newId } from "./db.ts";
import { config } from "./config.ts";
import { sendStaffAlert } from "./alerts.ts";

// How many distinct accounts may share one device before we flag device reuse.
const DEVICE_REUSE_THRESHOLD = 3;

// Geo-mismatch: our launch markets, mapping the ISO-2 country codes networks
// usually put in a postback to the full names we store on the user row. Extend
// this as new markets open. Anything not here falls through to a name compare.
const ISO2_TO_COUNTRY: Record<string, string> = {
  PK: "pakistan", IN: "india", BD: "bangladesh", ID: "indonesia", NG: "nigeria",
};

// Normalise a country to a comparable token: known ISO-2 -> canonical name,
// otherwise the lower-cased, trimmed string ("Pakistan" and "pakistan" match).
function canonicalCountry(c: string): string {
  const t = c.trim();
  if (!t) return "";
  return ISO2_TO_COUNTRY[t.toUpperCase()] ?? t.toLowerCase();
}

// Raise a flag only if an unresolved one of the same (type, scope key) doesn't
// already exist — so repeated logins from the same device/IP don't spam the
// queue. `scopeKey` is stored in the device_id column: a real device hash for
// device-scoped flags, or `ip:<addr>` for IP-scoped ones (kept distinct so a
// device flag and an IP flag on the same cluster dedupe independently).
//
// `magnitude` (founder, 2026-09-07) is the SIZE of the problem this specific
// occurrence represents — accounts sharing a device, distinct mismatched
// countries, whatever the call site can count. It is what lets a staff
// member's "Resolve (permanent)" mean "stop telling me about THIS scale of
// problem" rather than "never check this user again": once a flag type has
// been permanently resolved for a user, a NEW occurrence at the same or a
// smaller magnitude stays silent, but one that has genuinely gotten worse
// (a 4th account, a 5th abusive referral) still fires normally. Omit it (as
// every call site without a natural count does) and permanent resolve simply
// behaves like temporary for that flag type — never silences it — because
// promising silence on a signal we cannot measure the scale of would be a
// real blind spot, not a favour.
//
// Returns whether a NEW row was inserted — callers don't need it, but it is
// what lets this function page staff on the first occurrence of a high-
// severity flag without re-alerting on every dedup no-op of an issue already
// sitting in the queue (see the alert below).
export async function flagOnce(
  flagType: string,
  scopeKey: string,
  userId: string | null,
  severity: string,
  detail: string,
  magnitude?: number,
): Promise<boolean> {
  const existing = await sql.get<{ id: string }>(
    "SELECT id FROM fraud_flags WHERE flag_type = ? AND device_id = ? AND resolved_by IS NULL LIMIT 1",
    flagType, scopeKey,
  );
  if (existing) return false;

  // Permanently-forgiven, and not yet worse than it was when forgiven: stay
  // silent. This is a plain read with no lock — worst case under a race is
  // two flags inserted for two different scope keys, which is fine; it is
  // never a double-spend and this must never block a fraud check.
  if (userId && magnitude != null) {
    const baseline = await sql.get<{ magnitude: number | null }>(
      `SELECT magnitude FROM fraud_flags
        WHERE user_id = ? AND flag_type = ? AND resolution_type = 'permanent'
        ORDER BY resolved_at DESC LIMIT 1`,
      userId, flagType,
    );
    if (baseline && baseline.magnitude != null && magnitude <= baseline.magnitude) {
      return false;
    }
  }

  await sql.run(
    "INSERT INTO fraud_flags (id, user_id, device_id, flag_type, severity, detail, magnitude, created_at) VALUES (?,?,?,?,?,?,?,?)",
    newId(), userId, scopeKey, flagType, severity, detail, magnitude ?? null, now(),
  );
  // Page staff on every genuinely NEW high-severity flag — the single
  // enforcement point for alerting, so a future high-severity flag type gets
  // paged automatically instead of needing its own call site remembered (the
  // same reasoning as guardrail #8's lockUser() list). Not awaited: sending
  // to Telegram must never add latency to a fraud check or a postback.
  if (severity === "high") {
    void sendStaffAlert(`⚠️ ${flagType}\n${detail}`);
  }
  return true;
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
        users.length,
      );
    }

    // 2. IP reuse: many accounts from one IP. Softer than device reuse —
    // carrier-grade NAT in our markets makes many users legitimately share an
    // IP — so the threshold is higher and severity only medium (staff review).
    // Computed once and reused by the referral-ring IP check below (3) — both
    // ask exactly the same question.
    const ipUsers = ip
      ? await sql.all<{ user_id: string }>("SELECT DISTINCT user_id FROM user_devices WHERE ip = ?", ip)
      : [];
    if (ip && ipUsers.length >= config.ipReuseThreshold) {
      await flagOnce(
        "ip_reuse", `ip:${ip}`, userId, "medium",
        `${ipUsers.length} accounts seen from this IP.`,
        ipUsers.length,
      );
    }

    // 3. Referral ring: the account was invited by someone it shares hardware
    // or network with — classic self-referral / farm signal. Sharing a DEVICE
    // is strong (high); sharing only an IP is a weaker fallback (medium). The
    // magnitude reused here (accounts entangled in the same device/IP
    // cluster) is what lets "forgive this referral pair" still re-flag once a
    // 4th or 5th account joins the same cluster (founder, 2026-09-07).
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
          users.length,
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
            ipUsers.length,
          );
        }
      }
    }
  } catch {
    // Fraud recording must never block a legitimate login.
  }
}

// Payout-address reuse (P2): many distinct accounts cashing out to the SAME
// USDT wallet is the classic account-farm signal — a fraudster funnels the
// points from dozens of fake accounts into one destination address. We compare
// the normalised address across all withdrawal requests; EVM addresses are
// case-insensitive, so we lower-case them (Aptos too — hex). Soft, medium,
// staff-review only: it NEVER blocks the withdrawal (a family sharing one wallet
// is plausible here), matching the rest of the layer. Call at request time.
// Best-effort — never throws into the withdrawal path.
export async function checkPayoutAddressReuse(
  userId: string,
  address: string,
): Promise<void> {
  try {
    const norm = address.trim().toLowerCase();
    if (!norm) return;
    const accounts = await sql.all<{ user_id: string }>(
      "SELECT DISTINCT user_id FROM withdrawal_requests WHERE LOWER(payout_address) = ?",
      norm,
    );
    if (accounts.length >= config.payoutAddressReuseThreshold) {
      await flagOnce(
        "payout_address_reuse", `addr:${norm}`, userId, "medium",
        `${accounts.length} accounts withdraw to this wallet address.`,
        accounts.length,
      );
    }
  } catch {
    // A fraud signal must never break a legitimate withdrawal.
  }
}

// Geo-mismatch (P2): the offer was completed from a country that differs from
// the one the account signed up in — a common signal of proxy/VPN farming or a
// resold account. Uses the country the NETWORK reports in its postback vs the
// user's stated country, so it needs no GeoIP database. Soft, medium-severity
// signal for staff review only: it does NOT block crediting (legitimate travel
// and mobile VPNs exist), matching device/IP-reuse. No-ops when the network
// doesn't send a country. Best-effort — never throws into the postback path.
export async function checkGeoMismatch(
  userId: string,
  statedCountry: string,
  reportedCountry: string | undefined,
): Promise<void> {
  if (!reportedCountry) return; // network sent no country; nothing to compare
  try {
    const stated = canonicalCountry(statedCountry);
    const reported = canonicalCountry(reportedCountry);
    if (!stated || !reported || stated === reported) return;
    // Scope the dedupe by user + reported country, so a user genuinely on the
    // move raises at most one open flag per foreign country, not one per offer.
    //
    // ⚠️ NO MAGNITUDE HERE, DELIBERATELY (found in review, 2026-09-07). An
    // earlier version tried "distinct OTHER countries seen, excluding this
    // one" as a stand-in escalation score — it looked stable in isolation,
    // but is NOT: that count keeps growing as unrelated countries get
    // flagged over time, so country A recurring after being forgiven could
    // read as "escalated" purely because country B happened to appear in
    // between, with nothing about A itself having changed. Same treatment as
    // mining_bot_pattern/mining_device_share below: permanent resolve still
    // clears the current backlog, it just never promises future silence for
    // this flag type — a real blind spot here (this account can never be
    // geo-flagged again) would be worse than an occasional repeat flag.
    const scopeKey = `geo:${userId}:${reported}`;
    await flagOnce(
      "geo_mismatch", scopeKey, userId, "medium",
      `Offer completed from "${reportedCountry}" but account country is "${statedCountry}".`,
    );
  } catch {
    // Never let a fraud signal break a verified credit.
  }
}
