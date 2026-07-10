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

- **Device fingerprinting**: hash of device/browser signals (no PII). Cap completions per device per day.
- **Velocity checks**: rate-limit by IP and ASN; flag data-center IPs.
- **Geo mismatch**: flag if postback country/IP doesn't match user's stated country.
- **Referral ring detection**: flag clusters of referred accounts sharing a device/IP with the referrer.
- **Escalation path**: flags surface to Agents first; nothing is silently auto-banned without a visible trail.

## Commission split — starting framework (Admin confirms real numbers)

Tier-3 markets: per-action revenue is low (~$0.05–$0.50). Starting split to model against:
- Reserve ~10–15% as a fraud-loss and processing-fee buffer.
- Pass **50–60%** of what remains to the user as points.
- Keep the remainder as margin.

Store the split in the `networks` table as a configurable field, not a hardcoded constant.

## Payout rails

Each country needs its own integration; don't build a generic abstraction until two are live:
- Pakistan: JazzCash, EasyPaisa
- India: UPI
- Bangladesh: bKash
- Nigeria: Paystack/Flutterwave
- Indonesia: OVO/GoPay/DANA

Withdrawals route through Agent → Manager approval before any payout API in v1.

## API surface (high level)

- `POST /auth/email/request` (send 6-digit code), `POST /auth/email/verify` (Telegram verify is the planned fallback; SMS OTP dropped for cost)
- `GET /tasks` (offer feed for user's country)
- `POST /webhooks/{network}/postback` (per-network inbound)
- `GET /wallet/balance`, `GET /wallet/ledger`
- `POST /withdrawals`, `GET /withdrawals/:id`
- `GET /referrals/me`
- Admin/Manager/Agent-only: `/admin/*`, `/manager/*`, `/agent/*` — gated by `admin_users.role`, never by frontend hiding alone.
