// Browser push — the client half of api/src/push.ts.
//
// The flow is entirely the user's choice: nothing here runs until they tap
// "Turn on notifications" (the permission prompt must come from a tap anyway —
// browsers ignore requests that don't). State lives in the browser itself
// (Notification.permission + the service worker's subscription), so there is
// nothing to keep in sync with the server beyond subscribe/unsubscribe calls.
import { fetchPushConfig, registerPushSubscription, removePushSubscription } from "./api";

export type PushState = "unsupported" | "denied" | "off" | "on";

// The VAPID public key arrives base64url-encoded; subscribe() wants raw bytes.
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

// What the toggle should show right now. getRegistration(), never .ready —
// .ready blocks forever when no service worker is registered yet.
export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

// Must be called from a user tap (browsers drop permission prompts otherwise).
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const cfg = await fetchPushConfig();
  if (!cfg.enabled || !cfg.publicKey) return "unsupported";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";

  // InstallPrompt registers the worker on most screens, but don't depend on it.
  await navigator.serviceWorker.register("/sw.js");
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(cfg.publicKey) as unknown as BufferSource,
    }));

  const json = sub.toJSON();
  if (!json.keys?.p256dh || !json.keys?.auth) throw new Error("Subscription has no keys");
  await registerPushSubscription({
    endpoint: sub.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
  return "on";
}

export async function disablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    // Tell the server first (needs the endpoint), then drop the browser side.
    // If the server call fails the row is pruned on the next failed send anyway.
    await removePushSubscription(sub.endpoint).catch(() => {});
    await sub.unsubscribe();
  }
  return "off";
}
