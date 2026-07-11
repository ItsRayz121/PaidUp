# Architecture

## Deployment topology

```
User (mobile browser)
      |
      v
Next.js frontend  ------------->  Vercel (hosting + preview deploys via Vercel MCP)
      |  (API calls, HTTPS)
      v
Node backend (Express/Fastify) -->  Railway (Postgres + Redis add-ons)
      |
      +--> Ad network SDKs/APIs (outbound: fetch offer feed)
      +--- Ad network postback endpoints (inbound: webhook per network)
      +--> SMS OTP provider (auth)
      +--> Payout rail APIs (JazzCash/EasyPaisa, UPI, bKash, Paystack, etc.)
```

Backend and frontend are separate deploys so the frontend ships UI fast on Vercel while the backend (money and postbacks) has a slower, more carefully reviewed cadence on Railway.

## Data model (core entities)

- **users**: id, email (unique, primary login), telegram_id (nullable, fallback verify), phone (optional), created_at, status (active/suspended/banned), referred_by_user_id (nullable), country, device_fingerprint_ids[]
- **ledger_entries**: id, user_id, amount, direction (credit/debit), source_type (task_completion / referral_bonus / withdrawal / admin_adjustment), source_ref_id, created_at, note. **Balance is `SUM(amount)`, never a stored field.**
- **networks**: id, name, type (offerwall/rewarded_video), status (active/disabled), commission_split_pct (per network, overridable per country), postback_secret
- **tasks/offers**: id, network_id, external_offer_id, title, description, points_value, country_availability[]
- **task_completions**: id, user_id, task_id, network_id, status (pending/verified/credited/rejected), postback_payload, verified_at
- **withdrawal_requests**: id, user_id, amount, payout_rail, status (pending/agent_approved/manager_approved/paid/rejected), reviewed_by_user_id, reviewed_at, paid_at
- **referrals**: id, referrer_user_id, referred_user_id, created_at, bonus_paid (bool)
- **fraud_flags**: id, user_id or device_id, flag_type (velocity/geo_mismatch/device_reuse/referral_ring), severity, created_at, resolved_by, resolution_note
- **admin_users**: id, role (admin/manager/agent), permissions, created_at

## Ad network adapters — the pattern to follow for every network

Each network gets its own adapter module implementing the same interface:

```
interface AdNetworkAdapter {
  fetchOfferFeed(country: string): Offer[]          // outbound
  verifyPostback(req: Request): VerifiedCompletion   // inbound, network-specific check
  getMinPayout(): number
  getPaymentTerms(): string
}
```

**Inbound postback flow (never skip):**
1. Network calls our `/webhooks/{network}/postback` after a user completes an offer.
2. Adapter verifies signature/token per that network's method (query token, HMAC, or IP allowlist).
3. Check idempotency — reject if this completion ID was already processed.
4. Only after verification: write a `task_completions` row as `verified`, then a `ledger_entries` credit.
5. Log every postback received, verified or not — Agents use this to resolve disputes.

**Never** credit points from a client-side "I finished" call. That signal is trivially fakeable.

## Fraud & risk layer (Phase 1, don't defer)

- **Device fingerprinting** ✅ built: the web app computes a no-PII hash of coarse
  browser signals (`web/src/lib/device.ts`), sent as the `x-device-id` header;
  the backend records it per (user, device) in `user_devices` at every
  login/verify/reset (`api/src/fraud.ts`).
- **Velocity checks** ✅ built: a user can only be credited for the same offer
  *type* N times/day (`config.velocityCapPerTypePerDay`); over the cap →
  `velocity` flag, no credit (`api/src/routes/webhooks.ts`).
- **Device reuse** ✅ built: ≥3 accounts on one device → `device_reuse` flag.
- **IP reuse** ✅ built (Phase 2): ≥`config.ipReuseThreshold` accounts from one
  IP → `ip_reuse` flag (medium). Threshold is higher than device reuse on
  purpose — carrier-grade NAT in our markets means many users legitimately
  share an IP, so this is a soft signal for staff review, never an auto-ban.
- **Referral ring detection** ✅ built: an invited account sharing a **device**
  with its referrer → `referral_ring` (high); sharing only an **IP** (Phase 2)
  → `referral_ring` (medium) as a weaker fallback.
- **Global velocity cap** ✅ built (Phase 2): a user's total credited
  completions across ALL offer types/day is capped
  (`config.velocityCapAllTypesPerDay`), on top of the per-type cap — stops
  maxing every type at once. Over → `velocity` flag, no credit.
- **Escalation path** ✅ built: flags surface in the staff `/staff/fraud` queue;
  nothing is auto-banned. Managers resolve flags via `/staff/fraud/:id/resolve`,
  leaving an append-only trail (`resolved_by`, `resolution_note`).
- **Geo mismatch**: not yet built — postback country/IP vs stated country (Phase 2).
- Flag deduping: an unresolved flag of the same (type, device) is not re-raised,
  so repeated logins don't spam the queue.

## Commission split — starting framework (Admin confirms real numbers)

Tier-3 markets: per-action revenue is low (~$0.05–$0.50). Starting split to model against:
- Reserve ~10–15% as a fraud-loss and processing-fee buffer.
- Pass **50–60%** of what remains to the user as points.
- Keep the remainder as margin.

Store the split in the `networks` table as a configurable field, not a hardcoded constant.

**Referral commission (Phase 2 tuning):** the inviter earns `referral_bonus_pct`
of a referred user's task points as a separate `referral_bonus` ledger entry.
`referral_bonus_days` bounds it to a window — the inviter only earns while the
invited account is younger than that many days (`0` = lifetime). Both are
per-network, Admin-tunable (`PATCH /staff/networks/:id`), never hardcoded. The
window caps long-tail payout cost and the value of a referral farm.

## Payout rails

Each country needs its own integration; don't build a generic abstraction until two are live:
- Pakistan: JazzCash, EasyPaisa
- India: UPI
- Bangladesh: bKash
- Nigeria: Paystack/Flutterwave
- Indonesia: OVO/GoPay/DANA

Withdrawals route through Agent → Manager approval before any payout API in v1.

## API surface (as built)

Auth (email + password; SMS OTP dropped for cost, Telegram is the planned fallback):
- `POST /auth/register` (create unverified account, email a 6-digit code — password is bound to the code, applied only on verify), `POST /auth/verify-email`, `POST /auth/login`, `POST /auth/forgot`, `POST /auth/reset`, `GET /auth/me`

Earner:
- `GET /tasks` (offer feed for the user's country; hides disabled-network offers)
- `GET /wallet/balance`, `GET /wallet/ledger`
- `POST /withdrawals`, `GET /withdrawals` (USDT chains; funds held via ledger debit)
- `GET /referrals/me`
- `POST /support/tickets`, `GET /support/tickets`, `POST /support/tickets/:id/messages`

Inbound:
- `POST|GET /webhooks/:network/postback` — per-network adapter verifies; disabled networks are rejected; idempotent by (network, external_id). Client-side crediting never exists.

Staff (gated by `admin_users.role`, never by frontend hiding alone):
- Agent+: `GET /staff/withdrawals`, `POST /staff/withdrawals/:id/decision`, `GET /staff/users/:id`, `GET /staff/tickets`, `GET /staff/tickets/:id`, `POST /staff/tickets/:id/reply`
- Manager+: `GET /staff/fraud`, `POST /staff/fraud/:id/resolve`, `GET /staff/kpis`
- Admin: `GET /staff/networks`, `PATCH /staff/networks/:id` (commission split, referral bonus, enable/disable)

Every authenticated request also carries an `x-device-id` header (device fingerprint) used by the fraud layer.
