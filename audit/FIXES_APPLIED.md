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

## Not done in the FIRST round, and why

> Superseded by the second round below, which closed four of these five and half
> of the fifth. Left as written so the sequence is legible.

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

---
---

# Second round — 2026-09-04

Cost and memory ceilings first (the founder's own ordering: *"make sure nothing
can cause excessive Railway or blockchain API cost — control that first"*), then
four of the five remaining High findings.

Verified: **41 backend suites, all green, each from a genuinely fresh PGlite
store**; api + web typecheck; eslint 0 errors; web production build (38 routes);
`npm audit --omit=dev` reports **0 vulnerabilities on both projects** (was 3 high
in the API, 4 in the web).

## 8. A-01 — production email failed open and printed OTPs to the logs

`sendLoginCode` printed the recipient and the plaintext code to stdout and then
**returned normally**, in every environment. Two separate problems from one line:
a one-time authentication secret went into centralised logs, where it outlives
the ten-minute code and is readable by anyone with log access; and signup
**reported success while no email existed anywhere**.

- The console sink is now development-only, gated on `NODE_ENV`.
- Production with no `RESEND_API_KEY` **throws**. `issueCode` already documented
  that it throws when email cannot be sent, and `/auth/register` already turns
  that into a 502 with a readable message.
- Boot warns loudly, naming the four flows affected (signup verification,
  password reset, email linking, withdrawal step-up).

**Why a warning and not a fatal**, which is what the finding asked for: Telegram
sign-in does not touch email, so refusing to boot would take down a working
deployment over a feature that has its own fallback. And this is not a behaviour
regression dressed up as a fix — with no key, nobody could ever receive a code,
so every email flow was already broken. It just said otherwise.

| | before | after |
|---|---|---|
| production, no provider | logs the code, returns 200 | throws; the route returns an error |
| development | logs the code | unchanged — that is the point of it |

## 9. A-03 — a password reset did not end the sessions

The audit signed a token, reset the password, and got **HTTP 200** from
`/auth/me` with the old one. So the single action a worried user can take on
their own did not take their account back: a stolen 30-day token kept working for
up to a month.

`users.session_epoch` is stamped into every token as `se` and compared on every
authenticated request. Bumping the column invalidates every token that account
has ever been issued.

- Compared in `requireActiveUser` — which already read the user row, so the check
  costs no extra query — **and independently in `/auth/me`**, because that is the
  endpoint the web client uses to decide a token is really dead. If the two
  disagreed, the user would sit in an app where nothing worked and nothing signed
  them out.
- The `req` argument is **required, not optional**. An optional one lets a new
  route silently skip the check; the compiler is the only thing that can
  guarantee coverage.
- Bumped on **password reset** (in the same statement as the new password, so
  there is no window), on **staff suspension**, and by the new
  `POST /auth/logout-all` — surfaced as "Sign out everywhere" on `/profile`,
  deliberately a separate row from the ordinary sign-out.
- **Deploying it signs nobody out.** Tokens in the wild carry no `se` claim, read
  as 0, and the column defaults to 0. The rest of the repository's suites mint
  exactly that shape of token, which is why 40 other suites needed no change.

**Known limit, stated rather than hidden:** revocation is all-or-nothing per
account. Nothing distinguishes one device's token from another's, so per-device
sign-out still needs the session record the finding describes. That is why the
ordinary sign-out button was *not* wired to this.

Regression: `npm run test:sessions` — 27 checks including the audit's exact walk,
plus a structural tripwire over `auth.ts`'s own source. **The fix was reverted in
place and the suite re-run against the old code**: it reproduced the audit's
HTTP 200. A regression test nobody has watched fail is not evidence.

## 10. A-05 — TLS to Postgres authenticated nothing

`rejectUnauthorized: false` on every public connection, because the proxy
presents a certificate for a different host. Encrypted against everyone except
whoever is actually in the middle — and this database holds balances, payout
addresses and password hashes.

`pgSslOptions` now turns verification **on** whenever a CA is supplied:
`DATABASE_CA_CERT` (inline PEM) or `DATABASE_CA_CERT_PATH`, plus
`DATABASE_TLS_SERVERNAME` for the hostname mismatch that caused this in the first
place — naming the right host is the proper fix, rather than giving up on
checking. Railway's private network needs none of it.

With nothing configured the API still connects, because refusing to boot would
take down a running deployment over a change only the operator can make — but it
now warns on every boot instead of being silent. **Code-complete, waiting on one
operator step.**

## 11. A-06 — dependency advisories, and the regression the upgrade caused

| | before | after |
|---|---|---|
| API `npm audit --omit=dev` | 3 high | **0** |
| web `npm audit --omit=dev` | 4 high | **0** |
| fastify | 5.10.0 | 5.12.3 |
| sharp (API) | 0.34.3 | 0.35.4 |
| next | 16.2.10 | 16.3.4 |

sharp 0.35 is a major; it was smoke-tested against the exact
`rotate -> resize(256) -> webp` pipeline `staffTasks.ts` uses, not just installed.
Fastify 5.12.3 clears `GHSA-3m5p-2c4r-xxw2`, which is **half of A-04**.

### The upgrade silently broke `req.ip`, and one suite caught it

The advisory's own fix was to neuter numeric `trustProxy`. This app had used a
hop count (`TRUST_PROXY_HOPS=1`) since it was written, and on 5.12.3 a hop count
**stops resolving `X-Forwarded-For` at all** — `req.ip` becomes the socket peer,
i.e. the edge proxy's address, identical for every request. Nothing throws.

That is not a cosmetic field. `req.ip` feeds the per-IP rate limits, the IP fraud
rules (`ip_reuse`, referral-ring-by-IP), the audit log and the postback IP pin.
Per-IP limiting would have collapsed into one global bucket — the login limiter
becoming a self-inflicted lockout for the whole user base — and every IP fraud
rule would have compared everyone to everyone. The symptom is indistinguishable
from "lots of users behind one NAT", which is genuinely common in our markets, so
it would not have been spotted by looking at the data.

`npm run test:proxy` is the only thing that noticed. **That is the argument for
keeping small suites which assert an infrastructure property rather than a
feature.**

The replacement is what A-04's own remediation asked for: name the trusted
NETWORKS instead of counting hops. `TRUST_PROXY` defaults to
`loopback, linklocal, uniquelocal, 100.64.0.0/10` — the last because
carrier-grade NAT space is not in `uniquelocal` and several hosts use it
internally. `proxy-addr` walks `X-Forwarded-For` from the right, skipping trusted
addresses, so a client prepending a forged entry still loses: the value the real
edge appended sits to its right. Tested, including that `trustProxy: true` *would*
have been forgeable, and that a numeric hop count is now dead.

A misconfigured list is silent too, so `server.ts` logs a warning (at most once
per ten minutes) when an `X-Forwarded-For` arrives and `req.ip` still equals the
socket peer — the unambiguous tell that the trust list does not cover the edge in
front of this API. `npm run test:proxy` went from 5 checks to **11**.

## 12. A-09 — three endpoints returned unbounded collections

`/wallet/ledger` and `/wallet/usdt-task-rewards` cap at 500 rows;
`/support/tickets` at 50 tickets and 200 messages (newest kept, then re-ordered
ascending so a thread still reads correctly). Every cap is far above what any
screen renders — each shows a preview and a "see more" list — so this is
invisible in the product and bounded in the process.

The support one mattered most: every message carries `image`, a base64 data URL
of up to 2MB, so the unbounded response was "every screenshot this user has ever
sent, in one JSON body, held in memory". The earner app no longer calls it at all
(`/support/chat` with its `?since=` delta replaced it) — and a route nobody calls
is exactly the one nobody notices going wrong.

Cursor pagination and object storage, the fuller remedy, are still unbuilt.

## 13. Cost ceilings on every paid external call — `api/src/costGuard.ts`

Not an audit finding. The founder's first instruction this round, and it comes
from history rather than theory: this project has shipped **two real billing
incidents**, both the same shape — a loop polled a paid provider at a rate set by
code rather than by demand, and it was found by looking at a bill (CLAUDE.md,
2026-08-13 and 2026-08-27). Each was fixed at its own call site, which is the
right fix and is also the fix that only ever arrives afterwards.

So `costGuard.ts` is the other kind of control: **one ceiling that holds when a
specific safeguard turns out to have a gap** — the same reasoning already written
down for `autoWithdrawMaxPoints` and `autoRefundMaxMicro`. It cannot know which
loop went wrong. It guarantees that whatever goes wrong stops costing money at a
known, configured number.

**Two tiers, and the split is load-bearing.** A budget that refuses everything at
once turns a cost problem into a money-paths-down problem: the relay could not
confirm a broadcast it had already made, and a withdrawal gate that cannot read a
gas balance fails closed on a user who has done nothing wrong. So low priority
(scanners, screen reads, the hourly reconciliation) is cut off at 80% of the
limit, and the remainder is reserved for calls that are part of moving someone's
money right now. `payoutRelay`, `bnbWithdraw` and the deposit-credit reorg
re-check are tagged `high`; everything else defaults to `low`.

**Per replica, and it says so.** Same honesty as the rate limiter: the counter
lives in the process, so N replicas means N budgets. That is still a ceiling, and
it needs no Redis to hold.

Defaults: `RPC_MAX_CALLS_PER_HOUR=5000` against a steady state of roughly 80-100,
so it never shapes normal traffic; `EXPLORER_MAX_CALLS_PER_DAY=20000` on a *day*
window, matching the shape of the free-tier allowance it actually runs out
against. `0` disables a ceiling entirely, deliberately.

Live usage — used, ceiling, and how many calls were refused — is served by
`GET /staff/mining/rpc`, which is the screen an operator already opens to ask
what this is costing. Regression: `npm run test:costguard`, 7 checks, including
that the window really rolls (a counter that only went up would refuse everything
forever after one bad hour, which is an outage with extra steps).

## 14. The one paid call that scaled with the user base

Everything else in this system polls on a fixed tick, so its cost is flat no
matter how well the product does. **One call did not.** `GET /wallet/balance`
made a live `eth_getBalance` for the user's gas wallet — and that endpoint is
loaded by home, `/mine`, `/wallet` and `/wallet/usdt`.

None of those four screens render the result. Only the two withdraw screens do.
So an on-chain call was the price of opening the app, growing linearly with
daily active users — precisely the shape of both previous billing incidents.

The gas read is now opt-in (`?gas=1`), and `fetchBalanceWithGas` is used only by
the two screens that show it. Everyone else gets `null`, which those screens
already treat as "not checked".

⚠️ One trap worth recording: `relayReady` was doing double duty in that handler —
it also decides whether the gas SURCHARGE applies. Gating both on the new flag
would have made every screen that skipped the read start previewing a fee this
deployment does not charge. The two questions are now separate variables.

Alongside it, three unbounded in-process caches were bounded, because Railway
bills memory and each was keyed by user:

| cache | was | now |
|---|---|---|
| `payoutRelay` gas balances | one entry per user, forever | expiry sweep + 5,000-entry cap; TTL 20s -> `GAS_BALANCE_CACHE_MS` (60s) |
| `bscscan` address history | one entry per user, up to 25 rows each, forever | expiry sweep + 2,000-entry cap |
| `bscscan` treasury ledger | same | same |

And two intervals became env-tunable so they can be slowed without a deploy:
`RECONCILE_INTERVAL_MS` (its cost is one multicall per 300 deposit addresses, so
it grows with the user base too) and the existing `DEPOSIT_SCAN_INTERVAL_MS`.
The hourly reconciliation now also charges its whole estimated tick against the
budget before spending anything — those calls go out through viem's transport
rather than `rpc.ts`, so they were invisible to the per-call charge.

## Still open after this round

- **A-02** — email queue, retry, idempotency and delivery evidence. Blocked on a
  provider key: there is nothing to queue against yet.
- **A-04, second half** — a shared rate-limit store. **A spending decision, not a
  coding one:** a Redis add-on costs money every month to defend against an
  attack that only becomes possible once a second replica exists, and this
  deployment runs one.
- **A-08** (postback log retention), **A-10** (readiness/observability),
  **A-11** (web security headers), **A-12** (privacy/retention/deletion),
  **A-13** (registration reveals an existing account).
- **A-07, remaining half** — the 100,000-user model still needs a second replica
  and the timers out of the API process. The binding constraint was never the
  database.
- **B10** — splitting the staff database pool.

## 15. What `security-review` found in fix 9, before it shipped

The session-revocation change was reviewed against the running codebase and
**had a hole in exactly the place that mattered most.** Recorded in full because
the shape of the mistake is more useful than the patch.

Four routes in `auth.ts` called `getUserId()` and never `requireActiveUser()` —
`/auth/telegram/link`, `/auth/telegram/link-code`, `/auth/email/link-start`,
`/auth/email/link-confirm`. Every other authenticated surface in the app had
been updated, because the compiler forced it: those call sites pass through the
shared guards. These four hand-roll their own `try { getUserId(req) } catch`,
so nothing made them opt in.

They are also the four routes that **attach a new credential to an existing
account.** So the bypass was not "some endpoints skip a check" — it was a
complete defeat of the feature:

- Hold a stolen token. The victim resets their password or taps "Sign out
  everywhere"; the token now 401s everywhere that matters.
- POST it to `/auth/telegram/link-code`, which never looked at the epoch. Get a
  one-time binding code, open it in **your own** Telegram, and the bind
  succeeds — returning a fresh token carrying the **new** epoch. Every future
  mini-app login now mints a valid session. No later revocation can dislodge it.
- On a Telegram-only account, `/auth/email/link-start` + `link-confirm` is the
  same walk with an email and password the attacker controls.

Fixed by calling `requireActiveUser(userId, req)` on all four. That also closes
a pre-existing gap the finding surfaced in passing: a **suspended** account
could link credentials, which was already untrue of every other earner route.

Second, `/auth/email/link-confirm` writes a `password_hash` and did **not** bump
the epoch. Any route that changes what someone can log in with has to end the
sessions that existed under the old credentials, exactly as `/auth/reset` does;
it now bumps in the same statement — **and returns a replacement token**, or the
user would sign themselves out by the act of adding their own email
(`ConnectEmailCard` stores it).

### The test that would have caught it is structural, and it had to be

Request-level checks were added for all four routes, and **all four passed even
with a guard deliberately removed** — the two Telegram routes answer 503 before
they authenticate when no bot token is configured, which is the case in this
suite, so "did not succeed" is all a request can prove there.

So the tripwire reads `auth.ts`'s own source and asserts that **every**
`getUserId(req)` is followed by the revocation check, with `/auth/me` the single
deliberate exception (it must serve a suspended user their own account so the app
can explain why, and repeats the epoch comparison inline instead). Comment lines
are stripped before scanning, or the answer would depend on how much explanation
sits between the two statements. Verified by removing one guard: the four
behavioural checks stayed green and the tripwire failed, naming the line.

`npm run test:sessions` is **38 checks**.
