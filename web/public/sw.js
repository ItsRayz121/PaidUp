/* RoziPay service worker.
 *
 * Deliberately minimal. Its job is to make the app installable and to show a
 * friendly page when the phone has no internet — nothing else.
 *
 * Money rule: this worker NEVER caches a response that could contain user data.
 * Balances, ledger rows and withdrawals come from the API on another origin and
 * are not touched here; page navigations always go to the network. The only
 * things cached are the offline page and Next's content-hashed static assets,
 * which are immutable and carry no user data. A stale balance shown from a
 * cache would be a bug we can't afford, so we don't open the door to it.
 */

const CACHE = "rozipay-v1";
const OFFLINE_URL = "/offline";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ---- Push notifications -----------------------------------------------------
// The payload is JSON written by OUR api (api/src/push.ts): {title, body, url}.
// No user data is stored here — the note is shown and that is all.
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let note;
  try { note = event.data.json(); } catch { return; }
  event.waitUntil(
    self.registration.showNotification(note.title || "RoziPay", {
      body: note.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: note.url || "/" },
    }),
  );
});

// Tapping the notification opens (or focuses) the app at the note's URL.
// Only our api writes these payloads, but resolve against our own origin
// anyway so a note can never navigate the app off-site.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || "/";
  const resolved = new URL(raw, self.location.origin);
  const url = resolved.origin === self.location.origin ? resolved.href : "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) {
          w.navigate(url);
          return w.focus();
        }
      }
      return clients.openWindow(url);
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API + ad networks: never intercepted

  // Page loads: always fresh from the network, so a balance is never stale.
  //
  // When the phone has no internet we serve the offline page *first*, without
  // trying the network. Without this, the browser's own HTTP cache answers the
  // navigation (Next prefetches every tab link) and the user gets the app shell
  // with "Something went wrong" on every card — it looks broken and it hides the
  // one thing they need to know: they are offline, and their points are safe.
  // The .catch still covers the harder case: online, but the request fails.
  if (req.mode === "navigate") {
    event.respondWith(
      self.navigator.onLine === false
        ? caches.match(OFFLINE_URL).then((hit) => hit || fetch(req))
        : fetch(req).catch(() => caches.match(OFFLINE_URL)),
    );
    return;
  }

  // Build assets are content-hashed (a new build = a new URL), so serving them
  // from cache can never go stale. This is what makes the installed app open
  // instantly on a slow Pakistani mobile connection.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
