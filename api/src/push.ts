// Web push — telling a user something happened while the app is closed.
//
// The three moments that matter (and the only ones we send):
//   • their withdrawal was paid or rejected  — money news, the #1 trust builder
//   • support replied to their question      — so tickets don't feel like a void
//   • their ID check was decided             — it unblocks their first payout
//
// Design rules:
//   • Fire-and-forget. A push failure must NEVER fail the action that caused
//     it — a withdrawal is paid whether or not a notification goes out. Every
//     entry point here swallows its own errors.
//   • Send AFTER the database transaction commits, never inside it. A push
//     cannot be rolled back; announcing money that a rollback then un-pays
//     would be worse than saying nothing.
//   • Copy is plain English, same rules as the app (no jargon, no over-promise).
//   • Feature-flagged: no VAPID keys => everything here is a quiet no-op.
import webpush from "web-push";
import { config } from "./config.ts";
import { sql, now, newId } from "./db.ts";

export const pushEnabled = Boolean(config.vapidPublicKey && config.vapidPrivateKey);

if (pushEnabled) {
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
}

export type PushNote = {
  title: string;
  body: string;
  // Where tapping the notification opens the app, e.g. "/wallet".
  url: string;
};

type SubRow = { id: string; endpoint: string; p256dh: string; auth: string };

// Store (or move) a browser's subscription. Upsert on the endpoint: the same
// browser re-subscribing refreshes its keys, and a shared phone that logs into
// a different account hands the subscription to that account instead of
// notifying the previous one.
export async function savePushSubscription(
  userId: string,
  sub: { endpoint: string; p256dh: string; auth: string },
): Promise<void> {
  await sql.run(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id,
       p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    newId(), userId, sub.endpoint, sub.p256dh, sub.auth, now(),
  );
}

// Remove one browser's subscription (the user's own — scoped by user_id so
// nobody can delete someone else's by knowing their endpoint URL).
export async function deletePushSubscription(userId: string, endpoint: string): Promise<void> {
  await sql.run(
    "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
    userId, endpoint,
  );
}

// Send a note to every device the user enabled. Never throws.
export async function sendPushToUser(userId: string, note: PushNote): Promise<void> {
  if (!pushEnabled) return;
  try {
    const subs = await sql.all<SubRow>(
      "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?",
      userId,
    );
    const payload = JSON.stringify(note);
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        );
      } catch (err) {
        // 404/410 = the browser unsubscribed (app uninstalled, permission
        // revoked). The row is dead — prune it so we stop paying to fail.
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await sql.run("DELETE FROM push_subscriptions WHERE id = ?", s.id).catch(() => {});
        }
        // Anything else (push service hiccup): drop it. The next event retries
        // naturally; a notification is not worth a retry queue.
      }
    }));
  } catch (err) {
    console.error("push send failed (ignored):", (err as Error).message);
  }
}
