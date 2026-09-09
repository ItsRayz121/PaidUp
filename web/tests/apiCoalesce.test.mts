// Focused test for apiFetch's in-flight GET coalescing (lib/api.ts).
// Run: npx tsx --test src/lib/__coalesce.test.mts   (from web/)
import test from "node:test";
import assert from "node:assert/strict";

// --- minimal browser surface api.ts touches -------------------------------
const store = new Map<string, string>();
(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  location: { pathname: "/", href: "http://localhost/" },
  addEventListener() {}, removeEventListener() {},
  dispatchEvent() { return true; },
  navigator: { userAgent: "test" },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  crypto: { randomUUID: () => "device-test-uuid" },
};
(globalThis as any).localStorage = (globalThis as any).window.localStorage;
(globalThis as any).document = { cookie: "", documentElement: { dataset: {} } };
// node 24 exposes a getter-only globalThis.navigator; api.ts only needs window.navigator

let calls: { url: string; method: string; auth: string | null }[] = [];
let failNext = false;
const LAG = 40; // ms — long enough that two calls in the same tick overlap

(globalThis as any).fetch = (url: string, init: any = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  calls.push({ url: String(url), method, auth: init.headers?.authorization ?? null });
  const n = calls.length;
  const shouldFail = failNext;
  failNext = false;
  return new Promise((resolve) =>
    setTimeout(
      () =>
        resolve({
          ok: !shouldFail,
          status: shouldFail ? 500 : 200,
          json: async () => (shouldFail ? { error: "boom" } : { seq: n }),
        }),
      LAG,
    ),
  );
};

const api = await import("../src/lib/api.ts");
store.set("rozipay_token", "tok-A");
const get = () => (api as any).fetchBalance() as Promise<{ seq: number }>;
// Draining matters: an in-flight GET left over from an earlier test is a
// flight the next test would legitimately join, which reads as a miscount.
const reset = async () => {
  await new Promise((r) => setTimeout(r, LAG * 2));
  calls = [];
  failNext = false;
  store.set("rozipay_token", "tok-A");
};

test("two concurrent identical GETs make ONE request and both get the same data", async () => {
  await reset();
  const [a, b] = [get(), get()];
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls.filter((c) => c.method === "GET").length, 1, "should be one network call");
  assert.deepEqual(ra, rb);
});

test("it is NOT a response cache: a GET after the first settles refetches", async () => {
  await reset();
  await get();
  await get();
  assert.equal(calls.length, 2, "a later GET must open its own request");
});

test("a GET issued AFTER a mutation never joins a pre-mutation flight", async () => {
  await reset();
  // A read is already on the wire...
  const stale = get();
  // ...then the user mutates something (e.g. claims ROZI).
  const mutation = (api as any).claimMinedRozi();
  // ...and the screen reloads its data straight afterwards.
  const fresh = get();
  await Promise.allSettled([stale, mutation, fresh]);
  const gets = calls.filter((c) => c.method === "GET");
  assert.equal(gets.length, 2, "the post-mutation read must be its own request, not a join");
});

test("a different token never joins another account's flight", async () => {
  await reset();
  const a = get();
  store.set("rozipay_token", "tok-B");
  const b = get();
  await Promise.allSettled([a, b]);
  assert.equal(calls.length, 2, "two tokens, two requests");
  assert.notEqual(calls[0].auth, calls[1].auth);
  store.set("rozipay_token", "tok-A");
});

test("an error reaches every joiner and is not retained", async () => {
  await reset();
  failNext = true;
  const [a, b] = [get(), get()];
  const results = await Promise.allSettled([a, b]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "rejected", "the joiner must see the failure too");
  // and the failed entry must not poison the next attempt
  await get();
  assert.equal(calls.length, 2, "a retry after a failure must really go out");
});
