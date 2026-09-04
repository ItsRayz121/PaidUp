# Findings register

Statuses distinguish observed behavior from architectural risk and missing evidence.
Line references are to commit `8bc95ac1a97780c7962694cd6ccbb3e920b93e83`.

⚠️ **FIXED SO FAR.** Each closed entry says so at its top; the description of the
defect is left as written, because a finding that quietly turns into a success
story is no longer evidence of anything.

| Round | Findings closed | Evidence |
|---|---|---|
| 2026-09-04 (first) | A-14 (one-time codes redeemable in parallel), A-07 (capacity - improved, not closed) | `FIXES_APPLIED.md` 1-7 |
| 2026-09-04 (second) | **A-01** (email fail-open / OTPs in logs), **A-03** (unrevocable tokens), **A-05** (unverified database TLS), **A-06** (dependency advisories - 0 remaining), **A-09** (unbounded list endpoints), and A-04 in part (the Fastify advisory) | `FIXES_APPLIED.md` 8-14 |

**Still open:** A-02 (email queue/retry - blocked on a provider key), A-04 in part
(replica-local rate limits - needs a shared store, i.e. a paid add-on), A-08,
A-10, A-11, A-12, A-13, and the remaining half of A-07 (a second replica plus the
timers out of the API process).

## High severity

### A-01 — Production email can fail open and expose OTPs in logs

**Status:** ✅ **FIXED 2026-09-04 (second round).** The console sink is now
development-only: in production, `sendLoginCode` with no `RESEND_API_KEY`
**throws** instead of printing the code and returning normally, so a route
returns a real error rather than a false success, and a one-time authentication
secret can no longer reach centralised logs. Boot prints a loud warning naming
exactly which flows are affected - a WARNING and not a fatal, deliberately,
because Telegram sign-in does not touch email and refusing to boot would take
down a working deployment over a feature that has its own fallback. See
`FIXES_APPLIED.md` section 8. The finding as originally written follows.
**Status (original):** Confirmed  
**Evidence:** `api/src/email.ts:22-26`, `api/src/server.ts:39-65`,
`api/src/server.ts:327-330`, `api/src/auth.ts:312-318`, and
`results/auth-resilience.txt`.

When `RESEND_API_KEY` is absent, `sendLoginCode` prints the recipient and plaintext code
and returns normally. Production startup does not reject that configuration, so signup can
report success while no email exists and centralized logs contain an authentication
secret. The audit probe confirmed both behaviors.

**Remediation:** Make the development sink explicit and impossible in production; redact
all codes; include email configuration in production fail-fast checks; add a regression
test that startup and send both fail closed.

### A-02 — Email verification has no burst control, durable retry, or delivery evidence

**Status:** Confirmed design gap; live behavior blocked  
**Evidence:** `api/src/email.ts:29-47` performs one synchronous fetch; no email queue,
retry/backoff, request timeout, stored provider message ID, idempotency key, or delivery
webhook was found. `api/src/auth.ts:63-79` stores a code and waits inside the request.

Resend documents a default team-wide API limit of five requests per second and returns 429
for a sixth request in the window. A signup burst can therefore become user-visible 502s.
API acceptance is also not inbox delivery, and the application records neither delivery
events nor queue age. See [Resend account limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits)
and [email send/idempotency documentation](https://resend.com/docs/api-reference/emails/send-email).

**Remediation:** Persist an email job before responding, rate-shape it below the verified
account quota, retry transient failures with jitter, use `Idempotency-Key`, set timeouts,
store provider IDs, consume delivery/bounce webhooks, and expose queue-age/failure metrics.

### A-03 — Password reset and logout do not revoke 30-day bearer tokens

**Status:** ✅ **FIXED 2026-09-04 (second round).** `users.session_epoch` is stamped into
every token as `se` and compared on every authenticated request
(`requireActiveUser`, and independently in `/auth/me`, which is what the web
client uses to decide a token is dead). Bumping it invalidates every token the
account has ever been issued; it is bumped on password reset - in the same
statement as the new password, so there is no window - on staff suspension, and
by the new `POST /auth/logout-all`. Regression: `npm run test:sessions`
(27 checks incl. the audit's exact walk, plus a structural tripwire). The fix was
reverted in place and the suite re-run against the old code to confirm it can
fail: it reproduced the audit's HTTP 200. **Known limit, stated rather than
hidden:** revocation is all-or-nothing per account, because nothing distinguishes
one device's token from another's - per-device revocation still needs the session
record this finding describes. See `FIXES_APPLIED.md` section 9.
**Status (original):** Confirmed  
**Evidence:** `api/src/auth.ts:110-123` signs stateless 30-day JWTs containing only `sub`;
`api/src/auth.ts:396-413` resets the password without changing session state;
`web/src/lib/api.ts:72-103` stores the token in local storage and logout only deletes it
client-side. The audit probe received HTTP 200 from `/auth/me` using a token minted before
the reset.

A stolen user or staff token remains usable after password reset, logout, and potentially
role/security changes until expiry.

**Remediation:** Add a session record or `token_version`/`session_epoch` checked on every
authenticated request. Rotate/revoke on reset, logout, account disablement, and sensitive
staff changes. Shorten access-token lifetime and use rotating, revocable refresh sessions.

### A-04 — Abuse controls are replica-local and depend on a vulnerable proxy path

**Status:** 🟡 **HALF FIXED 2026-09-04 (second round).** The dependency half is
closed: Fastify is on **5.12.3**, past the `GHSA-3m5p-2c4r-xxw2` patch boundary
of 5.12.1, and `npm audit --omit=dev` on the API now reports **0
vulnerabilities**. The architectural half is **open, and it is a spending
decision rather than a coding one**: a shared store means a Redis add-on, paid
for every month, to defend against an attack that only becomes possible once a
second replica exists - and this deployment runs one. Recorded so the trade-off
is explicit rather than forgotten. See `FIXES_APPLIED.md` section 11.
**Status (original):** Confirmed architecture and dependency exposure  
**Evidence:** `api/src/server.ts:80` trusts a hop count; `api/src/server.ts:101-107`
registers Fastify rate limiting without an external store. The installed `fastify@5.10.0`
falls in `GHSA-3m5p-2c4r-xxw2` (`>=5.8.3 <5.12.1`), which concerns
`X-Forwarded-*` spoofing with hop-count trust. `req.ip` is used by rate limiting, fraud
logic, audit logs, and postback IP pinning.

The default limiter is process memory: adding replicas multiplies a caller's effective
limit and restarts erase counters. Proxy spoofing could also corrupt security decisions.

**Remediation:** Upgrade Fastify to a patched release, validate the deployed proxy chain
with end-to-end tests, prefer an explicit trusted proxy function/CIDR where possible, and
move critical rate limits to a shared store with atomic increments.

### A-05 — Public Postgres TLS does not authenticate the server

**Status:** ✅ **CODE FIXED 2026-09-04 (second round); one operator step remains.**
`pgSslOptions` (`api/src/db.ts`) turns verification **on** whenever a CA is
supplied - `DATABASE_CA_CERT` (inline PEM) or `DATABASE_CA_CERT_PATH`, with
`DATABASE_TLS_SERVERNAME` for the hostname mismatch that caused this in the
first place: naming the right host is the proper fix, rather than giving up on
checking. Railway's private network needs none of it. With nothing configured
the API still connects - refusing to boot would take down a running deployment
over a change only the operator can make - but it now warns loudly on every boot
instead of being silent. See `FIXES_APPLIED.md` section 10.
**Status (original):** Confirmed  
**Evidence:** `api/src/db.ts:40-48` sets `ssl: { rejectUnauthorized: false }` for every
non-internal connection because of a hostname mismatch.

Traffic is encrypted but the server certificate is not verified, leaving public database
connections open to man-in-the-middle impersonation.

**Remediation:** Use Railway's private network in production or a public endpoint/certificate
chain whose hostname validates. Supply the correct CA and keep `rejectUnauthorized: true`.
Add a deployment smoke test that fails on certificate mismatch.

### A-06 — Production dependency scan reports high-severity advisories

**Status:** ✅ **FIXED 2026-09-04 (second round).** `npm audit --omit=dev` reports **0
vulnerabilities** on both projects (was 3 high in the API, 4 in the web). Fastify
5.10.0 -> **5.12.3** (which also carries patched `find-my-way` and `fast-uri`),
sharp 0.34.3 -> **0.35.4** (a major, smoke-tested against the exact resize/webp
pipeline `staffTasks.ts` uses), Next 16.2.10 -> **16.3.4** (past the 16.2.11
advisory boundary, carrying patched postcss/nanoid/sharp). Verified by re-running
the whole backend matrix and the web build, not by the scanner alone. See
`FIXES_APPLIED.md` section 11.
**Status (original):** Confirmed versions; exploitability varies  
**Evidence:** `results/api-npm-audit.json`, `results/web-npm-audit.json`, and package locks.

- API: 9 aggregate high findings, including `fastify@5.10.0`,
  `find-my-way@9.6.0`, `sharp@0.34.3`, and URI/schema serialization dependencies.
- Web: 4 aggregate high findings, including `next@16.2.10`, `sharp@0.34.5`,
  `postcss`, and `nanoid`. The Next advisories use a patched boundary of 16.2.11.

Some Next advisory paths (Server Actions, custom rewrites, middleware/proxy) were not
found in this application, and PostCSS/Nanoid are primarily build-time paths. Conversely,
Fastify's trust-proxy advisory is directly relevant, and API Sharp parses staff-uploaded
task logos. Treat the scan as an upgrade requirement, not proof that every advisory is
remotely exploitable.

**Remediation:** Upgrade direct frameworks first, refresh lockfiles, rerun production
audits, then run targeted regression tests for proxy IPs, primitive schemas, routing,
image uploads, caching, and image optimization.

### A-07 — Neither the 10k nor the 100k active-user model is reachable as built

**Status:** ⚠️ **PARTLY FIXED 2026-09-04** — was: Confirmed, measured. On the same
rig the ceiling moved from a flat ~430–470 req/s to ~600 req/s, the knee moved
from between 60 and 100 screen-loads/second to between 125 and 150, and the
collapse at the knee is gone (100 screens/s: p95 7.06 s and 219 dropped → 49 ms
and none). **The 10,000-user model now clears all four provisional gates; the
100,000-user model still does not** — that needs a second replica and the timers
out of the API process, because the binding constraint was never the database.
Mining accrual at 100k went from 998,601 statements to 400,625. See
`FIXES_APPLIED.md`. The measurement as originally taken follows.  
**Evidence:** `api/src/db.ts:44-48` fixes the pool at ten connections per replica;
`api/src/routes/app.ts:385-457` makes several SQL operations for one balance read;
`api/src/mining/engine.ts:506-519` loads all active sessions and processes them
sequentially; `api/src/server.ts:187-311` runs multiple timers in every API process.

**Now measured** (`LOAD_TEST_PLAN_AND_VERDICTS.md`; raw output in `results/k6-stage-*.txt`,
`results/mining-scale-bench.txt`, `results/pool-during-load.json`):

| Target | Needed | Measured | Verdict |
|---|---:|---:|---|
| 10,000 active (1 action / 20 s) | 500 req/s | **~430–470 req/s ceiling**, p95 already past gate | **Fail** |
| 100,000 active | 5,000 req/s | same ceiling, single replica | **Fail, by an order of magnitude** |
| 100k accrual inside 15 min | — | 361 s on loopback in **998,601 sequential statements** (~11.6 min of network wait alone at a realistic RTT) | **No headroom** |
| 100k epoch settlement | — | **17.2 s**, 1,594 statements | **Pass** — better than predicted |

Two corrections to the pre-measurement analysis, both material: the connection pool was
**not** the first constraint (0.8 of 10 connections busy on average at the knee, zero lock
waits), so the single Node process binds first; and settlement is already effectively
batched, so the worker problem is accrual alone. Past the knee the system **queues instead
of shedding** — p95 38 ms → 22 s with throughput flat — which is the
missing-`connectionTimeoutMillis` behavior, and 20% of requests at the top stage failed as
TCP `dial` errors rather than HTTP 5xx.

⚠️ The rig was one machine shared with the load generator, loopback Postgres and a stub
RPC. That flatters the read path (no per-query network round trip) and starves it (shared
CPU) at the same time, so treat the ceiling as a floor of confidence, not a forecast.

**Remediation:** see `REMEDIATION_PLAN.md` § P2, which is now ordered by what the
measurement showed: cut the accrual statement count first, isolate and guard the timers
second, reduce `/mining/state`'s ~47 queries third, add pool timeouts for correct overload
behavior fourth, then add the missing indexes and re-measure on production-shaped
infrastructure.

### A-14 — A one-time email code can be redeemed several times at once

**Status:** ✅ **FIXED 2026-09-04** — was: Confirmed, exercised on real PostgreSQL.
After the fix, 12 simultaneous confirmations of one code accept **exactly one**,
and a burst of wrong guesses can no longer walk past the five-attempt cap. The fix
was reverted in place and the new suite re-run against the old code to prove the
test can actually fail (3 of 12 accepted, attempts reached 12 against a cap of 5).
Regression: `npm run test:otprace` — 22 checks on PGlite, 28 on real Postgres,
plus a structural tripwire, since PGlite cannot express the race. See
`FIXES_APPLIED.md` § 1. The finding as originally written follows.  
**Evidence:** `audit/results/race-tests.txt` (test 1). Twelve simultaneous
`POST /auth/verify-email` calls carrying **one** valid code were **all** hash-matched and
**four were accepted (HTTP 200)**. Expected: exactly one.

`consumeCode` (`api/src/auth.ts:86-107`) is a read-check-blind-write with no transaction,
no row lock, and no conditional predicate on the write:

```ts
// auth.ts:89-92 — read
"SELECT * FROM email_codes WHERE email = ? AND purpose = ? AND consumed = 0 ORDER BY created_at DESC LIMIT 1"
// ... hash compare ...
// auth.ts:106 — blind write, does not re-test consumed = 0
"UPDATE email_codes SET consumed = 1 WHERE id = ?"
```

Every concurrent caller reads the same `consumed = 0` row, every one matches the hash, and
every one writes `consumed = 1` over the top of the others. `email_codes` has only a
non-unique index on `email` (`db.ts:188`), so nothing in the schema serializes it either.

**Two distinct consequences:**

1. **Single-use is not enforced.** All four `consumeCode` purposes are affected —
   `verify` (`auth.ts:327`), `reset` (`auth.ts:403`), `link` (`auth.ts:608`) and
   **`withdraw`** (`routes/withdrawals.ts:159,621`). The withdrawal case is the
   money-adjacent one: the step-up code is consumed in the request path, *outside* the
   per-user advisory lock that guards the debit, so one emailed code can satisfy several
   concurrent withdrawal requests. The balance itself is still safe — the withdrawal
   double-spend test **passed** — but the step-up control was added specifically as the
   compensating control against structuring several requests under the threshold
   (`routes/withdrawals.ts:140-145`), and parallelism reduces it to one code per burst.
2. **The five-attempt cap is bypassable by parallelism.** `row.attempts >= config.otpMaxAttempts`
   (`auth.ts:98`, cap `5` at `config.ts:58`) is evaluated against a value read before the
   increment, so N simultaneous wrong guesses each see `attempts = 0`. The only real
   remaining brute-force bound is the per-IP limiter (`30 / 10 minutes`, `auth.ts:322`).

**Remediation:** make consumption the atomic act, not a follow-up write.

```sql
UPDATE email_codes SET consumed = 1
 WHERE id = ? AND consumed = 0
 RETURNING pending_password_hash
```

Zero rows returned means another request already spent it — return the existing
"No code found" error. This is one statement, needs no transaction and no lock, and
changes no behavior for a single well-behaved client. For the attempts cap, increment and
re-read in one statement (`UPDATE ... SET attempts = attempts + 1 ... RETURNING attempts`)
and reject on the returned value.

**Why the earlier pass could not see this:** the project's own suites run on PGlite, which
has a single connection and therefore serializes exactly the interleaving that breaks
here. This was previously carried as a suspicion in `BLOCKED_AND_UNVERIFIED.md`; the
disposable-Postgres run it asked for is what confirmed it.

## Medium severity

### A-08 — Postback logs retain unredacted request input and IP addresses

**Status:** Confirmed  
**Evidence:** `api/src/routes/webhooks.ts:16-29` stores
`JSON.stringify({ ...input, _ip: req.ip })` in `postback_log`; no purge/retention routine
was found.

Provider secrets/signatures, external identifiers, arbitrary query fields, and IPs can be
retained indefinitely. This increases incident and privacy impact.

**Remediation:** Allowlist operational fields, hash or redact credentials, set a documented
retention period, add a purge job, and restrict staff/database access.

### A-09 — Legacy history endpoints return unbounded collections

**Status:** ✅ **BOUNDED 2026-09-04 (second round)** - capped, not paginated.
`/wallet/ledger` and `/wallet/usdt-task-rewards` cap at 500 rows,
`/support/tickets` at 50 tickets and 200 messages (newest kept, then re-ordered
ascending so a thread still reads correctly). Every cap is far above what any
screen renders, so this is invisible in the product and bounded in the process.
The support one mattered most: each message carries a base64 data URL of up to
2MB, so the unbounded version was "every screenshot this user ever sent, in one
JSON body". Cursor pagination and object storage - the fuller remedy below - are
unbuilt. See `FIXES_APPLIED.md` section 12.
**Status (original):** Confirmed  
**Evidence:** `api/src/routes/app.ts:463-481` (`/wallet/ledger`), `:484+`
(`/wallet/usdt-task-rewards`), and `:877-909` (`/support/tickets`) have no pagination.
The support response can include all messages and data-URL images; uploads can be large.

Long-lived accounts can create large SQL results, API allocations, and response bodies.

**Remediation:** Add cursor pagination and hard limits, move images to object storage with
authorized short-lived URLs, and retire the legacy support route after client migration.

### A-10 — Health checks and operational alerting do not show service readiness

**Status:** Confirmed repository gap; provider dashboards blocked  
**Evidence:** `api/src/server.ts:131` always returns a static healthy response. No
OpenTelemetry/Prometheus/Sentry integration was found. `api/src/alerts.ts:20-34` sends a
single best-effort Telegram request; a failure only logs a warning.

Database loss, stuck worker loops, provider throttling, email backlog, and reconciliation
lag can coexist with a green health check. Telegram documents roughly 30 messages/second
for free bulk broadcasts and 429 behavior beyond limits; there is no durable retry here.
See [Telegram Bot FAQ](https://core.telegram.org/bots/faq).

**Remediation:** Separate liveness/readiness, track last-success and duration for each job,
measure queue/backlog age, expose DB/pool/provider checks, and route alerts through a
durable retry path with deduplication.

### A-11 — Web security headers are not defined in the application configuration

**Status:** Confirmed in repository; edge configuration unverified  
**Evidence:** `web/next.config.ts:4-14` defines only service-worker cache headers. There is
no application-level CSP, HSTS, `X-Content-Type-Options`, Referrer-Policy, or
Permissions-Policy. Bearer tokens are stored in local storage (`web/src/lib/api.ts:72-103`).

This does not prove the Vercel edge sends no headers, but the repository cannot guarantee
them. Any XSS has greater impact because it can read the bearer token.

**Remediation:** Establish and test a CSP, HSTS at the HTTPS edge, nosniff, a strict
referrer policy, and a minimal permissions policy. Prefer HttpOnly/Secure/SameSite session
cookies or otherwise materially reduce local-storage token exposure.

### A-12 — Privacy, deletion, and retention controls are incomplete

**Status:** Confirmed documentation/product gap  
**Evidence:** `docs/LAUNCH_CHECKLIST.md:60-65` explicitly notes a missing privacy policy.
No user-facing privacy/terms route, account deletion flow, or documented retention/purge
policy was found for KYC images, postbacks, device/IP/fraud data, support images, or auth
records.

**Remediation:** Obtain jurisdiction-specific review, publish accurate terms/privacy
notices, define purpose and retention per data class, add export/deletion workflows with
financial/legal hold exceptions, and test access controls and purge jobs.

## Low severity

### A-13 — Registration reveals whether an email already has an account

**Status:** Confirmed  
**Evidence:** `api/src/auth.ts:271-276` returns a distinct 409 for an existing account.
Login and forgot-password responses are more generic.

**Remediation:** If account privacy matters, use the same outward response/timing for new
and existing addresses while sending the appropriate private email.

## Concurrency note — now resolved by execution

The suspicion previously recorded here (`consumeCode` performing a read/check/update rather
than an atomic conditional update) was **tested on disposable PostgreSQL on 2026-09-04 and
failed**. It is promoted to **A-14** above.

The other two money races carried alongside it were tested in the same run and **passed**:

| Race | Result | Evidence |
|---|---|---|
| Mining claim double-credit — 12 parallel claims of one parked reward | **PASS** — exactly one success, 5,000,000 micro credited once, no orphaned `mining_unclaimed` row | `results/race-tests.txt` |
| Withdrawal double-spend — 10 parallel requests for the whole balance | **PASS** — one accepted, balance never negative | `results/race-tests.txt` |

Those two are the paths guardrail #8 covers, and the per-user
`pg_advisory_xact_lock(hashtext(userId))` did its job under genuine multi-connection
concurrency. `consumeCode` is the path that has no such lock.
