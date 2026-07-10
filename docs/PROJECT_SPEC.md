# Product Spec — Rewards & Offerwall App

## Problem Statement

In Pakistan, India, Bangladesh, Indonesia, and Nigeria, smartphone users have real spare time and strong demand for small amounts of extra cash, but few low-friction, trustworthy ways to earn it online. Most existing "earn money" apps in these markets either don't pay out, set withdrawal thresholds designed to never be reached, or are thin wrappers around a single ad network with no referral mechanics — so they don't retain users or grow virally. There's room for an app that actually pays, pays fast, and grows through referral trust rather than paid acquisition.

## Goals

1. Launch in one country first (recommend Pakistan) with one working payout rail, not five countries with none working.
2. Reach a real, low, reachable payout threshold and pay within a stated SLA (e.g., 24–72 hours) — this is the core trust mechanic the whole growth strategy depends on.
3. Drive growth primarily through referrals, not paid acquisition.
4. Keep gross margin per user positive after network commission, payment processing fees, and an allocated fraud-loss buffer.
5. Pass Google Play policy review without a takedown for undisclosed incentivized installs.

## Non-Goals (v1)

- **Not a crypto/airdrop product.** Points are redeemable for real local currency through real payout rails, full stop.
- **Not building all five countries' payout rails at once.**
- **Not building a native mobile app in v1.** A responsive web app on Vercel is faster to ship and iterate.
- **Not doing automated payouts in v1.** Manual Agent/Manager review of withdrawal requests first.

## Personas

- **Earner (primary user)**: 18–35, smartphone-first, price-sensitive, possibly burned by an app that didn't pay. Wants: clear tasks, visible points, fast real payout, low reading burden.
- **Referrer**: an Earner recruiting friends/family for referral commission. Wants: a shareable link/code, visible referral earnings, proof the app pays.
- **Agent (internal)**: handles user tickets and reviews payout requests under a threshold.
- **Manager (internal)**: approves payouts above the Agent threshold, oversees Agents, watches the fraud/analytics dashboard.
- **Admin (internal)**: configures ad networks, commission splits, feature flags; full financial visibility.

## Requirements

### Must-Have (P0)
- Email-verification signup/login | **AC**: user enters email, receives a 6-digit code by email, verifies, logged in within one flow; duplicate emails cannot create a second account. (Founder decision 2026-07-10: SMS OTP dropped for cost; email primary, Telegram verification is the planned cheaper fallback if email hurts signup.)
- Points ledger (append-only) with running balance view | **AC**: every credit/debit is a ledger row with source, amount, timestamp; balance is a derived sum, never directly edited.
- At least one offerwall network + one rewarded-video network with verified server-to-server postbacks | **AC**: a completed offer only credits points after postback signature/token validation; replayed or forged postbacks are rejected and logged.
- Withdrawal request flow with one working payout rail | **AC**: user requests withdrawal at/above threshold, sees pending status, Agent/Manager can approve, user sees paid status with timestamp.
- Admin panel: network config, commission split, user search, ledger view.
- Manager panel: approval queue above Agent threshold, KPI dashboard.
- Agent panel: ticket queue, low-value withdrawal queue.
- Basic device fingerprinting + velocity caps.
- Sponsored-offer disclosure shown before task start.
- Referral link/code + basic attribution.

### Nice-to-Have (P1)
- Referral commission (% of referred user's earnings, TBD)
- Second and third ad networks
- Local-language UI (Urdu first)
- Automated payout for small amounts under a fraud-safe threshold
- Basic analytics: cohort retention, per-network revenue per user

### Future Considerations (P2)
- Additional countries' payout rails
- Native mobile app
- Automated fraud scoring (ML-based)
- Multi-currency wallet display

## Success Metrics

**Leading**: % of withdrawals paid within SLA (target 95%+ within 72h); referral share of signups (TBD); task completion rate.
**Lagging**: 30-day Earner retention; gross margin per active user; fraud-flagged transaction rate.

## Open Questions

- **Commission split** (business): what % of net network payout goes to the user as points? *(Mechanism built — per-network `commission_split_pct` + `referral_bonus_pct` are Admin-configurable in the `networks` table / staff panel; the real number is still a founder decision.)*
- **Launch country** (business): confirm Pakistan-first.
- **Referral commission structure** (business): flat %, one-time bonus, or both?
- **Sentry authorization** (engineering): authorize via claude.ai connector settings before production error monitoring.
- **Local-language priority** (product): which language ships first alongside English.

## Phasing

- **Phase 0** ✅ — docs + architecture + design system. No code.
- **Phase 1 (MVP)** ✅ **complete (2026-07-10)** — all P0 requirements built + verified: email+password auth, append-only ledger, **two** ad networks with verified postbacks (offerwall + rewarded-video), USDT withdrawals with Agent→Manager approval, Admin/Manager/Agent panels (network config, KPI dashboard, ticket queue), device fingerprinting + velocity/device-reuse/referral-ring fraud detection, sponsored disclosure, referral attribution.
- **Phase 2** — referral commission tuning, third+ network, fraud rules tightened (geo mismatch), Sentry live.
- **Phase 3** — additional payout rails (PKR/local), automated low-risk payout, local-language UI (Urdu).

Phase 1 P0 is done; Phase 2 may begin once its items are prioritized. Note the second ad network (rewarded-video) originally listed under P1 was pulled into P0 because the P0 AC requires one offerwall *and* one rewarded-video network.
