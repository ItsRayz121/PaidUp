# RoziPay API — Capacity & Bottleneck Audit

**Scope:** `g:\Earning App\api\src` (Fastify 5 + node-postgres + in-process `setInterval` workers).
**Question:** where does this system get stuck under heavy pressure, at **10,000** and **100,000** concurrently-active users?
**Method:** read the code; every claim below carries a `file:line`. Where I extrapolate, the arithmetic is shown and the assumption is named. Anything I could not confirm from code is labelled **HYPOTHESIS**.

## Assumptions used in the arithmetic (state them, so you can rebut them)

| Assumption | Value | Basis |
|---|---|---|
| Query round trip, indexed, Railway private network | 0.5–1.0 ms | typical for same-region TCP + Postgres; I use **0.7 ms** |
| Seq scan of `users` | ~1 µs/row → 10 ms @100k, 1 ms @10k | conservative for a narrow row set |
| "Concurrently active" | user has the app open and navigates ≈1 screen / 20 s | the app is **not** interval-polling `/mining/state` (`web/src/app/page.tsx:43`, `mine/page.tsx:35` are mount-fetches); the 1 s timer at `mine/page.tsx:90` is a local countdown, not a fetch |
| Screens firing `/mining/state` | home, /mine, /wallet, /wallet/usdt, /wallet/bnb, /wallet/rozi, /mine/send — 7 routes | grep of `fetchMiningState` |
| BSC block rate | ~0.45 s/block (~200k/day) | `api/src/config.ts:422-424`, the codebase's own measured note |
| Replicas | 1 today; findings marked **[R]** get worse ×N | Railway single service, `server.ts` |

---

## ⚠️ Measured 2026-09-04 — three of these predictions were wrong

Everything below this banner was written from **reading the code**. It was afterwards
**executed** against real PostgreSQL 18.4 with a stub chain RPC and 5,000 seeded users
(`../LOAD_TEST_PLAN_AND_VERDICTS.md` has the rig and its caveats; raw output in
`results/`). Three corrections, stated here rather than buried, because the ranking below
is now partly out of date:

| Prediction | Measured | Correction |
|---|---|---|
| **B1** — the pool is "the wall everything else hits" | At the knee (100 screens/s) the pool ran **0.8 of 10 connections busy on average, peak 4, zero lock waits** | The pool is **not** what binds first. It is a real cliff further out, but the **single Node process — CPU and event loop — is the constraint at the observed knee.** B2 and B11 bind before B1. |
| **B5** — settlement 70 s+ at 100k | **17.2 s** at 100k, in **1,594** statements, not 100,000 | That path is already batched in practice. **De-rank B5.** |
| **B4** — accrual "cannot finish inside its 15-minute interval at 100k" | **361 s (6.0 min)** at 100k — but in **998,601 sequential statements** | **Confirmed, and worse than the clock suggests.** Loopback has no per-query round trip; at this document's own 0.7 ms Railway assumption those statements alone cost `998,601 × 0.7 ms ≈ 11.6 min`, before execution, inside a 15-min interval, with settlement queued behind it. The fix is the statement count. |

Measured throughput ceiling: **~430–470 req/s, flat** across offered loads of 100, 150 and
220 screens/s. The knee is between 60 and 100 screens/s (~290–430 req/s). Past it the
system **queues rather than sheds** — latency 38 ms → 22 s with no throughput gain — which
is exactly the missing-`connectionTimeoutMillis` signature B1 describes, so B1's *fix* is
still right even though its *rank* was not.

Two identical 100-screens/s runs differed 4× in p95 (7.06 s vs 2.77 s) with no
configuration change. That variance is consistent with **B8** — an unguarded background
tick landing inside one run and not the other — and there is no instrumentation that would
let you confirm it, which is the point B8 and the closing section both make.

## Ranked findings

| # | Component | What breaks | Breaks at ~ | Status | Evidence |
|---|---|---|---|---|---|
| **B1** | `pg` pool | `max: 10` connections, **no** `connectionTimeoutMillis`, **no** `statement_timeout`, **no** `idleTimeoutMillis`. Every other finding funnels through this. Overload ⇒ requests queue on `pool.connect()` **forever**, not 503. | **already tight; hard wall ≪10k** | Confirmed | `db.ts:44-47` |
| **B2** | `GET /mining/state` | ~47 DB round trips per request; `hashrateOf()` computed **3×**; `loadMiningSettings()` read **4×**. | **~2k concurrent** | Confirmed | `routes/mining.ts:219-245`; `mining/engine.ts:522-527,252-262` |
| **B3** | `users.referred_by` | **No index.** `referralHashrateOf` seq-scans `users` twice per `hashrateOf` ⇒ **6 full scans of `users` per `/mining/state`**, and 2 per accrual. | **10k degrades, 100k fatal** | Confirmed | `db.ts:155` (column), no matching `CREATE INDEX` anywhere; `mining/engine.ts:227-244` |
| **B4** | Mining accrual sweep | `accrueAllSessions()` = sequential `await` per open session, ~14 queries each incl. 2 unindexed `users` scans. **Cannot finish inside its 15-min interval at 100k.** Blocks settlement, which runs after it. | **~40k sessions** | Confirmed | `mining/engine.ts:506-519,433-494`; `server.ts:187,243` |
| **B5** | Epoch settlement | Per-miner `INSERT INTO mining_unclaimed` in a `for` loop, inside **one transaction** holding the **global** lock `hashtext('rozi-settlement')` and one of 10 pool connections. | 10k ok (7 s); **100k = 70 s+ lock** | Confirmed | `mining/engine.ts:599-712`, loop at `685-703` |
| **B6** | Deposit scanner | Address list is **every user** (see B7 chain), batched **200 addresses per `eth_getLogs`** ⇒ 50 RPC calls/window @10k, **500 @100k**, all sequential, **inside one tx** holding `hashtext('deposit-scan')` + a pool connection for the whole RPC duration. | **~20k users**, sooner on a slow provider | Confirmed | `deposits/adapters/evm.ts:24,81-96,111-116`; `deposits/scanner.ts:9-15,107-132` |
| **B7** | `GET /wallet/balance`, `GET /usdt` | Blocking **chain RPC** (`eth_getBalance`) in the request path, cached only **20 s per user per process**. ⇒ **500 RPC/s @10k, 5,000 RPC/s @100k**. Also silently creates a `deposit_wallets` row per user, which is what feeds B6. | **~1k concurrent** (provider quota); latency bites sooner | Confirmed | `routes/app.ts:385-397`; `payoutRelay.ts:105-131,160-176`; `db.ts:2626-2651` |
| **B8** | All 5 background timers | **No re-entrancy guard.** `setInterval` fires again while the previous tick is still inside `sql.tx` blocked on a global advisory lock ⇒ each overlapping tick consumes another of the 10 connections. Pool death in ~10 ticks. | whenever any tick > its interval (B4/B6) | Confirmed | `server.ts:243,271,291,298,311` |
| **B9** | `creditCompletion` | `campaignSpend()` = unindexed aggregate over `task_completions` (**no index on `task_id`**) executed **while holding** `pg_advisory_xact_lock('task-budget:<taskId>')` ⇒ every credit on one campaign serialises behind a table scan. | **~500k completion rows** | Confirmed | `taskBudget.ts:50-52,61-74`; `credit.ts:158-198`; index list at `db.ts:296-298,811-813` |
| **B10** | `GET /staff/analytics` | **31 concurrent unindexed COUNT/SUM queries in one `Promise.all`** against a 10-connection pool, plus 4 retention CTEs. One staff dashboard can starve the whole earner API. | **any scale — already a risk** | Confirmed | `analytics.ts:61-145`; `routes/staff.ts:2659-2667` |
| **B11** | `scrypt` login | Node default params on the **4-thread libuv pool** ⇒ ~50 logins/s per process, and it blocks `fs`/`dns` on the same threads. | **launch-morning spike** | Confirmed | `auth.ts:24,38-56`; no `UV_THREADPOOL_SIZE` anywhere in the repo |
| **B12** | Unbounded responses | `/wallet/ledger`, `/wallet/usdt-task-rewards`, `GET /withdrawals`, `GET /wallet/bnb/withdrawals` have **no LIMIT**; `GET /support/tickets` selects the base64 `image` column (≤3 MB each) for **all** of a user's messages with no LIMIT. | **one heavy user, any scale** | Confirmed | `routes/app.ts:463-478,484-500,877-895`; `routes/withdrawals.ts:504,840` |
| **B13** | Reconciliation | `multicall` `balanceOf` over **every** deposit address, 300/batch, and **throws on a single failure** ⇒ at 100k addresses (334 batches) reconciliation never succeeds again. | **~30k addresses** | Confirmed | `deposits/reconcile.ts:79,91-114` |
| **B14** | Per-process state | `touchActivity` memo Set, leaderboard cache, gas-balance cache, `lastGoodRange`, `cachedBotUsername`, rate-limit LRU — all in-process. **[R]** Each multiplies or de-syncs with replica count. | **the moment you add a 2nd replica** | Confirmed | `analytics.ts:34-47`; `leaderboard.ts:30,50`; `payoutRelay.ts:106`; `evm.ts:49`; `auth.ts:474` |
| **B15** | Rate limiting | In-process `LocalStore`, LRU capped at **5000 keys per route**. **[R]** Per-IP budgets multiply by replica count; a >5000-unique-IP flood evicts an attacker's own counter. | **≥2 replicas, or an IP flood** | Confirmed | `server.ts:101-107`; `node_modules/@fastify/rate-limit/store/LocalStore.js:5` |
| **B16** | Broadcast push | `pushAll` pages with `OFFSET` (O(n²)) and fires **200 concurrent `sendPushToUser`**, each 1 DB query, against a 10-connection pool. | **~50k recipients** | Confirmed | `notify.ts:175-193`; `push.ts:63-71` |
| **B17** | Every request | Maintenance hook does an **uncached `getSetting`** DB read on every non-exempt request; `getSetting` / `loadMiningSettings` / `allFlags` have **no cache at all**. | additive tax on B1 | Confirmed | `server.ts:150-158`; `db.ts:2352-2355`; `mining/settings.ts:24-36`; `flags.ts:21-43` |
| **B18** | Register / forgot | `fetch()` to Resend with **no timeout**, awaited in the request path. Node `fetch` has no default timeout ⇒ a hung Resend hangs the request indefinitely. | provider incident, any scale | Confirmed | `email.ts:29-33`; `auth.ts:78` |
| **B19** | Conversion window settle | Per-burn-row loop, 2 queries each, one transaction. Staff-triggered so low frequency — but O(participants). | 100k participants | Confirmed | `routes/mining.ts:1385-1402` |

**Things that are actually fine, and I am not going to invent a concern about them:** the staff broadcast fan-out is a single set-based `INSERT … SELECT` (`notify.ts:142-149`); `ownHashrateBatch` is genuinely batched to 3 queries for an arbitrary downline (`mining/engine.ts:150-208`) and its header explains why; `settleEpoch`'s idempotency on the `mining_epochs` PK is correct; per-user `pg_advisory_xact_lock(hashtext(userId))` (guardrail #8) is applied consistently and is **not** a contention problem — it is per-user by construction; `mining_shares` is covered by its `(epoch, user_id)` PK; the leaderboard is capped at 20 rows with a 60 s cache; `GET /tasks` fetches the whole task catalogue but that is tens of rows and the JS-side filtering buys a real correctness guarantee (`routes/app.ts:71-79`).

---

# B1 — The connection pool is the wall everything else hits

```ts
// db.ts:44-47
const pool = new Pool({
  connectionString,
  ssl: internal ? undefined : { rejectUnauthorized: false },
  max: 10,
});
```

That is the entire pool configuration. Three things are missing and each has a distinct failure mode:

- **No `connectionTimeoutMillis`.** When all 10 are busy, `pool.connect()` (used by `sql.tx`, `db.ts:56-58`) waits **without a deadline**. Under overload the API does not shed load — it accumulates an unbounded queue of pending checkouts, each holding a live HTTP request, until the process runs out of memory or Railway's health check fails. There is no back-pressure signal anywhere in the codebase.
- **No `statement_timeout`.** One of the unindexed scans in B3/B9/B10 that goes pathological runs until it finishes. There is no ceiling on how long a single query can hold 1/10 of total capacity.
- **No `idleTimeoutMillis` / `maxLifetime`.** Minor by comparison, but connections are never recycled.

### Arithmetic

Little's Law: sustainable queries/sec = `max / mean_query_latency`.

- All-indexed, 0.7 ms: `10 / 0.0007` = **~14,000 queries/s** — the theoretical ceiling.
- `/mining/state` costs ~47 queries (B2). Ceiling ⇒ **~300 req/s**, *before* any seq scan.
- Add B3's 6 `users` scans: @10k users that is `6 × 1 ms = 6 ms`, so ~39 ms DB time/request ⇒ **~256 req/s**. @100k it is `6 × 10 ms = 60 ms`, so ~93 ms ⇒ **~107 req/s**.

Demand at the stated scales, using the 1-screen-per-20 s assumption and the 7 screens that fire `/mining/state`:

| Scale | `/mining/state` demand | Capacity (B1+B2+B3) | Shortfall |
|---|---|---|---|
| 10,000 concurrent | ~500 req/s | ~256 req/s | **2×** |
| 100,000 concurrent | ~5,000 req/s | ~107 req/s | **47×** |

And that ignores `/wallet/balance`, `/tasks`, `/features` and `/notifications`, which the home screen fires alongside it.

### Fix

In `db.ts:44`:

```ts
const pool = new Pool({
  connectionString,
  ssl: internal ? undefined : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX ?? 30),
  connectionTimeoutMillis: 5_000,   // fail fast, do not queue forever
  idleTimeoutMillis: 30_000,
  statement_timeout: 10_000,        // no single query may hold 1/N of capacity
  application_name: "rozipay-api",
});
```

Two caveats specific to this deployment:

1. **Raise `max` only as far as Postgres itself allows.** Railway's smaller Postgres plans cap `max_connections` near 100, so `replicas × max ≤ max_connections − reserved`. Past 2–3 replicas, put **PgBouncer** (transaction pooling) in front. This codebase uses no session state, no `SET`, no named prepared statements and no `LISTEN` — the driver is a thin `?`→`$n` rewriter (`db.ts:35-39`) — so transaction pooling is compatible as written.
2. **Split the pools.** Give `/staff/*` its own small pool (`max: 3`) so B10 cannot starve earners. One extra `Pool` in `db.ts` plus a `sqlStaff` export is enough; the `Driver` abstraction at `db.ts:22-32` already makes this a local change.

---

# B2 — `/mining/state` does the same expensive work three times

```ts
// routes/mining.ts:219-222
app.get("/mining/state", guard(async (userId) => {
  const s = await loadMiningSettings();               // query 1
  const state = await sessionState(userId);           // ~27 queries
  const { breakdown } = await hashrateOf(userId, s);  // 8 more — RECOMPUTED
```

`sessionState` (`mining/engine.ts:522-527`) already computed the hashrate — twice:

```ts
export async function sessionState(userId: string): Promise<SessionState> {
  await accrue(userId);                    // -> accrueSession -> hashrateOf()   (9 queries)
  const s = await loadMiningSettings();    // 2nd settings read
  const [session, shares, { hashrate }] = await Promise.all([
    ..., hashrateOf(userId, s),            // 2nd hashrate computation (8 queries)
  ]);
```

`accrueSession` calls `hashrateOf(userId)` with **no** settings argument (`engine.ts:446`), so `hashrateOf` reads the settings again itself (`engine.ts:256`).

Full trace of one request:

| Step | Queries |
|---|---|
| `guard` → `requireActiveUser` (`auth.ts:131-133`) | 1 |
| `loadMiningSettings` (route) | 1 |
| `accrue` → session lookup | 1 |
| `accrueSession` → `hashrateOf` #1 (including its own `loadMiningSettings`) | 9 |
| `accrueSession` → settled check, `claimDevice` (insert+select), shares upsert, session update | 5 |
| `sessionState` → `loadMiningSettings` | 1 |
| `sessionState` → session + shares + `hashrateOf` #2 | 10 |
| `sessionState` → `minerPopulation()` (`engine.ts:33-36`) | 1 |
| `sessionState` → device-owner lookup | 1 |
| route → `hashrateOf` #3 | 8 |
| route → `Promise.all` of 8 reads | 8 |
| `kycFeatureEnabled()` | 1 |
| **Total** | **~47** |

At 0.7 ms each that is **~33 ms of pure DB round-trip time per request**, most of it serialised: `accrue` must finish before `sessionState`'s `Promise.all` starts, which must finish before the route's third `hashrateOf`.

### Fix — three edits, all local, no behaviour change

1. **Compute the hashrate once.** Change `sessionState` (`mining/engine.ts:522`) to return the `breakdown` its internal `hashrateOf` already produced, and delete the route's third call at `routes/mining.ts:222`. Saves 8 queries.
2. **Thread `MiningSettings` through the accrual path.** `accrue(userId)` → `accrue(userId, s)` → `accrueSession(userId, session, s)` → `hashrateOf(userId, s)`. The parameter already exists (`engine.ts:252-256`); the accrual path simply never passes it. Collapses 4 settings reads into 1.
3. **Cache the settings/flags reads** — see B17.

Net: ~47 queries → **~14**, a 3.4× throughput gain on the single hottest earner endpoint.

---

# B3 — `users.referred_by` has no index, and it is scanned six times per mining request

```sql
-- db.ts:155
referred_by    TEXT REFERENCES users(id),
```

Postgres does **not** auto-index the referencing side of a foreign key. Every `CREATE INDEX` in `db.ts` was enumerated; none covers `users(referred_by)`.

```ts
// mining/engine.ts:227-244
const active = async (referrerIds: string[]): Promise<string[]> => {
  if (referrerIds.length === 0) return [];
  const placeholders = referrerIds.map(() => "?").join(",");
  const rows = await sql.all<{ id: string }>(
    `SELECT DISTINCT u.id FROM users u
     JOIN mining_sessions ms ON ms.user_id = u.id
     WHERE u.referred_by IN (${placeholders})
       AND u.status = 'active' AND u.kyc_status = 'approved'
       AND ms.started_at > ?`,
    ...referrerIds, cutoff,
  );
  return rows.map((r) => r.id);
};
const l1 = await active([userId]);
const l2 = (await active(l1)).filter((id) => id !== userId && !l1.includes(id));
```

Two `active()` calls per `hashrateOf`, three `hashrateOf` calls per `/mining/state` (B2) ⇒ **6 full seq scans of `users` on every load of home, /mine, or any wallet screen**. Plus 2 more per background accrual (B4), for every session, every 15 minutes.

There is a second, sharper problem hiding in the same lines: `active(l1)` builds `IN (?,?,?…)` with **one bind parameter per L1 invitee**. Postgres's wire protocol caps bind parameters at 65,535. A successful inviter with a large enough downline gets a hard protocol error on every mining request — and the referral programme is the growth engine, so someone will get there. This is a correctness cliff, not just a performance one.

### Arithmetic

| Scale | 1 scan | 6 scans/request | Cost at 500 req/s (10k) / 5,000 req/s (100k) |
|---|---|---|---|
| 10k users | ~1 ms | 6 ms | 3.0 CPU-seconds/s → **3 cores of database burned on this alone** |
| 100k users | ~10 ms | 60 ms | 300 CPU-seconds/s → **impossible** |

### Fix

```sql
-- db.ts, in MIGRATIONS
CREATE INDEX IF NOT EXISTS idx_users_referred_by
  ON users(referred_by) WHERE referred_by IS NOT NULL;
-- the join's other side, so the L1/L2 activity probe is an index scan:
CREATE INDEX IF NOT EXISTS idx_mining_sessions_started
  ON mining_sessions(user_id, started_at);
```

Then replace the `IN (…)` list with `= ANY(?)` and a single array parameter at `engine.ts:229-236`. `pg` passes JS arrays through as Postgres arrays unchanged, and `toPg` (`db.ts:35-39`) rewrites the single `?` fine — this removes the 65,535-parameter cliff entirely and is a one-line change.

Longer term, `referralHashrateOf` should be one recursive CTE returning the L1+L2 set in a single query rather than two round trips plus `ownHashrateBatch`'s three. But the index alone converts this from fatal to acceptable.

---

# B4 — The accrual sweep is O(active sessions) with an await per row, and cannot finish at 100k

```ts
// mining/engine.ts:506-519
export async function accrueAllSessions(): Promise<number> {
  const sessions = await sql.all<SessionRow & { user_id: string }>(
    `SELECT id, user_id, device_id, expires_at, last_accrued_at
     FROM mining_sessions WHERE status = 'active'`,
  );
  for (const s of sessions) {
    try {
      await accrueSession(s.user_id, s);   // ~14 queries, incl. 2 users seq scans
    } catch (err) {
      console.error(`MINING: accrual failed for session ${s.id}`, err);
    }
  }
  return sessions.length;
}
```

This runs first on every settlement tick (`engine.ts:728`, driven from `server.ts:190` every 15 minutes) and it is **strictly sequential with a network round trip inside the loop**. No batching, no concurrency, no chunking.

Per session, `accrueSession` (`engine.ts:433-494`) issues: `hashrateOf` (9, of which 2 are B3 seq scans), a `mining_epochs` settled check, `claimDevice`'s insert+select (`engine.ts:358-370`), the `mining_shares` upsert, and the session `last_accrued_at` update — **~14 queries**.

### Arithmetic

Sessions run 8 hours (`sessionHours`), so "active sessions" ≈ users who started mining in the last 8 hours — for a mining-led app, close to the concurrently-active count.

| Scale | Sessions | Fast queries | B3 scans | **Tick duration** | Interval | Verdict |
|---|---|---|---|---|---|---|
| 10k | 10,000 | 10k × 12 × 0.7 ms = 84 s | 10k × 2 × 1 ms = 20 s | **~104 s** | 900 s | survives — but one pool connection is busy 12% of the time, permanently |
| 100k | 100,000 | 100k × 12 × 0.7 ms = 840 s | 100k × 2 × 10 ms = **2,000 s** | **~47 min** | 900 s | **cannot finish** |

At 100k the tick overruns its interval by 3×. Combined with **B8** (no re-entrancy guard), tick N+1 starts while N is still running, then N+2, each holding a pool connection; within ~5 ticks the pool is gone and the whole API stops.

Worse: because `settleDueEpochs` runs accrual *before* settling (`engine.ts:728`), **settlement never runs at all** — mining silently stops paying anyone, and the visible symptom is "the app is down", not "settlement is late".

Fixing B3 only recovers the 2,000 s of scans; the remaining 840 s still overruns.

### Fix

Two changes in `mining/engine.ts`:

1. **Batch the hashrate.** `ownHashrateBatch` (`engine.ts:150-208`) already computes N users' own hashrate in 3 queries, and its own header explains exactly why that mattered. Restructure `accrueAllSessions` to chunk sessions (say 500), call `ownHashrateBatch` **once per chunk**, and resolve the referral component for the whole chunk with one recursive CTE. That collapses 9 queries/session into ~4 queries per 500 sessions.
2. **Batch the writes.** The per-session `mining_shares` upsert, `claimDevice` insert and session `UPDATE` are all set-shaped:

```sql
INSERT INTO mining_shares (epoch, user_id, shares, updated_at)
SELECT * FROM unnest(?::int[], ?::text[], ?::bigint[], ?::text[])
ON CONFLICT (epoch, user_id)
DO UPDATE SET shares = mining_shares.shares + EXCLUDED.shares,
              updated_at = EXCLUDED.updated_at;
```

Result at 100k: ~200 chunks × ~7 statements = **~1,400 queries ≈ 1 second**, versus 47 minutes.

The `try/catch`-per-session guarantee ("one bad session must not stop the sweep", `engine.ts:513-517`) becomes per-chunk. That is a real narrowing and worth stating: a chunk-level failure still leaves 99.5% of the sweep intact, and the next tick retries the failed chunk, so the property the comment cares about survives.

---

# B5 — Settlement inserts one row per miner in a loop, in one transaction, under a global lock

```ts
// mining/engine.ts:685-703
for (const o of owed) {
  if (o.micro <= 0) continue;
  if (blocked.has(o.userId)) { withheld += o.micro; continue; }
  await t.run(
    `INSERT INTO mining_unclaimed (epoch, user_id, micro, created_at) VALUES (?,?,?,?)`,
    epoch, o.userId, o.micro, now(),
  );
  emitted += o.micro;
}
```

The surrounding `sql.tx` (`engine.ts:599`) takes `pg_advisory_xact_lock(hashtext('rozi-settlement'))` at `engine.ts:606` — a **global** lock held for the whole transaction. That is architecturally correct (it is what keeps the 21M supply cap literally true across replicas, and the comment at `engine.ts:600-605` says exactly that), but it means the loop's duration is time during which *no replica can settle anything*, with one of 10 connections pinned.

### Arithmetic

| Scale | Miners with shares | Inserts | Lock held |
|---|---|---|---|
| 10k | ~10,000 | 10,000 × 0.7 ms | **7 s** |
| 100k | ~100,000 | 100,000 × 0.7 ms | **70 s** |

Plus `totalEmittedMicro` (`mining/settings.ts:62-70`), which sums the whole of `rozi_ledger` twice, filtered by `source_type`. It is served by `idx_rozi_source` (`db.ts:1710`) but is still an aggregate over every mining credit ever made. At 100k users claiming daily, `rozi_ledger` reaches ~36M rows within a year; two `SUM`s over ~36M index entries is seconds, inside the same lock.

**Crash mid-epoch is handled correctly** — it is one transaction, so it rolls back whole and the next tick retries (`engine.ts:727-742`). The cost is that the retry redoes the full 70 s; and if the process is being restarted by a health-check failure caused by B8, it never converges.

### Fix

Replace the loop with one set-based insert, at `engine.ts:685`:

```ts
const payable = owed.filter((o) => o.micro > 0 && !blocked.has(o.userId));
if (payable.length) {
  await t.run(
    `INSERT INTO mining_unclaimed (epoch, user_id, micro, created_at)
     SELECT ?, u.user_id, u.micro, ?
     FROM unnest(?::text[], ?::bigint[]) AS u(user_id, micro)`,
    epoch, now(), payable.map((o) => o.userId), payable.map((o) => o.micro),
  );
}
emitted  = payable.reduce((a, o) => a + o.micro, 0);
withheld = owed.filter((o) => o.micro > 0 && blocked.has(o.userId))
               .reduce((a, o) => a + o.micro, 0);
```

70 s → well under a second, with identical semantics: still one transaction, still all-or-nothing, still idempotent on the `mining_epochs` PK.

Separately, replace the repeated `SUM` in `totalEmittedMicro` with a **maintained running total**: a single `app_settings` counter updated in the same transaction as every mint. The header at `mining/settings.ts:46-50` explicitly refuses a *cache* because a stale value could let us mint past the cap — a transactionally-updated counter is not a cache, it is a materialised aggregate written atomically with the thing it counts, so that guarantee is preserved. Keep the full `SUM` as a periodic assertion inside reconciliation.

---

# B6 — The deposit scanner's RPC cost is O(users), inside one transaction holding a global lock

```ts
// deposits/adapters/evm.ts:23-24
const MAX_BLOCK_RANGE = 5_000;
const MAX_ADDRESSES_PER_CALL = 200;

// deposits/adapters/evm.ts:85-94 — one RPC call per 200 addresses, sequential
for (let i = 0; i < addrList.length; i += MAX_ADDRESSES_PER_CALL) {
  const batch = addrList.slice(i, i + MAX_ADDRESSES_PER_CALL);
  const batchLogs = (await rpcCall(chain, "eth_getLogs", [{
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock:   "0x" + toBlock.toString(16),
    address:   tokenAddress,
    topics:    [TRANSFER_TOPIC, null, batch.map(addressToTopic)],
  }])) as EvmLog[];
  logs.push(...batchLogs);
}
```

`addrList` is **every** row in `deposit_wallets` (`evm.ts:111-116`), and B7 shows a row is created for essentially every user who opens the wallet or home screen. So the address list tracks the user base, not the depositor base.

The scanner's own header already flags the transaction shape and asks for exactly this review:

```
// deposits/scanner.ts:9-15
// ⚠️ The whole tick (RPC calls included) runs inside one transaction ...
// The tradeoff: a pool connection sits held for the duration of the RPC round
// trips, not just DB work. Acceptable at this tick's cadence and pool size;
// revisit if scan volume ever grows enough for that to matter.
```

It matters at 10k. The global lock is taken at `scanner.ts:114`.

### Arithmetic

BSC produces ~200 blocks per 90 s tick (`config.ts:422-424`; `DEPOSIT_SCAN_INTERVAL_MS=90000` per CLAUDE.md). Batches per window = `ceil(N / 200)`.

Healthy provider, full 5,000-block window allowed:

| Users | Batches/window | Windows | RPC calls/tick | @150 ms each | Interval | Verdict |
|---|---|---|---|---|---|---|
| 10k | 50 | 1 | 50 | 7.5 s | 90 s | OK |
| 100k | 500 | 1 | 500 | **75 s** | 90 s | marginal — one slow tick and it overruns |

Now the degraded case this codebase has *already been in* in production: when a provider refuses a wide `eth_getLogs`, the adaptive loop (`evm.ts:121-131`) shrinks to `MIN_BLOCK_RANGE = 10` (`evm.ts:44`). 200 blocks / 10 = **20 windows**:

| Users | Calls/tick at 10-block windows | @150 ms | Verdict |
|---|---|---|---|
| 10k | 20 × 50 = 1,000 | 150 s | **overruns the 90 s interval** |
| 100k | 20 × 500 = **10,000** | **25 min** | never completes; cursor never advances; deposits are never credited |

Every one of those seconds is a pool connection held **and** the `'deposit-scan'` advisory lock held. With B8, overlapping ticks queue on that lock *while each holds its own connection*, and the pool is gone.

### Fix — four changes, in priority order

1. **Move the RPC out of the transaction** (`deposits/scanner.ts:110-132`). Scan and collect `ObservedDeposit[]` with no transaction open; then open a short transaction that writes the deposits and advances the cursor. The property the header cares about ("roll back the cursor along with the credits") only requires the *writes* to be atomic, not the reads. This alone frees the pool connection and shortens the global lock from minutes to milliseconds.
2. **Stop filtering by address.** At 100k addresses the OR-filter is the wrong shape. Fetch **all** USDT `Transfer` logs for the window (one call: `address: token.usdt`, `topics: [TRANSFER_TOPIC]`) and filter `to` against the in-memory `byAddress` map that `evm.ts:115` already builds. The `if (!userId) continue` guard at `evm.ts:136-139` is already the real authority — the comment there says the topic filter "is not proof" — so correctness is unchanged. Cost goes from O(users) calls to **one call per window, forever**. Trade-off: a larger response body; measure it, but BSC USDT does not emit enough transfers in a 200-block window for that to be worse than 500 sequential round trips.
3. **Cache the address map** instead of re-`SELECT`ing all of `deposit_wallets` every tick (`evm.ts:111-113`); refresh on a version counter or every N ticks.
4. **Add a re-entrancy guard** (B8) so an overrun can never stack.

---

# B7 — Every wallet/home page load makes a blocking chain RPC call

```ts
// routes/app.ts:391-397
const relayReady = relayAvailable("bep20");
const [gasFeeRate, gas, points, depositUsdtMicro, earnedUsdtMicro, minWithdraw, withdrawalFeeSetting] =
  await Promise.all([
    getGasFeeRate(),
    relayReady ? hasEnoughGasForDisplay(userId, "bep20") : Promise.resolve(null),
    ...
  ]);
```

```ts
// payoutRelay.ts:105-131
const GAS_BALANCE_CACHE_MS = 20_000;
const gasBalanceCache = new Map<string, { balanceWei: bigint; expiresAt: number }>();
...
const cacheKey = `${chain}:${wallet.address}`;      // <-- PER ADDRESS
...
const raw = (await rpcCall(chain, "eth_getBalance", [wallet.address, "latest"],
                           { timeoutMs: 4_000 })) as string;
```

`relayAvailable` (`payoutRelay.ts:82-84`) is **true in production today** — CLAUDE.md records `CUSTODY_XPUB_BEP20`, `CUSTODY_SEED_EVM_*` and `TREASURY_KEY_*` all set live. So this path is active.

There is a 20-second cache, added deliberately in a 2026-08-27 performance pass. But the key is **per address**, so it caps calls at *one per user per 20 s*, not one per 20 s globally.

Note the second-order effect: `userGasWallet` calls `getOrCreateDepositWallet` (`db.ts:2626-2651`), which **INSERTs a `deposit_wallets` row** on first call. Loading `/wallet` once permanently enrols that user into the deposit scanner's address list. That is precisely how B6's cost becomes O(users) rather than O(depositors), and it also inflates B13.

### Arithmetic

| Scale | Distinct users hitting `/wallet/balance` per 20 s | `eth_getBalance`/s | per day |
|---|---|---|---|
| 10,000 concurrent | 10,000 | **500/s** | 43.2 M |
| 100,000 concurrent | 100,000 | **5,000/s** | 432 M |

Alchemy prices `eth_getBalance` around 19–26 CU. At 10k that is **~1.1 billion CU/day**. For calibration: this project has already suffered **two billing incidents** (CLAUDE.md, 2026-08-13 and 2026-08-27) caused by roughly **2 RPC calls per 20 seconds** in total. This is five orders of magnitude larger. No provider tier absorbs it, and the `$3` Alchemy cap trips within minutes of a real launch.

**[R]** The cache is per-process, so N replicas multiply this by N.

Latency, separately: `rpcCall` (`rpc.ts:56-101`) walks the endpoint list giving each its own timeout. At 4 s × the 5 configured endpoints (`config.ts:180-186`), a bad provider adds **up to 20 seconds** to the response on the app's most-loaded endpoint. `hasEnoughGasForDisplay` catches the error (`payoutRelay.ts:170-176`) but only *after* the full failover walk.

### Fix

The gas balance is a **display signal, never a gate** — the file's own comment says so (`payoutRelay.ts:95-104`), and the request-time gates in `withdrawals.ts` / `mining.ts` call `hasEnoughGas` directly, not this display wrapper. So:

1. **Remove it from `GET /wallet/balance` entirely.** Return `personalGasWei: null` there and let the two screens that actually need it (`/wallet/withdraw`, `/mine/refund`) fetch it from a dedicated `GET /wallet/gas` endpoint, hit once when the user opens a withdraw form. That moves the call rate from *per page load* to *per withdrawal attempt* — roughly a 1000× reduction with no UX loss, because a user who is not withdrawing never needed the number.
2. **If you keep it anywhere hot, persist it.** Add `deposit_wallets.gas_wei` + `gas_checked_at`, read from the row when under 5 minutes old, refresh asynchronously. The cache then survives restarts and is shared across replicas.
3. **Decouple wallet creation from the display read.** Change `userGasWallet` (`payoutRelay.ts:116`) to a **read-only** lookup returning `null` when no `deposit_wallets` row exists, and create the row only where a user genuinely needs a deposit address (`GET /usdt`'s `personalAddress`, `routes/mining.ts:659`). That keeps `deposit_wallets` proportional to real depositors, which directly shrinks B6 and B13.

---

# B8 — None of the five background timers guards against overlapping ticks

```ts
// server.ts:243
setInterval(tickSettlement, SETTLE_INTERVAL_MS).unref();
// server.ts:271
setInterval(tickDeposits, config.depositScanIntervalMs).unref();
// server.ts:291
setInterval(tickPayoutRelayJob, config.depositScanIntervalMs).unref();
// server.ts:298-300
setInterval(() => { void tickReconcile().catch(...) }, RECONCILE_INTERVAL_MS).unref();
// server.ts:311-313
setInterval(() => { void tickTicketAutoClose().catch(...) }, TICKET_AUTO_CLOSE_TICK_MS).unref();
```

`setInterval` with an `async` callback fires on schedule regardless of whether the previous invocation finished. Two of these ticks take **global** advisory locks *inside* `sql.tx` (`mining/engine.ts:606`, `deposits/scanner.ts:114`), which means the second tick has already checked out a pool connection **before** it blocks on the lock.

**The failure sequence, concretely.** Deposit scan takes 150 s (B6's degraded case at 10k users) against a 90 s interval:

| t | Event | Connections held by the scanner |
|---|---|---|
| 0 s | tick 1 starts, takes a connection + the lock | 1 |
| 90 s | tick 2 starts, takes a connection, **blocks on the lock** | 2 |
| 180 s | tick 3 starts | 3 |
| … | … | … |
| 810 s | tick 10 starts | **10 — pool exhausted** |
| 810 s+ | every earner request now waits on `pool.connect()` **with no timeout** (B1) | API down |

This is what turns a *slow* subsystem into a *total outage*, and it is silent: the logs only show "Deposit scan tick failed" when a tick errors, never when ticks pile up.

### Fix

A shared helper in `server.ts`:

```ts
function everyNoOverlap(ms: number, name: string, fn: () => Promise<unknown>) {
  let running = false;
  const run = async () => {
    if (running) { app.log.warn({ tick: name }, "previous tick still running — skipped"); return; }
    running = true;
    const t0 = Date.now();
    try { await fn(); }
    catch (err) { app.log.error({ err, tick: name }, "tick failed"); }
    finally {
      running = false;
      app.log.info({ tick: name, ms: Date.now() - t0 }, "tick finished");
    }
  };
  setInterval(() => void run(), ms).unref();
  return run;
}
```

Wrap all five. Log tick duration on every run, so an overrun becomes visible **before** it becomes an outage — right now no such metric exists anywhere in the codebase.

Additionally, swap the two global `pg_advisory_xact_lock` calls for `pg_try_advisory_xact_lock` and return early when not acquired. `advanceRelayJob` already does exactly this (`payoutRelay.ts:384-387`) and is the right precedent: a tick that cannot get the lock has nothing useful to do, and *blocking* on it is what converts contention into connection exhaustion.

---

# B9 — The campaign budget check is an unindexed scan held under a per-campaign lock

```ts
// credit.ts:170-179
await lockCampaign(t, taskId);
const budget = await t.get<BudgetRow>(
  "SELECT budget_conversions, budget_points, budget_usdt_micro FROM tasks WHERE id = ?", taskId);
if (budget) {
  const pointsInc = points + Math.floor(roziMicro / 1_000_000);
  const v = overBudget(budget, await campaignSpend(t, taskId), pointsInc, usdtMicro);
```

```ts
// taskBudget.ts:50-52
export function lockCampaign(t: Pick<TxApi, "run">, taskId: string) {
  return t.run("SELECT pg_advisory_xact_lock(hashtext(?))", `task-budget:${taskId}`);
}
// taskBudget.ts:67-73
const row = await t.get<{ n: number; pts: number; usdt: string | number }>(
  `SELECT COUNT(*)::int AS n,
          COALESCE(SUM(points), 0)::int + (COALESCE(SUM(reward_rozi_micro), 0) / 1000000)::int AS pts,
          COALESCE(SUM(usdt_micro), 0) AS usdt
     FROM task_completions WHERE task_id = ? AND status = 'credited'`,
  taskId,
);
```

`task_completions` has exactly two indexes: `idx_completion_ext (network, external_id)` (`db.ts:296-298`) and `idx_completions_user_created (user_id, created_at)` (`db.ts:811-813`). **There is no index on `task_id`.** So `campaignSpend` is a full seq scan of `task_completions`, executed while holding the per-campaign advisory lock.

The lock is correct and necessary — the comment at `credit.ts:159-165` explains the read-then-write race it closes, and it should not be removed. The problem is that it is held for the duration of a **table scan**, so every credit on one campaign serialises behind that scan.

### Arithmetic

| Rows in `task_completions` | Seq scan | Max credits/s on ONE campaign |
|---|---|---|
| 100k | ~30 ms | ~33/s |
| 1M | ~300 ms | ~3/s |
| 10M | ~3 s | ~0.3/s |

A campaign that goes viral at 100k users generates far more than 3 completions/second, and every excess one queues on the lock while holding a pool connection. That is B8's pool-exhaustion sequence again, triggered by *success* rather than by failure.

### Fix

```sql
CREATE INDEX IF NOT EXISTS idx_completions_task_credited
  ON task_completions(task_id) WHERE status = 'credited';
```

That makes `campaignSpend` an index scan over just this campaign's credited rows.

Better still: since the lock exists precisely to serialise a read-then-write on a shared total, maintain `tasks.spent_conversions` / `spent_points` / `spent_usdt_micro` as counters incremented in the same transaction as the completion insert. The budget check then becomes a single-row read of the `tasks` row already fetched at `credit.ts:171`, and `lockCampaign` can be replaced by `SELECT … FROM tasks WHERE id = ? FOR UPDATE` — narrower, and it lets Postgres do the queueing. Keep `campaignSpend` as a reconciliation assertion.

---

# B10 — A staff dashboard poll can starve the earner API

```ts
// analytics.ts:66-90 (abridged) — 31 entries in ONE Promise.all
const [ totalUsers, verifiedUsers, newToday, new7d, new30d, dau, wau, mau, ... ] =
  await Promise.all([
    scalar("SELECT COUNT(*)::int AS v FROM users"),
    scalar("SELECT COUNT(*)::int AS v FROM users WHERE email_verified = 1"),
    scalar("SELECT COUNT(*)::int AS v FROM users WHERE created_at >= ?", startOfToday),
    ...
    scalar("SELECT COALESCE(SUM(amount),0)::int AS v FROM ledger_entries WHERE source_type = 'task_completion' AND direction = 'credit' AND created_at >= ?", since),
    ...
  ]);
```

Thirty-one queries issued simultaneously against a pool of **ten**. Twenty-one queue immediately. Four more retention CTEs then run after (`analytics.ts:145-180`).

Almost none is indexed for what it asks. `COUNT(*) FROM users WHERE created_at >= ?` has no index on `users(created_at)`. `SUM(amount) FROM ledger_entries WHERE source_type = … AND created_at >= ?` is poorly served by `idx_ledger_user_source (user_id, source_type)` (`db.ts:833-834`) because there is no `user_id` predicate.

`GET /staff/dashboard` (`routes/staff.ts:2599-2619`) does the same thing with 12 queries, polled every **30 s** (`web/src/components/staff/DashboardOverview.tsx:33`), and the money queues poll every **20 s** (`QUEUE_POLL_MS`, `web/src/components/staff.tsx:33`).

### Arithmetic

At 100k users and ~5M `ledger_entries` rows, each of those aggregates is a multi-second seq scan. Three staff members with the dashboard open = `3 × 31` queries every 30 s, each holding a connection for seconds. **The earner API's 10 connections are gone**, and nothing in the code prioritises an earner request over a staff chart.

### Fix

1. **Separate pool** (see B1): `sqlStaff` with `max: 3`, used by `routes/staff*.ts`. Highest leverage here, because it makes the blast radius of *every future* staff-panel query bounded by construction.
2. **Serialise instead of fanning out.** Replace the 31-entry `Promise.all` with 3–4 hand-written queries using `FILTER (WHERE …)` — every `users` count above collapses into one scan with eight `COUNT(*) FILTER (…)` expressions.
3. **Cache the analytics response** for 60 s in `analytics.ts`. `leaderboard.ts:30,50` already establishes this pattern in this codebase, and a KPI chart does not need to be fresh to the second.
4. Add `CREATE INDEX ON users(created_at)`, `ON ledger_entries(source_type, created_at)`, `ON task_completions(status, created_at)`.

---

# B11 — Login throughput is capped by the 4-thread libuv pool

```ts
// auth.ts:24,38-41
const scryptAsync = promisify(scrypt);
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;   // DEFAULT params
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}
// auth.ts:49-55
async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  ...
  const derived = (await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length)) as Buffer;
```

No `{ N, r, p, maxmem }` options are passed, so Node's defaults apply: **N=16384, r=8, p=1** (~16 MB, ~60–100 ms per hash on a cloud vCPU). `crypto.scrypt`'s async form runs on the **libuv threadpool**, which defaults to **4 threads**, and nothing in this repo sets `UV_THREADPOOL_SIZE`.

### Arithmetic

- Concurrency 4, ~80 ms per hash ⇒ **~50 password verifications/second per process**, a hard ceiling regardless of how many cores beyond 4 the container has.
- The login rate limit is 30/minute **per IP** (`auth.ts:350`). CGNAT in Pakistan puts thousands of real users behind one IP — `server.ts:90-93` acknowledges this explicitly as the reason the limiter is `global: false` — so the limiter is not the constraint. The threadpool is.
- Every `/auth/login` pays the cost, including one for an unknown email: `DECOY_PASSWORD_HASH` (`auth.ts:44-47`) deliberately makes the miss path as expensive as the hit path.
- Those same 4 threads serve `fs` and `dns`. A login burst therefore also stalls DNS resolution for every outbound `fetch` — Resend, chain RPC, Telegram, web-push.

At 10k users returning after a push notification, a 60-second surge of 2,000 login attempts needs 40 s of wall clock at 50/s. Most clients time out first and retry, which makes it worse.

### Fix

1. **Set `UV_THREADPOOL_SIZE`** to `max(4, 2 × cores)` in the Railway environment. Free, immediate, roughly linear up to core count.
2. **Pin the scrypt parameters explicitly** rather than inheriting Node's defaults, so the cost is a visible decision: `scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })`. Then encode them in the hash string (`scrypt$N$r$p$salt$hash`) so the cost can be raised later without invalidating existing passwords — the current format at `auth.ts:38-41,49-55` cannot express a parameter change at all, which means today's cost is frozen forever.
3. If login volume becomes a real constraint, move verification to a `worker_threads` pool sized independently of libuv so it cannot starve DNS.

---

# B12 — Unbounded response payloads

Four endpoints have no `LIMIT`:

```ts
// routes/app.ts:465-471 — the ENTIRE points ledger for one user
`SELECT le.*, w.status AS w_status
 FROM ledger_entries le
 LEFT JOIN withdrawal_requests w ON w.id = le.source_ref_id AND le.source_type = 'withdrawal'
 WHERE le.user_id = ? ORDER BY le.created_at DESC`

// routes/withdrawals.ts:504 — SELECT *, every request ever made
"SELECT * FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC"
```

The worst is support, because of what it selects:

```ts
// routes/app.ts:889-895
`SELECT m.ticket_id, m.author_role, m.body, m.image, m.created_at
 FROM ticket_messages m JOIN support_tickets s ON s.id = m.ticket_id
 WHERE s.user_id = ? AND m.author_role <> 'internal'
 ORDER BY m.created_at ASC`
```

`m.image` is a base64 data URL accepted up to **3,000,000 characters** (`routes/app.ts:915-919`, `routes/app.ts:1024-1027`). There is no `LIMIT`. A user who has sent 20 screenshots over six months gets a **~60 MB JSON response**, serialised into a single Node string, over a mobile connection in Pakistan.

`GET /support/chat` gets this right — `MESSAGE_CAP = 300` plus a `?since=` delta (`routes/app.ts:970,994`), and the comment at `routes/app.ts:983-989` explains the exact bandwidth reasoning. `GET /support/tickets` is the older sibling that never got the treatment.

### Arithmetic

Memory, not CPU, is binding here. Each 60 MB response is copied several times (row buffer → JS string → JSON → socket). Ten concurrent such requests is >1 GB of transient heap and an OOM restart. At 100k users it takes only a handful of heavy users coinciding.

### Fix

- **`GET /support/tickets`: stop selecting `image` in the list query.** Return `hasImage: boolean` and serve the bytes from a per-message endpoint. Add `LIMIT 300` mirroring `/support/chat`. Better still, delete this endpoint — `/support/chat` supersedes it and the frontend has moved to it.
- **Add `LIMIT 100` + a cursor** to `/wallet/ledger`, `GET /withdrawals`, `GET /wallet/bnb/withdrawals`, `/wallet/usdt-task-rewards`, matching the pattern `/mining/history` already uses (`routes/mining.ts:395`).
- **Move `ticket_messages.image` out of the row entirely** — a `ticket_message_images` side table keyed by message id. `ticket_messages` is scanned by the staff support queue and written by the auto-close sweep (`ticketAutoClose.ts:40-45`); a 2 MB blob on those rows is paid for on every one of them. This is the same reasoning already applied to avatars (CLAUDE.md, profile settings: "`auth.ts` does `SELECT *` on every request and a 40KB blob on that row would be paid for on all of them") and it applies verbatim, at 50× the size.

---

# B13 — Reconciliation reads every deposit address, and one failure aborts the whole check

```ts
// deposits/reconcile.ts:79
const MULTICALL_BATCH_SIZE = 300;
// deposits/reconcile.ts:97-112
for (let i = 0; i < addresses.length; i += MULTICALL_BATCH_SIZE) {
  const batch = addresses.slice(i, i + MULTICALL_BATCH_SIZE);
  const results = await publicClient.multicall({
    contracts: batch.map((address) => ({ address: token.usdt, abi: erc20Abi, functionName: "balanceOf", args: [address] })),
    allowFailure: true,
  });
  for (let j = 0; j < results.length; j++) {
    if (results[j].status !== "success") {
      throw new Error(`balanceOf failed for deposit address ${batch[j]}: ...`);
    }
```

The throw-on-any-failure is deliberate and well argued (`reconcile.ts:81-90`): substituting 0 would fabricate a shortfall and page staff over nothing. But the consequence is that the probability of a *successful* reconciliation is `p^N` for per-address success probability `p`. At 100k addresses across 334 multicall batches on a public-tier RPC, that rounds to zero — **reconciliation stops working entirely, silently, forever** — and reconciliation is the only automated check that the treasury holds what the ledger says it owes.

### Arithmetic

| Addresses | Multicall batches | @1.5 s each | Hourly interval |
|---|---|---|---|
| 10k | 34 | 51 s | fits |
| 100k | 334 | **8.4 min** | fits on time, but `p^100000` ≈ 0 |

### Fix

1. **Shrink the address set.** Fixing B7's create-on-display bug makes this O(actual depositors) rather than O(users) — likely a 100× reduction, and by far the cheapest change.
2. **Make failure partial, not total.** Reconcile a *rotating slice* per tick (e.g. 5,000 addresses/hour, cycling through), comparing the slice's on-chain subtotal against the ledger subtotal for the same slice. A shortfall is still caught; a flaky RPC only loses one slice.
3. **Detect the silence.** Track `last_successful_reconcile_at` and raise a `high` fraud flag — which already pages Telegram via `fraud.ts`'s `flagOnce` — when it exceeds 6 hours. Today a permanently-failing reconciliation is indistinguishable from a healthy one.

---

# B14 — Everything stateful is per-process, so the second replica changes behaviour

| State | Location | What a 2nd replica does |
|---|---|---|
| `touchActivity` seen-Set | `analytics.ts:29-39` | DAU writes double (harmless — `ON CONFLICT DO NOTHING`); ~10 MB per replica per 100k DAU, cleared daily |
| Gas balance cache | `payoutRelay.ts:106` | RPC call rate **×N** (B7) |
| Leaderboard cache | `leaderboard.ts:30,50` | Two replicas can show different top-20s; `bustLeaderboardCache` (`leaderboard.ts:33-40`) on one does not clear the other |
| `lastGoodRange` | `deposits/adapters/evm.ts:49` | Each replica re-discovers the provider's window limit from `MAX_BLOCK_RANGE` |
| `cachedBotUsername` | `auth.ts:474` | One extra `getMe` per replica — harmless |
| Rate-limit LRU | `@fastify/rate-limit` `LocalStore` | Budgets **×N** (B15) |
| All 5 timers | `server.ts:243-313` | Tick frequency **×N**; the two global advisory locks make the *work* safe, but the *contention* multiplies |

The advisory locks mean nothing double-executes incorrectly — that part of the design holds. What breaks is efficiency and rate: N replicas produce N× the RPC calls and N× the lock contention, and each replica's blocked tick holds a connection from its own pool.

### Fix

- **Move the timers out of the request-serving process.** Railway can run a second service from the same image with `TICKS_ONLY=1`; gate the five `setInterval` calls behind that flag and gate route registration behind its inverse. That is a ~20-line change in `server.ts` and it makes horizontal scaling of the API safe by construction.
- The gas cache and leaderboard cache move to a shared store (Redis) or to the database once more than one replica exists. `bustLeaderboardCache` has no cross-process story at all today.

---

# B15 — Rate limiting is per-replica, and per-route LRU-capped

```ts
// server.ts:101-107 — no `redis` option, so LocalStore is used
await app.register(rateLimit, {
  global: false,
  errorResponseBuilder: () => ({
    statusCode: 429,
    error: "Too many tries. Please wait a minute and try again.",
  }),
});
```

```js
// node_modules/@fastify/rate-limit/store/LocalStore.js:5
function LocalStore (continueExceeding, exponentialBackoff, cache = 5000) {
  this.lru = new Lru(cache)
}
```

`LocalStore.prototype.child` gives every route its own store, so each of the 11 limited routes (`auth.ts:264,322,350,382,396,422,443,491,527,557,591`) has its own 5000-key LRU.

Two consequences:

- **[R] Budgets multiply by replica count.** `/auth/login` is 30/min/IP (`auth.ts:350`); behind a load balancer with 3 replicas it is effectively 90/min/IP. The one control standing between a credential-stuffing run and B11's 50-hashes/second ceiling loses two thirds of its strength the moment you scale out.
- **The LRU is capped at 5000 keys.** Not a memory risk — it is bounded, which is good — but an eviction risk: an attacker who can present more than 5000 unique source addresses (a botnet, or IPv6 rotation) evicts their own counter and continuously resets their budget.

### Fix

Add a shared store the moment there is a second replica:

```ts
await app.register(rateLimit, {
  global: false,
  redis: new Redis(process.env.REDIS_URL),   // Railway Redis add-on
  errorResponseBuilder: () => ({ statusCode: 429, error: "Too many tries. Please wait a minute and try again." }),
});
```

This is the only place in the system that genuinely needs Redis; the plugin's Redis store is a drop-in and nothing else about the registration changes. Also consider keying the login limiter on **email** rather than IP, which sidesteps both CGNAT (the reason the current numbers are so loose) and IP rotation, and is the more meaningful budget for a brute-force control.

---

# B16 — Broadcast push uses OFFSET pagination and 200-way concurrency against a 10-connection pool

```ts
// notify.ts:175-193
const BATCH = 200;
let offset = 0;
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
```

Each `sendPushToUser` (`push.ts:63-71`) runs its own `SELECT … FROM push_subscriptions WHERE user_id = ?`. So each batch issues **200 concurrent queries into a 10-connection pool** — 190 queue immediately, with no timeout (B1). During a broadcast, earner requests compete with that queue.

`OFFSET` is O(offset): the 500th page of a 100k broadcast makes Postgres walk and discard 99,800 rows.

### Arithmetic

100k recipients = 500 batches. Sum of discarded rows across the run ≈ `500 × 501 / 2 × 200` ≈ **25M rows**. Plus 100k individual subscription lookups. Plus up to 100k outbound HTTPS pushes, whose DNS resolution shares the libuv threadpool with B11's scrypt.

### Fix

1. **Keyset pagination** — `WHERE broadcast_id = ? AND user_id > ? ORDER BY user_id LIMIT 200`, carrying the last `user_id` forward. O(1) per page.
2. **One query per batch, not 200.** Join the subscriptions in:
   ```sql
   SELECT n.user_id, ps.id, ps.endpoint, ps.p256dh, ps.auth
     FROM notifications n
     JOIN push_subscriptions ps ON ps.user_id = n.user_id
    WHERE n.broadcast_id = ? AND n.user_id > ?
    ORDER BY n.user_id LIMIT 200
   ```
   That is 500 queries for the whole broadcast instead of 100,500.
3. **Cap outbound HTTPS concurrency explicitly** (say 50) rather than letting it equal the batch size. The header comment at `notify.ts:171-174` already reasons about not firing everything at once; the batch size is doing double duty as both a DB page size and a concurrency limit, and they should be separate numbers.

---

# B17 — An uncached settings read on every request, and no cache on any settings read

```ts
// server.ts:149-158
const MAINTENANCE_OPEN = /^\/(health|auth|staff|webhooks|features)\b/;
app.addHook("onRequest", async (req, reply) => {
  if (MAINTENANCE_OPEN.test(req.url.split("?")[0])) return;
  if ((await getSetting("maintenance_mode", "0")) !== "1") return;
```

```ts
// db.ts:2352-2355
export async function getSetting(key: string, fallback: string): Promise<string> {
  const row = await sql.get<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", key);
  return row?.value ?? fallback;
}
```

That is one additional DB round trip on **every** earner request, before routing. `loadMiningSettings` (`mining/settings.ts:24-36`) and `allFlags` (`flags.ts:21-43`) have the same shape and are called several times per mining request (B2).

At 5,000 req/s (100k scale) that is 5,000 queries/s for a value that changes maybe twice a year — roughly 35% of the entire pool's theoretical throughput, on its own.

### Fix

A short TTL cache in `db.ts`, invalidated by `setSetting`:

```ts
const settingCache = new Map<string, { value: string | null; at: number }>();
const SETTING_TTL_MS = 5_000;

export async function getSetting(key: string, fallback: string): Promise<string> {
  const hit = settingCache.get(key);
  if (hit && Date.now() - hit.at < SETTING_TTL_MS) return hit.value ?? fallback;
  const row = await sql.get<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", key);
  settingCache.set(key, { value: row?.value ?? null, at: Date.now() });
  return row?.value ?? fallback;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await sql.run(`INSERT INTO app_settings ... ON CONFLICT ...`, key, value, now());
  settingCache.delete(key);   // this process; others expire within 5s
}
```

Same treatment for `loadMiningSettings`. **[R]** Across replicas an admin change propagates within 5 s, which is well inside what "tunable with no redeploy" promises.

**Do not apply this to `totalEmittedMicro`.** Its header at `mining/settings.ts:46-50` correctly forbids caching the supply-cap input, and that reasoning stands — see B5 for the right answer (a transactionally-maintained counter, which is a different thing from a cache).

---

# B18 — The Resend call in the registration path has no timeout

```ts
// email.ts:29-33
const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: { authorization: `Bearer ${config.resendApiKey}`, "content-type": "application/json" },
  body: JSON.stringify({ ... }),
});
```

```ts
// auth.ts:78
await sendLoginCode(email, code);
```

Node's `fetch` has **no default timeout**. If Resend hangs (not errors — hangs), `/auth/register`, `/auth/forgot`, `/auth/reset` and the step-up withdrawal code all hang with it, each holding an open request and socket.

The pattern to copy is already in this file's neighbourhood: `auth.ts:476-478` passes `AbortSignal.timeout(5000)` to the Telegram `getMe` call. It just was never applied here.

### Fix

```ts
const res = await fetch("https://api.resend.com/emails", {
  method: "POST", headers: { ... }, body: ...,
  signal: AbortSignal.timeout(8_000),
});
```

Consider going further and decoupling: write the `email_codes` row, return 200, and send from a small outbox drained by the settlement tick. The user experience ("check your email") is unchanged, and a provider outage stops being a registration outage.

---

# B19 — Conversion window settlement is a per-burn-row loop in one transaction

```ts
// routes/mining.ts:1385-1402
const burns = await t.all<{ id: string; user_id: string; rozi: string }>(
  "SELECT id, user_id, rozi FROM conversion_burns WHERE window_id = ? ORDER BY created_at", windowId);
const totalBurnMicro = burns.reduce((a, b) => a + Number(b.rozi), 0);

let paid = 0;
for (const b of burns) {
  const points = conversionPayout(Number(b.rozi), totalBurnMicro, w.pot_points);
  if (points <= 0) continue;
  await postLedger({ userId: b.user_id, points, direction: "credit", ... }, t);   // 1 query
  await t.run("UPDATE conversion_burns SET points_paid = ? WHERE id = ?", points, b.id);  // 1 query
  paid += points;
}
```

Structurally identical to B5: two sequential round trips per participant inside one transaction. The per-row (rather than per-user) design is deliberate and correct — `routes/mining.ts:1377-1383` explains that grouping by user would triple-count `points_paid` — so keep the row granularity and change only the batching.

At 100k participants: 200,000 round trips ≈ **140 seconds** in one transaction holding one connection.

Ranked last because it is staff-triggered and rare. But a conversion window is precisely the moment when the most users are watching. Fix it the same way as B5: one `INSERT … SELECT FROM unnest(...)` for the ledger rows and one `UPDATE … FROM unnest(...)` for `points_paid`. The overpay assertion at `routes/mining.ts:1408-1413` still works unchanged against the JS-side sum.

---

# What must change before 100k, ordered by leverage

Each item names the file and the shape of the change. Items 1–5 are what the system does not survive without; 6–10 are what make it comfortable.

**1. Give the timers their own process, and give every tick a re-entrancy guard.** `server.ts:243-313`. First, because it is what converts "a subsystem is slow" into "the API is down" (B8), and because it makes every later scaling decision independent. Gate the five `setInterval` calls behind a `TICKS_ONLY` env flag, run one worker service, and wrap each tick in a no-overlap helper that logs duration. Also swap the two global `pg_advisory_xact_lock` calls for `pg_try_advisory_xact_lock` (`mining/engine.ts:606`, `deposits/scanner.ts:114`), matching what `payoutRelay.ts:384-387` already does.

**2. Configure the pool properly, and split it.** `db.ts:44-47`. `max` from env (start at 30), `connectionTimeoutMillis: 5000`, `statement_timeout: 10000`, `idleTimeoutMillis: 30000`. Then a second `Pool` with `max: 3` for `routes/staff*.ts`. Without the timeouts, every other bottleneck here expresses itself as an unbounded queue instead of a 503; without the split, one staff chart can take the earner app down (B1, B10).

**3. Take the chain RPC out of the request path and off the per-user cadence.** `routes/app.ts:392`, `payoutRelay.ts:105-131`. Remove `hasEnoughGasForDisplay` from `GET /wallet/balance`; serve it from a dedicated endpoint the withdraw screens call once. Make `userGasWallet` read-only so `deposit_wallets` tracks depositors rather than everyone who opened the app. This eliminates 500–5,000 RPC calls/s (B7) *and* shrinks B6 and B13 by roughly the users-to-depositors ratio — the cheapest large win available.

**4. Add the four missing indexes.** In `db.ts`'s `MIGRATIONS`:
```sql
CREATE INDEX IF NOT EXISTS idx_users_referred_by       ON users(referred_by) WHERE referred_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mining_sessions_started ON mining_sessions(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_completions_task_credited ON task_completions(task_id) WHERE status = 'credited';
CREATE INDEX IF NOT EXISTS idx_ledger_source_created   ON ledger_entries(source_type, created_at);
```
The first turns 6 full `users` scans per mining request into index probes (B3); the third un-serialises campaign crediting (B9). One line each, no behaviour change. Ship them with `CONCURRENTLY` against the live database.

**5. Batch the two per-user loops in mining.** `mining/engine.ts:506-519` (accrual sweep: chunk + `ownHashrateBatch` + `unnest` upsert) and `mining/engine.ts:685-703` (settlement: `INSERT … SELECT FROM unnest`). At 100k these go from 47 minutes and 70 seconds respectively to roughly a second each (B4, B5). Do the accrual sweep first — it is the one that currently prevents settlement from running at all.

**6. Stop recomputing `hashrateOf` three times per `/mining/state`.** `routes/mining.ts:219-222`, `mining/engine.ts:522-527`. Return the breakdown from `sessionState`; thread `MiningSettings` through the accrual path. ~47 queries → ~14 on the app's hottest endpoint (B2).

**7. Cache settings and flags for 5 seconds; make `totalEmittedMicro` a maintained counter.** `db.ts:2352`, `mining/settings.ts:24`, `flags.ts:21`. Removes the per-request maintenance read (B17) and the two full `rozi_ledger` sums from inside the settlement lock (B5).

**8. Change the deposit scanner from address-filtered to token-filtered, and move its RPC out of the transaction.** `deposits/adapters/evm.ts:81-96`, `deposits/scanner.ts:110-132`. O(users) RPC calls → one per block window, and the global lock drops from minutes to milliseconds (B6).

**9. Bound the unbounded responses, and get the base64 images out of `ticket_messages`.** `routes/app.ts:463-500,877-895`, `routes/withdrawals.ts:504,840`. Add `LIMIT` + cursors; move `image` to a side table and return `hasImage` in list queries (B12).

**10. Shared rate-limit store and `UV_THREADPOOL_SIZE` before the second replica.** `server.ts:101-107` (Redis store), Railway env (`UV_THREADPOOL_SIZE`), and pin the scrypt parameters into the hash format so the cost is changeable later (B11, B15).

## The one thing this audit could not determine

**HYPOTHESIS:** the real ratio of "concurrently active" to "open mining session", and the real page-view rate per active user. Every arithmetic table above is parameterised on the assumptions at the top of this document, and the two that matter most are session count (drives B4) and page-view rate (drives B1/B2/B7). Before committing to any of these numbers, add tick-duration logging (item 1) and a per-endpoint query counter — at present there is **no instrumentation anywhere in this codebase** that would tell you which of these bottlenecks you are approaching, and the first symptom of most of them is an API that stops answering rather than one that gets gradually slower.
