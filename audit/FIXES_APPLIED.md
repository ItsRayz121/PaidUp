# Fixes applied — 2026-09-04

Authorised by the founder after the audit report. Each entry states what was
measured **before**, what changed, and what was measured **after**, on the same rig
with the same command. Nothing here is estimated; where a number is extrapolated
the arithmetic is shown and labelled.

**Regression state after every change below:** 38 suites (6 unit + 32 e2e), **1,497 checks,
0 failures** (91 unit + 1,406 e2e), each e2e suite run from a genuinely fresh
database; `tsc --noEmit` clean. Two new suites were added (`test:otprace`,
`test:miningbatch`).

---

## 1. A-14 — a one-time email code could be redeemed several times at once

**The defect, measured before:** twelve simultaneous `POST /auth/verify-email`
calls carrying **one** valid code → **4 accepted**. `consumeCode`
(`api/src/auth.ts`) read the row, compared the hash in JS, then wrote
`consumed = 1` unconditionally, so every concurrent caller passed. Affected
`verify`, `reset`, `link` and — the money-adjacent one — the `withdraw` step-up
code, which is consumed outside the per-user lock that guards the debit. The
five-attempt guess cap had the same shape: the count was read *before* the
increment, so a burst of wrong guesses all saw zero.

**The fix:** the claim is now the atomic act, not a follow-up to a read.

```sql
UPDATE email_codes SET consumed = 1 WHERE id = ? AND consumed = 0
  RETURNING pending_password_hash          -- zero rows => someone else spent it
UPDATE email_codes SET attempts = attempts + 1 WHERE id = ? AND consumed = 0
  RETURNING attempts                       -- the count AFTER this increment
```

Under READ COMMITTED the second writer blocks on the row lock, re-evaluates the
predicate against the committed version, sees `consumed = 1`, and returns nothing.

**Measured after:** 12 simultaneous confirmations → **exactly 1 accepted**; 12
simultaneous wrong guesses → the code is burned at the cap and dead afterwards.

**Proof the test can actually fail.** The fix was reverted in place and the same
suite re-run against the old code: **3 of 12 accepted, `attempts` reached 12
against a cap of 5 with the code still alive.** A regression test that has never
been seen to fail is not evidence, so this was checked rather than assumed.

`npm run test:otprace` — 22 checks on PGlite, **28 on real Postgres** (the six
extra are the races). It also carries a structural tripwire that reads `auth.ts`'s
own source and fails if either write is turned back into a blind one: PGlite has a
single connection and serialises the interleaving, so the broken version passes
there. That tripwire is the only thing protecting this fix on the default driver.

---

## 2. B1 — the pool queued forever instead of shedding load

**Before:** `new Pool({ connectionString, ssl, max: 10 })` — no
`connectionTimeoutMillis`, no `statement_timeout`. Past capacity the API did not
error, it queued: offered load 100 → 150 → 220 screen-loads/second moved
throughput not at all (426 / 407 / 438 req/s) while p95 went 38 ms → 22 s → 41 s,
every waiting request still holding a live HTTP connection.

**After:** `max` from `PG_POOL_MAX` (default 20), `connectionTimeoutMillis: 5000`,
`statement_timeout: 10000`, `idleTimeoutMillis: 30000`, `application_name`, and a
`pool.on("error")` handler — without that last one a single dropped idle
connection is an unhandled `error` event, which takes the process down instead of
being replaced silently.

⚠️ **Boot DDL is deliberately exempt from `statement_timeout`.** `CREATE INDEX` on
a table with millions of rows can legitimately outlast any request deadline, and a
deadline there means the bigger the database gets, the likelier the API is to fail
to boot at all. `driver.exec` now sets `statement_timeout = 0` on its own client
and restores it before release, destroying the connection rather than returning it
if the DDL throws. Verified by booting against a genuinely fresh UTF-8 Postgres
database.

The 10-second ceiling is real and it will fire on things that deserve to: the
audit's own 100k-row bench trips it on `DELETE FROM users`. That is what
`PG_STATEMENT_TIMEOUT_MS` is for, and the bench now sets it.

---

## 3. B8 — five timers with no re-entrancy guard

**Before:** five bare `setInterval`s. Each tick opens a transaction, and a
transaction holds one pooled connection for its whole duration — so a tick running
longer than its interval was joined by a second holding a second connection, then
a third. The measured accrual sweep was 6 minutes against a 15-minute interval,
i.e. the closest of them to that failure. Two identical 100-screens/s runs
differing 4× in p95 (7.06 s vs 2.77 s) is consistent with exactly this.

**After:** every timer goes through one `everyNoOverlap()` helper in `server.ts`
that skips a tick while the previous one is still running, logs the first skip
loudly and then rarely, warns when a tick exceeds half its interval, and can never
throw out of a timer. The boot kicks route through the same guard rather than
calling the raw functions, or a boot run and the first interval run could overlap.

Both **global** advisory locks became **try**-locks
(`pg_try_advisory_xact_lock`), matching what `payoutRelay.ts` already did:
`hashtext('rozi-settlement')` (`mining/engine.ts`) and
`hashtext('deposit-scan')` (`deposits/scanner.ts`). A blocking wait counted
toward the new `statement_timeout` and held a connection for the holder's whole
duration; declining costs nothing, because settlement is idempotent on the
`mining_epochs` primary key and the deposit scan is cursor-based.

⚠️ Why the tick durations are now logged: the audit's closing note was that
nothing in this codebase would tell you which bottleneck you were approaching. A
tick quietly taking longer than its interval is the first symptom of most of them.

---

## 4. B3 / B9 — three missing indexes on hot paths

**Before:** `users.referred_by` had **no index**. Mining walks it twice per
hashrate calculation, and `/mining/state` computed the hashrate three times — six
sequential scans of the whole `users` table on the app's most-requested endpoint,
plus two per accrual. `task_completions.task_id` had no index either, and
`campaignSpend()` aggregates over it *inside* the advisory lock that serialises
crediting for a campaign, so every concurrent postback on a popular campaign
queued behind a table scan.

**After:**

```sql
CREATE INDEX idx_users_referred_by ON users(referred_by) WHERE referred_by IS NOT NULL;
CREATE INDEX idx_mining_sessions_user_started ON mining_sessions(user_id, started_at);
CREATE INDEX idx_completions_task_credited ON task_completions(task_id) WHERE status = 'credited';
```

**Verified used, not merely created.** `EXPLAIN` on the exact production queries
against a fresh database reports `idx_users_referred_by` for the referral walk and
`idx_completions_task_credited` for the campaign aggregate.

⚠️ `idx_mining_sessions_user_started` lives in `MINING_SCHEMA`, **not** in
`MIGRATIONS` with the other two, because `MIGRATIONS` runs first and
`mining_sessions` does not exist yet at that point. Putting it there fails
`initDb()` outright on a genuinely fresh database — the exact mistake that already
shipped once with `rigs.base_cost_usdt`. Caught here by booting a fresh database
rather than by reading the code, and both blocks now carry a note pointing at each
other.

---

## 5. B2 — `/mining/state` did the same expensive work three times

**Before, measured** (statements per call, real Postgres, a three-person downline):
`sessionState` **24**, plus the route's own third `hashrateOf` **8** = **32**.
Settings were read twice and the hashrate computed twice inside `sessionState`
alone.

**After, measured:** `sessionState` **15**, route total **15**. A **53% cut on the
app's hottest endpoint.** The saving grows with downline size, because what is no
longer repeated is the referral walk.

Settings are read once and threaded through; `accrue()` returns the hashrate it
already computed and `sessionState` reuses it; the breakdown rides back on
`SessionState` so the route does not recompute it.

⚠️ Reusing accrual's number is correct rather than convenient: accrual claims the
device and writes shares — it touches no rig, boost, streak or referral row, so
nothing between the two points can change a multiplier. When accrual had no time
owing it computed nothing, and only then is the hashrate computed here.

---

## 6. B4 — the accrual sweep, the one hard ceiling on the worker

**Before, measured:** 100,000 sessions → **998,601 sequential statements**, 361 s
(6.0 min) on loopback. The clock was never the problem: at a realistic per-query
round trip those statements alone are `998,601 × 0.7 ms ≈ 699 s ≈ 11.6 min`,
inside a 15-minute interval, with settlement queued behind it.

**After, measured on the same bench:**

| Miners | Statements before | Statements after | Wall before | Wall after |
|---:|---:|---:|---:|---:|
| 10,000 | 96,926 | **39,441** (−59%) | 32.3 s | **20.9 s** |
| 100,000 | 998,601 | **400,625** (−60%) | 361 s | **205 s (3.4 min)** |

Extrapolated to Railway's round trip: **~4.7 minutes of statement wait instead of
~11.6**, which puts it inside the window with real headroom rather than none.

Three changes, in order of size:

1. **`hashrateOfBatch()`** — the full hashrate, referral component included, for a
   whole chunk of sessions in a fixed number of queries instead of ~8 per session.
   The referral walk is re-expressed set-wise: active invitees grouped by
   referrer, one query per chunk per level.
2. **One settings read per sweep**, not one per session.
3. **The settled-epoch guard is skipped for the current epoch only**, because
   `settleEpoch()` refuses outright while `epoch >= epochOf()` — today cannot
   already be settled, by construction. Past epochs (the midnight-crossing case)
   are still checked against the database every time. This is a query per session
   removed, not a relaxation of the guard.

**Chunking is not tuning, it is a correctness requirement.** Postgres refuses a
statement with more than 65,535 bound parameters and these queries bind one per
user id, so a 100,000-miner sweep *cannot* be one query however well written.
`PARAM_CHUNK` is 2,000; the sweep additionally groups sessions in 500s so a
background tick does not hold one batch's intermediate maps for every user at once
in a process it shares with the request path.

⚠️ **The per-session WRITES are deliberately still per-session.** Each claims the
device for the day (a primary-key conflict is how one-device-one-account is
enforced) and each session is wrapped in its own try/catch, which is the property
that makes this loop safe to run unattended. Batching the reads is a pure win;
batching the writes would trade that isolation away for less than it costs.

### How this was made safe to change

`MINING_PLAN.md` M9.5 exists because two earlier bugs in these exact paths
silently destroyed user earnings. A batched rewrite that is 1% different from the
original underpays real people every fifteen minutes, forever, with nothing on any
screen to show it. So the two implementations are not compared by reading them —
`npm run test:miningbatch` **runs both against the same data and requires them to
agree**, on the hashrate *and* the breakdown, for a population built to make
disagreement possible: rigs at several levels, more boosts than the stack cap
allows, streaks above and below the cap, a two-level downline, invitees that must
not count (unverified, suspended, idle, stale), a referral **cycle**, and an input
list long enough to cross the internal chunk boundary.

⚠️ **That test immediately caught a real bug in the new batch code**, before it
went anywhere: `SELECT DISTINCT` is per **statement**, and the query runs once per
chunk, so an id appearing in two chunks contributed its invitees twice and its
referral component was **summed twice**. The arithmetic was right; the set
handling was not. The only visible symptom would have been some users quietly
mining faster than they should. Input is now deduplicated and invitees accumulate
into a `Set` per referrer.

Both `hashrateOf()` and `hashrateOfBatch()` now assemble their result through one
shared `hashrateFromParts()`, so the arithmetic and the breakdown cannot drift
apart later even if someone edits only one of them.

---

## Measured effect on capacity

Same rig, same k6 journeys, same commands as the audit's own run
(`audit/results/k6-stage-*.txt` before, `k6-after-stage-*.txt` after). Warm API in
both cases.

| Offered load | Req/s before → after | p95 before → after | Dropped before → after |
|---|---:|---:|---:|
| 30 screens/s | 144 → 141 | 25 ms → 28 ms | 0 → 0 |
| 60 screens/s | 287 → 289 | 38 ms → **22 ms** | 0 → 0 |
| **100 screens/s** | 426 → **475** | **7.06 s → 49 ms** | **219 → 0** |
| 110 screens/s | — → 517 | — → 142 ms | — → 0 |
| **125 screens/s** | — → **598** | — → **445 ms** | — → **0** |
| 150 screens/s | 407 → 588 | 22.1 s → 8.7 s | 1,727 → 595 |

**The knee moved from between 60 and 100 screens/s to between 125 and 150.** The
throughput ceiling moved from a flat ~430–470 req/s to ~600 req/s.

At **125 screens/s (598 req/s) all four of the audit's own provisional pass gates
pass** — p95 229 ms (gate 750 ms), p99 487 ms (gate 1.5 s), 0.00% failures, 0
dropped iterations — where the pre-fix build failed every one of them at 100
screens/s.

### What that means for the two stated targets

| Target | Needed | Before | After |
|---|---:|---|---|
| 10,000 active users (1 action / 20 s) | 500 req/s | **Fail** — ~430–470 ceiling, p95 past gate | **Passes on this rig** — 598 req/s within every gate |
| 100,000 active users | 5,000 req/s | Fail, order of magnitude | Still **fails** — one process, ~600 req/s |
| 100k accrual inside 15 min | — | No headroom (≈11.6 min of round trips) | **≈4.7 min** of round trips |

⚠️ **The same rig caveat still applies and it has not stopped being true**: one
Windows machine shared with the load generator, loopback Postgres (no per-query
network round trip), a stub chain RPC, one API process. These are floors of
confidence, not a Railway forecast. The honest claim is that **the fixes moved the
measured ceiling by ~40% and eliminated the collapse at the knee**, and that the
10k model now clears the gates *where it previously did not, on identical
hardware and an identical workload*.

### And the constraint is still not the database

Sampled through the 125-screens/s run: **1.1 of 20 connections busy on average,
peak 6, zero lock waits** (`results/pool-after-load.json`). Before the fixes it
was 0.8 of 10, peak 4, zero lock waits. The single Node process — CPU and event
loop — remains what binds first, which is why the next real step for 100k is a
second replica and taking the timers out of the API process, not more database
work. `REMEDIATION_PLAN.md` § P2 items 2 and 6 are that work.

---

## Not done, and why

- **A-01 email fail-open / OTP logging**, **A-03 revocable sessions**,
  **A-04 shared rate-limit store**, **A-05 database TLS**, **A-06 dependency
  upgrades.** Unchanged. Three of those five are infrastructure decisions rather
  than code (a Redis add-on, Railway TLS, a dependency-upgrade window with a full
  re-run); revocable sessions is a schema migration plus web changes and wants its
  own pass.
- **Splitting the staff pool** (B10) and **bounding the unbounded reads** (B12).
  Both still open; neither is a measured cliff at present data volume, and both
  are safe to do next.
- **Taking the timers out of the API process.** The guard makes overlap harmless;
  it does not make the tick free. That is `REMEDIATION_PLAN.md` § P2 item 2 and it
  is the single highest-leverage remaining change for 100k.
