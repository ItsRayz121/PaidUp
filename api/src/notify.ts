// Notifications — the in-app inbox and how a staff message reaches it
// (brief part 39).
//
// ⚠️ THE INBOX IS THE CHANNEL. PUSH IS AN EXTRA, AND THAT ORDER IS DELIBERATE.
// push.ts has said since it was written that a push goes out on exactly four
// events and never for marketing. That rule was not arbitrary: a browser
// subscription is revoked once, permanently, by an annoyed user — and the
// notification it was there for is "your withdrawal was paid". Spending it on
// an announcement costs the one message that builds trust.
//
// So a staff announcement lands in the inbox, which interrupts nobody, and
// sending a push alongside it is a separate explicit tick on the compose
// screen with the cost stated next to it. The rule is amended, not abandoned:
// the four events still push automatically; everything else has to be chosen.
//
// ⚠️ THE AUDIENCE IS MATERIALISED AT SEND TIME. Every rule below resolves to a
// concrete set of user ids in one statement, and those rows are written then.
// Re-evaluating the rule at read time would mean "everyone with a balance on
// Tuesday" silently becoming "everyone with one today" — a message about a
// moment that keeps finding new recipients forever, and no answer to "who did
// we tell?".
import { sql, now, newId } from "./db.ts";
import { sendPushToUser } from "./push.ts";

export type AudienceId =
  | "all"            // every verified account
  | "active_7d"      // signed in / used the app in the last 7 days
  | "inactive_30d"   // has NOT, for 30 days — the win-back audience
  | "withdrawable"   // holds at least the withdrawal minimum
  | "miners"         // has ever been credited ROZI from mining
  | "verified_id";   // passed the ID check

export const AUDIENCES: Record<AudienceId, { label: string; note: string }> = {
  all: { label: "Everyone", note: "Every account with a verified email." },
  active_7d: { label: "Active this week", note: "Used the app in the last 7 days." },
  inactive_30d: { label: "Gone quiet (30 days)", note: "Has not opened the app in 30 days." },
  withdrawable: { label: "Can cash out now", note: "Holds at least the withdrawal minimum." },
  miners: { label: "Miners", note: "Has ever earned ROZI from mining." },
  verified_id: { label: "ID verified", note: "Passed the ID check." },
};

export function isAudience(v: unknown): v is AudienceId {
  return typeof v === "string" && v in AUDIENCES;
}

/**
 * The SELECT that produces the recipient ids for an audience.
 *
 * Every branch starts from `users u` with `email_verified = 1`, because an
 * unverified shell account is not a person — it is a half-finished signup, and
 * counting one as a recipient makes every "we reached N users" number wrong.
 *
 * Returned as SQL text rather than a list of ids on purpose: the fan-out below
 * is one `INSERT … SELECT`, so a hundred thousand recipients is one statement
 * and not a hundred thousand round trips.
 */
function audienceSql(a: AudienceId, minWithdrawPoints: number): { text: string; params: unknown[] } {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  switch (a) {
    case "all":
      return { text: "SELECT u.id FROM users u WHERE u.email_verified = 1 AND u.status = 'active'", params: [] };
    case "active_7d":
      return {
        text: `SELECT u.id FROM users u WHERE u.email_verified = 1 AND u.status = 'active'
               AND EXISTS (SELECT 1 FROM user_activity_days d WHERE d.user_id = u.id AND d.day >= ?)`,
        params: [sevenDaysAgo],
      };
    case "inactive_30d":
      return {
        text: `SELECT u.id FROM users u WHERE u.email_verified = 1 AND u.status = 'active'
               AND NOT EXISTS (SELECT 1 FROM user_activity_days d WHERE d.user_id = u.id AND d.day >= ?)`,
        params: [thirtyDaysAgo],
      };
    case "withdrawable":
      // Balance is SUM(ledger) — guardrail #2. There is no balance column to
      // read, and inventing one for a notification audience would be the first
      // step to inventing one everywhere.
      return {
        text: `SELECT u.id FROM users u WHERE u.email_verified = 1 AND u.status = 'active'
               AND (SELECT COALESCE(SUM(amount),0) FROM ledger_entries le WHERE le.user_id = u.id) >= ?`,
        params: [minWithdrawPoints],
      };
    case "miners":
      return {
        text: `SELECT u.id FROM users u WHERE u.email_verified = 1 AND u.status = 'active'
               AND EXISTS (SELECT 1 FROM rozi_ledger r WHERE r.user_id = u.id AND r.source_type = 'mining')`,
        params: [],
      };
    case "verified_id":
      return {
        text: `SELECT u.id FROM users u WHERE u.email_verified = 1 AND u.status = 'active'
               AND u.kyc_status = 'approved'`,
        params: [],
      };
  }
}

/** How many people an audience would reach, without sending anything. */
export async function audienceSize(a: AudienceId, minWithdrawPoints: number): Promise<number> {
  const q = audienceSql(a, minWithdrawPoints);
  const row = await sql.get<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM (${q.text}) s`, ...q.params);
  return row?.n ?? 0;
}

export type Message = { title: string; body: string; url?: string | null };

/**
 * Put one message in one user's inbox. Used by the per-user "message this
 * user" action and available to any future event that should be readable in
 * the app rather than only pushed.
 */
export async function notifyUser(
  userId: string, m: Message, broadcastId: string | null = null,
): Promise<void> {
  await sql.run(
    `INSERT INTO notifications (id, user_id, title, body, url, broadcast_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    newId(), userId, m.title, m.body, m.url ?? null, broadcastId, now(),
  );
}

/**
 * Send to an audience.
 *
 * Returns the broadcast id and how many inboxes it landed in. `alsoPush` is the
 * explicit choice described in this file's header — when false (the default
 * on the compose screen) nothing interrupts anyone.
 */
export async function broadcast(params: {
  audience: AudienceId;
  message: Message;
  sentBy: string;
  alsoPush: boolean;
  minWithdrawPoints: number;
}): Promise<{ id: string; recipients: number }> {
  const id = newId();
  const q = audienceSql(params.audience, params.minWithdrawPoints);
  const at = now();

  // One INSERT … SELECT: the fan-out is a single set-based statement, so the
  // cost is the audience query plus the write, not a round trip per user.
  const res = await sql.run(
    `INSERT INTO notifications (id, user_id, title, body, url, broadcast_id, created_at)
     SELECT gen_random_uuid()::text, s.id, ?, ?, ?, ?, ?
     FROM (${q.text}) s`,
    params.message.title, params.message.body, params.message.url ?? null, id, at,
    ...q.params,
  );
  const recipients = res.rowCount;

  await sql.run(
    `INSERT INTO notification_broadcasts (id, title, body, url, audience, recipients, pushed, sent_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id, params.message.title, params.message.body, params.message.url ?? null,
    params.audience, recipients, params.alsoPush ? 1 : 0, params.sentBy, at,
  );

  if (params.alsoPush) {
    // Fire-and-forget, AFTER the inbox rows are written — same rule as every
    // other push in this codebase: a push cannot be rolled back, so nothing is
    // announced before the thing it announces is durable. Failure here can
    // never fail the send; the message is already in the inbox either way.
    void pushAll(id, params.message);
  }

  return { id, recipients };
}

// Push to everyone the broadcast reached. Serial in batches rather than one
// Promise.all over the whole audience: sendPushToUser already swallows its own
// errors, but firing a hundred thousand HTTPS requests at once would be a
// self-inflicted outage rather than a notification.
async function pushAll(broadcastId: string, m: Message): Promise<void> {
  const BATCH = 200;
  let offset = 0;
  try {
    for (;;) {
      const rows = await sql.all<{ user_id: string }>(
        `SELECT user_id FROM notifications WHERE broadcast_id = ?
         ORDER BY user_id LIMIT ${BATCH} OFFSET ${offset}`,
        broadcastId,
      );
      if (rows.length === 0) return;
      await Promise.all(rows.map((r) =>
        sendPushToUser(r.user_id, { title: m.title, body: m.body, url: m.url ?? "/notifications" })));
      offset += rows.length;
      if (rows.length < BATCH) return;
    }
  } catch (err) {
    console.error("broadcast push failed (ignored):", (err as Error).message);
  }
}

/**
 * Where a notification is allowed to point.
 *
 * ⚠️ INTERNAL PATHS ONLY. An inbox row is written by staff and rendered inside
 * our own chrome, so an external link there is a phishing vector wearing our
 * branding — and the one place a user has been taught to trust. Home content
 * blocks are a separate decision (see routes/staffContent.ts): those are
 * clearly cards, and one may legitimately point at a Telegram channel.
 */
export function isInternalPath(url: string): boolean {
  return /^\/[A-Za-z0-9\-._~/?#[\]@!$&'()*+,;=%]*$/.test(url) && !url.startsWith("//");
}
