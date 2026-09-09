/* RoziPay service worker.
 *
 * Deliberately minimal. Its job is to make the app installable and to show a
 * friendly page when the phone has no internet — nothing else.
 *
 * Money rule: this worker NEVER caches a response that could contain user data.
 * Balances, ledger rows and withdrawals come from the API on another origin and
 * are not touched here; page navigations always go to the network. The only
 * things cached are the offline page, Next's content-hashed static assets, and
 * the icon/illustration files under /icons/, /brand/ and /roadmap/ — none of
 * which carry user data. A stale balance shown from a cache would be a bug we
 * can't afford, so we don't open the door to it. See the fetch handler for why
 * the second group is revalidated in the background and the first is not.
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

  // Two different kinds of same-origin asset, and the difference is what
  // decides whether a cached copy may be served forever.
  //
  // 1. /_next/static/ is CONTENT-HASHED — a new build is a new URL — so a
  //    cached copy can never go stale and there is nothing to revalidate.
  //    Cache-first, forever. This is what makes the installed app open
  //    instantly on a slow Pakistani mobile connection.
  //
  // 2. /icons/, /brand/ and /roadmap/ hold the PWA icon set and the app's
  //    illustrations. They carry no user data either, but their names carry
  //    no content hash: the logos and PWA icons are replaced IN PLACE.
  //
  // ⚠️ (2) IS STALE-WHILE-REVALIDATE, NOT CACHE-FIRST, AND THAT IS THE WHOLE
  // POINT OF THE SPLIT. `next.config.ts` deliberately refuses to send
  // `immutable` on these files because a one-year pin puts a replaced logo on
  // every existing user's phone with no way to push a fix. A cache-first
  // service worker is STRICTLY WORSE than the header it rejected: the pin is
  // permanent, not a year, and only bumping CACHE above would clear it. So the
  // cached copy is served immediately (same speed — nothing waits on the
  // network) and a background fetch refreshes it for next time, which means a
  // replaced asset corrects itself on the very next visit.
  //
  // The revalidation is close to free: the header on these paths is
  // `max-age=86400`, so for a day the background fetch is answered out of the
  // browser's own HTTP cache without touching the network at all.
  const immutableAsset = url.pathname.startsWith("/_next/static/");
  const replaceableArt =
    url.pathname.startsWith("/icons/") ||
    url.pathname.startsWith("/brand/") ||
    url.pathname.startsWith("/roadmap/");

  // ⚠️ /roadmap/ is listed for completeness and currently matches almost
  // nothing: /mine/roadmap draws its two scenes through `next/image`, so the
  // real request is /_next/image?url=%2Froadmap%2F... and never this path.
  // /brand/ is the one that genuinely pays off — the /mine hero is a plain CSS
  // background-image, so it is fetched by its own URL and does get cached here.
  // /_next/image is deliberately NOT intercepted: those URLs embed an
  // unversioned source path for some assets, so caching them would reintroduce
  // exactly the permanent pin this split exists to avoid.

  if (!immutableAsset && !replaceableArt) return;

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        if (replaceableArt) {
          // Off the critical path: the response above is already going back.
          // waitUntil keeps the worker alive long enough to finish the write.
          event.waitUntil(
            fetch(req)
              .then((res) => (res.ok ? caches.open(CACHE).then((c) => c.put(req, res)) : null))
              .catch(() => {
                /* offline, or the asset is gone — the cached copy still stands */
              }),
          );
        }
        return hit;
      }
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    }),
  );
});
