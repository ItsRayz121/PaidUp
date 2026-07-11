# Rewards & Offerwall App — Project Memory

This file is the entry point. Read this first on every session. Full detail lives in `/docs`:

| File | Contains |
|---|---|
| `docs/PROJECT_SPEC.md` | The PRD — problem, goals, non-goals, user stories, requirements, phasing |
| `docs/ARCHITECTURE.md` | System design — data model, ad-network adapters, fraud layer, deploy topology |
| `docs/DESIGN_BRIEF.md` | Visual direction, simple-English copy rules, accessibility |
| `docs/TEAM_AND_AGENTS.md` | The 15-role virtual team, mapped to real Claude Code agents/skills/MCPs |

## What this product is

A rewards app: users complete offers (app installs, surveys, rewarded video) supplied by ad networks and earn points redeemable for local cash. Revenue = network payout to us, minus points paid to users. Growth = referral loops, not ad spend. Primary markets: Pakistan, India, Bangladesh, Indonesia, Nigeria.

## Tech stack (decided)

- **Frontend**: Next.js, deployed on **Vercel**. Use the Vercel MCP for deploys/previews. Lives in `web/`.
- **Backend**: Node (Express or Fastify), deployed on **Railway**, Postgres + Redis (Railway add-ons). Will live in `api/`.
- **Auth**: **Email + password**, with a one-time email code to verify the address at signup. Founder decision (2026-07-10, revised same day): the original passwordless "code every login" flow is replaced — users register with email+password, verify once by code, then log in with the password; a code is only re-sent for email verification or **forgot password**. Phone SMS OTP remains **dropped** (per-SMS cost too high); **Telegram** is the planned cheaper fallback if email hurts signup. Passwords are scrypt-hashed (Node built-in, no dependency). See `api/src/auth.ts`.
- **Graphics/icons**: Canva MCP for icon sets and marketing assets.
- **Domain**: GoDaddy MCP for DNS once a domain is chosen.
- **Error monitoring**: Sentry — currently unauthorized in this workspace. Authorize before Phase 2.
- **Not used on this project**: TradingView MCP, twitterapi-mcp — leave these idle.
- ⚠️ **No Railway MCP is connected.** Backend deploys must go through the Railway CLI via bash, or a Railway API token set as an env var.

## Non-negotiable guardrails

These override convenience or speed at every step:

1. **Every point credited must trace to a verified server-to-server postback**, never a client-side "I finished the offer" call.
2. **Every points transaction is an append-only ledger entry**, never a mutable balance field. Balance = sum of ledger.
3. **Disclose that offers are sponsored and rewards come from third parties**, in-product, before a user starts a task.
4. **Never design a payout threshold to be effectively unreachable.**
5. **Rate-limit and fingerprint at the device level from day one.**
6. **Simple English + icon-first UI everywhere user-facing.** No jargon in any user-facing string.

## Working conventions

- Treat `docs/PROJECT_SPEC.md` as the source of truth for scope. Flag conflicts rather than silently expanding scope.
- Before writing code for a new feature, check `docs/ARCHITECTURE.md` for the data model and adapter pattern.
- After any change touching auth, payments, or ad-network postback endpoints, run the `security-review` skill.
- Before marking a feature done, run `verify`/`run` to confirm it works end-to-end.

## Current build status

- **Phase 0**: docs + architecture + design system. ✅ done.
- **Phase 1 (MVP)**: ✅ **all P0 features built + verified** (2026-07-10). Earner app (`web/`) + backend (`api/`) live on Vercel/Railway (Postgres), wired end-to-end.
  - Auth: email + password, one-time signup verification, forgot-password reset.
  - Append-only ledger; balance = SUM(ledger). Money writes in transactions.
  - **Two** ad-network adapters with verified S2S postbacks: `offerhub` (offerwall, HMAC) + `tapvid` (rewarded-video, token+HMAC). Add a network = one adapter file + one registry line.
  - Withdrawals in USDT (BEP20/Polygon/Base/Aptos), address-validated, held via ledger debit, advisory-lock against double-spend, Agent→Manager approval chain.
  - **Networks table** — Admin sets commission split + referral bonus per network and can disable a network (stops crediting + hides offers) with no redeploy.
  - **Fraud layer**: per-user velocity cap, **device fingerprinting** (`x-device-id`), **device-reuse** + **referral-ring** detection, staff flag-resolution trail.
  - **Staff panels** (`/staff`): withdrawal queue, **KPI dashboard** (manager), **support-ticket queue** (agent), **network config** (admin), dispute lookup, fraud queue.
  - **Earner Help/Support** (`/help`): create tickets, threaded replies.
- Verified: API smoke tests (all endpoints), fraud detection fires, `web` build + typecheck clean. See `security-review` run notes.

- **Phase 2 (in progress)**: three build items done + verified (2026-07-11):
  - **3rd ad network** `surveyx` (offerwall) — a *third* postback verification scheme (HMAC + signed-timestamp freshness/replay window + completion-status gate); adapter + registry line + seed rows only, no changes to the other adapters.
  - **Referral commission tuning** — per-network `referral_bonus_days` window (0 = lifetime), Admin-tunable in `/staff` next to the split; past the window the inviter stops earning from that referral.
  - **Tighter fraud** — `ip_reuse` detection, `referral_ring`-by-shared-IP (medium, softer than the device-share high), and a **global** daily velocity cap across all offer types on top of the per-type cap.
  - Verified: 13-check API smoke test (surveyx accept/reject paths, referral window in/out/lifetime, global velocity flag, IP fraud flags), `api` + `web` typecheck, `web` production build — all clean.
- **Phase 2 (cont.)**: three more items done + verified (2026-07-11):
  - **Launch business decisions locked** (founder): commission = **60% of net payout to users** / 40% margin (default in code; apply to live rows via `railway run npm run seed` — see `DEPLOY.md`); launch market = **Pakistan** (already the default country everywhere); app name = **RoziPay**, domain **rozipay.xyz** (final, 2026-07-11 — renamed from PaidUp across the whole app; live infra hostnames unchanged until the domain is pointed in Vercel).
  - **Geo-mismatch fraud rule** — compares the country the network reports in the postback vs the user's stated country (ISO-2 ↔ name normalised for our markets); soft `geo_mismatch` medium flag, deduped per user+country, **never blocks crediting**. No GeoIP source needed (uses the postback's own country field), which is what had it deferred.
  - **Telegram login fallback** — `POST /auth/telegram` verifies the Login Widget signature server-side (HMAC-SHA256 keyed by SHA256(bot token)) + freshness/replay window; finds-or-creates by `telegram_id` with a synthetic never-emailed address; feature-flagged off until `TELEGRAM_BOT_TOKEN` (backend) + `NEXT_PUBLIC_TELEGRAM_BOT` (web) are set. Frontend widget on `/login` + register.
  - Verified: 12-check API smoke test (commission=60 after seed, geo match/mismatch/dedupe, telegram valid/bad-sig/stale/repeat), `api` + `web` typecheck, `web` production build, `security-review` (no findings) — all clean.

- **Phase 2/3 (cont.)**: three more items done + verified (2026-07-11):
  - **USDT payout settlement** — the manual mark-paid stub is replaced by a payout
    provider (`api/src/payout.ts`). Manual mode is live: marking paid records the
    on-chain **tx hash** + computed **USDT amount** (`POINTS_PER_USDT` rate) as
    proof; staff panel prompts for the hash. On-chain auto-send is scaffolded and
    config-gated (`PAYOUT_MODE=onchain` + signer + RPC), deliberately disabled
    until proven on testnet — see DEPLOY.md § Payout.
  - **Fraud rule `payout_address_reuse`** — flags (never blocks) when
    `payoutAddressReuseThreshold` (3)+ accounts withdraw to one wallet; the farm
    cash-out signal. Checked at withdrawal-request time, deduped per address.
  - **Urdu localization (Phase 3)** — client-side i18n (`web/src/lib/i18n.tsx`,
    en/ur dictionary, RTL, localStorage preference), `LangToggle`, provider in
    `Shell`. **All earner screens localized**: Home, Tasks, Wallet, Refer, Help,
    Withdraw (money flow), Login (all 5 modes) + bottom nav. 131 keys, en/ur in
    sync (verified). Staff panel intentionally stays English (internal tool).
  - Verified: api + web typecheck, web production build, payout unit tests (12),
    fraud DB test (4), `security-review` (no findings) — all clean.

**Founder collection list → `docs/LAUNCH_CHECKLIST.md`.** The real launch blockers
are things only the founder can obtain: (1) a **real ad-network account** + its
postback secret (offerhub/tapvid/surveyx are spec adapters, not live), (2) a
**Resend API key + verified email domain**, (3) a **funded USDT treasury wallet**.
Then 🟡 Sentry auth, ⚪ custom domain, ⚪ Telegram.

**Still open (business decisions):** ✅ all three locked (60% split / Pakistan / RoziPay — domain rozipay.xyz).

**Phase 2 remaining:** Sentry authorization (still **blocked** — needs founder to authorize the connector in claude.ai settings; non-interactive session can't run the OAuth flow). Further fraud tuning + finishing Urdu across all screens are open Phase 3 work.

See `docs/` for the full spec.
