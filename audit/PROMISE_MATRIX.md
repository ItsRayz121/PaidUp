# Promise-to-implementation matrix

The baseline is `docs/PROJECT_SPEC.md`, the launch/mining/custody documentation, current UI
copy, and the behavior exercised at commit
`8bc95ac1a97780c7962694cd6ccbb3e920b93e83`.

| Promise or expectation | Implementation evidence | Verification | Verdict |
|---|---|---|---|
| User receives a six-digit email code and completes signup in one flow | Email-code issue/consume routes and Resend adapter exist | Logic inspected; real send/inbox/DNS blocked; missing key fails open | **Partial / launch blocker** |
| Duplicate emails cannot create a second account | Unique account check and 409 path | API suite passed | Met locally |
| Balance derives from an append-only points ledger | Ledger schema/queries and no balance column | Money, wallet, fees, withdrawal and admin suites passed | Met locally |
| Offer/reward credits require verified postbacks and replay is rejected/logged | Network-specific webhook validation and external-ID records | E2E postback/replay tests passed | Met locally; log-retention issue remains |
| Withdrawal has a working rail, status, and staff approval | Points/USDT withdrawal, disbursement, relay, role and fee paths exist | Local suites passed; no real chain or payout performed | Partial / external unverified |
| Agent/Manager/Admin permissions separate duties | Database role checks and route guards | Authorization and queue suites passed | Met locally |
| Basic device/velocity fraud controls exist | Fingerprint, velocity, flag and referral controls exist | Relevant suites passed | Met locally; distributed IP/limiter risk remains |
| Sponsored disclosure appears before tasks | Disclosure UI/source exists | Source inspected; browser journey blocked | Implemented / visual unverified |
| Referral link/code and attribution exist | Referral routes and ledger attribution | Referral E2E passed | Met locally |
| 95% of withdrawals are paid within 72 hours | Target stated in `PROJECT_SPEC.md:58-61` | No production SLA telemetry or payout evidence available | Unverified |
| Product is a smartphone-first PWA | Manifest/service worker and responsive Next routes exist | Production build passed; real browser/install/device run blocked | Implemented / UX unverified |
| Telegram is an email fallback/login path | Login Widget, Mini App and linking validation exist | Telegram E2E passed | Met locally |
| Telegram bot processes incoming conversational updates once | No conversational update webhook or polling consumer exists | Topology inspection | Not applicable |
| Automated low-risk payout is future/P1 | Auto-settle and relay code now exist | Auto-withdraw/refund/relay suites passed | Implemented; older docs are stale |
| ROZI mining/custody/store functions safely | Mining sessions, rigs, conversion, deposits/refunds/store and staff tools exist | Extensive local suites passed; chain and real concurrency blocked | Partial / external unverified |
| Product can serve 10k and 100k active users | Sequential accrual and a 10-connection pool as built | **Measured 2026-09-04** on an isolated local rig: read path plateaus at ~430–470 req/s against 500 needed for 10k and 5,000 for 100k; 100k accrual takes 998,601 sequential statements | **Not met** at either scale |
| ROZI mining money paths hold under real concurrency | Per-user `pg_advisory_xact_lock` on balance-changing paths (guardrail #8) | **Executed 2026-09-04** on real PostgreSQL: withdrawal double-spend and mining-claim double-credit each accepted exactly once | **Met** |
| An emailed one-time code can be used once | `consumeCode` reads, checks, then blind-writes `consumed = 1` (`api/src/auth.ts:86-107`) | **Executed 2026-09-04**: 4 of 12 simultaneous confirmations of one code accepted | **Not met** — `FINDINGS.md` A-14 |
| Users are told how personal/KYC data is used and can exercise deletion rights | Launch checklist acknowledges missing policy; no deletion/retention flow found | Repository inspection | Not met |

## Documentation drift

- `docs/ARCHITECTURE.md` references a Redis add-on, but no Redis-backed limiter, cache, or
  queue exists in the current implementation.
- Earlier payout documents describe manual-only settlement; current code includes
  auto-settle/relay modes.
- Native mobile remains a future consideration; the current deliverable is a web PWA.
- Mining, custody, BNB/USDT and expanded staff operations make the current system
  materially larger than the original MVP description.

Before launch, designate one current product/spec document as authoritative and link old
plans to it as historical records.
