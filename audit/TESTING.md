# Reproducible checks and test notes

All commands were run from `G:\Earning App` on Windows with Node.js 24.14.1. Tests used
fresh copied API directories and PGlite databases so suites could not pollute one another.
No production target or provider was contacted except npm's advisory service.

## Commands executed

```powershell
Set-Location 'G:\Earning App\api'
npx tsc --noEmit

Set-Location 'G:\Earning App\web'
npm run lint
npm run build

Set-Location 'G:\Earning App\api'
npm audit --omit=dev --json

Set-Location 'G:\Earning App\web'
npm audit --omit=dev --json
```

API scripts were enumerated from `api/package.json`. Each `test:*` script ran in its own
copy with a junction to the already-installed `node_modules` and with `DATABASE_URL`
unset, which makes `api/src/db.ts` create a fresh PGlite database under that copy's
`data/pg`. The Node 24 built-in TypeScript transformer was used because `tsx` failed in
this host before application code with `os.userInfo(): uv_os_get_passwd ENOMEM`.

Equivalent per-suite command:

```powershell
Set-Location '<fresh-api-copy>'
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
node --experimental-transform-types <test-file-from-package-script>
```

## Results

| Check | Result |
|---|---|
| API TypeScript | Pass |
| Web ESLint | Pass, 7 performance warnings for raw `<img>` elements |
| Web production build | Pass, 38 routes |
| API test scripts | 36/36 scripts completed; 1,463 assertions; 0 failures |
| Real concurrency markers | 2 skipped under PGlite |
| Audit auth-resilience aggregate | Intentionally failed: two insecure expectations reproduced |
| API production dependency audit | 9 high, 0 critical |
| Web production dependency audit | 4 high, 0 critical |

## Audit-only auth probe

Copy `tests/auth-resilience.e2e.ts` into `api/src/tests/` inside a disposable API copy and
run:

```powershell
node --experimental-transform-types src/tests/auth-resilience.e2e.ts
```

The probe uses `.invalid` addresses and clears the Resend key. It does not contact a real
mailbox. Its output is expected to remain nonzero until reset-token revocation and the
production email fallback are fixed.

## Load-test scaffold

`tests/k6-capacity.js` is intentionally not executed by default. Seed a separate user per
token in an approved isolated environment, save only synthetic bearer tokens in an ignored
`tokens.json`, then run a baseline such as:

```powershell
$env:BASE_URL='https://approved-isolated-api.example'
$env:TOKENS_FILE='G:\safe-temp\tokens.json'
$env:TARGET_RPS='10'
$env:DURATION='2m'
k6 run 'G:\Earning App\audit\tests\k6-capacity.js'
```

Never point the scaffold at production. Its 500 rps and 5,000 rps profiles are workload
models for 10k/100k active users at one action per 20 seconds, not capacity claims.

## Executed capacity and concurrency pass (2026-09-04)

Everything below ran against an **isolated local** target, never production. The working
rig lives in `audit/.work/load/` (git-ignored: it holds a 76 MB API log, a Postgres data
directory and 5,000 synthetic bearer tokens). Reproducing it means re-creating the rig;
the scripts to do so are all in that directory, and the retained evidence is in
`results/`.

**Rig**: real PostgreSQL 18.4 via `embedded-postgres` on port 5433 (`.work/load/pgserver.mjs`,
`max_connections=300`, `shared_buffers=256MB`); the API from `api/src` at `NODE_ENV=production`
on port 4100 with the environment in `.work/load/api.env.sh` (payouts manual, native deposit
scan off, no Resend/Telegram key, `RPC_BEP20` pointed at the local stub in
`.work/load/stub-rpc.mjs`); k6 v2.2.0; 5,000 users seeded by `.work/load/seed-load-users.mjs`
with tokens in `.work/load/tokens.json`.

```bash
# 1. database, stub RPC, API  (three long-running processes)
node .work/load/pgserver.mjs                  # > .work/load/pg.log
node .work/load/stub-rpc.mjs                  # > .work/load/stub-rpc.log
source .work/load/api.env.sh && node --experimental-transform-types api/src/server.ts

# 2. seed 5,000 users + tokens
node .work/load/seed-load-users.mjs

# 3. staged read-path load: 30, 60, 100, 150, 220 screen-loads/s, 40 s each
.work/load/run-stages.sh                      # -> results/k6-stage-*.txt

# 4. pool/lock sampling through one stage (run concurrently with step 3)
node .work/load/watch-pool.mjs                # -> results/pool-during-load.json

# 5. mining worker at both target scales (drives the real accrue/settle functions)
node --experimental-transform-types tests/mining-scale-bench.ts   # -> results/mining-scale-bench.txt

# 6. the three money/auth races PGlite cannot express
node .work/load/race-tests.mjs                # -> results/race-tests.txt
```

`tests/k6-journeys.js` (new) drives five real screen journeys — home, mine, wallet, tasks,
refer — with the exact endpoint sets those screens fetch, so a "screen-load" is a realistic
request fan-out rather than a single call. `tests/mining-scale-bench.ts` (new) imports and
calls `accrueAllSessions()` and `settleEpoch()` directly and counts statements as well as
wall time, because on loopback the statement count is the transferable number and the clock
is not.

`.work/load/race-tests.mjs` is the one to keep: it is the reproducer for **A-14**, and it
cannot be ported into the existing PGlite suites, because PGlite has a single connection and
serializes exactly the interleaving the test must provoke.

### Results

| Check | Result |
|---|---|
| Read path, 30 / 60 screens per second | **Pass** — 144 / 287 req/s, p95 25 / 38 ms, no failures, nothing dropped |
| Read path, 100 / 150 / 220 screens per second | **Fail** — throughput plateaus at ~430–470 req/s while p95 goes 2.8 s → 22 s → 41 s |
| Connection pool at the knee | 0.8 of 10 busy on average, peak 4, **zero** lock waits — not the binding constraint |
| Mining accrual, 10k / 100k sessions | 32.3 s / **361 s**, at 96,926 / **998,601** sequential statements |
| Epoch settlement, 10k / 100k miners | 1.6 s / **17.2 s**, at 775 / 1,594 statements — already batched |
| Withdrawal double-spend, 10 parallel | **Pass** — one accepted, balance never negative |
| Mining claim double-credit, 12 parallel | **Pass** — one success, parked amount credited exactly once |
| One-time email code single-use, 12 parallel | **FAIL** — 4 of 12 accepted → `FINDINGS.md` A-14 |

⚠️ The load generator ran on the same machine as the API. Loopback removes the per-query
network round trip production has, and the co-located generator takes CPU the API would
otherwise have. The throughput ceiling is a floor of confidence, not a Railway forecast —
which is why the accrual finding is stated in **statements**, not seconds.

## Fixes and their verification (2026-09-04)

After the audit, the founder authorised fixes. `FIXES_APPLIED.md` carries the
before/after measurements; the commands are these.

```bash
# the two new regression suites
cd api
npm run test:otprace       # one-time codes: 22 checks on PGlite
npm run test:miningbatch   # the batched hashrate must equal the per-user one

# the OTP race only exists on real Postgres - PGlite has one connection and
# serialises exactly the interleaving that breaks, so the BROKEN version passes
DATABASE_URL=postgres://... npm run test:otprace   # 28 checks, races included

# the mining worker bench, before and after. PG_STATEMENT_TIMEOUT_MS is needed
# because the bench bulk-deletes users, which legitimately outlasts the new
# 10s request deadline - that is the knob existing for the reason it exists.
DATABASE_URL=postgres://... PG_STATEMENT_TIMEOUT_MS=600000 \
  npx tsx ../audit/tests/mining-scale-bench.ts 10000 100000

# the read path, warm API, same journeys as the pre-fix run
audit/.work/load/run-stages.sh
```

⚠️ **Wait for the boot-time ticks to finish before measuring.** The API kicks
every background tick once at startup, and the accrual sweep over the seeded
population competes with the first seconds of a load run - a stage started 25
seconds after boot reported p95 941 ms where the same stage on a warm process
reported 22 ms. That was a measurement artifact, not a regression, and it is the
easiest way to draw a wrong conclusion from this rig.

⚠️ **A fresh test database must be UTF-8.** `CREATE DATABASE x` on this Windows
cluster inherits WIN1252 from template1, and the schema blocks contain 491
non-ASCII characters (em-dashes, warning glyphs) that WIN1252 cannot encode, so
`initDb()` fails with `no equivalent in encoding "WIN1252"`. Use
`CREATE DATABASE x WITH ENCODING 'UTF8' TEMPLATE template0`. Railway is UTF-8, so
this is a local-rig trap only - but it looks exactly like a broken migration.

