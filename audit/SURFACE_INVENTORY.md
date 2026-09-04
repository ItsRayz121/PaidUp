# Product and technical surface inventory

## User-facing web

The successful Next.js build generated 38 routes. Main journeys are login/verification,
home and earnings, tasks and surveys, referrals/leaderboard, notifications, help/support,
profile/KYC, points/ROZI/USDT/BNB wallets and withdrawals, plus mining start/claim,
rigs/boosters, transfer/receive, conversion, top-up/refund, store and roadmap.

The `/staff` application contains operational dashboards and queues for users, roles,
fraud, support, KYC, tasks/proofs, networks, content/notifications, analytics/audit,
withdrawals, BNB, relay jobs, disbursements, treasury, deposits/refunds, mining, rigs,
conversion, allocations and store fulfillment.

## API

Static enumeration found 202 Fastify route definitions across authentication, application,
webhook, withdrawal, mining, profile, push and staff modules. Important public boundaries:

- Email/password registration, verification, login, forgot/reset and email linking.
- Telegram Login Widget, Mini App and link-code authentication.
- Authenticated user reads/actions for tasks, surveys, wallets, referrals, notifications,
  support, profile, KYC, withdrawals and mining.
- Signed/token/IP-pinned partner postbacks that can credit value.
- Staff role-gated read/write endpoints covering money, identity, users and configuration.
- Public `/health`, `/features`, asset delivery and IP diagnostic endpoints.

## Persistent state

Postgres is the system of record in production; PGlite is the local test/development
driver. State includes users/roles, verification codes, append-only points ledger, USDT
ledger/custody, tasks/proofs/postbacks, withdrawals/addresses, disbursements/relay jobs,
deposits/sweeps/reconciliation, mining sessions/rigs/boosters/epochs/conversion,
referrals/fraud flags, KYC images, support messages/images, notifications/push
subscriptions, settings/content and audit records.

## External integrations

- Vercel hosts the Next.js PWA; Railway hosts API/Postgres.
- Resend sends verification/reset codes.
- Telegram supplies Login/Mini App identity and best-effort staff alerts.
- Offer/survey partners send value-bearing postbacks.
- BNB Chain/configured JSON-RPC providers support deposits, sweeps and payouts.
- Browser push services receive Web Push payloads.

No conversational Telegram update consumer, Redis, general-purpose durable job queue,
separate worker, object storage service, or application performance monitoring
integration was found. Selected payout/chain workflows do persist their own relay state.

## Background execution

The API process starts recurring settlement/mining/task/code cleanup, deposit scan/sweep,
payout relay, reconciliation and support auto-close work. Replicas therefore duplicate
timer triggers; database locks/idempotency are the correctness boundary. Timer ownership,
backlog, retry and last-success are not exposed by the static health route.
