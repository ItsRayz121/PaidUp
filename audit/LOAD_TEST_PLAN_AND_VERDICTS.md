# Capacity test plan and verdicts

Plan written 2026-09-03. **Executed 2026-09-04** against an isolated local target; the
verdict table below is now measured, not modeled.

⚠️ **These are the PRE-FIX numbers, and they have been superseded.** Fixes were
applied the same day and the whole profile re-run on the same rig: the ceiling
moved from ~430–470 to ~600 req/s and the collapse at the knee is gone. The
after-table, the before/after per finding and the honest limits are in
**`FIXES_APPLIED.md`**. Everything below is kept as the baseline it was measured
as — overwriting it would destroy the only evidence the fixes did anything.

## Test rig (read this before quoting any number)

| | |
|---|---|
| API | `api/src` at commit `8bc95ac`, `NODE_ENV=production`, single process, **one** replica |
| Database | real **PostgreSQL 18.4** on loopback (`127.0.0.1:5433`), `max_connections=300`, `shared_buffers=256MB` — **not** PGlite |
| Chain RPC | local stub (`.work/load/stub-rpc.mjs`) — no provider quota, no WAN latency |
| Email / Telegram / push | unconfigured, so those paths no-op |
| Generator | k6 v2.2.0, `tests/k6-journeys.js`, 5 real screen journeys, **5,000** seeded users with real bearer tokens |
| Indexes | the four indexes recommended in `CAPACITY_BOTTLENECKS.md` were **not** added; this measures the code as it ships |

⚠️ **The generator and the API shared one Windows machine.** They competed for CPU, and
the failures at the top stage were TCP `dial` errors at the generator, not HTTP 5xx from
the API. Every ceiling below is therefore a **floor of confidence** — the real Railway
ceiling could be higher (dedicated CPU, no co-located generator) or lower (network RTT
per query, which loopback removes entirely). Do not quote these as a production forecast.

## Measured verdict

| Offered load | Achieved | Requests/s | p95 screen | Failed | Dropped | Verdict |
|---|---:|---:|---:|---:|---:|---|
| 30 screens/s | 30.0 | 144 | **25 ms** | 0.00% | 0 | **Pass**, comfortable |
| 60 screens/s | 60.0 | 287 | **38 ms** | 0.00% | 0 | **Pass**, comfortable |
| 100 screens/s | 88.6 | 426 | 7.06 s | 0.00% | 219 | **Fail** on latency |
| 100 screens/s (re-run) | 100.0 | 473 | 2.77 s | 0.00% | 0 | **Marginal** — served, but over the p95 gate |
| 150 screens/s | 85.3 | 407 | 22.1 s | 0.00% | 1,727 | **Fail** |
| 220 screens/s | 91.7 | 438 | 41.3 s | **20.08%** | 2,886 | **Fail** — stopped accepting connections |

**The throughput ceiling on this rig is ~430–470 requests/second**, and it is flat: 426,
473, 407 and 438 req/s across four stages of increasing offered load. Past the knee the
system does not shed load, it queues — latency went from 38 ms to 22 s while throughput
did not improve, which is the signature `CAPACITY_BOTTLENECKS.md` § B1 predicts for a pool
with no `connectionTimeoutMillis`.

**The knee is between 60 and 100 screens/s** — i.e. between ~290 and ~430 req/s.

### Two identical 100-screens/s runs disagreed by 4×

p95 7.06 s with 219 dropped iterations on the first attempt; 2.77 s with none on the
re-run. Same build, same data, same offered load. The pool was **not** the constraint
during the re-run:

```json
// results/pool-during-load.json — 45 samples through the re-run
{"totalConns":{"max":10,"avg":"9.3"},"activeConns":{"max":4,"avg":"0.8"},
 "idleConns":{"max":10,"avg":"8.6"},"lockWaits":{"max":0,"avg":"0.0"}}
```

Only 0.8 of 10 connections busy on average, peak 4, and **zero** lock waits. So at the
knee the binding constraint is **the single Node process — CPU and event-loop — not
Postgres**, which is a correction to the ranking in `CAPACITY_BOTTLENECKS.md`: B1's pool
limit is a real cliff waiting further out, but B2 (≈47 queries and three redundant
`hashrateOf` computations per `/mining/state`) and B11 (`scrypt` on the 4-thread libuv
pool) are what bind first. The 4× run-to-run variance is itself consistent with B8 — a
background timer tick landing inside one run and not the other, with no re-entrancy guard
and no instrumentation to tell you which.

## Mining worker, measured at both target scales

`tests/mining-scale-bench.ts` drove the real `accrueAllSessions()` and `settleEpoch()`
against the same Postgres (`results/mining-scale-bench.txt`):

| Miners | Accrual | Statements | Per user | Settlement | Statements | Verdict |
|---:|---:|---:|---:|---:|---:|---|
| 10,000 | **32.3 s** | 96,926 | 3.24 ms | 1.6 s | 775 | fits the 15-min interval |
| 100,000 | **361 s (6.0 min)** | 998,601 | 3.61 ms | 17.2 s | 1,594 | fits **on loopback only** |

Two things follow, and they point opposite ways:

- **Settlement is better than predicted.** `CAPACITY_BOTTLENECKS.md` § B5 estimated 70 s+
  at 100k; measured 17.2 s, in 1,594 statements rather than 100,000 — so that path is
  already batched in practice. **B5 should be de-ranked.**
- **Accrual is the confirmed problem, and the arithmetic is worse than the clock says.**
  998,601 statements for 100k sessions is ~10 per session, sequential. On loopback that is
  6 minutes. Railway's private network adds a real round trip per statement: at the
  document's own 0.7 ms assumption, `998,601 × 0.7 ms ≈ 699 s ≈ 11.6 min` **of pure network
  wait alone**, before query execution — inside a 15-minute interval with almost nothing to
  spare, and settlement runs *after* it. **B4 is confirmed and remains the top worker
  risk.** The fix is the statement count, not the clock speed.

## What this does and does not settle

| Question | Answer |
|---|---|
| Does the read path serve 10,000 concurrent users (500 req/s at 1 screen/20 s)? | **No.** ~430–470 req/s measured on this rig, with p95 already past the gate at 473. |
| Does it serve 100,000 (5,000 req/s)? | **No** — an order of magnitude short, single replica. |
| Does mining accrual finish inside 15 minutes at 100k? | **On loopback yes (6 min); on Railway, arithmetic says roughly 11.6 min of network wait alone.** No headroom. Not proven on production-shaped networking. |
| Is the database the first thing to break? | **No** — the process is, at this scale. Corrects the pre-measurement ranking. |
| Do the money paths hold under real concurrency? | Withdrawal double-spend and mining claim **pass**; one-time email codes **fail** (see `FINDINGS.md` A-14). |

## Safe staged execution

Use `tests/k6-capacity.js` only against an approved isolated API with synthetic accounts,
production-shaped Postgres, and disabled outbound providers. Start at 10 rps and progress
through 50, 100, 250, then 500 rps. Stop immediately on data-integrity errors, p99 above
three seconds, more than 2% errors, worker lag beyond one interval, database saturation,
or any unexpected external call.

Do not attempt 5,000 rps until the 500-rps profile passes a soak test and the cost/impact
has been explicitly approved. Use a distributed k6 runner if one generator saturates.

## Dataset

- Unique bearer token and device ID per virtual user.
- Representative account ages and ledger sizes, including p50/p95/p99 history depth.
- Active/inactive mining sessions, rigs, boosts and referrals in production-like ratios.
- Open/closed support conversations without real images or personal data.
- Pending/paid/rejected withdrawals and disbursements with synthetic chain hashes.
- Stubbed Resend, Telegram, push, ad-network and chain/RPC services with programmable
  latency, 429, 5xx, timeout and duplicate responses.

## Measurements required

Report request p50/p95/p99/max, failures by route, dropped iterations, CPU, memory,
event-loop lag, DB connections/pool wait, query latency/count, lock wait/deadlocks, rows
scanned, worker throughput/lag, provider queue age/retries, and cost per million requests.
Verify ledger invariants and exactly-once business outcomes after every run.

## Provisional pass gates

- More than 99% journey checks pass and fewer than 1% HTTP requests fail.
- p95 below 750 ms and p99 below 1.5 seconds for the read mix.
- No dropped iterations, negative balances, duplicate credits/debits, or double payouts.
- No sustained pool saturation; enough headroom remains for a single-replica failure.
- Mining accrual completes inside its 15-minute interval with bounded lag.
- Provider 429/5xx responses are queued/retried without losing or duplicating user-visible
  outcomes.

These are provisional engineering gates. Final SLOs need product and operational approval.
