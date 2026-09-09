// What the service worker is allowed to serve from cache, and for how long
// (public/sw.js).
//
// This exists because of a real bug: the worker was made cache-first over
// /brand/ and /icons/ — files that are replaced IN PLACE under the same name —
// in the same change that deliberately refused to send `immutable` on those
// exact paths, because a long pin puts a replaced logo on every existing
// user's phone with no way to push a fix. A service-worker pin is worse than
// the header that was rejected: it is permanent until CACHE is bumped.
//
// Run: npm run test:sw
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://rozipay.xyz";

type Body = string;

function bootWorker() {
  const handlers = new Map<string, (e: any) => void>();
  const store = new Map<string, Body>();      // the SW's Cache
  const server = new Map<string, Body>();     // what the network currently holds
  const netLog: string[] = [];

  const res = (body: Body, ok = true) => ({
    ok,
    status: ok ? 200 : 404,
    body,
    clone() { return res(body, ok); },
  });

  const cache = {
    addAll: async (urls: string[]) => { for (const u of urls) store.set(new URL(u, ORIGIN).href, server.get(new URL(u, ORIGIN).href) ?? "precached"); },
    put: async (req: any, r: any) => { store.set(req.url, r.body); },
    match: async (req: any) => (store.has(req.url) ? res(store.get(req.url)!) : undefined),
  };

  const sandbox: any = {
    URL, Promise, console,
    caches: {
      open: async () => cache,
      match: async (req: any) => {
        const url = typeof req === "string" ? new URL(req, ORIGIN).href : req.url;
        return store.has(url) ? res(store.get(url)!) : undefined;
      },
      keys: async () => ["rozipay-v1"],
      delete: async () => true,
    },
    fetch: async (req: any) => {
      const url = typeof req === "string" ? new URL(req, ORIGIN).href : req.url;
      netLog.push(url);
      const body = server.get(url);
      return body === undefined ? res("404", false) : res(body);
    },
    clients: { matchAll: async () => [], openWindow: async () => null, claim: async () => undefined },
  };
  sandbox.self = {
    addEventListener: (n: string, h: (e: any) => void) => handlers.set(n, h),
    skipWaiting: async () => undefined,
    clients: sandbox.clients,
    location: { origin: ORIGIN },
    navigator: { onLine: true },
    registration: { showNotification: async () => undefined },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  // Drive one request through the fetch handler the way the browser would.
  async function request(path: string, mode = "no-cors") {
    const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
    let responded: Promise<any> | null = null;
    const pending: Promise<any>[] = [];
    handlers.get("fetch")!({
      request: { url, method: "GET", mode },
      respondWith: (p: any) => { responded = Promise.resolve(p); },
      waitUntil: (p: any) => { pending.push(Promise.resolve(p).catch(() => {})); },
    });
    const out = responded ? await responded : null;
    await Promise.all(pending); // let any background revalidation finish
    return out as { body: Body } | null;
  }

  return { request, server, store, netLog };
}

test("content-hashed build assets are served from cache forever, never re-fetched", async () => {
  const w = bootWorker();
  w.server.set(`${ORIGIN}/_next/static/chunks/abc123.js`, "v1");
  const first = await w.request("/_next/static/chunks/abc123.js");
  const second = await w.request("/_next/static/chunks/abc123.js");
  assert.equal(first?.body, "v1");
  assert.equal(second?.body, "v1");
  assert.equal(w.netLog.length, 1, "a hashed URL can never go stale — one fetch, ever");
});

test("a logo replaced in place is NOT pinned: the next visit corrects itself", async () => {
  const w = bootWorker();
  const url = `${ORIGIN}/brand/logo-mark.png`;
  w.server.set(url, "old-logo");

  assert.equal((await w.request("/brand/logo-mark.png"))?.body, "old-logo");

  // The founder replaces the logo under the same filename.
  w.server.set(url, "new-logo");

  // Still instant from cache (nothing waits on the network)...
  assert.equal(
    (await w.request("/brand/logo-mark.png"))?.body,
    "old-logo",
    "the cached copy is what gets served — speed is not given up",
  );
  // ...and the background revalidation has now replaced it.
  assert.equal(w.store.get(url), "new-logo", "the stale copy must not survive the visit");
  assert.equal(
    (await w.request("/brand/logo-mark.png"))?.body,
    "new-logo",
    "a replaced asset corrects itself on the very next visit",
  );
});

test("the same applies to /icons/ and /roadmap/", async () => {
  for (const p of ["/icons/icon-192.png", "/roadmap/hero-mountain-v2.webp"]) {
    const w = bootWorker();
    w.server.set(`${ORIGIN}${p}`, "old");
    await w.request(p);
    w.server.set(`${ORIGIN}${p}`, "new");
    await w.request(p);
    assert.equal(w.store.get(`${ORIGIN}${p}`), "new", `${p} must revalidate too`);
  }
});

test("an offline revalidation leaves the cached copy standing", async () => {
  const w = bootWorker();
  const url = `${ORIGIN}/brand/mine-hero-v2.webp`;
  w.server.set(url, "art");
  await w.request("/brand/mine-hero-v2.webp");
  w.server.delete(url); // network now fails for it
  const hit = await w.request("/brand/mine-hero-v2.webp");
  assert.equal(hit?.body, "art", "the hero still paints with no network");
  assert.equal(w.store.get(url), "art", "a failed refresh must not evict good art");
});

test("nothing else is intercepted: navigations, the API, and the image optimiser", async () => {
  const w = bootWorker();
  w.server.set(`${ORIGIN}/_next/image?url=%2Froadmap%2Fx.webp&w=640&q=75`, "opt");
  // The optimiser URL embeds an unversioned source path for some assets, so
  // caching it would reintroduce the very pin this split exists to avoid.
  assert.equal(await w.request("/_next/image?url=%2Froadmap%2Fx.webp&w=640&q=75"), null);
  assert.equal(w.store.size, 0, "nothing cached");
  // A page load must always go to the network (a stale balance is the one bug
  // this worker refuses to open the door to).
  const nav = await w.request("/wallet", "navigate");
  assert.notEqual(nav, null, "navigations are handled (offline fallback), not cached");
  assert.equal(w.store.size, 0, "a navigation is never written to the cache");
  // Another origin — the API and the ad networks.
  assert.equal(await w.request("https://api.rozipay.xyz/wallet/balance"), null);
});
