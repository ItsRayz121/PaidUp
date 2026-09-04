# Captured results

Files in this directory record exact commands and outputs from checks executed during
the 2026-09-03 static pass and the 2026-09-04 capacity/concurrency pass. A retained output is evidence of that command only; it is not a
claim about production behavior, third-party delivery, or untested environments.

| File | Result |
|---|---|
| `api-typecheck.txt` | `tsc --noEmit`: pass |
| `web-lint.txt` | ESLint: pass with 7 `<img>` performance warnings |
| `web-build.txt` | Next.js production build: pass, 38 routes generated |
| `api-test-suite.txt` | 36 isolated API test scripts; 1,463 assertions; 0 failures; 2 real-Postgres checks skipped |
| `api-test-summary.txt` | Parsed roll-up and the two explicit concurrency skips |
| `auth-resilience.txt` | Audit-only probe: old JWT survives reset and missing Resend key logs plaintext OTP; secure aggregate result fails as intended |
| `api-npm-audit.json` | 9 high-severity production dependency findings |
| `web-npm-audit.json` | 4 high-severity production dependency findings |
| `secret-scan.txt` | Filename/pattern scan methodology and sanitized outcome |

### 2026-09-04 — capacity and real-Postgres concurrency

Run against an isolated local target: real PostgreSQL 18.4 on loopback, a stub chain RPC,
unconfigured email/Telegram/push, one API process, 5,000 seeded users. The generator and
the API shared one machine — see the rig caveats in `../LOAD_TEST_PLAN_AND_VERDICTS.md`
before quoting any figure.

| File | Result |
|---|---|
| `k6-stage-30.txt` | 30 screens/s → 144 req/s, p95 25 ms, 0 failed, 0 dropped: **pass** |
| `k6-stage-60.txt` | 60 screens/s → 287 req/s, p95 38 ms, 0 failed, 0 dropped: **pass** |
| `k6-stage-100.txt` | 100 screens/s → 426 req/s, p95 7.06 s, 219 dropped: **fail on latency** |
| `k6-stage-100-rerun.txt` | Same load re-run → 473 req/s, p95 2.77 s, 0 dropped: **marginal**; 4× variance against the run above is itself the finding |
| `k6-stage-150.txt` | 150 screens/s → 407 req/s, p95 22.1 s, 1,727 dropped: **fail** |
| `k6-stage-220.txt` | 220 screens/s → 438 req/s, p95 41.3 s, 20.08% failed (all TCP `dial`, no HTTP 5xx), 2,886 dropped: **fail** |
| `pool-during-load.json` | 45 samples through the 100/s re-run: 0.8 of 10 connections busy on average, peak 4, **zero** lock waits — the pool was not the constraint at the knee |
| `mining-scale-bench.txt` | Real `accrueAllSessions()`/`settleEpoch()`: accrual 32.3 s @10k, **361 s @100k** (998,601 statements); settlement 1.6 s / 17.2 s |
| `race-tests.txt` | 3 races on real Postgres: withdrawal double-spend **pass**, mining claim double-credit **pass**, one-time email code single-use **FAIL** (4 of 12 accepted) → `FINDINGS.md` A-14 |

The k6 throughput figures are a floor of confidence, not a Railway forecast: loopback
removes the per-query network round trip that production has, and a co-located generator
removes CPU the API would otherwise have.

### 2026-09-04 — AFTER the fixes (same rig, same commands)

See `../FIXES_APPLIED.md` for what changed and why. Same journeys, same generator,
warm API in every run.

| File | Result |
|---|---|
| `k6-after-stage-30.txt` | 141 req/s, p95 28 ms, 0 dropped |
| `k6-after-stage-60.txt` | 289 req/s, p95 **22 ms** (was 38 ms) |
| `k6-after-stage-100.txt` | 475 req/s, p95 **49 ms**, **0 dropped** — was 426 req/s, p95 7.06 s, 219 dropped |
| `k6-after-stage-110.txt` | 517 req/s, p95 142 ms, 0 dropped |
| `k6-after-stage-125.txt` | **598 req/s, p95 445 ms, 0 dropped — all four pass gates met** (p95 229 ms, p99 487 ms on the repeat run) |
| `k6-after-stage-150.txt` | 588 req/s, p95 8.7 s, 595 dropped — past the new knee |
| `pool-after-load.json` | At the new knee: 1.1 of 20 connections busy on average, peak 6, **zero** lock waits — the database is still not the constraint |

Mining worker, same bench (`tests/mining-scale-bench.ts`), before → after:
10,000 miners 96,926 → **39,441** statements (32.3 s → 20.9 s); 100,000 miners
998,601 → **400,625** statements (361 s → **205 s**).

The dependency counts are npm's aggregate package counts, not thirteen independently
reachable product exploits. Reachability is discussed in `../FINDINGS.md`.
