// E2E for web push subscriptions against a real database.
//
// What matters here is not the sending (that is the push service's job and
// web-push's protocol code) but OUR bookkeeping:
//   • upsert-by-endpoint: a phone that logs into a second account must hand its
//     subscription over, not notify the previous user
//   • delete is scoped to the caller: knowing someone's endpoint URL must not
//     let you silence their notifications
//   • with no VAPID keys (dev default), sending is a quiet no-op — a missing
//     env var must never break a money path that fires a notification
//
//   npm run test:push
import { sql, now, newId, initDb } from "../db.ts";
import { savePushSubscription, deletePushSubscription, sendPushToUser, pushEnabled } from "../push.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();

const mkUser = async (label: string) => {
  const id = newId();
  await sql.run(
    `INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at)
     VALUES (?,?,1,'Pakistan',?,'active',?)`,
    id, `${label}-${id}@t.test`, id.slice(0, 8).toUpperCase(), now(),
  );
  return id;
};

const subsOf = (userId: string) =>
  sql.all<{ endpoint: string }>("SELECT endpoint FROM push_subscriptions WHERE user_id = ?", userId);

const alice = await mkUser("alice");
const bob = await mkUser("bob");
const E1 = `https://push.example.test/ep/${newId()}`;
const E2 = `https://push.example.test/ep/${newId()}`;

console.log("\n-- feature flag --");
check("push is OFF in dev (no VAPID keys)", pushEnabled === false);
let threw = false;
try { await sendPushToUser(alice, { title: "t", body: "b", url: "/" }); } catch { threw = true; }
check("sending with push OFF is a quiet no-op, never a throw", !threw);

console.log("\n-- subscribe bookkeeping --");
await savePushSubscription(alice, { endpoint: E1, p256dh: "pk-a", auth: "au-a" });
check("subscribing stores the row", (await subsOf(alice)).length === 1);

// Same endpoint, resubscribed with fresh keys: one row, updated, not two.
await savePushSubscription(alice, { endpoint: E1, p256dh: "pk-a2", auth: "au-a2" });
const after = await sql.get<{ p256dh: string }>(
  "SELECT p256dh FROM push_subscriptions WHERE endpoint = ?", E1);
check("re-subscribing the same browser upserts (still one row)", (await subsOf(alice)).length === 1);
check("...and refreshes the keys", after?.p256dh === "pk-a2");

// The shared-phone case: the SAME browser logs into Bob's account and enables
// notifications. The subscription must move to Bob — pushing Alice's money
// news to a phone now signed in as Bob would be a privacy hole.
await savePushSubscription(bob, { endpoint: E1, p256dh: "pk-b", auth: "au-b" });
check("same browser, new account: subscription MOVES to the new user",
  (await subsOf(bob)).length === 1 && (await subsOf(alice)).length === 0);

await savePushSubscription(bob, { endpoint: E2, p256dh: "pk-b2", auth: "au-b2" });
check("a second device adds a second row", (await subsOf(bob)).length === 2);

console.log("\n-- delete is scoped to the owner --");
await deletePushSubscription(alice, E1); // Alice knows Bob's endpoint URL somehow
check("someone else's endpoint cannot be deleted", (await subsOf(bob)).length === 2);
await deletePushSubscription(bob, E1);
check("the owner can delete it", (await subsOf(bob)).length === 1);

// cleanup so reruns start clean
await sql.run("DELETE FROM push_subscriptions WHERE user_id IN (?,?)", alice, bob);

console.log(`\n${pass} passed, ${fail} failed`);
// Always exit explicitly: PGlite keeps the event loop alive otherwise.
process.exit(fail > 0 ? 1 : 0);
