# Executive audit report

Audit dates: 2026-09-03 (static pass) · **2026-09-04 (capacity + real-Postgres concurrency pass)**  
Repository commit: `8bc95ac1a97780c7962694cd6ccbb3e920b93e83` (`main`)

## Fixes applied after this report

The founder authorised fixes on 2026-09-04. Six items were implemented, measured
before and after, and are documented in **`FIXES_APPLIED.md`**: the A-14 code-reuse
defect (closed), pool timeouts and load shedding, a re-entrancy guard on all five
background timers plus two blocking global locks made non-blocking, three missing
hot-path indexes, `/mining/state`'s triple work (32 → 15 statements), and the
mining accrual sweep (998,601 → 400,625 statements at 100k).

On the same rig the read-path ceiling moved from ~430–470 to ~600 req/s, the knee
moved from between 60 and 100 screen-loads/second to between 125 and 150, and the
collapse at the knee is gone. **The 10,000-active-user model now clears all four
provisional gates; the 100,000 model still does not.** Regression state: 38 suites,
**1,497 checks, 0 failures**, every e2e suite from a fresh database.

The other High findings — email fail-open, revocable sessions, shared rate limits,
database TLS, dependency upgrades — are **unchanged**, and the release gates below
still stand for them.

## Verdict

RoziPay has unusually broad local regression coverage for its size, particularly around
ledger integrity, role authorization, withdrawals, deposits, disbursements, mining, KYC,
and webhook replay handling. The isolated API run completed **36 scripts, 1,463
assertions, and zero failures**. TypeScript, ESLint, and the production Next.js build also
passed.

It should nevertheless **not yet be represented as production-hardened**. The principal
blockers are authentication/session revocation, email fail-open and burst behavior,
vulnerable framework versions, public database TLS verification being disabled,
replica-local abuse controls, and production-operability evidence.

**Capacity is no longer unmeasured — it is measured, and it does not reach either target.**
On an isolated local rig (real PostgreSQL 18.4, stub chain RPC, one API process) the read
path plateaus at **~430–470 requests/second**, flat, against the **500 req/s** the 10,000-
active-user model needs and the **5,000 req/s** the 100,000 model needs. The knee sits
between 60 and 100 screen-loads/second, and past it the system **queues rather than sheds
load** — p95 went 38 ms → 22 s with no throughput gain. Mining accrual for 100,000 sessions
took 6 minutes on loopback in **998,601 sequential statements**, which at a realistic
per-query network round trip is ~11.6 minutes of pure wait inside a 15-minute interval that
settlement runs after. These figures come from one machine shared with the load generator
and are a **floor of confidence, not a production forecast**.

**One new confirmed defect, and it was found by execution rather than inspection:** a
one-time email code can be redeemed several times when the requests arrive together
(**A-14**). Twelve simultaneous verifications of a single code produced four acceptances.
It affects signup verification, password reset, account linking and the **withdrawal
step-up confirmation**, and it also lets the five-attempt guess cap be overrun by
parallelism. The fix is a one-statement conditional update. The two money races tested
alongside it — withdrawal double-spend and mining claim double-credit — **both passed**
under genuine multi-connection concurrency, so guardrail #8's per-user advisory lock is
doing its job on the paths that have it; `consumeCode` is the path that has none.

## Risk summary

| Severity | Count | Most important items |
|---|---:|---|
| High | 8 | **one-time codes redeemable in parallel (A-14, executed)**, OTP logging/fail-open, fragile email delivery, non-revocable 30-day JWTs, per-process rate limits plus proxy advisory, database TLS verification, vulnerable dependencies, capacity now measured short of both targets |
| Medium | 5 | Sensitive postback retention, unbounded history routes, shallow health/monitoring, browser security-header gap, privacy/deletion/retention gap |
| Low | 1 | Registration account enumeration |

The dependency item groups related npm advisories rather than inflating each transitive
package into a separate product finding.

## Evidence that increases confidence

- API money and authorization suites passed in fresh databases rather than sharing state.
- Telegram signature, link-code, replay, and authorization tests passed locally.
- Next.js generated all 38 discovered routes successfully.
- No tracked `.env`, private-key, or confirmed live-secret file was found; only examples,
  test fixtures, and code patterns matched the filename/pattern scan.
- Existing code uses transactions, idempotency keys, and advisory locks on many high-risk
  money paths — and on 2026-09-04 those locks were **proven** on real multi-connection
  PostgreSQL for the withdrawal and mining-claim paths, not merely inspected.
- Epoch settlement measured far better than predicted (17.2 s for 100,000 miners, in 1,594
  statements), and no lock waits were observed at any tested load.

## Release gates

Before a public launch or material growth campaign:

1. Make one-time code consumption atomic (A-14) — one conditional `UPDATE`, under an hour,
   with a reproducing test already written. Cheapest item on this list.
2. Fail production startup when email is not configured; never log OTPs; add bounded
   retries/queueing, idempotency, and delivery telemetry.
3. Add server-side session versioning or a session store so reset, logout, disablement,
   and staff-role changes can revoke active tokens.
4. Upgrade Fastify, Next.js, Sharp, and affected transitive packages to patched versions,
   then rerun the full suite and targeted proxy/schema/image tests.
5. Restore authenticated database TLS and verify the Railway certificate/hostname path.
6. Use a shared rate-limit store and validate the exact trusted proxy chain after the
   Fastify upgrade.
7. Re-run the staged load profile on production-shaped infrastructure (real per-query
   network round trip, real RPC provider, generator not competing for CPU), after cutting
   the accrual statement count — the local pass already shows the read path an order of
   magnitude short of 100k and the worker with no headroom at all.
8. Add readiness/worker/provider metrics, backup evidence, and a restore drill.

## Scope limits

No live emails, Telegram messages, chain transactions, destructive tests or DAST scans
were sent. High-volume traffic **was** generated on 2026-09-04, but only against an
isolated local target with stubbed providers — never against production.
Responsive/browser testing was attempted but blocked by a local browser runtime mismatch. Provider account settings, DNS records, production
logs/metrics, and Railway backup state were not accessible.
