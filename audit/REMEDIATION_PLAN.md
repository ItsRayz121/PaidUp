# Prioritized remediation plan

No remediation was applied during the audit phase. The founder then authorised
fixes on 2026-09-04.

✅ **Done, with before/after measurements in `FIXES_APPLIED.md`:** P0 item 0
(A-14 atomic code consumption), and P2 items 1–6 in substance — the accrual
statement count, a re-entrancy guard on every timer plus non-blocking global locks,
`/mining/state`'s triple work, pool timeouts, and the missing indexes. The timers
still run **inside** the API process (P2 item 2's other half) and the profile has
not been re-run on production-shaped infrastructure (P2 item 6).

⏳ **Still open, unchanged:** P0 items 1–5 (email fail-closed, revocable sessions,
dependency upgrades, database TLS, shared rate limits) and all of P1. Three of
those five P0s are infrastructure decisions rather than code.

## P0 — Release blockers

0. **Make one-time code consumption atomic** (`FINDINGS.md` A-14 — found by an
   *executed* concurrency test on real PostgreSQL, not by inspection). Replace the
   read-check-blind-write in `consumeCode` (`api/src/auth.ts:86-107`) with a single
   conditional `UPDATE ... WHERE id = ? AND consumed = 0 RETURNING pending_password_hash`,
   and take the attempts count from `UPDATE ... SET attempts = attempts + 1 ... RETURNING
   attempts` instead of the value read beforehand. One statement each, no lock, no
   behavior change for a single client. **Do this first: it is the cheapest item on the
   list and it is the one with a reproducing test already written**
   (`.work/load/race-tests.mjs`). Owner: backend. Estimate: under an hour, plus the
   regression test on real Postgres. ⚠️ The regression test cannot live in the existing
   PGlite suites — single-connection PGlite serializes the very interleaving it must
   provoke.
1. **Email fail-closed and secret hygiene** — Require a valid Resend key/from-domain in
   production, remove OTP logging, add an explicit dev mail sink, and add startup/send
   regression tests. Owner: backend. Estimate: 1 day.
2. **Revocable sessions** — Introduce a session table or user session epoch; revoke on
   reset/logout/disablement/role changes; shorten access-token life and rotate refresh
   sessions. Owner: backend + web. Estimate: 3–5 days plus migration.
3. **Framework/security upgrades** — Upgrade Next, Fastify, Sharp and lockfiles to patched
   releases, then run the entire suite and targeted advisory-path tests. Owner: platform.
   Estimate: 1–3 days depending on compatibility.
4. **Authenticated database TLS** — Move production traffic to Railway private networking
   or configure a valid CA/hostname. Add a TLS smoke test. Owner: platform. Estimate: 1 day.
5. **Shared rate limits and proxy correctness** — Add an external atomic store, document
   trusted hops/CIDRs, and test spoofed forwarding headers through the real edge. Owner:
   platform/backend. Estimate: 2–3 days.

## P1 — Reliability and operability before growth

1. **Durable email delivery** — Queue, retry/backoff/jitter, idempotency keys, provider IDs,
   delivery/bounce webhooks, quota shaping, and queue-age alerts.
2. **Worker isolation** — Run one scheduler separately from API replicas; use leased jobs,
   durable checkpoints, bounded batches and explicit retry/dead-letter states.
3. **Observability** — Readiness checks, structured error tracking, traces/metrics, DB pool
   wait, lock wait, event-loop lag, worker last-success/lag, provider 429/5xx, and money
   reconciliation alerts.
4. **Bound large reads** — Cursor-paginate ledger/reward/support history and externalize
   support images.
5. **Data governance** — Privacy/terms, data inventory, retention schedule, purge jobs,
   access audit, account export/deletion, and KYC-specific review.
6. **Web hardening** — Enforce/test CSP and baseline headers; reduce bearer-token exposure.

## P2 — Capacity work, now that it is measured

The staged plan in this section was **executed on 2026-09-04**; see
`LOAD_TEST_PLAN_AND_VERDICTS.md` for the rig, the numbers and the caveats. What follows
replaces "go and measure it" with "here is what the measurement says to fix", in leverage
order. `CAPACITY_BOTTLENECKS.md` carries the file-and-line detail for each item.

1. **Cut the statement count in the mining accrual sweep** (`mining/engine.ts:506-519`).
   Measured: 998,601 sequential statements for 100k sessions — 6 min on loopback, and
   roughly 11.6 min of pure network wait at Railway's per-query round trip, inside a
   15-minute interval that settlement queues behind. This is the one confirmed hard
   ceiling on the worker side. **Settlement does not need the same work** — measured at
   17.2 s for 100k, already effectively batched.
2. **Give the five timers their own process and a re-entrancy guard** (`server.ts:243-313`).
   Two identical load runs differed 4× in p95 with no configuration change, which is what
   an unguarded tick landing inside one run looks like. This also stops a slow subsystem
   from expressing itself as an unavailable API.
3. **Reduce per-request work on `/mining/state`** (`routes/mining.ts:219-245`) — ~47 queries
   and three separate `hashrateOf` computations per call. With the pool measured idle at
   the knee, **this and CPU are what bind first**, not the database.
4. **Add `connectionTimeoutMillis` and `statement_timeout`** (`db.ts:44-47`). The pool was
   *not* saturated at the knee, so raising `max` is not the urgent part — but the measured
   behavior past the knee was queueing, not shedding (38 ms → 22 s with flat throughput),
   and that is precisely the missing-timeout signature. Fix for correct overload behavior,
   not for headroom.
5. **Add the four missing indexes** (`db.ts` `MIGRATIONS`), then **re-measure**. They were
   deliberately absent from the run above so it measured the code as it ships; their real
   value is therefore still unquantified.
6. **Then re-run the same staged profile on production-shaped infrastructure** — real
   per-query network RTT, a real RPC provider with its quota, and a generator that is not
   competing with the API for CPU. Loopback flatters the read path and punishes nothing;
   a real network punishes exactly the statement counts item 1 is about.
7. Add burst, soak, API-restart, worker-overlap, provider-429 and Postgres-failover tests,
   which the executed pass did not cover.
8. Publish hardware/replica/database sizes, dataset, duration, p50/p95/p99, errors,
   saturation, worker lag and cost with any capacity claim. The 2026-09-04 numbers are a
   floor of confidence on one machine, not a production forecast.

## Verification required for closure

- Run every existing suite plus `tests/auth-resilience.e2e.ts` against disposable real
  PostgreSQL. ✅ **Done 2026-09-04** for the three money/auth races
  (`results/race-tests.txt`) — one failed, and is now A-14. The remaining suites still run
  on PGlite.
- Verify reset/logout revocation from two clients and all staff roles.
- Burst email jobs through a test Resend account and prove 429 recovery and delivery-event
  reconciliation.
- Test proxy IP resolution at the deployed edge with multiple header chains.
- Prove TLS rejection using an invalid CA/hostname.
- Restore a backup into a clean service and reconcile representative money records.
