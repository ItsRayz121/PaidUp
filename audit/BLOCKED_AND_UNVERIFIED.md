# Blocked and unverified checks

These are deliberately not labeled pass or fail.

**Four rows were closed by execution on 2026-09-04** and have moved out of this table:
the real-Postgres OTP single-use race (**failed** → `FINDINGS.md` A-14), the mining
spend/advisory-lock race (**passed**), the withdrawal double-spend race (**passed**), and
10k/100k capacity (**measured** → `LOAD_TEST_PLAN_AND_VERDICTS.md`). Capacity was measured
on an isolated *local* rig, not a production-shaped one, so the follow-on rows below
(multi-replica, real RPC, Railway networking) remain open.

| Check | Status | Why blocked | What is needed |
|---|---|---|---|
| Real email receipt, spam placement, sender DNS, bounce/delivery events | Blocked | No provider account, mailbox, DNS or safe test domain access | Test Resend account/domain and controlled inboxes |
| Resend quota/plan and production delivery limits | Unverified | Repository cannot show account-level limits | Provider dashboard export and staged quota test |
| Real Telegram Bot API 429/retry behavior | Blocked | No approved bot/test chat; sending externally was out of scope | Dedicated bot/chat and rate-test approval |
| Incoming Telegram webhook replay/order | Not applicable | Product has login/Mini App validation and outbound alerts, not a conversational update consumer | Reclassify if an update webhook is added |
| ~~Real-Postgres OTP single-use race~~ | **Closed — FAILED** | Executed 2026-09-04 on PostgreSQL 18.4; 4 of 12 parallel confirms accepted | Now `FINDINGS.md` A-14 |
| ~~Mining spend/advisory-lock race~~ | **Closed — PASSED** | Executed 2026-09-04; mining claim and withdrawal double-spend each accepted exactly once | `results/race-tests.txt` |
| Task-budget postback race | Unverified | Existing suite skips the true concurrency claim on PGlite | Same as above |
| ~~10k/100k active-user capacity~~ | **Closed — measured, both FAIL** | Executed 2026-09-04 on a local rig: ceiling ~430–470 req/s vs 500 needed for 10k and 5,000 for 100k | `LOAD_TEST_PLAN_AND_VERDICTS.md` |
| The same capacity on production-shaped infrastructure | Unverified | The measured rig was loopback Postgres, a stub RPC, one process, and a co-located generator | Isolated Railway-shaped deployment with real per-query network RTT |
| Restart/overlap/backlog worker recovery | Blocked | Requires process control and production-shaped data | Isolated multi-replica deployment |
| Real chain RPC/deposit/sweep/payout correctness | Blocked | No sandbox chain credentials/funds and no authorization for transactions | Dedicated test wallets/RPC and capped budget |
| DAST, hostile fuzzing, credential-stuffing and denial-of-service tests | Blocked | Active security traffic requires an explicitly approved isolated target | Written scope, target, limits and monitoring |
| Responsive/device/browser journeys | Blocked | The required in-app browser runtime referenced missing version `26.825.51511`; installed skill assets are `26.820.71523` | Repair/reinstall the browser runtime, then rerun mobile/desktop journeys |
| Production headers at Vercel edge | Unverified | Repository lacks the headers, but edge/project settings were inaccessible | Deployed URL and project config access |
| Railway backup/PITR configuration and restore RTO/RPO | Unverified | No Railway account/project access | Backup settings export and timed restore drill |
| Production logs, alerts, SLOs and incident response | Unverified | No dashboards, alert history or runbooks were provided | Read-only observability and incident artifacts |
| Legal/regulatory compliance | Not assessed | Requires jurisdiction and qualified legal review | Counsel review for Pakistan/target markets, KYC and payouts |

Railway documents both [backups/restores](https://docs.railway.com/guides/postgres-backups-restores)
and [point-in-time recovery](https://docs.railway.com/volumes/point-in-time-recovery), but
documentation availability is not evidence that this project's service has either enabled
or tested.
