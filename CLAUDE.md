# Rewards & Offerwall App — Project Memory

This file is the entry point. Read this first on every session. Full detail lives in `/docs`:

| File | Contains |
|---|---|
| `docs/PROJECT_SPEC.md` | The PRD — problem, goals, non-goals, user stories, requirements, phasing |
| `docs/ARCHITECTURE.md` | System design — data model, ad-network adapters, fraud layer, deploy topology |
| `docs/DESIGN_BRIEF.md` | Visual direction, simple-English copy rules, accessibility |
| `docs/TEAM_AND_AGENTS.md` | The 15-role virtual team, mapped to real Claude Code agents/skills/MCPs |
| `docs/MINING_SPEC.md` | **ROZI mining** — the second currency: tokenomics, emission, hashrate, sinks, conversion |
| `docs/MINING_PLAN.md` | The mining build checklist — what's done, what's deliberately not |

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
7. **ROZI and Points are two separate append-only ledgers, and the only path between
   them is a Conversion Window** — a pre-committed, hard-capped pot of Points
   (`docs/MINING_SPEC.md` § 6). There is **no fixed ROZI→Points rate anywhere**, by
   design: a fixed rate is a promise to buy back an asset we mint for free, i.e. an
   unfunded liability that grows with our own success. ROZI is safe to mint *only*
   because it is not a claim on the treasury. Never sell it to users as cash.
8. **Every transaction that reads a balance then debits it must take
   `pg_advisory_xact_lock(hashtext(userId))` first** (see `lockUser()` in
   `api/src/routes/mining.ts`, and `routes/withdrawals.ts`). Without it, two
   concurrent requests both read the same balance, both pass the affordability
   check, and both debit. This is not theoretical — it was a real bug caught in
   review on the mining debit paths.

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
  - ~~**Urdu localization (Phase 3)**~~ — **REVERSED 2026-07-12, see below.**
    The Urdu dictionary, `LangToggle` and RTL were removed at the founder's
    request. `web/src/lib/i18n.tsx` survives as an **English-only copy deck**.
  - Verified: api + web typecheck, web production build, payout unit tests (12),
    fraud DB test (4), `security-review` (no findings) — all clean.

- **Phase 3 (cont.)**: earnings/referral/withdrawal upgrade done + verified (2026-07-11):
  - **Withdrawal networks** narrowed to **USDT BEP20, Base, Aptos** (Polygon dropped;
    TRC20/Tron is a quick future add — one validator). ⚠️ **Narrowed again to
    BEP20 ONLY on 2026-07-29 — see the "ONE CHAIN IN, ONE CHAIN OUT" entry below.**
  - **Saved payout address** — set once per chain, reused (`payout_addresses` table
    + `/withdrawals/addresses` GET/PUT; auto-saved on withdrawal). Withdraw screen
    pre-fills it and is reachable **below the threshold** so users set it up early.
  - **2-level referral** — L1 15% + L2 5% of an invite's task points, **from margin
    (never deducted from the invitee)**, + a **100-point bonus when the invite
    finishes their FIRST task** (anti-farm: rewards real activity, not signups). All
    per-network, Admin-tunable in `/staff`. Run `npm run seed` to apply to existing
    live rows (see DEPLOY.md — old rows keep 10%/no-L2 until seeded).
  - **Leaderboard** — top earners + top inviters (masked handles), `/leaderboard`
    page, linked from Refer. Social proof to drive referrals.
  - **Value model locked (founder 2026-07-11)** — **1000 points = 1 USDT** (the real
    payout rate; backend `pointsPerUsdt` / `POINTS_PER_USDT`). This replaced a stale
    demo rate (100 pts = Rs 1) that under-stated value ~28x and disagreed with the
    payout. **USDT is the ONLY money figure shown (founder, 2026-07-12)** — the
    earlier "≈ Rs" approximation beside it was removed: a rupee figure derived from
    a hard-coded rate goes stale and reads as a promise we don't control (see
    `web/src/lib/format.ts`).
    Minimum withdrawal = **2000 points = 2 USDT** (`minWithdrawPoints`).
    ⚠️ `web/src/lib/format.ts` `POINTS_PER_USDT` must stay in sync with the backend.
  - **Admin-tunable withdrawal fee** — flat points fee (global, `app_settings`
    key-value table, `/staff/settings` admin endpoints; default 0). Snapshotted
    onto each request (`withdrawal_requests.fee_points`) so an Admin change never
    alters an in-flight payout; net USDT = pointsToUsdt(amount − fee). Shown to
    the user (fee + "you receive") before they confirm. Editable in `/staff`.
  - Verified: api+web typecheck, web build, i18n parity (143 keys en/ur), a 10-check
    referral/withdrawal/leaderboard e2e test (L1/L2/first-task math, idempotency,
    saved-address upsert), `security-review` (no findings) — all clean.

- **CPX Research — FIRST REAL AD NETWORK (2026-07-12)**: live survey wall, app id
  **34405**. This is the revenue unblock.
  - **Dynamic-amount networks now supported.** Real survey walls have no fixed task
    row (payout varies per survey), so `VerifiedCompletion` gained `points` /
    `offerType` / `reversal`, `task_completions` gained `points` + `offer_type`
    (task_id now nullable, backfilled), and velocity caps read `offer_type` instead
    of joining `tasks`. Fixed-catalog adapters are unchanged.
  - **Split enforced in the CPX dashboard**: Reward Settings `1 USD = 600 points`
    ⇒ CPX pays $1 → user gets 600 pts (=$0.60) → we keep $0.40 (60/40).
  - **Security**: CPX signs `md5(trans_id + "-" + secret)` — the signature does NOT
    cover the amount, so a captured postback could be replayed with a bigger number.
    Closed by (a) the unique `(network, external_id)` index ⇒ replay is a duplicate
    no-op, (b) minting a new `trans_id` needs the secret, (c) `CPX_MAX_POINTS` cap.
    Optional IP pin (`CPX_ENFORCE_IP`, off by default — Railway proxy).
  - **Fraud reversal**: CPX re-calls with `status=2` up to ~60 days later; we claw
    back the user's reward AND the referral bonuses it paid, mark the completion
    `reversed`, and raise a `network_reversal` flag. User may go negative — correct,
    and flagged for staff.
  - **Survey wall** at `/surveys` (iframe, URL signed server-side — the app secret
    never reaches the browser), linked from Tasks. Verified: 22 e2e checks incl.
    inflated-replay and forgery attacks, `security-review` (no findings).
  - ⚠️ `POSTBACK_SECRET_CPX` **must be set on Railway or the API will not boot.**
    Script Tag integration (higher revenue than the iframe) is a pending upgrade.

- **Installable app (PWA) — 2026-07-12**: the website installs to the phone's home
  screen and opens like a native app. It is **not an APK** — nothing is downloaded
  and there is no Play Store step; the copy says so plainly, in en + ur.
  - `web/src/app/manifest.ts` (standalone, brand colours, Tasks/Wallet shortcuts),
    icons in `web/public/icons/` (192/512/maskable/apple — **real RoziPay brand
    art**, added by the founder 2026-07-13), `web/public/sw.js`, `/offline` page.
  - **The service worker never caches user or money data.** Navigations are
    network-only; only `/offline`, `/icons/*` and content-hashed `/_next/static/*`
    are cached. A stale balance from a cache would be a real bug — the door is
    shut. `/sw.js` is served `no-store` so a bad worker can't get pinned.
  - **`InstallPrompt` fires only after 5 minutes of *visible* time on site**
    (accrued across visits in localStorage), never on `/login` or `/surveys`, never
    inside the installed app; "Not now" snoozes 3 days. iOS gets Share → Add to
    Home Screen steps (Safari has no install API).
  - Verified: 17-check real-Chrome e2e (gate, install click, snooze, iOS branch,
    standalone suppression), lint/typecheck/build clean, `security-review` (no
    findings).

- **ROZI MINING — SECOND CURRENCY (2026-07-12)**: a mined token, `$ROZI`, on a
  **separate append-only ledger** (`rozi_ledger`) from Points. Built because CPX has
  no survey fill for Pakistani traffic most of the day — mining gives a reason to
  open the app when there is nothing to earn from. Full design: `docs/MINING_SPEC.md`.
  - **It is real mining, not a tap-to-earn.** Hashrate is earned; nothing is
    tapped.
  - ⚠️ **EMISSION MODEL CHANGED 2026-07-13 (founder). Default is now `"pi"`, not
    `"pool"`.** `emissionModel` in `/staff` → Mining switches between them; both
    are live and tested, and the **supply cap is a hard ceiling under both**.
    - **`"pi"` (default, Pi Network-style).** You earn `piBaseRate × your
      multipliers × the fraction of a full day you mined`. **Your payout does NOT
      depend on how many other people mine** — no dilution. The throttle is
      **`piHalvingUsers`: the base rate HALVES each time the user base crosses a
      milestone** (10k / 50k / 250k / 1M / 5M). Halving on *user count*, not the
      calendar, because people are what drain the pool, so people must be what
      slows the tap. The daily total floats with the crowd, so it **can** ask for
      more than the cap has left — when it does, every payout is scaled by the
      same factor (`capScaleFactor`), never paid in row order until the pool dries
      up mid-list.
    - **`"pool"` (fallback, Bitcoin-style).** Fixed daily pot (3M, halving every
      100 days) split pro-rata by hashrate-seconds. Over-issuing is
      *arithmetically* impossible here, which is why it is kept as the safe place
      to fall back to.
    - **Why the change:** under `"pool"`, a user's earnings were cut by halving
      **and** dilution *stacked* — a halving day with 10× the miners was a **20×**
      drop, not 2×. "Halving" did not mean halving *to the person*. And a lone
      miner was shown the entire daily pot (`~3,000,000 ROZI`), a number that
      collapsed by orders of magnitude once real traffic arrived: honest
      arithmetic that read as a broken promise. Under `"pi"` a halving is a clean
      50% cut, and **a ×2 multiplier exactly offsets one halving** — which is what
      makes streaks and referrals worth keeping.
    - ⚠️ ~~**Keep the effective rate above ~10.**~~ **OBSOLETE.** True only while
      the ledger held whole ROZI. It holds millionths now, which is what made the
      2026-07-29 cut to **0.5/day** safe. `rateTooLow` was re-aimed at < 0.001/day.
    - ⚠️ **Rig prices are a function of `piBaseRate`.** Retune one, retune the
      other, or the first rig becomes unaffordable and the whole ROZI sink
      silently stops existing. See `SEED_RIGS` in `api/src/db.ts`.
  - **Hashrate is earned, never tapped**: streak (up to ×2), **credited task ⇒ +50%
    for 48h** (the line that makes mining *feed* the offerwall instead of competing
    with it), watched ad ⇒ +100% for 4h, rigs bought with ROZI (cost growth 1.6 >
    power growth 1.5, so the tree is a permanent burn), referral hashrate (L1 10% /
    L2 3%, **active invitees only**, capped at 100% of own).
  - **Sinks**: rigs, conversion burns, transfer fees. Plus **Points-priced boosters**
    — a sink for the *cash* currency, which quietly reduces USDT withdrawal pressure.
  - **Anti-farm**: **one device mines for ONE account per epoch** (second account
    accrues zero + high flag, but is not hard-blocked — families share phones);
    verified email required; flagged accounts are **withheld, not dropped from the
    denominator**, so catching fraud never inflates honest miners' payouts.
  - **Ships OFF, deliberately**: conversion, transfers, ads. Users mine for the
    2–3 month lock period with nothing convertible and nothing tradeable — this is
    what makes the whole design safe.
  - **We will NOT build an in-app P2P market.** Wallet-to-wallet transfer, yes.
    Matching trades or holding the money leg would make us an unlicensed exchange
    (PVARA). Reason recorded in `MINING_SPEC.md` § 7 so it is not re-litigated.
  - Everything tunable in `/staff` → Mining, no redeploy. Settlement is an in-API
    timer, idempotent per epoch.
  - Verified: **19 unit + 37 e2e + 15 admin + 5 proxy = 76 checks, all green**;
    api + web typecheck; web production build.
  - ⚠️ **A senior review pass after the first "done" found 9 real defects** — two of
    which silently destroyed user earnings (mining across midnight; closing the
    app), one of which was theft-by-race (ad nonce), and one of which meant the
    unit tests had never actually been passing. All fixed, each with a regression
    test. **Read `MINING_PLAN.md` M9.5 before touching the accrual or settlement
    paths** — several of those bugs are the kind you reintroduce by "simplifying".

- **ROZI LEADS, POINTS FOLLOW + the invite offer is now stated (2026-07-29)**:
  two founder decisions, one change.
  - **Screen order.** The home screen and `/wallet` now put the **ROZI card
    first** and the points card second. Mining is why someone opens the app on a
    day CPX has no survey for Pakistani traffic — which is most of the day — and
    a home screen leading with a points balance that had not moved since
    yesterday taught people there was nothing here today. **The guardrail did not
    move**: the two currencies stay in separate cards, each labelled for what it
    is, `wallet.rozi.notcash` still says outright that ROZI cannot be cashed out,
    and the **only "Get my money" button lives on the points card**. Ordering
    says what the app is *about*; copy and buttons say what each currency can
    *do* — those must never trade places.
  - **What a friend is worth is now visible.** The app paid two levels of
    referral points **+** a first-task bonus **+** referral mining speed, and
    none of it was stated anywhere a user could read it — people do not share a
    link for a reward nobody told them about. `GET /referrals/me` now also
    serves `joined2` (friends of friends) and a `rewards` block; the new
    `components/InviteRewards.tsx` renders it on home (only for users with zero
    invites), `/refer` and `/wallet`.
  - ⚠️ **Every advertised rate comes from the API, never from the copy deck.**
    The percentages are Admin-tunable per network, so a literal "15%" in
    `i18n.tsx` becomes a lie the first time an Admin edits a row — and the stale
    number is the one users already repeated to their friends on WhatsApp. The
    advertised rate is the **MIN across ACTIVE networks**: a floor we always
    meet on every offer, and a disabled network can never drag it down.
  - The strongest line on the card is the true one: **"Your share comes from our
    cut, not theirs"** — referral points come out of margin, never the invitee's
    balance (`api/src/credit.ts`), which is the objection every user in our
    markets has already met.
  - Verified: `npm run test:referrals` (14 checks — two-level counting stops at
    two, min-across-active-networks, disabled network excluded), api + web
    typecheck, eslint, web production build.

- **ROZI GETS REAL USES — conversion ceiling + spending store (2026-07-29).**
  The founder proposed a **fixed ROZI→USD rate** with referral-earned ROZI fully
  withdrawable. That was **not built**, and the reason is written down so it is
  not re-litigated: mining's only revenue is ad impressions, and at the current
  `piBaseRate` an engaged miner produces ~30 ROZI/day. Even at $0.001/ROZI with
  only 20% withdrawable, funding it needs ~20 ad impressions per user per day
  against the 3–5 `/mine` actually shows. **The rate cheap enough to fund is too
  small to motivate; the rate big enough to motivate is unfundable.** Making
  *referral-minted* ROZI cashable is worse still — invites generate no revenue,
  so it is a pure mint, and every fraud signal we have is flag-only by design.
  Three funded alternatives were built instead:
  - **Per-user conversion ceiling** (`conversionMaxPctOfMined`, default **30**,
    100 = off). A user may convert at most that % of the ROZI they have **ever
    mined**, cumulative for the life of the account. The pot caps what the
    *business* pays; this caps what any *one account* can extract.
    ⚠️ **The denominator is lifetime MINING CREDITS, and that is load-bearing.**
    Not the current balance — "30% of what you hold" is drained in steps
    (burn 30, hold 70, burn 21…) until the cap has capped nothing. Not ROZI
    received by transfer — that is the anti-farm property: fifty mules can send
    ROZI to one wallet, and that wallet still cannot convert a micro of it.
    Both bypasses have regression tests; do not "simplify" this to the balance
    that is already in scope at the call site.
  - **The Conversion Window is now reachable by users** — `/mine/convert` was
    the missing half (backend + admin panel already existed). The screen states
    the floating rate *twice, before the input*: a user who works that out after
    converting will believe they were cheated.
  - **ROZI store** (`/mine/store`, `rozi_store_items` + `rozi_redemptions`):
    spend ROZI on real goods (mobile top-up, data bundles) at a price we set and
    can raise. **A shop, not an exchange** — we sell items, we never offer to buy
    ROZI back, so exposure is bounded by `stock` instead of being an unfunded
    liability. ROZI is debited at **order** time (so it can't be double-spent
    while pending); staff fulfil or reject, and a rejection refunds the
    **snapshot on the row**, never a recomputed price, and returns the item to
    stock. New ROZI ledger source type `store_redemption` (debit out, credit
    back).
  - **Bulk referral rates** — `PATCH /staff/networks/referrals/all`. Raising
    referral pay one network at a time does *not* raise what users see, because
    the invite screens advertise the **minimum across active networks**; one
    forgotten row silently pins the advertised rate. The endpoint **refuses
    L1+L2 above the margin** (at a 60/40 split, >40% loses money on every task).
  - Verified: 40 unit + 50 mining e2e + 25 conversion + 29 store/bulk-referral +
    14 referrals + 15 admin + 25 kyc + 9 push + 45 telegram + 5 proxy, all green;
    api + web typecheck, eslint, web production build, security review (no
    findings). The `LOCKED_PATHS` tripwire in `mining.e2e.ts` caught the store's
    new debit path — **if you add a spending path, add `lockUser()` and add it to
    that list.**

- **ONE TOKEN, ONE CURRENCY, A 21M SUPPLY, AND A PUBLIC ROAD MAP (2026-07-29).**
  Five founder decisions in one pass. All verified: 41 unit + 50 mining e2e +
  28 profile + 41 usdt + 25 conversion + 29 store + 14 referrals + 15 admin +
  25 kyc + 9 push + 45 telegram + 5 proxy = **327 checks green**; api + web
  typecheck, eslint, web production build all clean.
  - **Supply cut 650M → 21M, rate cut 10/day → 0.5/day.** These are ONE decision
    and the unit test `THE SUPPLY CAP AND THE MINING RATE ARE ONE DECISION` says
    so. Rig prices were rescaled ÷20 to match (`SEED_RIGS` +
    `migrateRigCosts21m`, a one-time guarded migration for existing rows), along
    with `baseEmission` (3M → 100k), `transferDailyCap` (50k → 1k) and
    `adminAdjustMaxRozi` (1M → 25k). **The cap can never go down again** — see
    `MINING_SPEC.md` § 2. And on the record, because it will be asked again: **a
    smaller cap does not make the token worth more.** It buys a unit price that
    reads like a real asset and a smaller daily mint. Nothing else.
  - **The word "points" is gone from the earner app.** Money shows as **USDT**
    everywhere (`formatMoney`), the withdraw screen takes USDT as input and
    converts at the API edge (`usdtToPoints`), and `formatUsdt` now uses **three
    decimals under $1** — a 5-point task is $0.005, and at two decimals that
    renders as "0.00 USDT", i.e. telling someone their work was worth nothing.
    ⚠️ **The ledger is still points and the API still speaks points.** That is
    where the integer arithmetic lives. The staff panel deliberately still shows
    points: it is where the ledger is reconciled.
  - **Profile settings** (`/profile/settings`): display name (free to change),
    **@handle** (unique case-insensitively, **one change per 30 days**), and a
    picture. The cooldown is a **security control, not a preference** — a
    freely-swappable handle lets someone take a name, collect the transfers meant
    for its owner, drop it, and repeat. The handle is a send target
    (`POST /mining/transfer` accepts `@handle` / code / email), and `/mine/receive`
    is the other half. Avatars are **magic-byte sniffed** (an avatar renders back
    into a page, so a "JPEG" that is really `<svg onload=…>` is stored XSS) and
    live in their own table — `auth.ts` does `SELECT *` on every request and a
    40KB blob on that row would be paid for on all of them.
  - **Public road map** at `/mine/roadmap`, with the founder's exact months.
    Two rules the page keeps: **no price, ever** (a road map that mentions what
    ROZI might be worth stops being a plan and becomes an offer), and what
    already works is listed FIRST — a page of only future dates reads as a wish
    list. ⚠️ **The September "ID check" milestone is already live today**; the
    founder asked for those dates and got them, but that row may want rewording.
  - **USDT top-up credit** — real money in, to buy mining machines with
    (`/mine/topup`, `usdt_ledger`, `usdt_topups`). Built to the founder's
    explicit "ROZI **or** real USDT" after a recommendation against it. **Every
    narrowing is what makes it safe, and none of them are optional:**
    1. **SPEND-ONLY.** It buys rigs and nothing else — no withdrawal, no
       transfer, no conversion. The `usdt.e2e.ts` suite asserts the **absence**
       of those routes and the ledger's CHECK constraint refuses a `withdrawal`
       row at the database level. The moment this balance can leave the app we
       are holding customer funds, which is the licensed activity (PVARA) this
       product refuses everywhere else. **Do not add an exit.**
    2. **Deposits are manual and staff-confirmed.** User sends to one published
       treasury address and pastes the tx hash; a human checks the chain. No hot
       wallet, no chain listener, no private key in this system. The **reviewer's**
       amount is credited, never the user's claim — otherwise send $1, claim $500.
    3. One transaction = one claim, ever, across all users (unique index on
       `(chain, tx_hash)`); confirmation is an atomic `UPDATE … WHERE pending`.
    4. **Ships OFF** (`usdtTopupEnabled` + `usdtTreasuryAddress`), and **no rig
       has a USDT price by default** — ⚠️ setting one publishes an **implied ROZI
       exchange rate** (100 ROZI or $10 ⇒ $0.10/ROZI) for a token we say has no
       price. Price the USDT option well above what the ROZI price implies.
  - Still the founder's call, not built: **transfers remain OFF**
    (`transfersEnabled = 0`). The send/receive screens are finished and it is one
    toggle in `/staff → Mining`, but turning it on contradicts the documented
    2–3 month lock period, so it was left alone. ⚠️ **SUPERSEDED 2026-07-30 —
    transfers are now ON, see below.**

- **ONE CURRENCY ON SCREEN, AND THE INVITE STOPS SOUNDING LIKE A BOUNTY
  (founder, 2026-07-30).** Verified: 41 unit + 50 mining e2e + 31 profile +
  52 usdt + 25 conversion + 29 store + 14 referrals + 15 admin + 25 kyc +
  9 push + 45 telegram + 5 proxy = **341 checks green**; api + web typecheck,
  eslint, web production build all clean.
  - **The earner app shows ONE balance, in ROZI.** Home's second card ("Your
    money · 1.60 USDT" + a progress bar to payout) is **gone**; the ROZI card
    now shows mined ROZI **plus** task/referral earnings converted at
    `POINTS_PER_ROZI = 100` (`web/src/lib/format.ts`), with the split as a small
    line underneath. `/wallet` shows the same combined number, so the two
    screens can never disagree.
    ⚠️ **This is a DISPLAY merge and the two ledgers are untouched** — points
    are still points, ROZI is still ROZI, nothing converts, and a withdrawal
    still debits points in points. That separation is exactly what keeps the
    ratio changeable: retuning it restates the screen and rewrites nobody's
    history. Guardrail #7 stands.
    ⚠️ **A FIXED RATIO PUBLISHES AN IMPLIED ROZI PRICE, and that is the accepted
    cost, not an oversight.** Points have a public rate (1000 = 1 USDT), so
    100 points = 1 ROZI states in public that 1 ROZI = $0.01 — a $210,000 implied
    valuation against the 21M cap. The founder was told this before it was built
    and chose it. It is why the road map's no-price rule matters *more* now, not
    less: the app must not add a second, louder price claim on top.
  - **`/wallet` leads with "Set up your withdrawal wallet"** — saving a payout
    address is the one thing a user can actually finish there today, since
    cash-out is not open. The money figure and "Get my money" are still on that
    screen; they are just no longer the first thing a new user meets.
  - **The invite card is no longer a per-head bounty.** It headlined
    "0.100 USDT for every friend" — which says we pay cash for a link (we do
    not) and is the exact shape a fake-signup farm looks for. The two SHARE rows
    now lead, and the starter bonus is last, in ROZI, named for the friend's
    **first finished task**, never their signup.
  - **Road map re-dated** to the founder's months: Aug–Sep mining, Oct–Nov ID
    check, Dec open trading, Jan big exchange. The `b2b` step was dropped.
    ⚠️ **"Cash out to USDT" was REMOVED from the "Working today" list** — the
    withdrawal code works, but the treasury is unfunded, so no user can act on
    it. It goes back when a real payout has cleared, and not before.
  - **"Soon you can cash it out"** replaces "you cannot cash it out yet" on
    `/mine`. ⚠️ **"Soon" is the ceiling** — not a date, not a rate, on any
    screen, until a payout has actually cleared. Home, `/mine` and the road map
    deliberately use the same word so there is no version of the promise
    anywhere that says more.
  - **Three social tasks** (WhatsApp / Telegram / X) seeded in `seed.ts` with
    per-task **logos** — new `tasks.icon` column, a **closed list**
    (`TASK_ICONS` in `staffTasks.ts` ↔ `taskIcon` in `web/components/icons.tsx`),
    never a URL: task cards sit next to a balance, and an Admin-supplied remote
    image there is a third-party request on a money screen. Links are edited in
    `/staff → Our own tasks`. They ship **disabled with no link** — a guessed URL
    would send users to a 404 and then ask them to prove they followed it — and
    the seed uses `ON CONFLICT DO NOTHING`, so re-running it to apply network
    config never resets a link, reward or on/off switch the Admin has set.
  - **ROZI transfers are ON** (`transfersEnabled = 1`). Asked for repeatedly;
    the send/receive screens and `POST /mining/transfer` were already built and
    tested. **Nothing was relaxed to turn it on**: ID check still required to
    send, 7-day minimum account age, daily cap, 2% burned, receiving open to
    all. Conversion and the store stay shut, so ROZI still cannot leave the
    system for money — it can only move between accounts inside it.
    ⚠️ The change is to the **default** in `mining/core.ts`. A stored
    `mining.transfersEnabled` row wins over it, so an instance where an Admin
    once set it to 0 stays off until they flip it in `/staff → Mining`.

- **THE WALLET BECOMES A WALLET, AND USDT LEAVES THE EARNER APP (founder,
  2026-07-30, same day, second pass).** Verified: 41 unit + 50 mining e2e +
  31 profile + 52 usdt + 25 conversion + 29 store + 14 referrals + 15 admin +
  25 kyc + 9 push + 45 telegram + 5 proxy = **341 checks green**; api + web
  typecheck, eslint, web production build all clean.
  - **`/wallet` now has Send and Receive**, plus a **token list**. The two
    transfer screens already existed under `/mine`; surfacing them here changed
    no transfer rule — `POST /mining/transfer` still enforces the ID check, the
    7-day account age and the daily cap. Send renders **disabled with a reason**
    when `transfersEnabled` is off rather than being hidden: a wallet missing
    its Send button reads as a broken app.
  - **The token list is ROZI / USDT / BNB.** ROZI is the combined balance; USDT
    is the spend-only top-up credit.
    ⚠️ **THE BNB ROW HAS NO BALANCE BEHIND IT, BY CONSTRUCTION.** We hold no BNB
    for anyone — no per-user wallet, no chain listener, nothing that could make
    that number move (`docs/CUSTODY_SPEC.md`). The founder asked for the row
    knowing this. It therefore reads **"not open yet" / "Soon"**, never a bare
    `0.00`, because a zero beside two real balances reads as a bug or as money
    that went missing. **When per-user deposit wallets are built, that label is
    what gets deleted** — do not quietly turn it into a live-looking zero first.
  - **USDT is gone from every earner screen** (`formatMoney` → the new
    `formatPointsAsRozi`): task reward pills, the task-start confirmation, the
    TopBar, `/refer`, `/leaderboard`, and the wallet balance + history. The task
    pill is the clearest reason why — a 5-point task rendered as **"0.005 USDT"**,
    the smallest number in the app, on the exact element meant to persuade
    someone to do the work. It is 0.05 ROZI now.
    ⚠️ **THREE SCREENS KEEP USDT AND MUST**: `/wallet/withdraw` (what we
    actually send, on a real chain), `/mine/topup` + `/mine/rigs` (credit bought
    with real USDT), and `/mine/convert` (the conversion window's entire job is
    stating a cash rate). The staff panel stays in raw points — it is where the
    ledger is reconciled. `formatPointsAsRozi` carries this list in its comment.
  - **The TopBar shows the SAME combined figure as home and `/wallet`**, which
    cost it a second API call (`fetchMiningState`). Worth it: that bar is on
    every screen, and a top bar reading 2.20 above a card reading 14.68 is a
    user working out which number the app is lying with.

- **PER-USER DEPOSIT/WITHDRAWAL WALLETS — SPECIFIED, NOT BUILT (2026-07-30).**
  Founder asked for an HD-derived address per user on BEP20 + TRC20, deposit and
  withdraw. Full spec, costs and build order: **`docs/CUSTODY_SPEC.md`**. The
  short version, because it will be asked again: deriving addresses is free,
  everything after that is not. Sweeping costs ~$0.15–0.25/deposit on BEP20 and
  **~$2–3 on TRC20** unless TRX is staked; it needs an RPC provider, a chain
  listener, a gas-funder wallet and a signer; and it makes us a **custodian**,
  which is the licensed activity (PVARA) every other decision in this product
  routes around. **`CUSTODY_SPEC.md` § 5 step 1** — address per user, read-only,
  staff still confirm deposits — delivers most of what was described with none
  of the custody risk, and is the thing to build if this is wanted soon.

- **CONNECT WALLET — the payout address now proves it belongs to the user
  (founder, 2026-08-01).** The "set up your withdrawal wallet" form is no longer
  a text box you paste 42 characters into: the user taps **Connect my wallet**,
  their wallet app hands over the address, signs a message we wrote, and the
  server works out the address **from the signature**. Verified: `npm run
  test:wallet` (52 checks) + all 12 other suites green (341 → **393**); api +
  web typecheck, eslint, web production build, `security-review` (no findings).
  - **THIS IS A THEFT FIX, NOT AUTOFILL, and that is why it was worth building.**
    Every check we had on a payout address was a check on the *string* — 42
    characters, valid hex, and an EIP-55 checksum that only exists when the
    address happens to be mixed-case. None of it can tell a user's own wallet
    apart from an address a fake "support agent" sent them on WhatsApp, which
    is the most common way money is taken from users in our markets, and a
    payout cannot be reversed. A signature proves the person asking to be paid
    holds the key. That scam stops working.
  - ⚠️ **NO PRIVATE KEY ENTERS THIS SYSTEM.** The user's wallet signs; we see a
    public signature and recover a public address. This adds **zero custody** —
    `docs/CUSTODY_SPEC.md` § 2c is untouched by it, and that is deliberate.
  - ⚠️ **THE ADDRESS COMES FROM THE SIGNATURE, NEVER FROM THE REQUEST.** The
    address in the challenge call is only the user's *claim*; what gets saved is
    what `recoverSigner` returns. If the claim were trusted this whole feature
    would be a longer way of pasting a string. There is a regression test that
    claims one address and signs with another.
  - ⚠️ **THE SERVER PICKS THE WORDS THAT GET SIGNED**, stores them
    (`wallet_link_nonces.message`), and verifies against the stored copy. The
    text names our host — from `config.webOrigins`, **never the `Host` header** —
    so a signature harvested by a phishing page cannot be spent here.
  - ⚠️ **HIGH-S SIGNATURES ARE REFUSED.** Every ECDSA signature has a second
    valid encoding (`s → n−s`). Accepting both would make "one-time code" a lie:
    the same approval submits twice in two forms. Do not "simplify" that check
    out of `wallet.ts`.
  - ⚠️ **A PROOF IS ABOUT ONE ADDRESS.** `verified_at` is written only by the
    route that checked a signature; every other write to `payout_addresses`
    clears it — *except* a re-save of the identical address, because the
    auto-save after each withdrawal runs on every payout and must not throw the
    badge away. Both branches are tested.
  - **PASTING IS STILL ALLOWED and removing it would break real users**: a
    smart-contract wallet cannot `personal_sign` at all, an exchange deposit
    address has no signer the user controls, and plenty of phones have no wallet
    app. Connecting is the default; "Type the address in instead" sits beside
    it, and a typed address says so on screen rather than borrowing the tick.
  - **Mobile Chrome gets deep links, not a dead button.** Most users here have
    the wallet app installed but browse in Chrome, where nothing is injected —
    so the card offers "Open in MetaMask" / "Open in Trust Wallet", which reopen
    the page inside the wallet's own browser. Saying "you have no wallet" would
    be wrong and would send them to install a second one.
  - **No wallet SDK, no third-party script on a money screen.** The whole client
    is two EIP-1193 `request` calls (`web/src/lib/wallet.ts`).
  - **The proof reaches whoever approves the payout.**
    `withdrawal_requests.address_verified` is snapshotted at request time — same
    reason `fee_points` is — and rendered in the `/staff` queue as "signed by
    the user's wallet" or "not checked — typed in". ⚠️ **The match is on the
    ADDRESS, not on the user.** Proving wallet A says nothing about wallet B,
    and B is exactly where a scammer's address would be; there is a test for
    that specific walk.
  - ⚠️ **A SIGNAL, NEVER A GATE.** Nothing about withdrawing is blocked by an
    unproved address, deliberately — see the paste-still-works note above.
  - ⚠️ **This does NOT touch deposits.** A top-up from a Binance hot wallet is
    still an unidentifiable transfer a human matches by tx hash. Only
    `CUSTODY_SPEC.md` § 5 step 1 (address per user) fixes that, and it is still
    waiting on the founder's xpub + a BSC RPC endpoint as Railway env vars.
    **An xpub, never a seed phrase.** The two features are complementary, not
    substitutes — § 5b of that doc has the table.

- **DEPOSITS BECOME REFUNDABLE, AND THE PAYOUT FLOOR DROPS TO $1 (founder,
  2026-08-01).** Verified: 41 unit + 50 mining e2e + 31 profile + **65 usdt** +
  25 conversion + 29 store + 14 referrals + 15 admin + 25 kyc + 9 push +
  45 telegram + 5 proxy + 52 wallet = **406 checks green** (was 393); api + web
  typecheck, eslint, web production build all clean.
  - ⚠️ **THE SPEND-ONLY RULE ON USDT TOP-UP CREDIT IS AMENDED.** The old rule —
    written in `db.ts` as "THERE IS NO WITHDRAWAL PATH AND ONE MUST NOT BE
    ADDED" — no longer holds. A user may now ask for their own **unspent
    deposit** back (`POST /usdt/refunds`, `/mine/refund`, staff queue in
    `/staff → Mining`). The founder was told plainly that returning customer
    money on request is **custody in the plain sense** (PVARA — the licensed
    activity every other decision in this product routes around) and chose it,
    on the reasoning that money a user can never get back is a harder sell than
    the licence question is a risk. Recorded in `CUSTODY_SPEC.md` § 2d as a
    **decision with a date**, so it is not mistaken for drift and reverted.
  - ⚠️ **EVERY NARROWING IS WHAT KEEPS IT SURVIVABLE, and none are optional.**
    (a) The cap is the **deposit ledger** — `SUM(usdt_ledger)`, i.e. topups
    minus machine purchases minus earlier refunds — **never** what the user is
    owed, so mined ROZI and earned Points cannot walk out through this door.
    There is a test that a ROZI-rich account with **zero** deposits cannot
    refund a cent, because that is the laundering shape: put nothing in, take
    something out. (b) **Staff send it by hand from the treasury** — no signer,
    no hot wallet, **zero new key material**, so `CUSTODY_SPEC.md` § 2c is
    otherwise untouched. (c) The **debit lands at REQUEST time under
    `lockUser()`** (guardrail #8) or a queued refund gets spent on a rig while
    it waits; `usdt refund` is now in the `LOCKED_PATHS` tripwire. (d) ID check
    required, same gate as a withdrawal. (e) **1 USDT minimum** — a BEP20 send
    costs real gas, and below a dollar the transfer costs more than it returns.
    (f) **Not gated on `usdtTopupEnabled`**: switching deposits off must never
    strand money people already sent us.
  - ⚠️ **`'withdrawal'` IS STILL REFUSED BY THE `usdt_ledger` CHECK.** Only
    `'refund'` was added. That gap is load-bearing — it is what stops "refund
    your own deposit" drifting into "withdraw any balance" by one commit. The
    `/usdt/transfer` and `/usdt/convert` routes are still asserted **absent**.
  - **The top-up screen no longer says "you cannot take it back out."** That
    string became false the moment this shipped, and it sat directly above the
    address someone is about to send money to. A false promise about money, on
    that element, is the worst string this app could carry.
  - **Withdrawal minimum: 5000 → 1000 points ($5 → $1).** Both moves this week
    were **downward**, for the same reason: CPX has no survey fill for Pakistani
    traffic most of the day, so our own numbers say $5 takes an ordinary user
    weeks. Guardrail #4 — a threshold nobody reaches is the fastest way to lose
    an earner base. The cost is more, smaller, hand-sent payouts; accepted.
  - **Chain RPC is now a LIST with failover** (`api/src/rpc.ts`,
    `RPC_BEP20=a,b,c`), defaulting to five public BSC nodes, plus
    `GET /staff/mining/rpc` to see which are alive. ⚠️ Public nodes are fine for
    **occasional reads**; they are **not** fine under a deposit listener, where
    a dropped block is silent and a silently-missed deposit is a user who paid
    us and got nothing. A paid endpoint goes **first** in the list.
    ⚠️ `payoutRpc` values are **arrays now** — `Boolean([])` is `true`, so the
    onchain-payout readiness check is `.length > 0`. Getting that wrong makes
    the one code path whose job is to refuse say "yes, I can auto-send".
  - **Founder runway (recorded, drives what is and is not a blocker):** months
    1–2 **mining only**, month 2–3 opens **P2P transfer**, then a **DEX**
    listing, then a **centralised exchange**. Cash payouts are not on that
    runway — hence the treasury is **deferred, not blocking**. **Sentry is
    declined.** Ad networks: applied, **none approved yet** — the fix is real
    daily users, not more code (see `LAUNCH_CHECKLIST.md` § 1).

- ⚠️ **A HANDLE MUST NEVER SHADOW AN INVITE CODE (security fix, 2026-07-29).**
  Caught by `security-review` on the @handle work, and it was theft-by-squatting.
  Invite codes are generated as uppercase letters + two digits (`AHMED42`,
  `uniqueReferralCode` in `auth.ts`) — which lower-cases to `ahmed42`, a
  perfectly legal @handle. **Both are accepted as "send ROZI to" targets**, and
  `/mine/receive` tells users to share their invite code so people can pay them.
  The recipient lookup was one `WHERE username = ? OR referral_code = ? OR
  email = ?` with no ordering, so both rows matched and `sql.get` returned
  whichever the planner picked. An attacker took the lowercase form of a
  victim's *published* code as their handle and collected the transfers — and
  the victim could not fix it, because codes are generated, not chosen.
  **Two independent defences now, and both have regression tests:**
  1. `routes/profile.ts` refuses a handle matching any existing `referral_code`.
     The unique index cannot catch this — it compares usernames to usernames, so
     the two namespaces have to be checked against each other explicitly.
  2. `routes/mining.ts` resolves the recipient in **explicit priority order**,
     invite code FIRST, because a system-generated identifier must always beat a
     user-chosen one. Do not "simplify" this back into a single `OR`.

- **ONE CHAIN IN, ONE CHAIN OUT — USDT on BEP20 only (founder, 2026-07-29).**
  Both the deposit and the payout side are now BEP20, for two *different*
  reasons that should not be collapsed into one:
  - **Deposits: a SAFETY reason.** The top-up screen's copy names the network
    literally — "BNB Smart Chain (BEP20)" — so `usdtTreasuryChain` is validated
    to `bep20` and the admin panel **refuses** Base or Aptos. A treasury moved
    to another chain would leave that copy pointing every user at the wrong
    network, and those deposits are unrecoverable.
    ⚠️ **The deposit copy separates the TOKEN from the NETWORK, and must keep
    doing so.** The old line interpolated the chain label and read *"Send only
    USDT on BEP20 · BNB Chain"* — in which the most eye-catching word is **BNB**,
    a real token in the same wallet. People send BNB, it arrives, it is not
    USDT, and there is no way to give it back. So the screen now shows "Coin to
    send: USDT" and "Network: BNB Smart Chain (BEP20)" as two labelled rows, and
    **BNB appears exactly once — in the list of coins NOT to send.** Do not put
    a `{chain}` placeholder back into a sentence about what to send.
  - **Payouts: an OPERATIONAL reason.** One chain to hold USDT on, one gas token
    to keep funded, one explorer, one answer when a user asks support "which
    network?".
  - ⚠️ **`chains.ts` (both copies) now has TWO lists and the split is
    load-bearing.** `KNOWN_CHAINS` is everything we can validate and label;
    `CHAINS` is what is currently *offered*. Base and Aptos stay in
    `KNOWN_CHAINS` because deleting them would blank the network on every
    historical withdrawal row and break `payout.ts` recognising its own past
    work. `chainById()` spans the known set on purpose; the new
    **`chainIsOffered()`** is what gates new requests, and it guards both
    `POST /withdrawals` and `PUT /withdrawals/addresses` (a saved address on a
    dead chain would pre-fill a form that then refuses itself). Restoring a
    chain = moving one line back into the filter, on both sides.
  - The withdraw screen renders a single offered chain as a **statement, not a
    picker** — a radio group with one option reads as "there are others, find
    them". The picker returns by itself when `CHAINS.length > 1`.
  - Verified: `npm run test:usdt` is now **52 checks**, including that Base and
    Aptos still label, that only BEP20 is offered, and that a *valid* Base
    address is refused anyway — the address is fine, the chain is not on offer.

- **ENGLISH ONLY — Urdu dropped (founder, 2026-07-12).** The `ur` dictionary,
  `LangToggle`, RTL and the locale preference are **deleted**. Earners read simple
  English, and the phone translates for anyone who wants it.
  - `web/src/lib/i18n.tsx` remains, but it is now a **copy deck, not a translation
    layer**: one file holding every user-facing string (202 keys), so the whole
    app's wording can be reviewed for plain English in a single pass.
  - **The rule that replaces translation is stricter than translation was**: every
    string must be short, plain, everyday English. **No jargon, ever** — no
    "postback", "ledger", "hashrate", "pro-rata", "epoch". Say *"mining speed"*, not
    *"hashrate"* (`H/s` was stripped from the UI for exactly this reason). If a
    sentence needs a second read, rewrite it.
  - Staff panel is unaffected — it writes copy inline and jargon is allowed there.

- **Pre-launch cross-check + SEO layer (2026-07-13)**: robots.txt + sitemap.xml
  (only `/` and `/login` public; `/staff` and all logged-in screens disallowed),
  `metadataBase` + OpenGraph/Twitter tags (**WhatsApp referral links now show a
  preview card** — set `NEXT_PUBLIC_SITE_URL` on Vercel, see DEPLOY.md), favicon,
  branded 404 + root error boundary (both inline-English — they can render
  outside the I18nProvider), all 8 React-Compiler-era lint errors fixed
  (`/login` reads `?ref` via `useSearchParams` under `Suspense`).

- **WEB PUSH NOTIFICATIONS (2026-07-13)**: browser push via the service worker,
  strictly opt-in (card on `/help` + the withdraw success screen; permission
  prompt only from a user tap). **Sent on exactly four events, never marketing**:
  withdrawal paid, withdrawal rejected, staff ticket reply, KYC decided.
  - Backend: `api/src/push.ts` (web-push + VAPID), `push_subscriptions` table
    (upsert by endpoint — a shared phone logging into a second account HANDS OVER
    the subscription, so user A's money news never reaches a phone now signed in
    as user B; delete scoped to owner), routes `GET /push/config`,
    `POST/DELETE /push/subscriptions`.
  - **Sends fire AFTER the DB transaction commits, never inside** — a push can't
    be rolled back, so we never announce money a rollback un-pays. All sends are
    fire-and-forget: a push failure can never fail a money path. Dead
    subscriptions (404/410) are pruned on send.
  - Ships OFF: enabled only when `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` are set
    on Railway (`npx web-push generate-vapid-keys`, see DEPLOY.md). Web hides
    the toggle while the API reports disabled. iOS Safari (not installed) has no
    push — the card renders nothing there.

- **MONETAG LIVE — mining ad revenue (2026-07-17)**: real account, site 3411999
  (`rozipay.xyz`) verified via meta tag in `web/src/app/layout.tsx`. ⚠️ **Their
  "verification file" is named `sw.js` — never use the file method; it would
  clobber our service worker (push + offline).** Key discovery: Monetag's
  rewarded SDK (`show_zone()` promise) is **Telegram-Mini-App-only**, and the old
  SDK host coded into `web/src/lib/ads.ts` was a dead domain — so `ads.ts` was
  rewritten for the two formats a website really gets: **vignette** (zone
  `11331636`, loaded on `/mine` only — the ad around the Start-mining tap;
  passive, grants NO boost) and **direct link** (the watch-to-boost button: tab
  opens pre-`await` to dodge pop-up blockers, then the existing server nonce +
  15s dwell + daily cap decide the boost — server code unchanged). New setting
  `monetagDirectLink` (admin-tunable); enable = `adProvider`+`adsEnabled`+the
  Monetag values in `/staff → Mining`. **2026-07-18: third format added —
  `monetagBannerZone` (In-Page Push, the "banner"), shown on `/mine` only,
  passive, no boost; empty = off.** Also fixed: the mining admin panel
  Number()-coerced every setting except `adProvider`, silently NaN-ing
  `emissionModel`/`piHalvingUsers` edits. See `docs/LAUNCH_CHECKLIST.md` § 3c.

- **TELEGRAM MINI APP (2026-07-18)**: the site runs as a Telegram Mini App —
  same codebase, no fork. Bot token is set on Railway (login fallback is LIVE).
  `POST /auth/telegram/miniapp` verifies the webview's signed `initData`
  (HMAC key = HMAC-SHA256("WebAppData", bot token) — a *different* scheme than
  the Login Widget's SHA256(token), per Telegram's spec) + 1h freshness;
  referral rides `start_param` INSIDE the signed set. `GET /auth/telegram/config`
  serves the bot username (getMe, cached) so `NEXT_PUBLIC_TELEGRAM_BOT` is dead —
  the login widget configures itself from the API. Web: `lib/telegram.ts`
  (`useInsideTelegram` via useSyncExternalStore), `TelegramBoot` auto-login,
  install prompt suppressed in Telegram. **Rewarded video**: new setting
  `monetagRewardedZone` — Monetag's real video-with-completion-promise format is
  Telegram-Mini-App-only; inside Telegram the boost button plays it (server
  nonce/dwell/cap unchanged), in a browser it falls back to the direct link.
  ⚠️ api.telegram.org is BLOCKED from the founder's network (no VPN) — BotFather
  steps need VPN; server-side calls from Railway work fine. **Second pass
  (same day):** (a) **no telegram-web-app.js anywhere** — the script host is
  blocked locally and a blocked beforeInteractive script stalls the page, so
  `lib/telegram.ts` reads initData from the URL fragment (#tgWebAppData) +
  sessionStorage and speaks the webview's native postEvent bridge directly;
  (b) the API **configures the bot's menu button itself at boot**
  (`src/telegram.ts`, setChatMenuButton — automates what BotFather would);
  (c) **account linking** `POST /auth/telegram/link` (Profile → Connect
  Telegram): initData OR widget payload re-verified, `hasTelegram` on
  publicUser, empty tg-only shells absorbed / active accounts 409;
  (d) `/refer` shows BOTH invite links (site + `t.me/<bot>?startapp=<code>`).
  **Third pass (same day): the Login Widget is GONE** — it asked users to log
  into Telegram in a browser form (founder veto). Connecting from the website
  is now a **binding link**: `POST /auth/telegram/link-code` mints a one-time
  10-min code (`telegram_link_codes`, hash-stored, single-use, atomic claim),
  `t.me/<bot>?startapp=link-<code>` opens the Telegram app, and the miniapp
  login consumes it — binds + signs into the website account; stale/spent
  codes fall back to a normal login. The login screen's Telegram option is a
  plain "Continue in Telegram" t.me link (ref rides in startapp). No
  /setdomain needed anymore. **Fourth pass: the mirror direction** — a
  Telegram-created account ADDS AN EMAIL + password (`/auth/email/link-start`
  + `link-confirm`, authed; OTP purpose `"link"` on the existing email_codes
  machinery, password rides on the code) so the same account logs in on the
  website; `hasEmail` on publicUser (false = still on the synthetic
  @telegram.local address), Profile shows an "Add your email" card for those
  accounts and hides the synthetic address. 45-check e2e
  (`npm run test:telegram`). **FULLY LIVE (2026-07-18): Monetag Telegram app
  3414088 + Rewarded zone `11343471` set in /staff, and BotFather Mini App
  ENABLED → rozipay.xyz — every t.me link now opens the app; rewarded video,
  auto-login, linking, invites all armed.** NOTE: sending the real
  add-email/signup code emails still needs the Resend key.

- **THE WALLET SCREEN GETS REAL TOKEN LOGOS, AND ROZI STEPS BACK OFF IT
  (founder, 2026-08-03).** Verified: full e2e matrix unchanged and green (72
  usdt — was 65, +7 for the new address feature — plus every other suite:
  41 unit + 50 mining e2e + 31 profile + 25 conversion + 29 store + 14
  referrals + 15 admin + 43 kyc + 9 push + 45 telegram + 5 proxy + 52 wallet +
  15 admin); api + web typecheck, eslint, web production build all clean.
  - **Real brand-coloured USDT and BNB marks** replace the generic outline
    icons on the `/wallet` token list — new `web/src/components/tokenIcons.tsx`,
    deliberately separate from `icons.tsx` (that file is outline-only,
    currentColor, functional UI icons; a token logo identifies a specific coin
    and needs fixed brand colours regardless of theme, the same reason a bank
    app never re-themes a Visa mark).
  - **ROZI is off `/wallet` entirely**, top balance card included. The screen
    that shows deposits/withdrawals/Send/Receive no longer states a ROZI
    number anywhere; its token-list row reads "Coming soon" instead, same
    treatment as the BNB row. `/mine` is completely untouched — the full
    mined+earned balance and history still live there exactly as before; this
    was a display change on one screen, not a mining change.
  - **Per-user USDT deposit addresses, STEP 1 of `docs/CUSTODY_SPEC.md` § 5,
    now shipped for BEP20.** `api/src/custody.ts` derives a deterministic
    address per user from ONE public account xpub (`CUSTODY_XPUB_BEP20`) —
    public-key-only (CKDpub) derivation, so this process holds no private key
    and can never sign anything. `GET /usdt` returns it as `personalAddress`,
    additive alongside the existing shared `treasuryAddress`; `/mine/topup`
    shows it once present. **Still exactly step 1**: nothing watches the
    chain, nothing auto-credits or sweeps, a deposit is confirmed by staff
    reading a pasted tx hash precisely as it always has been. Steps 2–4
    (auto-credit, sweeping, auto-withdrawal) are unbuilt and each needs its
    own founder sign-off per `CUSTODY_SPEC.md` § 3 — this did not open that
    door, it only removed the "same address as everyone else" wart.
  - ⚠️ **The founder asked to provide the actual seed phrase; that was declined.**
    A live seed in this app can spend every user's funds on every chain,
    forever, the moment the server is breached — the exact failure mode
    `CUSTODY_SPEC.md` § 2c was written to keep out. The xpub-only path gets the
    same outcome the founder wanted (a wallet "extracted from the official
    wallet," ready for more chains later) with none of that blast radius: a
    leaked xpub exposes addresses and balances, never spending power. See
    `CUSTODY_SPEC.md` § 5b-2 for the full reasoning, including why Aptos
    (Ed25519) was never going to ride the same derivation as BEP20/TRC20
    (secp256k1) regardless of seed vs. xpub.
  - ⚠️ **The admin KYC toggle was NOT flipped.** `/staff → Verify IDs` already
    has an on/off switch (`kyc_enabled` in `app_settings`, built 2026-08-01)
    that waives the ID check on withdrawals, refunds and ROZI transfers all at
    once — deposits never required it. Flipping it needs the live production
    database; do it from `/staff` directly when ready.

- **REAL CUSTODY, PART ONE: A WITHDRAWAL SIGNER (founder, 2026-08-05).** The
  founder asked for platform-controlled wallets (deposit AND withdraw from one
  address, platform can freeze on abuse) after being told the per-user
  deposit addresses shipped 2026-08-03 are watch-only and can never spend —
  that was the whole safety property. Told plainly what the alternative
  costs — this is the licensed activity (PVARA) every other decision in this
  product has routed around, and needs a real legal opinion, not a coding
  answer — the founder chose to proceed anyway. Verified: `npm run
  test:signer` (8, pins the exact address + ERC-20 calldata a known test key
  produces) + `npm run test:autowithdraw` (15, proves every refusal path
  never reaches a network call) + all 15 other suites green (390+ checks);
  api typecheck clean. Full detail and the activation checklist:
  `CUSTODY_SPEC.md` § 5c.
  - **This is the withdrawal side ONLY, and it is NOT LIVE.** `signer.ts`
    holds one encrypted treasury private key (AES-256-GCM, two separate env
    vars — `TREASURY_KEY_ENCRYPTED` + `TREASURY_KEY_SECRET` — same pattern
    `kyc.ts` already used for ID photos). `payout.ts`'s `onchainProvider`,
    scaffolded since payouts existed and left deliberately unimplemented, now
    really signs and broadcasts a USDT `transfer` via `viem` — per-chain
    contract + decimals in one map (`ONCHAIN_CHAINS`) because BSC USDT is
    **18 decimals**, not the 6 most USDT deployments use, which is exactly
    the silent-wrong-amount bug that map exists to prevent.
  - ⚠️ **"FREE" WAS THE FOUNDER'S CHOICE OVER A KMS, AND THAT IS A REAL GAP,
    NOT A ROUNDING ERROR.** A cloud KMS/HSM signs without ever exposing the
    key; encrypted-at-rest does not — anyone with real Railway dashboard
    access to this service can read both env vars the same way the process
    does. Told clearly before building; recorded here so it reads as a
    decision, not an oversight, if it's ever questioned.
  - **`autoWithdraw.ts` is the "fully automatic" half**: every new
    withdrawal tries to settle itself the instant it's created, no staff
    click. It only succeeds when `PAYOUT_MODE=onchain` AND a treasury key
    exists AND the amount is at or under `AUTO_WITHDRAW_MAX_POINTS`
    (defaults to 5000 — the founder deferred a real number; needs revisiting
    with real volume) AND the account is not held. Miss any one of those and
    the request drops into the **unchanged** manual Agent→Manager queue.
  - **The safety valve the founder asked for**: `POST
    /staff/users/:id/withdrawal-hold` (manager/admin, mandatory reason,
    optional `until` for a hold that lifts itself). Narrower than suspending
    the whole account — a held user still mines and earns, only their
    withdrawals stop auto-paying.
  - ⚠️ **`PAYOUT_MODE` stays `manual` until this is proven on BSC testnet
    end-to-end, including the failure cases.** Nothing in this build has
    broadcast a real transaction — the tests pin the cryptography and prove
    the refusal paths, deliberately never reaching a live RPC call. Turning
    this on for real needs a NEW treasury wallet (not the deposit-derivation
    seed), funded with real USDT + gas, proven on testnet first — see
    `CUSTODY_SPEC.md` § 5c for the exact activation order.
  - ⚠️ **Steps 2–3 of the custody build (a chain listener, a sweeper) still
    do not exist.** Deposits are still confirmed by staff reading a pasted tx
    hash. "Fully automatic" describes withdrawals only — do not read this
    entry as "custody is done," it is the harder, narrower half of it.

- **CUSTODY, STEPS 2–3, BEP20 ONLY: a real chain listener + sweeper, built
  (founder, 2026-08-06).** The gap the entry directly above named — "deposits
  are still confirmed by staff, nothing sweeps" — is closed for BEP20. Full
  design: `docs/CUSTODY_SPEC.md` § 5 (unchanged) — this is that spec's steps
  2–3 in code, phase 1 of a five-chain plan (TRC20/BTC/Solana/Aptos are next,
  not started). Verified (every suite actually re-run this pass, not carried
  forward from an earlier entry): 41 unit + 50 mining e2e + 31 profile +
  72 usdt + 25 conversion + 29 store + 14 referrals + 15 admin + 43 kyc +
  9 push + 45 telegram + 5 proxy + 52 wallet + **8 custodySeeds (new) +
  17 deposits (new) + 21 withdrawal-controls (new) + 16 autowithdraw (was
  15)** = all green; api + web typecheck, `security-review` (2 findings,
  both fixed — see below).
  - **The architectural fact this rests on**: sweeping needs a private key
    capable of spending FROM a deposit address, which the existing xpub-only
    system (`custody.ts`) deliberately never held. `custodySeeds.ts` is the
    new, strictly bigger secret: the encrypted-at-rest PRIVATE half of the
    same account-branch key `custody.ts`'s xpub is the public half of, so a
    child it derives is *guaranteed* the same address custody.ts already
    showed the user (proven in `test:custodyseeds` against an independent
    signer, viem, not this codebase's own arithmetic). ⚠️ **Unlike the
    treasury key, this is not rotatable after a leak** — it can eventually
    derive every past and future deposit address on the chain. Recorded
    plainly, not hidden, same as every other custody trade-off in this repo.
  - Kept deliberately out of `custody.ts` itself (which still holds zero
    private key material and still says so) — the new file is a separate,
    narrower blast-radius surface, and `custodyPool.ts` (the ed25519/pool
    counterpart, unused until Solana/Aptos exist) is separate again so a pure
    unit test of the derivation math never has to open a live database
    connection (see `mining.test.ts`'s header for the exact node:test hang
    that split avoids).
  - **Deposit scanner** (`deposits/scanner.ts` + `adapters/evm.ts`): polls
    `eth_getLogs` for USDT `Transfer` events into any known deposit address,
    wired into the *existing* in-API timer next to mining settlement — no
    new process, no Redis, one global `pg_advisory_xact_lock('deposit-scan')`
    so two Railway instances can't double-scan. **Never credits before
    `depositConfirmations` blocks, and re-checks the block hash at credit
    time** — a block that had enough confirmations when first seen can still
    reorg before being credited; the re-check, not the depth filter, is what
    actually enforces it (`deposits/credit.ts`).
  - **Sweeper** (`deposits/sweep.ts`): two-phase per address
    (`pending → gas_sent → gas_confirmed → swept`) so a crash mid-sweep
    resumes instead of re-sending gas. **Never calls `postUsdt()`** —
    crediting already happened at deposit-confirm time; sweeping is pure
    treasury consolidation, enforced by that file having no ledger import at
    all. A dust floor (`sweepDustFloorMicro`, default $0.50) skips sweeps that
    would cost more in gas than they move (CUSTODY_SPEC.md § 2a's own pricing).
  - **Reconciliation** (`deposits/reconcile.ts`, hourly): treasury +
    known-unswept balance vs. what the ledger says we owe, written to
    `treasury_balance_snapshots` every tick; a shortfall raises a
    `reconciliation_mismatch` flag. New staff read endpoint,
    `GET /staff/mining/reconciliation`. ⚠️ **At the time this shipped, this WAS
    the alerting** — no Sentry, no paging, so a mismatch at 3am was silent
    until a human opened the panel. **Superseded 2026-08-12 — see the "STAFF
    PAGING OVER TELEGRAM" entry below**, which pages a staff Telegram group on
    exactly this flag (and every other high-severity one) the instant it's
    first raised. `CUSTODY_SPEC.md` § 3.5's "who is accountable at 3am" is
    narrower now, not closed — Telegram has no escalation, acknowledgement or
    rotation, so someone still has to be watching that chat.
  - **Withdrawal abuse controls**, shipped alongside (not after) — the
    compensating controls for having no per-request human approval below the
    auto-withdraw ceiling: a **rolling 24h auto-withdraw cap**
    (`autoWithdrawMaxPointsPer24h`, default 15,000 points) distinct from the
    per-request ceiling, and **step-up email confirmation**
    (`stepUpMinPoints`, default 4,000) reusing the existing `email_codes`
    machinery under a new `"withdraw"` purpose — no new channel.
  - ⚠️ **`security-review` caught two real races/gaps in this same pass, both
    fixed before landing:** (1) the 24h cap was read *before* the per-user
    lock in `tryAutoSettle`, so concurrent requests could each see a stale
    sum and jointly exceed it — moved inside `pg_advisory_xact_lock(userId)`,
    guardrail #8 applied to an aggregate read, not just a balance. (2) the
    step-up trigger checked only the current request's own amount, so
    splitting one large withdrawal into several requests each individually
    under the threshold never asked for a code — it now checks the rolling
    24h REQUESTED total, not the single request. Both have regression tests
    (`test:autowithdraw`'s new "rolling 24h cap" scenario,
    `test:withdrawcontrols`'s new "splitting does not skip step-up" scenario).
  - **Not done, on purpose, this pass**: TRC20/BTC/Solana/Aptos (phases 2–4
    of the plan); the offline ed25519 address-pool generation tooling;
    `PAYOUT_MODE` is still `manual` — none of this auto-sends anything real
    yet, same standing rule as the withdrawal signer above.

- **A DEPOSIT REFUND CAN NOW AUTO-SETTLE TOO (founder, 2026-08-06).** The
  founder's framing: "the money he deposited, he can withdraw it any time
  with no issues — the only restriction should be admin approval." That
  restated what `POST /usdt/refunds` already did (any address, capped only by
  what the user themselves deposited, a staff queue) — what was actually
  missing was that the staff step was **mandatory**, not optional, and the
  screen's disclosure line ("this is not your task money…") read like a
  refusal instead of information. Both are fixed. Verified: **8 new checks**
  (`npm run test:autorefund`) + `test:usdt` re-run at 72 (was 65) + all other
  suites green; api + web typecheck, eslint, web production build clean.
  - **`autoRefund.ts` mirrors `autoWithdraw.ts` exactly, one level narrower.**
    A refund request tries to settle itself the instant it's created, no
    staff click, when `PAYOUT_MODE=onchain` AND a treasury signer exists AND
    the amount is at or under `autoRefundMaxMicro` (default $5) — same shape
    as the withdrawal ceiling, in micro-USDT instead of points because a
    refund never touches the points ledger. Miss any gate and it drops into
    the **unchanged** manual staff queue, exactly today's live behaviour.
  - **This stays completely dormant right now, same as withdrawal
    auto-settle.** `PAYOUT_MODE` is still `manual` — nothing about this
    ships live until the signer is proven on testnet (see the entry above).
    Building it now, gated the same way, means the moment that switch is
    flipped for real, refunds go instant alongside withdrawals instead of
    needing a second build later.
  - **Reuses the withdrawal hold**, deliberately not a second flag: a staff
    member holding an account means "stop this account's automatic outgoing
    money," full stop, and a second independent hold would be a second place
    fraud response has to remember to check.
  - **The rolling 24h cap (`autoRefundMaxMicroPer24h`, default $15) is the
    same compensating control** CUSTODY_SPEC.md § 3.3 named for withdrawals —
    a per-request ceiling is where an attacker aims, repeatedly, just under
    it — read inside the same `pg_advisory_xact_lock(userId)` scope as the
    write, guardrail #8 applied to an aggregate read.
  - ⚠️ **`usdt_refund_requests.reviewed_by` had a `REFERENCES users(id)` FK
    that `withdrawal_requests.reviewed_by` never had — a real latent bug this
    surfaced immediately in testing.** `'system:auto'` is not a user row, so
    the first auto-settle would have failed the constraint in production. The
    FK is dropped (`db.ts`, migrated for existing databases the same way the
    `usdt_ledger` CHECK constraint above it is).
  - The refund screen now shows a distinct "Sent!" confirmation with the tx
    hash when a request settles instantly, instead of the "staff will send it
    in a few hours" copy every request showed before.

- **A GAS FEE, ON BOTH WAYS MONEY LEAVES (founder, 2026-08-08).** Sending USDT
  on BEP20 costs the platform real gas, and neither a withdrawal nor a deposit
  refund recovered any of it before this — a refund of the full requested
  amount was a guaranteed per-request loss. Percent-of-amount + a fixed floor
  (the founder's own example: 5% + $0.01 on a $1 request — a pure percentage
  undercharges on small requests, where the fixed gas cost is the bigger share
  of the total), admin-tunable in `/staff`, **off (0%/$0) by default**. New
  shared helper `api/src/fees.ts`.
  - **Applies to withdrawals (task/referral cash-out) and deposit refunds
    ("Get your USDT back") — explicitly NOT deposits going in**, per the
    founder: "only withdrawal need fee not deposit."
  - **Withdrawals**: the gas fee is ADDED to the pre-existing flat
    `withdrawal_fee_points` (unchanged, still admin-tunable separately) and
    stored in the SAME `fee_points` column, so every existing net/display/
    payout path (`autoWithdraw.ts`, `staff.ts`) already does the right thing
    with no further changes.
  - **Refunds had no fee mechanism at all before this** — new
    `usdt_refund_requests.fee_micro` column, snapshotted at request time for
    the same reason `fee_points` is (an Admin change mid-flight must not alter
    an in-flight payout).
  - ⚠️ **THE FEE COMES OUT OF WHAT GETS SENT, NEVER OUT OF WHAT GETS HELD.**
    On both flows, the user is still debited the FULL requested amount at
    request time (unchanged) — only the eventual payout (auto-settle in
    `autoRefund.ts`, or the amount staff are told to send in the `/staff`
    refund queue) is reduced by the fee. Getting this backwards would either
    double-charge the fee or silently let the account holding the money
    absorb it.
  - ⚠️ **A REJECTED REFUND RETURNS THE FULL GROSS AMOUNT, NOT THE DISCOUNTED
    NET.** Nothing was sent, so nothing should be kept — `staffMining.ts`'s
    reject handler was already crediting back `amount`, not `amount -
    fee_micro`, and stayed that way; there is a regression test for exactly
    this (`test:fees`).
  - **A fee that would consume the entire request is refused up front**, on
    both flows, rather than settling for a $0 or negative net.
  - Both screens preview the fee before the user submits (`GET
    /wallet/balance` and `GET /usdt` now also return `gasFeePercent` /
    `gasFeeFixedMicro`), but the fee actually charged is always re-computed
    and snapshotted server-side at request time — the preview is never
    trusted from the client.
  - Verified: new `test:fees` (24 checks: off-by-default, the founder's exact
    5%+$0.01 example on both flows, full-debit-not-net on both flows,
    reject-returns-gross, staff-queue-shows-net, fee-consumes-whole-request
    refused on both flows), plus `test:usdt` (72), `test:withdrawcontrols`
    (21), `test:autorefund` (8), `test:autowithdraw` (16) all re-verified
    green; api + web typecheck, eslint, web production build all clean.

- **AUTOMATIC ON-CHAIN PAYOUT IS LIVE (founder, 2026-08-08).** `PAYOUT_MODE=onchain`
  is now set on Railway — confirmed via `railway variables`, and the API has
  restarted with it. `TREASURY_KEY_ENCRYPTED`/`_SECRET` and
  `CUSTODY_SEED_EVM_ENCRYPTED`/`_SECRET` were already set. This is the
  activation `autoWithdraw.ts`/`autoRefund.ts` (2026-08-05/06) and the two
  admin-tunable ceilings above (`autoSettleSettings.ts`) were built for —
  every withdrawal or refund at or under its ceiling now signs and broadcasts
  for real, no staff click, the instant it's requested.
  - ⚠️ **THIS WENT LIVE WITHOUT THE TESTNET PROOF STEP.** Every other entry in
    this file about the signer says, repeatedly and on purpose, "must be
    proven on testnet before mainnet" — that rule existed for exactly this
    moment. The founder was told plainly, in those terms, immediately before
    doing it, and chose to go straight to mainnet anyway. Recorded here as a
    **decision with a date**, the same way the deposit-refund custody call
    and the USDT top-up decision are recorded elsewhere in this file — not a
    gap that was missed, a risk that was accepted knowingly.
  - The ceilings (`GET/PATCH /staff/settings` → `autoWithdrawMaxPoints` /
    `autoRefundMaxMicro`) are the only brake left on a single bad request —
    whatever they're set to right now is live money exposure per request,
    not a hypothetical. Check `/staff → Withdrawal fee` before assuming a
    number is still the old default.
  - ⚠️ **CONFIRMED THE SAME DAY: THE TREASURY HOLDS $0.** Address
    `0xbabE91B523747A3c96D35C43d240F4adcE9f9d22` (from `treasury_address_bep20`
    in `app_settings`) — checked live on-chain, 0 BNB and 0 USDT, and the
    reconciliation snapshot agrees (`onchain_balance: 0, ledger_total: 0,
    delta: 0` at 12:57 UTC). So right now, "auto-send is on" and "auto-send
    can pay anyone" are NOT the same fact — every qualifying request will
    fail to settle (no gas, nothing to send) and fall back to the manual
    queue via `tryAutoSettle`'s "never throws" guarantee, not lose money.
    This needs real funding before automatic payout does anything visible.
  - ~~⚠️ THE DEPOSIT SCANNER IS FAILING IN PRODUCTION RIGHT NOW, SEPARATELY.~~
    **FIXED 2026-08-12 — see the "still blocked on the founder" section
    further down for the full verification.** Railway logs showed a repeating
    `Deposit scan tick failed … eth_getLogs failed: limit exceeded` every
    ~20s; commit `c63d0ed` shrank the block range adaptively and reordered the
    default endpoints by measured behaviour, and `RPC_BEP20` on Railway now
    leads with a real Alchemy endpoint. Confirmed live: zero scan-tick errors
    across 100+ ticks post-deploy.

- **GAS IS THE USER'S OWN RESPONSIBILITY, NOT TREASURY'S, NOT A USDT FEE
  (founder, 2026-08-08, same day, later same evening).** Found by tracing
  three stuck "Get your USDT back" requests from live screenshots: the relay
  (built earlier the same day, entry above) funded gas by sending
  **treasury's own BNB** to the user's derived address first — so the
  confirmed-$0 treasury silently blocked refunds too, even though a refund
  never touches treasury money. One relay job retried this **65+ times,
  forever**, with no terminal state and no staff alert — exactly what "left
  at 'sending' so staff see it" was supposed to prevent, except nothing ever
  told staff. Root-caused via a read-only query against the live DB
  (founder's explicit go-ahead) before any code changed, per the founder's
  own instruction: trace the money before touching the architecture.
  Verified: `test:payoutrelay` 48 (22 new) + `test:usdt` 72 + `test:fees` 24
  + `test:withdrawcontrols` 21 + `test:autorefund` 8 + `test:autowithdraw`
  16 = 189 green; api+web typecheck, eslint, web build clean; confirmed live
  on the actual stuck request post-deploy (see below).
  - **`payoutRelay.ts`'s treasury-BNB-funding hop is GONE.** Refunds now
    have **zero treasury involvement, period** — the user's own address
    already holds the USDT (verified on-chain, unchanged) and pays its own
    gas to forward it. Withdrawals keep the USDT prefund leg (unavoidable —
    that money only ever existed at treasury) but the forward leg needs the
    **user's own BNB**, not treasury's.
  - **The route checks the user's own address's live BNB balance BEFORE any
    debit** (`routes/withdrawals.ts`, `routes/mining.ts`) — insufficient gas
    refuses the request outright, exactly the founder's spec: "the withdrawal
    must NOT start, the USDT must NOT be deducted." A production relay job
    can also re-check defensively right before signing (BNB can be spent out
    of the address between request and send).
  - **A relay job now gives up.** `relayMaxAttempts` (15, ticks every 20s ≈
    5 min) marks a job `failed` instead of retrying forever, and — the
    founder's own required test case, "no money disappears" — **auto-credits
    the held money back** whenever no value has actually moved yet. ⚠️
    **`safe` is the one thing standing between this and a double payment** —
    true only while nothing has moved (refund: always, up to a reverted
    forward tx; withdrawal: only before the prefund leg confirms). Once
    treasury's USDT genuinely sits at the user's own address, auto-refunding
    points on top of that would double-pay — that case is left for staff to
    check the chain, deliberately not automated.
  - **The 0.05 USDT "network fee" is gone from the relay path.** `fees.ts`'s
    gas-fee surcharge doesn't apply once the user's own BNB is what's really
    paying gas — no more "we sent 0.95 after a 0.05 fee" for a $1 refund.
    Untouched on the manual/direct-treasury fallback, where treasury really
    is paying real gas and really does recover it this way. The live
    `gas_fee_percent`/`gas_fee_fixed_micro` settings were reset to 0/0 as
    part of shipping this (0/$0.05 → 0/$0).
  - **`/wallet`'s BNB row is real now**, not "Coming soon" — every user's own
    derived address (`custody.ts`) can genuinely hold BNB since the relay
    work landed. The refund/withdraw screens show the live gas-wallet status
    before submit, with the founder's own copy for "not enough": *"You need
    BNB in your wallet to pay the network fee. Please deposit BNB to your
    RoziPay wallet before withdrawing USDT."*
  - **Confirmed live, post-deploy:** the stuck request auto-resolved on its
    own next tick — `payout_relay_jobs` flipped to `failed` (286 accumulated
    attempts crossed the new cap), `usdt_refund_requests` flipped to
    `rejected` with `reviewed_by = 'system:auto'`, and the full $1.00 landed
    back in the user's balance via a `usdt_ledger` credit — no manual staff
    click needed, matching exactly how the founder had already resolved the
    other two by hand.
  - ⚠️ **Two of the three original stuck requests were already fine** before
    any of this shipped — the founder had rejected them by hand in `/staff`,
    which is why the visible balance was $0.04, not $0 or something inflated.
    Only the third (still "Sending") was actually broken; recorded here so
    it isn't mistaken for a bigger loss than it was.

- **THE WALLET SCREEN BECOMES A REAL WALLET: DEPOSIT/WITHDRAW, ONE USDT
  TOTAL (AVAILABLE+LOCKED), UNIFIED HISTORY, A REAL BNB WITHDRAW (founder,
  2026-08-08, third pass).** A detailed spec asked `/wallet` to read like an
  ordinary crypto wallet app. Verified: `npm run test:usdt` is now **85**
  checks (was 72, +4 balance-math +9 BNB withdraw), all other suites
  unchanged and green (182 re-run: usdt+withdrawcontrols+autowithdraw+
  autorefund+payoutrelay+deposits, all pass); api+web typecheck, eslint, web
  production build all clean.
  ⚠️ **SUPERSEDED 2026-09-03 — points are OUT of Total Balance again, see the
  "THE WALLET USDT TOTAL DROPS POINTS AGAIN" entry near the end of this
  file.** The "+ withdrawable task/referral points" half of the formula
  right below no longer holds; deposit + earned USDT only.
  - ⚠️ **THIS REVERSES THE 2026-07-30/08-03 "ROZI-ONLY" WALLET DISPLAY
    DECISIONS, ON THIS ONE SCREEN, DELIBERATELY.** `/wallet`'s headline is
    USDT again: **Total Balance = real deposited USDT (`usdt_ledger`) +
    withdrawable task/referral points, at the existing real 1000pts=$1
    rate** — confirmed with the founder before building, because it looks
    like the exact thing guardrail #7 forbids and isn't: guardrail #7 is
    about **ROZI**, which still has no fixed rate and is never folded into
    this number. Points already convert to USDT at a real, fixed rate used
    at actual payout — folding them into one wallet figure is not a new
    liability, just the display the founder wants back on this one screen.
    ROZI's own balance still reads "Coming soon" on `/wallet` (that decision
    stands) — only the USDT headline reverses.
  - **Available / Locked is a derived read, not a new ledger.**
    `usdtAvailableMicro = usdtBalanceMicroOf(user) + (points ≥
    minWithdrawPoints ? pointsAsUsdt : 0)`; `usdtLockedMicro` is the
    points-derived half otherwise. No new table, no unlock event — crossing
    the $1 minimum flips Locked to Available on the very next read, for
    free. `GET /wallet/balance` (`api/src/routes/app.ts`) carries the three
    new fields; the real `usdt_ledger` balance is unconditionally Available
    (it has no locking concept today, and none was invented).
  - **A real BNB Withdraw, not just Deposit** — confirmed explicitly with the
    founder, since there was no existing capability for a user to pull BNB
    back out (it's gas for the user's own relay address, per the 2026-08-08
    "gas is the user's own responsibility" entry above). `bnbWithdraw.ts`
    reuses the exact signing primitive the existing USDT refund relay
    already uses (`deriveChildPrivateKey`, `payoutRelay.ts`) — a plain
    native-value `sendTransaction`, not an ERC-20 transfer, **zero treasury
    involvement and zero ledger entry**: the balance moved is the address's
    own live on-chain balance, so a failed job needs no compensating credit,
    because nothing was ever debited internally. New table
    `bnb_withdrawal_requests`, gated by a **partial unique index allowing
    only one in-flight request per user** (the amount check is a live
    balance read, so two concurrent requests could otherwise both pass it).
    ⚠️ **No manual fallback exists for this route, unlike USDT** — a BNB send
    can only be signed by the relay, so `POST /wallet/bnb/withdraw` refuses
    outright (400) rather than queue a request when `PAYOUT_MODE` isn't
    `onchain`, instead of accepting one that could sit forever.
  - ⚠️ **Caught in review before landing: `advanceBnbWithdrawal` was missing
    the exact "load-bearing check" `payoutRelay.e2e.ts` exists to prove** —
    `relayAvailable()` alone doesn't know about `PAYOUT_MODE`, so a job
    could have signed and broadcast for real even with the founder's switch
    left on `manual`, if every key happened to be configured. Fixed to match
    `advanceRelayJob`'s own guard exactly, with the identical regression
    test (`fully configured signing keys, but payoutMode MANUAL => still
    refused`). **Also caught**: the route originally kicked off signing
    synchronously from inside the request handler (`void
    advanceBnbWithdrawal(id)`), unlike every other relay path in this
    codebase, which leaves that entirely to the background tick — fixed to
    match, both because a request handler reaching the real chain over the
    network is a real-world latency/reliability smell this codebase avoids
    everywhere else, and because it's what makes the e2e suite provable
    without ever touching BSC (same convention `payoutRelay.e2e.ts`'s header
    states outright).
  - **Unified History, still a display merge (guardrail #7's own pattern,
    extended).** `wallet/page.tsx`'s existing `unify()` — already documented
    as "two ledgers, interleaved by time, nothing written" — now folds in
    THREE more sources: `/withdrawals` (real USDT payouts, native amount +
    tx hash, replacing the ROZI-converted row the points ledger alone would
    have shown), `GET /usdt`'s `topups`/`refunds` arrays, and the new BNB
    withdrawals. Extracted into `web/src/lib/walletHistory.ts` +
    `components/{TxDetailSheet,HistoryList}.tsx` so `/wallet`,
    `/wallet/usdt`, `/wallet/bnb` and `/wallet/rozi` all agree on how a row
    is labelled and detailed — one function, four screens, not four copies.
    Task/referral/adjustment rows are UNCHANGED (still ROZI, the app-wide
    convention) — only rows that are real USDT/BNB movement switch to their
    native currency, because that's what actually moved.
  - **Deposit/Withdraw buttons are a relabel, not new plumbing.** The
    existing Send/Receive chooser-sheet mechanism (ROZI transfer vs. real
    USDT flows, founder 2026-08-05) is untouched — only the trigger labels
    changed (Send→Withdraw, Receive→Deposit, same up/down-arrow icons,
    which already matched the new words) — plus one new row for BNB
    withdraw in the Withdraw sheet. Nothing about ROZI peer-to-peer transfer
    or the existing USDT cash-out/refund/deposit flows was removed or
    rebuilt.
  - **New dedicated token pages**: `/wallet/usdt` (Available/Locked/Total,
    deposit address + QR + copy, USDT-only history), `/wallet/bnb` (live
    balance, same deposit address as USDT since it's the same chain, the
    real withdraw form, BNB-only history), `/wallet/rozi` (mining balance,
    links to the existing `/mine/send`/`/mine/receive`, ROZI-only history —
    `/mine` remains ROZI's real home and is untouched). QR codes render
    client-side (new `qrcode` npm dependency, `components/QrCode.tsx`) — no
    network call, so a deposit address never leaves the browser to render.
  - **Notifications**: added, using the existing `sendPushToUser`
    box-after-commit pattern, for deposit-credited (both the on-chain and
    manual-confirm paths), USDT withdrawal/refund submitted, and all three
    BNB withdrawal states — all low-frequency, high-value events. **Per-task
    and per-mining-tick push notifications were deliberately NOT added**,
    confirmed with the founder first: the existing design is stated as
    "sent on exactly four events, never marketing" specifically to avoid
    notification fatigue, and task/mining credits fire far more often than
    that. A "Push Notifications" ON/OFF row was added to
    `/profile/settings`, reusing `NotificationsCard`'s existing
    subscribe/unsubscribe logic — no new permission-request code.
  - ⚠️ **UNRELATED PRE-EXISTING BUG FOUND AND FIXED WHILE VERIFYING THIS ON A
    FRESH DATABASE**: `db.ts`'s migration chain had `ALTER TABLE rigs ADD
    COLUMN IF NOT EXISTS base_cost_usdt BIGINT` sitting in `MIGRATIONS`
    (runs 2nd), while `rigs` itself is created in `MINING_SCHEMA` (runs
    3rd) — `initDb()` would fail outright on a genuinely fresh database
    (`relation "rigs" does not exist`), before the API could serve a single
    request. Invisible on every developer's machine because nobody's local
    `data/pg` had ever been fresh since that line was added — it was always
    already-migrated. This would have broken a brand-new Railway database
    or a new contributor's first `npm run dev` identically. Moved the
    `ALTER TABLE` to sit right after `rigs` is created in `MINING_SCHEMA`.
    Confirmed fixed by deleting the local `data/pg` (git-ignored, disposable)
    and re-running the entire test suite from an empty database — 20 suites,
    every one green, which is a stronger check than existed before this pass
    (nobody had exercised a truly fresh boot before).
  - **Scope cuts, stated up front:** no generic blockchain-explorer indexer
    for arbitrary external wallet activity (the user's derived address is a
    custody/relay address this system controls and already watches for
    everything it originates — deposits, withdrawals, refunds, BNB sends —
    each with a real tx hash; a full external-chain indexer is a separate,
    much larger project). No admin-configurable ROZI valuation (the
    request's own spec says not to hard-code it yet) — the Total Balance
    formula has exactly one place a future ROZI-valuation term would slot
    in.

- **STAFF-PANEL CLEANUP + THE "ONE CURRENCY" ANSWER (founder phone review,
  2026-09-02).** A long voice-memo list of ~24 asks about `/staff`. Plan +
  full checklist: `~/.claude/plans/immutable-sleeping-pixel.md` and the memory
  file `founder-review-2026-09-02.md`. Verified: api + web typecheck, eslint,
  web production build (37 routes); e2e re-run green from a fresh DB —
  messagesadmin 14, moneyadmin 82, usersadmin 50, referrals 26, mining:e2e 65,
  telegram 45, analytics 46, stage4 48, stage5 67, stage6 70, deposits 37,
  usdt 85, disbursements 65, permissions 17, mining unit 42; `security-review`
  — no findings.
  - **Points vs ROZI — the answer is vocabulary, not a data-model change.**
    The two ledgers (cash Points / minted ROZI, 21M cap) cannot merge —
    guardrail #7. The earner app ALREADY shows one currency (ROZI); Points are
    an internal unit rendered as ROZI via `formatPointsAsRozi`. So the fix was
    to make the STAFF panel tell the same story: "Boosters (the POINTS sink)"
    → "Speed boosters" (paid with task earnings, shown to users as ROZI);
    "ROZI → Points conversion" → "Cash out mined ROZI (conversion window)";
    plain-English `help:` on every referral-hashrate / cap / conversion knob,
    a worked ROZI/day example on the task boost, and a new Mining → **"How it
    works"** tab with an explainer + a live `MiningSimulator` (mirrors
    `computeHashrate` / `piBaseRateFor`, uses saved settings, shows the halving
    cliff as user count rises). New `docs`-style content lives in the tab, not
    a separate file. See `points-vs-rozi-model.md`.
  - ⚠️ **RECONCILIATION STOPS RE-FLAGGING A RESOLVED SHORTFALL.**
    `deposits/reconcile.ts` `shouldRaiseReconFlag()` remembers the last-alerted
    `|delta|` per chain in `app_settings` (`recon.lastAlert.<chain>`) and only
    raises a NEW `reconciliation_mismatch` flag / pages staff again when the
    shortfall gets **materially worse** (> `MISMATCH_THRESHOLD_MICRO` beyond the
    last) or a week has passed. `flagOnce` only ever deduped against *unresolved*
    rows, so resolve-then-re-detect paged staff every hour forever (the live
    `bep20: −2.00` case). The marker is cleared when `delta >= 0`.
  - **Suspending an account auto-closes its open fraud flags**
    (`setUserStatusOne`, `resolved_by = 'system:suspended'`), and `GET
    /staff/fraud` + the dashboard `fraudOpen` count both exclude suspended
    users' flags — so a suspended farm account stops keeping the tile red.
  - **The dashboard hides resolved signals instead of turning them green**
    (`DashboardOverview.tsx`): `bnbFailed` / `relayFailed` / `fraudOpen` /
    `reconciliationShortfall` tiles render ONLY while `open > 0`. Plus a
    "Find the over-credited user" button on the treasury-shortfall callout →
    new `GET /staff/mining/reconciliation/suspects` (the
    `usdt_topups ⟕ chain_deposits ON tx_hash` join) → one-click negative
    `usdt-adjust` + re-check.
  - **Strong tile borders everywhere** — new `--color-line-strong` token +
    shared `StatCard` / `Framed` / `DateField` in `staff/primitives.tsx`;
    ~8 local card impls bumped to `border-2 border-line-strong`. Money-queue
    filter chips are **Title Case** and every queue **defaults to "All"**
    (`StatusTabs`, `useQueueControls(q, "all")`).
  - **Money & payouts IA**: "BNB out" → "BNB withdrawals", moved next to
    "USDT withdrawals"; queues relabelled "USDT deposits/refunds"; new
    "USDT top-up" sub-tab (`UsdtTopupConfigPanel`, still PATCHes
    `/staff/mining/settings`) moved out of the Mining tab. Money Overview's
    empty "Latest withdrawals" replaced by "Recent money out" merging
    withdrawals + refunds + BNB.
  - **Messages "Send" flow**: the disabled button now names what's missing
    ("choose who gets it · add a title · add a message") and reads "Send
    message" instead of "Pick who gets it"; content-card + allocation dates
    use the native `<input type="date">` `DateField`.
  - **Growth**: "Per network" is its own sub-tab (`PerNetworkPanel`); Top
    partners lists **every** inviter (≥1 invite, was ≥1 paid), shows active
    %, and expands to the invitee list (`GET /staff/referrals/:id/invitees`).
  - **Real Telegram identity**: new `users.telegram_username` /
    `telegram_name`, captured from the signed initData in `auth.ts`
    (`findOrCreateTelegramUser`), refreshed on every login. New
    `displayIdentity()` in `web/src/lib/format.ts` (@handle → @tg-username →
    name → email, never a raw `@telegram.local`) wired into top miners,
    growth boards, top partners, invitee lists. ~~⚠️ Fraud / withdrawals /
    support / audit tables still show raw email — not wired this pass.~~
    **CLOSED same day, see the follow-up entry below.**
  - **`piHalvingUsers`** edits as add/remove rows (`MilestoneEditor`),
    serialised back to the CSV string the API still takes.
  - **Staff alerts** merged into "Staff & roles" as a sub-tab (the standalone
    section is gone); the panel now carries the exact `getUpdates` steps to
    obtain `TELEGRAM_ALERT_CHAT_ID`.
  - ⚠️ **STILL NEEDS THE FOUNDER, IN PROD (both one clicks):** (a) the live
    `bep20: −2.00` shortfall — open the dashboard callout → "Find the
    over-credited user" → Adjust, then Re-check; the recurrence is already
    fixed in code so it won't come back. (b) the one FAILED relay job (286
    tries, money already auto-returned) — open Money → Relay jobs → the row →
    "Mark as handled". No DELETE route was added (append-only spirit); "handled"
    is the clear path and the tile then disappears. **DONE — founder confirmed
    both, same day, see the follow-up entry below.**

- **THE SAME FOUNDER REVIEW, RE-VERIFIED AND THE LAST GAP CLOSED (2026-09-02,
  later the same day).** The founder re-sent the full ~26-item voice memo
  asking for a completion audit rather than assuming the earlier "DONE" claim.
  Every item was re-checked against the LIVE CODE (grep + read, not the
  changelog) rather than trusted from this file — borders, Title-Case
  defaulting-to-"All" chips, the send-message button, the Growth "Per network"
  sub-tab, the Money IA, `piHalvingUsers` as rows, Boosters/Conversion
  relabels, and Staff alerts under Staff & roles all confirmed present in the
  code as written above. The founder separately confirmed both one-click prod
  actions (the `bep20: −2.00` adjust, the 286-try relay job marked handled)
  are done.
  - **The one real gap found — `displayIdentity` not reaching fraud /
    withdrawal / support / audit — is now closed.** Every SELECT behind those
    screens (`api/src/routes/staff.ts`: withdrawals, BNB withdrawals, relay
    jobs, fraud flags, the support-ticket list + detail, the User 360 user row
    + `invitedBy` + `invitees`; `api/src/routes/staffMining.ts`: USDT topups +
    refunds) now also selects `username`, `display_name`,
    `telegram_username`, `telegram_name`. Every render that used to show a raw
    `userEmail`/`email` in those tables now calls `displayIdentity()`:
    `MoneyQueues.tsx` (withdrawals/deposits/refunds/BNB/relay rows + detail
    titles, via a shared `identityOf()` helper for the camelCase money-queue
    shape), `staff/page.tsx` `FraudPanel`, `SupportQueue.tsx` (ticket list) +
    `staff.tsx` `TicketThread` (the "who you're replying to" header), and
    `UserDetail.tsx` (page title/breadcrumb, "Invited by", the invitees
    table). The `email` FIELD itself is left visible where it already had its
    own row (e.g. User 360's "Email" field, CSV exports) — only the identity
    HEADLINE changed.
  - ⚠️ **Noted but deliberately left alone**: `Disbursements.tsx` (the
    admin-payout-batch screen) has the same `userEmail`-only pattern in two
    spots. Not named in the founder's original list, so left for a future
    pass — fix it the same way (add the four columns to whatever query feeds
    `EligibleReward`, then `displayIdentity()` in the render) if it comes up.
  - Verified: api + web typecheck, eslint, web production build (37 routes)
    all clean; `test:usersadmin` (50), `test:moneyadmin` (82),
    `test:messagesadmin` (14), `test:admin` (15), `test:stage6` (70) all green
    — the fraud/support/withdrawal query changes touch none of their
    assertions.

- **PRODUCT AUDIT PASS: THE MONEY SCREENS STOP CONTRADICTING THEMSELVES
  (founder, 2026-08-09).** A 75-part product/UX/backend brief was audited against
  the real codebase; nine defects were fixed. The two headline asks — a general
  task marketplace (brief parts 8–19) and an admin operations rebuild (parts
  32–48) — were **deliberately NOT started**, because they are schema work and
  half-starting them is worse than scoping them. Verified: api + web typecheck,
  eslint, web production build (24 routes) all clean. ⚠️ The 20 backend e2e
  suites were **not re-run** (they need a live Postgres); nothing in this pass
  touched backend code.
  - ⚠️ **`/wallet/rozi`'s Send button was a dead end and had been since the page
    shipped.** It offered "Withdraw" → `/mine/send`, and NEITHER screen checked
    `transfersEnabled` — the user picked a recipient, typed an amount, and only
    the API refused it at submit (`routes/mining.ts`). `/wallet`'s chooser sheet
    gated this correctly; this route walked past it. Now disabled-with-a-reason,
    matching the chooser. **If you add a third entry point to a transfer screen,
    gate it there too** — the gate is per-entry-point, not on `/mine/send`.
  - **ROZI's two buttons are Send/Receive, never Withdraw/Deposit.** Those words
    mean real money crossing a chain everywhere else on that screen, and ROZI
    cannot leave the system at all. "Withdraw ROZI" next to a real USDT withdraw
    is a cash-out promise for a token the road map refuses to price.
  - ⚠️ **SUPERSEDES the 2026-08-03 "no ROZI balance on /wallet" decision.** The
    row said "Coming soon" with no number, one tap above `/wallet/rozi` showing
    a real balance — the screen contradicting itself. What is coming soon is
    TRANSFERS. ⚠️ **THE ROW SHOWS MINED ROZI ONLY, never `totalRoziMicro()`** —
    the task/referral half is already inside the Total Balance card above it, as
    USDT, so the combined figure would put the same money on screen twice.
  - **Standard wallet status words**: `Added/Waiting/Not added` →
    `Completed/Pending/Processing/Rejected/Returned`, in both definitions
    (`components/ui.tsx` `statusMap` ↔ `lib/walletHistory.ts` `STATUS_TEXT`) and
    the legend. ⚠️ **`refunded` IS NOT "Failed", and that was the founder's own
    suggested word.** A rejected withdrawal or a relay job that gave up credits
    the full amount straight back; "Failed" there tells a user their money is
    gone when it is already in their balance.
  - **Task badge "Checking" → "Under review"** — a proof sits in a HUMAN staff
    queue and the wait is hours; "Checking" reads as automatic and instant.
  - ⚠️ **THE CASH-OUT PROMISE IS REMOVED FROM EVERY SCREEN.** "Soon you will be
    able to cash out your ROZI" is gone from `/mine` AND home
    (`wallet.rozi.notcash`) together — the founder's own instruction, "do not
    promise future cash-out unless that is guaranteed", against an unfunded
    treasury, on the app's most-visited screen. The old rule ("one promise,
    three screens, no version that says more") still holds and the promise is
    now nowhere. **Do not put it back on one screen alone.**
  - History filters: three permanent rows → the token row plus one **Filter**
    control that names its own current value, so a filter cannot be left on with
    the row that set it collapsed out of view.
  - Copy pass on 14 strings in the deck (wallet subtitle, tasks subtitle —
    de-ROZI'd so it survives a USDT-paying task, withdrawal address, sign-out,
    support, Telegram, ID-check-off, "Your mining speed", "Roadmap").
  - **A stale comment claimed the opposite of its own string**: the deck
    asserted "the word KYC appears nowhere a user can see it" directly above
    `"Verify your KYC"`. The STRING was right (founder, 2026-08-01: KYC is the
    familiar word in these markets); the comment predated the decision. Fixed
    the comment, not the string — cross-linked so it cannot drift again.
  - ⚠️ **NOT BUILT, AND THE ORDER MATTERS: brief parts 15 + 16 (per-campaign
    revenue tracking + budget control) SHOULD COME FIRST** of the task-engine
    work. Today `tasks` has one reward field, one country string, and one
    free-text proof box — no campaign budget means no auto-pause, so the first
    partner who buys 2,000 conversions can be given 20,000. Adding a budget
    column now is free; retrofitting it onto live campaigns is a migration under
    pressure. Then: configurable input fields (unlocks the task detail page),
    then categories/targeting, then the review dashboard.

- **THE ADMIN REBUILD, STAGES 1–3: PERMISSIONS, FEATURE FLAGS, ANALYTICS
  (founder, 2026-08-09).** The admin operations rebuild the audit entry above
  deliberately declined to half-start (brief parts 32–48) is now started
  properly, in three commits. Verified this pass by re-running **everything**,
  not carrying results forward: **23 suites, 666 checks, 0 failures** (41 mining
  + 16 permissions + 8 flags + 8 custody + 8 signer + 8 custodySeeds unit;
  40 analytics + 85 usdt + 52 wallet + 50 mining + 48 payoutRelay + 45 telegram
  + 43 kyc + 31 profile + 29 store + 25 conversion + 24 fees + 21
  withdrawControls + 17 deposits + 16 autoWithdraw + 15 admin + 14 referrals
  + 9 push + 8 autoRefund + 5 proxy e2e); api + web typecheck, eslint, web
  production build (28 routes) all clean.
  - **Permissions are named, not ranked** (`api/src/permissions.ts`). A route
    used to say `staffGuard(["manager","admin"])` — the gate WAS the role, and
    the three roles were a strict ladder. A ladder cannot express a Finance
    person who pays withdrawals but must not edit a task campaign, or a Task
    Manager who is the reverse: neither contains the other, and no number of
    extra rungs fixes that. The gate is now an `area.verb` permission and a role
    is a bundle of them; adding a role is one line in `ROLE_PERMISSIONS` and
    touches no route.
    ⚠️ **THE THREE LIVE ROLES KEEP EXACTLY THE REACH THEY HAD.** There are real
    accounts holding `agent`/`manager`/`admin`, and a permissions refactor is the
    easiest place in a codebase to silently widen one. Every permission carries
    the **lowest legacy role that already held it** (`tier`), and the three role
    bundles are built *from those tags* — the old ladder is reproduced by
    construction, not by hand, and `test:permissions` asserts it.
  - **`write: true` is stated per permission, never inferred from the name.**
    `users.list` reads, `users.status` writes, and no naming convention survives
    forty permissions. It is what makes "an analyst is read-only" a property the
    tests can check instead of a promise in a comment.
  - **Feature flags delegate to the switch that already exists**
    (`api/src/flagsCore.ts` — split from `flags.ts` so the unit test can read the
    registry without opening a database connection; same node:test hang
    `mining/core.ts` documents). ⚠️ **A SECOND SWITCH FOR THE SAME FEATURE WOULD
    BE WORSE THAN NO SWITCH** — two controls, disagreeing, with no way to tell
    from the panel which one is actually stopping the thing. Five of the fourteen
    features already had a working, tested switch (ROZI transfers, ads, USDT
    deposits, ROZI conversion, the ID check); those flags point at the **existing
    key, unchanged**. Only genuinely new flags get a new row.
  - ⚠️ **A FLAG MUST DO SOMETHING, AND THE DISPLAY-ONLY ONES SAY SO IN THE
    PANEL.** A switch that reads back what you set but changes no behaviour will
    be trusted in an incident. Every flag names its enforcement point in a
    comment; the ones that only hide a feature in the app without making the
    route refuse are labelled `displayOnly` on screen rather than pretending.
    Defaults are ON for everything already live, so deploying the file changed
    nothing about the running system.
  - **Analytics are DERIVED, never a second source of truth**
    (`api/src/analytics.ts`). No pipeline, no event stream — a KPI that disagrees
    with the ledger is worse than no KPI, and counting things twice is the
    fastest way to get one. The single exception is `user_activity_days`, because
    DAU genuinely cannot be derived from anything already stored.
  - **`touchActivity()` is fire-and-forget and memoised per user per day per
    process.** It is called from the guard every earner request passes through;
    without the memo, an app that polls mining every few seconds would issue
    thousands of no-op writes per user per day. Errors are swallowed on purpose —
    an analytics row must never fail a request that was otherwise going to
    succeed — and the memo entry is *deleted* on failure so the day gets retried
    rather than lost.
  - ⚠️ **A REAL SQL BUG SHIPPED PAST TYPECHECKING AND ONLY A LIVE-POSTGRES TEST
    CAUGHT IT**: the network-margin query selected `networks.label`, a column
    that does not exist (it is `name`). TypeScript cannot see inside a SQL
    string, so the build was clean and the endpoint would have 500'd the moment
    an admin opened the dashboard. It is why this stage's effort went into a
    40-check suite driving real Postgres rather than more screens — and why the
    e2e suites, which the previous pass skipped, were all re-run here.
  - ⚠️ **THE DASHBOARD HAS NOT BEEN LOOKED AT IN A BROWSER.** Chart geometry is
    verified numerically across eight edge cases (including all-zero and
    single-point series) and the colours are validated by script, but nobody has
    rendered it and looked — that needs a logged-in admin session against real
    data. Treat the visual layer as unverified until someone does.
  - **Still not built, and the order still matters**: Stage 5 (machines,
    referral admin, leaderboard — 38/41/42), Stage 6 (notifications, support,
    home content — 39/40/43), Stage 7 (the task-section work). ⚠️ **Brief parts
    15 + 16 (per-campaign budget + revenue tracking) remain the highest-value
    item in that list** for the reason the entry above gives: no budget means no
    auto-pause, so the first partner who buys 2,000 conversions can be given
    20,000. (Stage 4 landed — see the entry below. **Stages 5 and 6 have since
    landed too**, and parts 15+16 shipped — see the last entries in this file.)

- **THE ADMIN REBUILD, STAGE 4: USER DETAIL, DEPOSITS, WITHDRAWALS — AND TWO
  REAL DEFECTS FOUND WHILE BUILDING IT (founder, 2026-08-09).** Brief parts
  34/35/36. Verified: new `npm run test:stage4` (**38 checks**) plus every
  suite that touches a changed endpoint re-run green (85 usdt + 48 payoutRelay
  + 40 analytics + 24 fees + 21 withdrawControls + 17 deposits + 16
  autoWithdraw + 16 permissions + 15 admin + 8 autoRefund); api + web
  typecheck, eslint, web production build all clean. **Running total: 704
  checks.**
  - ⚠️ **DEFECT 1 — THE FINANCE ROLE COULD NOT DO ITS JOB.** `finance` holds
    `deposits.decide` and `refunds.decide`, but the only screens rendering
    those two queues (`TopupPanel`, `RefundPanel`) sat inside `MiningPanel`,
    and the sidebar gates the Mining section on `mining.manage` /
    `machines.manage` — neither of which Finance has. So the role created
    specifically to own money-in and money-out **could not reach the
    deposit-confirm or refund-payout screens at all**. They now live under
    Money & payouts, each gated on its own permission. **Deposits are money,
    not mining** — that is why the placement was wrong, and the comment left
    at the old site says so.
  - ⚠️ **DEFECT 2 — THE WITHDRAWAL QUEUE SHOWED THE GROSS AND THE "MARK PAID"
    PROMPT NEVER SAID HOW MUCH TO SEND.** Manual payout is a human reading
    that screen and sending USDT by hand, so with a fee configured they send
    `amount` and the platform silently eats the fee it just charged, on every
    withdrawal. `GET /staff/withdrawals` now serves `feePoints` + `netUsdt`
    per row and a `pendingTotal` (net — the number to fund the treasury
    with), and the prompt names the amount **and** the address, the way the
    refund queue already did. **Latent, not live**: the gas fee and flat fee
    are both 0 right now, so nothing has been overpaid — but the settings
    panel invites an admin to set one.
  - ⚠️ **THE `networks.label` BUG CLASS BIT AGAIN, IN THE SAME SESSION, AND
    ONLY THE TEST CAUGHT IT.** The new withdrawal-history query was written
    against `chain` / `address` / `note`; the table really holds
    `payout_rail` / `payout_address` / `review_note`. Three wrong column
    names, api typecheck **clean**, and the user-detail screen would have
    500'd on open. They are aliased now, with a comment saying which is the
    stored name and which is the served one. **Assume any new SQL is wrong
    until a live query has run it** — that is now twice in two stages.
  - **Part 34, the user detail screen, answers "who is this" in one place.**
    `GET /staff/users/:id` gained: all three balances, withdrawal history
    (with the signed-address proof), a paid-out summary counted from `paid`
    rows only and **net of fees**, both referral directions, and support
    tickets. Every field is DERIVED from a table that already exists —
    `analytics.ts`'s rule — so there is no new counter to drift from the
    ledger.
  - ⚠️ **THREE BALANCES, THREE BOXES, NEVER A TOTAL** (guardrail #7). Points
    and USDT credit have real rates; ROZI has none by design. A combined
    figure on a staff screen would invent one, and it would then be quoted to
    a user in a dispute. There is a check asserting no total is served. And
    all three are shown *because* showing one of three is how a support agent
    tells someone their money is gone while it sits on a ledger the screen
    did not read.
  - **The hold is served as a decided boolean (`withdrawalHeld`), not a date
    string.** The panel must not re-derive "is this still in force" and get it
    wrong; a lifted hold rendered as active is a user told they cannot be paid
    when they can. Open-ended / expired / future-dated are each tested.
    The badge says **"payouts held"**, never "suspended" — a held account
    still mines and earns, and conflating the two is a wrong answer to a
    ticket.
  - **A caught-before-render styling bug**: the new badges used
    `bg-warn-tint` / `text-warn`, and there is no `warn` token in the design
    system — it is `pending`. It would have rendered unstyled. Worth noting
    because the dashboard from Stage 3 is still unviewed in a browser, and
    this is the second piece of evidence that the visual layer is where this
    work is least verified.

- **THE ADMIN REBUILD, STAGES 5–6: MACHINES, GROWTH, MESSAGES, SUPPORT, HOME
  CONTENT (founder, 2026-08-09).** Brief parts 38/41/42 and 39/40/43 — every
  remaining permission that existed with **nowhere to spend it**. `marketing`
  held `referrals.manage`, `leaderboard.manage`, `notifications.send` and
  `content.manage` and could not reach a single screen; the booster endpoints
  had been permission-gated and callable since the mining build with **no UI
  at all**. Same defect class as Finance in Stage 4. Two new sidebar sections
  (**Growth**, **Messages & content**). Verified by re-running **everything**
  from a genuinely fresh database: **29 suites, 879 checks, 0 failures**
  (23 e2e — stage6 70, stage5 55, stage4 48, usdt 85, wallet 52, mining 50,
  payoutRelay 48, taskbudget 46, telegram 45, kyc 43, analytics 40, profile 31,
  store 29, conversion 25, fees 24, withdrawControls 21, deposits 17,
  autoWithdraw 16, admin 15, referrals 14, push 9, autoRefund 8, proxy 5;
  6 unit — mining 41, permissions 16, custody 8, signer 8, custodySeeds 8,
  flags 8); api + web typecheck, eslint, web production build clean;
  `security-review` no findings.
  - **Machines (38).** The rig and booster catalogues now serve what they
    actually DID — owners, levels sold, ROZI burned, points taken — all
    DERIVED from `user_rigs` and the ledgers' own `rig_purchase` /
    `booster_purchase` rows (`analytics.ts`'s rule; no counter to drift). A
    price column alone answers "what did I set?" and says nothing about
    whether the sink ever ran, and the honest answer to "should I reprice
    this?" is usually **"nobody has bought one"**.
    ⚠️ **BURN IS REPORTED AS A MAGNITUDE.** Both ledgers store a debit
    negative, and "burned −1,400 ROZI" reads as a refund. Regression test.
    Boosters got their first screen ever; new ones ship **DISABLED** — a
    booster with a price nobody chose is a price we did not mean to publish.
  - **Referrals (41).** The screen leads with the **ADVERTISED rate — the
    minimum across ACTIVE networks** — because that is the only number a user
    has been told (`/referrals/me`). Rows pinning the floor are marked
    `floor`, so "raise it" means raising *those* rows. Plus activation rate
    and invites-vs-active per inviter, which is the shape of a signup farm on
    one row.
  - **Leaderboard (42).** New `leaderboard_exclusions` — hide a seeded test
    account or one under review. ⚠️ **A SUPPRESSION, NEVER A PUNISHMENT**: no
    balance moves, nothing is clawed back, they carry on earning. The board
    query moved to `api/src/leaderboard.ts` so **staff and earners read the
    same rows** — a staff-only filter would be a screen lying to the person
    reading it — and adding an exclusion **busts the one-minute cache**, or an
    admin hides someone, reloads, still sees them, and clicks again.
  - ⚠️ **NOTIFICATIONS (39): THE INBOX IS THE CHANNEL; PUSH IS AN OPT-IN TICK
    BOX, OFF BY DEFAULT.** `push.ts` has said since it was written that a push
    fires on exactly four events and never for marketing. That rule is
    **amended, not abandoned**: a browser subscription is revoked *once,
    permanently*, by an annoyed user — and the message it exists for is "your
    withdrawal was paid". A staff announcement lands in the new `notifications`
    inbox, which interrupts nobody; the compose screen states that cost next
    to the tick box. Six audiences, each sized live before you send.
    ⚠️ **THE AUDIENCE IS MATERIALISED AT SEND TIME** (one `INSERT … SELECT`),
    never re-evaluated at read time — or "everyone with a balance on Tuesday"
    quietly becomes a message that keeps finding new recipients forever, and
    "who did we tell?" has no answer. There is a test for the latecomer case.
    ⚠️ **AN INBOX MESSAGE MAY ONLY LINK INSIDE THE APP** (`isInternalPath` in
    `notify.ts`). It is staff-written and rendered in our own chrome, which
    makes it the most trusted link in the product; an external one there is
    phishing wearing our branding. Home cards are the deliberate exception.
  - ⚠️ **SUPPORT (40): `author_role <> 'internal'` IN `GET /support/tickets`
    IS THE ENTIRE DEFENCE** between a staff note and the person it is about.
    The `CHECK` constraint in `db.ts` *permits* the value; it does not hide
    it. The earner-facing `TicketMessage` type deliberately has no `'internal'`
    member (staff use the wider `StaffTicketMessage`), and there is a test that
    writes a real note and reads the ticket back as the user. **A note also
    leaves the status alone** — marking a ticket "answered" because someone
    wrote to themselves drops a waiting user out of the open queue. Plus
    assignment (`"me"` resolves server-side), search, reopen, and per-status
    counts computed over **ALL** tickets, never the current filter.
  - **Home content (43).** `content_blocks` — announcement cards on home, with
    a live window checked at **READ** time so an expired card needs no timer.
    ⚠️ **The icon is a CLOSED LIST, never a URL** (`CONTENT_ICONS` ↔
    `contentIcon`) — these sit directly above a balance, so an admin-supplied
    remote image is a third-party request on a money screen. A card **may**
    link out (a Telegram channel is a real case) and says so in words before
    it is tapped; `javascript:` and plain http are refused.
    ⚠️ **THE SCHEDULE IS COMPARED AS A STRING**, so an un-normalised date
    silently changes when a card appears instead of failing — `"2026-9-1"`
    sorts *below* `"2026-08-09T…"`, so a September card would never have shown
    and nothing would say why, and a date-only end meant a card set to end
    today was gone by one minute past midnight. Dates are normalised (a
    date-only END is the **end** of that day) and a partial edit is validated
    against the **stored** start, so a window cannot be inverted one field at
    a time. Found in review, not in production; three regression tests.
  - ⚠️ **THE LOCAL PGlite STORE CORRUPTS WHEN SUITES RUN BACK TO BACK.** Every
    e2e file ends in `process.exit()` without closing PGlite, so the next
    suite opening `api/data/pg` immediately after can abort at boot with a wasm
    `RuntimeError: Aborted()` — which looks exactly like a broken migration and
    is not. `rm -rf api/data/pg` between suites (it is git-ignored and
    disposable). Running the matrix that way is also a **stronger** check: every
    suite then exercises a genuinely fresh boot.
  - ~~**Still not built**: Stage 7~~ — **shipped, see the entry below.**

- **THE ADMIN REBUILD, STAGE 7: THE TASK ENGINE — CONFIGURABLE INPUT FIELDS, A
  TASK DETAIL PAGE, CATEGORIES, TARGETING, AND A REAL REVIEW DASHBOARD
  (founder, 2026-08-09).** The last stage of the rebuild. Verified by
  re-running **everything** from a genuinely fresh database, not carried
  forward: **30 suites, 963 checks, 0 failures** (24 e2e — usdt 85, stage7 78
  (new), stage6 70, stage5 55, wallet 52, mining 50, stage4 48, payoutRelay 48,
  taskbudget 46, telegram 45, kyc 43, analytics 40, profile 31, store 29,
  conversion 25, fees 24, withdrawControls 21, deposits 17, autoWithdraw 16,
  admin 15, referrals 14, push 9, autoRefund 8, proxy 5; 6 unit — mining 41,
  permissions 16, custody 8, signer 8, custodySeeds 8, flags 8); api + web
  typecheck, eslint, web production build (33 routes) clean; `security-review`
  no findings.
  - ⚠️ **TARGETING IS AN ELIGIBILITY GATE, NOT A FEED FILTER, AND FIXING THAT
    IS THE POINT OF THE STAGE.** Country targeting was a `WHERE` clause in
    `GET /tasks` **and nowhere else** — so hiding a task from a user's list
    never stopped a user who had its id (a screenshot, a shared link, a stale
    cached feed) from POSTing a proof straight at it. Every rule now lives in
    `api/src/taskTargeting.ts` and is asked by the feed, the task's own page
    AND the submit path. A rule added to one of those three SQL queries and not
    to that file gives you a task that is invisible everywhere and still
    claimable. There is a test that skips the feed entirely and submits to a
    task it was never shown.
  - ⚠️ **TWO KINDS OF "NO", AND THE SPLIT IS A PRODUCT DECISION.** `hide: true`
    (wrong country; "new members only" for an old account) means the user can
    **never** qualify — showing it is a reward dangled where no effort reaches
    it, so it never leaves the server. `hide: false` (account too new, finish N
    tasks first) is a gate they can pass, so the task is shown **locked, with
    the reason** — that is a goal. Four rules ship: countries (multi),
    min/max account age, min finished tasks. All NULL-means-no-limit, so every
    task row that predates this keeps exactly the behaviour it had.
  - **`tasks.country` is now a LABEL, and `target_countries` is the authority.**
    The new column holds a **comma-WRAPPED** list (`,Pakistan,India,`) so a
    `LIKE '%,X,%'` cannot match a country whose name is a prefix of another;
    `,ALL,` is everywhere. ⚠️ **The two columns are written together on every
    save, always** — `country` is what the staff panel and every pre-Stage-7
    query still read, and a save that touched one would give a task reading
    "Pakistan" in the panel while showing in India.
  - **Configurable input fields** (`task_fields`, `api/src/taskFields.ts`): an
    Admin writes the questions — short text / long text / number / email / link
    / phone / pick-one — and the answers arrive as label→value pairs instead of
    one paragraph a reviewer has to guess their way through. The old single
    proof box is **unchanged and still the fallback** when a task has no
    fields; a tap-to-confirm task still works with no answers at all.
    ⚠️ **THE LABEL AND KIND ARE SNAPSHOTTED ONTO THE ANSWER** (`task_proofs
    .answers`), same reason `fee_points` is snapshotted onto a withdrawal: an
    Admin renaming "Your username" to "Your email" afterwards would otherwise
    silently relabel evidence a reviewer had already read, and a correct answer
    would be rejected for being the wrong kind of thing. Regression test.
    ⚠️ **A `url` ANSWER IS SCHEME-CHECKED SERVER-SIDE** — it is rendered as an
    `href` in the staff queue, an admin session is the session worth stealing,
    and `new URL()` accepts `javascript:` and `data:` perfectly happily. Same
    check the task's own action URL already had, for the same reason. The queue
    shows the **whole URL**, not a friendly word, so a reviewer reads where a
    link goes before clicking it.
    ⚠️ **Fields are saved as a WHOLE LIST in one PUT.** Order is a property of
    the list, not of any row; per-field endpoints would let a half-finished
    rewrite become the live form. Keeping the row ids on re-save is what stops
    a second save duplicating the whole form — tested.
  - **A task detail page** (`/tasks/[id]`), which the fields unlock: a bottom
    sheet covers the instructions the user is trying to read while typing into
    it. ⚠️ **A SPONSORED OFFER STILL STARTS IN EXACTLY ONE PLACE and it is not
    this page** — the task list's disclosure sheet (guardrail #3). The detail
    page is for OUR OWN tasks; a network task reached by typing a URL is shown
    with its disclosure and sent back rather than quietly becoming a second
    start button. **`ProofSheet` was deleted, not kept alongside** — two copies
    of a submit flow disagree within a week.
  - **Categories** — a **CLOSED LIST** (`TASK_CATEGORIES` ↔
    `TASK_CATEGORY_LABELS`), same reason the icon list is: the category renders
    as a chip in the app's own navigation, and free text there shows whatever
    an Admin typed. ⚠️ **The chips are built from what is actually in the feed**,
    never from the full list — a chip that filters to nothing tells a user
    there is work in an empty category, and on a quiet day that is most of them.
  - **The review dashboard**: per-status counts, a per-task filter, search by
    email/@handle, the user's own prior approved/rejected record on every row,
    who decided it and when, and bulk approve/reject. Split into
    `web/src/components/proof-queue.tsx` — an Agent reviews, an Admin writes
    campaigns.
    ⚠️ **THE COUNTS ARE OVER ALL PROOFS, NEVER THE CURRENT FILTER** (stage 6's
    rule for the ticket queue): a pending number that shrank because someone
    typed a search reads as the backlog clearing.
    ⚠️ **A BULK DECISION IS N SEPARATE DECISIONS, NOT ONE.** Each row runs the
    same `creditCompletion()` path as a single click and gets its own outcome —
    because the interesting cases are per-row: one user over a velocity cap, the
    campaign hitting its budget partway down the list, a row already decided in
    another tab. One transaction would let one blocked user silently undo forty
    good approvals; one ok/error would leave a reviewer believing they had
    cleared a queue they had not.
  - **The `finance`/`marketing` defect class did not recur** — every new route
    is gated on a permission that a role already holds (`tasks.view`,
    `tasks.manage`, `tasks.review`) and reachable from a screen that role can
    open.
  - **Not built, deliberately**: nothing else was pulled forward. The brief's
    task-section list is now complete.

- **STAFF PAGING OVER TELEGRAM — the "who's accountable at 3am" gap gets a
  cheap, real answer (2026-08-12).** Every dated entry that shipped a
  fraud-detection or reconciliation feature in this file said the same thing
  afterward: the flag lands in a queue and sits there until a human opens the
  panel (Sentry declined). New `api/src/alerts.ts` (`sendStaffAlert`) pages a
  staff Telegram group instead, reusing the SAME bot token the Telegram
  login/mini-app feature already uses — no second bot to create or rotate.
  Verified: api + web typecheck, eslint, and a live end-to-end check against a
  real (local) server — `POST /staff/alerts/test` correctly reports "not
  configured" with no env vars set, correctly reaches the send path and
  returns `ok:true` once `TELEGRAM_BOT_TOKEN`/`TELEGRAM_ALERT_CHAT_ID` are set
  (even pointed at a fake token, confirming the network failure is caught and
  logged, never thrown), and a genuinely fresh high-severity `flagOnce` call
  does NOT block its caller (fire-and-forget, confirmed by the response
  latency staying flat regardless of Telegram's reachability).
  - **One enforcement point, not one call site per flag type.**
    `fraud.ts`'s `flagOnce` now returns whether it inserted a NEW row (existing
    callers ignore the return value, so this is additive) and pages staff
    itself whenever severity is `"high"` **and** the row is new — not on a
    dedup no-op of an already-open flag. This means `reconciliation_mismatch`
    (`deposits/reconcile.ts`), `referral_ring`'s device-sharing case
    (`fraud.ts`) and `rozi_transfer_ring` (`routes/mining.ts`) are ALL paged
    automatically, today, with zero changes at those call sites — and any
    *future* high-severity flag type pages staff the moment it's added, the
    same reasoning CLAUDE.md already states for guardrail #8's `lockUser()`
    list: one list to remember beats N call sites to remember individually.
  - **Ships OFF by default**, same pattern as VAPID push / Monetag / USDT
    top-up: `alertsEnabled` requires BOTH vars, and while `TELEGRAM_BOT_TOKEN`
    is already live on Railway (the login feature set it), `TELEGRAM_ALERT_CHAT_ID`
    is not — so `alerts.ts` is a quiet no-op today until that one is added.
    `.env.example` has the exact steps to get a group chat id via
    `getUpdates`. A **"Send test
    alert" button** ships in `/staff → Features & settings` (new
    `StaffAlertsPanel`, gated on the admin-only `infra.view` permission) so
    the wiring can be confirmed live instead of guessed at.
  - ⚠️ **THIS IS NOT REAL ON-CALL PAGING, AND THE CODE SAYS SO.** No
    escalation, no acknowledgement, no rotation — a message lands in a group
    chat and it is still on a human to be watching it. `CUSTODY_SPEC.md`
    § 3.5's question narrows from "nothing tells anyone" to "someone has to
    have notifications on for that chat," which is a real improvement and not
    the same thing as solving it.
  - **Still blocked on the founder, but only by ONE variable**:
    `TELEGRAM_BOT_TOKEN` is already set live on Railway (the Telegram login
    feature already needs it); `TELEGRAM_ALERT_CHAT_ID` is the only thing
    missing. Getting a chat id is a five-minute Telegram step (create a
    group, add the existing bot, call `getUpdates`) — see `.env.example` for
    the exact instructions — then set that one variable on Railway.

- **A VOICE-MEMO AUDIT PASS: MINING BECOMES A REAL CLAIM, DEPOSIT UIs GET
  SIMPLER, AND A REAL RACE BUG WAS CAUGHT AND FIXED BEFORE IT SHIPPED (founder,
  2026-08-12, later the same day).** The founder sent a long voice memo
  covering ~20 asks; this pass audited what had already shipped earlier the
  same day (a lot — deposit auto-credit, wallet history filtering, roadmap
  states, the ad-boost card were all already live) versus what was genuinely
  still missing, flagged three items that collided with guardrails already
  recorded in this file, and got explicit founder answers before touching
  them. Verified: 62 mining e2e (was 59, +3 for the claim-correctness
  regression test) + 41 mining unit + 85 usdt + 52 wallet + 33 deposits + 78
  stage7, all green; api + web typecheck, eslint (0 errors, pre-existing
  unrelated warnings only), web production build (33 routes) all clean;
  `security-review` found and this pass fixed one real bug before it ever
  reached production (below).
  - **Mining is now a real claim, not a silent daily auto-credit** (founder's
    explicit choice, after being told this changes real settlement behavior,
    not just its look). `settleEpoch()` (`api/src/mining/engine.ts`) no longer
    calls `postRozi` directly — it parks the owed amount in a new
    `mining_unclaimed` table instead, and the ONLY way that ever becomes a
    real `rozi_ledger` credit is the new `POST /mining/claim`
    (`claimRozi()`), locked exactly like every other balance-changing route
    (guardrail #8). `totalEmittedMicro()` (`mining/settings.ts`) now sums
    `rozi_ledger` mining credits **plus** `mining_unclaimed`, so the supply
    cap still can't be breached by a backlog of unclaimed rewards eventually
    getting claimed. `/mine` shows a "Your gems are ready" card with a claim
    button and a gem-glint/burst animation (`globals.css`) — purely
    decorative, same rule as the existing mining-chamber ring: it never
    implies the number is ticking up live.
    ⚠️ **A SECURITY REVIEW CAUGHT A REAL DATA-LOSS RACE IN `claimRozi()`
    BEFORE THIS SHIPPED, FIXED THE SAME PASS.** The original `DELETE FROM
    mining_unclaimed WHERE user_id = ?` was a blanket delete. `settleEpoch()`
    locks on a GLOBAL key (`hashtext('rozi-settlement')`), not the per-user
    key `claimRozi()` uses, so the two can genuinely interleave — under READ
    COMMITTED, if settlement commits a brand-new unclaimed row for a user in
    the gap between `claimRozi`'s `SELECT` and its `DELETE`, the blanket
    delete would erase that row too, even though it was never summed or
    credited: the reward silently vanishes, still counted as emitted against
    the cap but paid to nobody. Fixed by scoping the delete to the exact
    epochs just summed. A regression test was added (`mining.e2e.ts`), with
    an honest caveat matching the double-spend test right next to it: PGlite
    is single-connection and cannot reproduce the actual transaction
    interleaving, so the test proves the sequential case pays in full, not
    the race itself — that needs `DATABASE_URL` against real Postgres.
  - **USDT deposits on `/mine/topup` are as simple as the BNB screen now**
    (founder: "make the interface as BNB interface"). The screen used to
    always ask for a pasted transaction ID + amount before crediting anything
    — a leftover from before personal deposit addresses existed. They exist
    now and the scanner (`deposits/scanner.ts` + `credit.ts`, unchanged) has
    already auto-credited them since 2026-08-06; the manual form was pure
    friction over money already in the balance. It now shows a QR + address
    (matching `/wallet/usdt`/`/wallet/bnb`'s exact layout) with an
    auto-credit note, and the manual paste-tx-hash form appears ONLY as a
    fallback on a deployment with no `personalAddress` (no custody xpub
    configured).
  - **Profile got simpler**: the "Set up your withdrawal wallet" row is gone
    from `/profile`, and the whole payout-address section (ConnectWallet +
    typed fallback) is gone from `/profile/settings` — the withdraw screen
    already collects and auto-saves the address inline, so a second place to
    set the same thing was the duplication, not a feature. `/wallet/withdraw`
    gained a small "Use your saved address" chip that tap-fills the box,
    covering the founder's "click it and it pastes instantly" ask without
    building a full named-address book for what is, today, a single saved
    address (only one chain is offered). **Forgot password now works from
    inside the app**: `/profile/settings` links to `/login?mode=forgot`,
    reusing the exact existing flow rather than a second copy of it — the
    login page's "already signed in → bounce to home" redirect now has a
    narrow exception for `mode=forgot`/`reset`, verified against `auth.ts`
    that both routes are genuinely session-independent (email + emailed
    code), so this opens no new attack surface.
  - **Rig cards show what a machine is actually worth**: `GET /mining/rigs`
    now computes `extraRoziPerDayMicro` — the extra ROZI/day the NEXT level
    alone would add, holding the user's other multipliers constant — and the
    UI shows "+X ROZI a day · pays for itself in ~N days" plus a "Best value"
    badge on whichever rig pays back fastest. ⚠️ **Computed ONLY under the pi
    emission model, deliberately null under pool**: a pi payout comes from
    the user's own shares alone (no dilution), so the rate is a real, stable
    number; under pool it depends on a shared, moving pot, and showing a
    payback estimate there would be a guess wearing a number.
  - **Three items were flagged as colliding with guardrails already recorded
    in this file, and the founder's explicit answer is recorded, not
    silently assumed:**
    1. **The "sponsored offers" banner on `/tasks` is removed, but the
       PER-OFFER disclosure sheet in `TaskFlow.tsx` — the one that actually
       fires immediately before a sponsored task starts — was deliberately
       left untouched.** The founder asked to remove the disclosure outright;
       told plainly this is guardrail #3 (disclose sponsorship before a
       user starts a paid task) and a likely compliance requirement in these
       markets, the founder chose to remove the banner anyway. What was
       removed is the redundant, skippable list-screen summary; what still
       fires is the harder-to-miss per-offer sheet, which is closer to what
       the rule actually requires. Recorded here as a knowing decision, same
       pattern as every other guardrail override in this file.
    2. **Rig prices are NOT set to a fixed 1 ROZI = 0.1 USDT rate.** The
       founder asked for exactly that; told it would publish a real implied
       ROZI valuation (roughly $2.1M on the 21M cap at that rate) — precisely
       what guardrail #7 and multiple prior entries in this file exist to
       prevent — the founder chose the existing "display estimate only, made
       more prominent" option instead. No rig pricing code changed.
    3. **Mining's "claim" mechanic is real, not cosmetic** — see above. The
       founder was told this changes actual settlement behavior (the thing
       MINING_PLAN.md M9.5 says to be careful around) and chose it anyway,
       explicitly.
  - **Not done, and said so rather than guessed at**: no literal "screenshot"
    references exist anywhere user-facing in the app (searched the whole web
    app; the only two hits were an admin-only config description and a code
    comment on the KYC photo input) — the founder's "remove the screenshots"
    ask could not be matched to anything concrete and was left alone pending
    clarification. The requested progressive ad-boost copy ("watch a 2nd ad,
    mine 3x faster"...) was not implemented as literally described because
    the real boost math doesn't stack that way today (each watch adds a flat
    `adBoostPct`, capped at `adBoostMaxStack` watches, matching CLAUDE.md's
    existing "advertised rate comes from the API, never invented copy" rule)
    — the icon was swapped from a video icon to a rocket (`RocketIcon`) as
    asked, but the copy still states the real percentage/hours/cap rather
    than a 2x/3x/5x ladder that doesn't exist server-side.

- **A REAL BILLING INCIDENT: THE BNB DEPOSIT SCANNER WAS BURNING ALCHEMY CU
  24/7 WITH ZERO USER ACTIVITY BEHIND IT (founder, 2026-08-13).** The founder
  saw Alchemy usage climb toward the account's $3 spending cap with no
  deposits, withdrawals, or any real on-chain activity to explain it — real
  money spent for nothing. Root cause, confirmed by reading the code, not
  guessed: `deposits/adapters/evmNative.ts` (the BNB-transfer half of the
  deposit scanner, separate from the USDT half) calls
  `eth_getBlockByNumber(blockNum, true)` **once per BLOCK**, every tick
  (`config.depositScanIntervalMs`, 20s default), forever, the instant any
  single user has a `deposit_wallets` row — which was already true (custody
  went live 2026-08-03). Unlike the USDT scanner (`adapters/evm.ts`), which
  covers a whole block RANGE in one `eth_getLogs` call, there is no
  range-query equivalent for a plain native-value transfer over JSON-RPC —
  every block must be fetched individually, so this scanner's call volume is
  set by the CHAIN'S OWN BLOCK RATE, not by anything a user does. **Slowing
  the tick interval would not have fixed this** — every block still has to be
  scanned exactly once eventually, so a slower tick just batches the same
  total call count into fewer, larger ticks, not fewer calls.
  - **Fixed by turning it off, not by tuning it.** New
    `config.nativeDepositScanEnabled` (env `NATIVE_DEPOSIT_SCAN_ENABLED`),
    **default `false`**, gating the one call site in
    `deposits/scanner.ts`'s `tickDepositScan()`. Same "ships OFF by default"
    posture as every other cost/risk switch in this codebase.
  - ⚠️ **THIS SCANNER WAS NEVER MONEY-AUTHORITATIVE — `creditNative.ts`'s own
    header already said so.** `/wallet/bnb`'s balance is a live
    `eth_getBalance` read (`bnbWithdraw.ts`'s `userGasWallet`), completely
    independent of this scan. Turning it off changes nothing about balance
    correctness, gas checks, or the real BNB withdraw path.
  - **The honest cost of turning it off**: incoming BNB deposits stop
    generating a "BNB received" push notification, and stop appearing as
    rows in `/wallet/bnb`'s history list (`routes/mining.ts` reads
    `native_deposits`, which this scan is what populates) — purely
    cosmetic/notification-only, exactly what `creditNative.ts` already says
    this table is for. A user's real balance is unaffected and still shows
    correctly the moment they open the wallet.
  - Verified: `npm run test:deposits` (33 checks) still green — those tests
    call `scanEvmNativeChain`/`recordObservedNativeDeposit` directly, not
    through the now-gated tick, so the fix is proven not to have touched the
    underlying scan logic itself, only whether it runs unattended. `npx tsc
    --noEmit` clean.
  - **The $3 Alchemy spending cap the founder already had configured is what
    kept this from being worse** — worth keeping in place as a backstop
    regardless of this fix, the same reasoning as every other spending
    ceiling already in this file (`autoWithdrawMaxPoints`,
    `autoRefundMaxMicro`, etc.): one ceiling that holds even when a specific
    safeguard turns out to have a gap.
  - **If BNB deposit notifications/history are wanted back**, the fix is not
    "turn this back on" — re-enabling reproduces the exact same per-block
    cost. It needs either a much smarter mechanism (an indexed
    provider-specific API instead of walking raw blocks — a bigger
    architectural change this codebase has deliberately avoided so far to
    stay provider-agnostic across the RPC failover list, see `rpc.ts`'s own
    header) or an explicit, informed decision that the cost is worth it.

- **THE SAME BILL, A DIFFERENT SCANNER: THE USDT SCANNER'S OWN STEADY-STATE
  COST (founder, 2026-08-27).** The entry above closed the BNB-native leak,
  but the founder reported Alchemy usage still climbing days later with no
  real deposit activity. Root cause is different and, unlike the native
  scanner, not a bug: `deposits/adapters/evm.ts`'s USDT scanner (the one
  that's supposed to run) calls `eth_blockNumber` + `eth_getLogs` on
  **every single tick, forever**, the moment `CUSTODY_XPUB_BEP20` is set —
  which it has been, live, since 2026-08-03. This is inherent to polling a
  chain for new deposits, not a defect: the server cannot know a block is
  empty without checking it. Confirmed live on Railway that `RPC_BEP20` leads
  with the Alchemy key and `DEPOSIT_SCAN_INTERVAL_MS` was unset (default
  20s) — so this was 2 Alchemy calls every 20 seconds, 24/7, ~8,600+
  calls/day, completely independent of whether anyone deposited.
  - **Fixed the same way as the interval config already documents it should
    be tuned: `DEPOSIT_SCAN_INTERVAL_MS` raised 20,000 → 90,000 (90s) on
    Railway**, ~4.5x fewer calls, applied live. Deposit-credit latency goes
    from a worst case of ~20-65s to ~90-135s — still well inside the
    `depositConfirmations` (15 blocks ≈ 45s) window that already gates
    crediting, and nobody watches a live countdown on a manual top-up.
    ⚠️ **This is a dial, not a fix for the underlying shape** — any nonzero
    interval still burns CU forever at a rate set by the interval, not by
    activity. Lower it further only if a founder decision explicitly accepts
    slower deposit detection for less cost, same tradeoff already recorded
    for the native scanner above.
  - **Tested five free public BSC endpoints for the real address-filtered
    `eth_getLogs` shape this scanner actually sends** (Ankr now requires a
    signup key even for the public tier; dRPC/NodeReal's shared demo
    key/OMNIA rate-limit or error from a datacenter IP) — none reliably beat
    what the 2026-08-12 investigation already found (`config.ts`'s own
    comment): the free dataseed/public nodes either refuse this exact
    query shape outright or cap it far below what a single Railway-origin
    scanner needs. **Alchemy stays first in `RPC_BEP20` for a real reason,
    not inertia** — swapping it out was tested and would reintroduce the
    2026-08-12 crash-loop, not just move the cost.
  - **DONE, same day**: the founder signed up for a real NodeReal key
    (`bsc-mainnet.nodereal.io/v1/…`, free tier). Tested against the EXACT
    production query — USDT contract + `Transfer` topic + the `to`-address OR
    filter this scanner actually sends, over a full 5,000-block range
    (`MAX_BLOCK_RANGE`) — and it answered cleanly, no rate limit, no range
    error, unlike every shared/public endpoint tested above. `RPC_BEP20` now
    leads with NodeReal; Alchemy is demoted to first fallback (still there,
    still paid, but now only spends if NodeReal has an outage) — confirmed
    live via `railway logs` post-redeploy: clean boot, zero scan-tick errors.
    NodeReal's free daily CU allowance is well above this scanner's call
    volume even at the pre-90s 20s interval, so the steady-state cost this
    whole entry is about should now land on a free tier instead of a metered
    one with a $3 cap.
  - A `wss://bsc-mainnet.nodereal.io/ws/v1/…` endpoint was also issued with
    the same key. **Not wired in** — `rpc.ts` is a plain HTTP JSON-RPC client
    (fetch, one request/response), not a WebSocket client, so using it would
    need a real architecture change: a persistent `eth_subscribe("logs", …)`
    connection per instance, reconnect/resubscribe handling for drops, and
    almost certainly a slower polling pass kept alongside it as a safety net
    for whatever a reconnect gap misses. That is the actual answer to
    "credits spent only when there's something to report" — a push
    subscription only costs something when a matching log really occurs,
    where polling always costs something every tick by construction, no
    matter how the interval is tuned. Worth building if the WS free-tier
    numbers justify it; not started.
  - **Not a chain problem, a provider problem — recorded because it was
    asked**: switching the deposit chain itself (e.g. to Tron/TRC20) does not
    address this. The cost driver is which JSON-RPC PROVIDER answers a
    BEP20 poll, not which chain is polled; a Tron listener would need its own
    RPC provider with its own pricing and would be a genuinely new build
    (custody derivation, adapter, treasury — see `CUSTODY_SPEC.md` § 5's
    five-chain plan, phases 2+, not started), not a cost fix.
  - Verified: `npm run test:deposits` (33) unaffected — this change is
    config-only, no code touched. `railway variables` confirms
    `DEPOSIT_SCAN_INTERVAL_MS=90000` live.

- **STAFF PANEL: LIVE QUEUE REFRESH, BULK USER ACTIONS, AND A REAL "UNDER
  REVIEW" STATE (founder, 2026-08-27).** Three asks from a recommendations
  list, built one at a time with a cross-check after each. Verified per
  phase, then all together at the end: api + web typecheck, eslint, web
  production build (36 routes) all clean; `test:usersadmin` (new, 32 checks)
  + `test:admin` (15) + `test:permissions` (16) + `test:stage4` (48) all
  green; `security-review` — no findings.
  - ⚠️ **A FOURTH ITEM ON THE SAME LIST — "campaign budgets" — TURNED OUT TO
    ALREADY BE SHIPPED.** `api/src/taskBudget.ts` (advisory-locked spend
    check, auto-pause to `exhausted`) and its 46-check e2e suite already
    exist; the CLAUDE.md audit note calling it "the highest-value gap" was
    stale, superseded by work that landed without an explicit write-up back
    to this file. No code changed for this item — recorded here so the
    stale note stops being repeated as a recommendation.
  - **Live refresh on the money/fraud queues** — Withdrawals, USDT deposits,
    USDT refunds, and Open fraud flags were pull-on-load only; during an
    active incident that is exactly the wrong moment to be stale. `useApi`
    (`web/src/lib/hooks.ts`) gained an optional `pollMs` param; a shared
    `RefreshBar` (`web/src/components/staff.tsx`) gives each queue a manual
    Refresh button, an "Updated Xs ago" readout, and an auto-refresh toggle,
    ON by default at 20s.
    ⚠️ **POLLING PAUSES WHEN THE TAB IS HIDDEN, ON PURPOSE.** This app has
    shipped two real billing incidents (see the Alchemy entries above) from
    something polling forever in the background with nobody watching; a
    staff tab left open overnight must not repeat that shape against our own
    API, even though the actual cost here is a cheap DB read, not a paid RPC.
    A background poll never flips the loading state — it would blank a queue
    someone is actively reading every 20 seconds.
  - **Bulk actions on the Users list** — checkboxes + "N selected" bar for
    Suspend/Restore, plus an Export-to-CSV button for the current search
    (not just the loaded page).
    ⚠️ **A BULK DECISION IS N SEPARATE DECISIONS, NOT ONE** — the exact rule
    Stage 7's proof-queue bulk-decide already established, applied here for
    the first time to user status. `POST /staff/users/bulk-status` and the
    existing single-row route now share one helper, `setUserStatusOne`
    (`api/src/routes/staff.ts`), so the two can never drift into different
    suspend/restore rules. Each id in a batch gets its own outcome: the
    actor's own id in the selection fails on its own row (not the whole
    batch), a not-found id fails on its own row, and duplicate ids collapse
    to one decision. `GET /staff/export/:what` gained a `users` type, reusing
    the exact search filter `GET /staff/users` already applies, gated on the
    existing `export.data` (admin-tier) permission.
  - **A formal "under review" state** — new `under_review_reason` /
    `under_review_by` / `under_review_at` columns, a `users.review`
    permission (manager-tier, same as `users.hold`), and
    `POST /staff/users/:id/review` (`reason: null` clears).
    ⚠️ **THIS GATES NOTHING, AND THAT IS THE ENTIRE POINT.** It is a triage
    label, the same shape as `withdrawal_hold_*`, not a third value squeezed
    into `status` — `requireActiveUser` (`auth.ts`) treats any status other
    than `'active'` as suspended, so a real third status value would
    silently lock the account out the moment it was set. The founder's own
    framing — "distinct from active/suspended" — meant this must NOT gate
    anything; a regression test (`test:usersadmin`) asserts `status` stays
    `'active'` after marking a user for review.
    ⚠️ **REPLACES THE "SUSPECT (N)" BADGE'S JOB, NOT THE BADGE ITSELF.** The
    fraud-flag-count badge is a live count and clears itself the instant
    every flag happens to resolve — it cannot say "we are looking into this"
    across a multi-day investigation. The new "under review" badge is a
    second, differently-coloured badge next to it: a person turns it on and
    off deliberately, and it survives flags resolving in between. Both stay
    on the row because they answer different questions.

- **A "FINAL TOUCH" PASS: PREMIUM BACKGROUND, USDT-BOUGHT MACHINES, TASK
  REWARDS IN ROZI, AND FIVE SCREEN CLEANUPS (founder, 2026-08-29).** A phone
  review turned into a nine-item list. Verified: full backend matrix re-run
  from a fresh DB (stage7 78, taskbudget 46, taskmarketplace 10, mining e2e
  62, referrals 14, stage4 48, stage5 55, stage6 70, analytics 40, admin 15,
  usersadmin 32, kyc 43, usdt 85, wallet 52, deposits 33, + every other suite;
  6 unit suites incl. mining 41) — all green; api + web typecheck, eslint, web
  production build; `security-review` — no findings.
  - **Premium animated background.** `components/AmbientBg.tsx` replaces the
    flat near-white page + two faint blobs on Home/Mine/Wallet/Profile: a soft
    teal page gradient, three morphing aurora blobs (teal/marigold/cyan), a
    faint static circuit-tile texture, and twelve slow "mining energy" motes
    rising up the screen. `/mine` gets brighter blobs, faster motes and a
    marigold glow behind the dial. All motion is transform/opacity only
    (compositor-safe); `prefers-reduced-motion` freezes every layer. One shared
    component so the four screens cannot drift.
  - ⚠️ **MACHINES ARE BOUGHT WITH USDT NOW, AND THIS RE-OPENS GUARDRAIL #7 ON
    PURPOSE.** `SEED_RIGS` ROZI prices ×10 (Old Phone next-upgrade 40 → 400,
    Laptop 150 → 1500) via a one-time `migrateRigPrices2026Usdt`, which also
    fills `base_cost_usdt` for the five launch rigs (Old Phone $5 → Data Centre
    $400) where an admin has not set one. `/mine/rigs` + `/mine/rigs/[id]`: when
    a rig has a USDT price **and** top-ups are on, the USDT button leads
    (accent) and the raised ROZI price sits under it as a "later" option; ROZI
    stays primary where there is no USDT price (dev / un-configured instances).
    The founder was told, again, that a USDT price on a rig that also has a
    ROZI price publishes an implied ROZI value (~$210k against the 21M cap at
    $0.01/ROZI) — the exact thing #7 and the 2026-08-12 "rig prices are NOT set
    to a fixed rate" entry exist to prevent — and chose it. **The old "first
    rig ≈ five days of baseline mining" invariant in `SEED_RIGS` is
    deliberately set aside**: the ROZI price is now aspirational, USDT is the
    real purchase path. **USDT-buy needs `usdtTopupEnabled` + a treasury
    address**, same as the top-up feature it spends.
  - **"Expected ROZI" on a machine card = per-day only, no lifetime total**
    (founder's own choice when asked). The existing `extraRoziPerDayMicro` line
    stays; a `rigs.rateNote` caveat ("speed drops as halvings happen") was
    added. No projected total — it would read as a promise.
  - **The USDT withdraw screen (`/wallet/withdraw`) now matches the BNB
    withdraw screen**: logo + title + the single payout chain as a subtitle
    (not a picker card), a compact success card (not a full-screen
    celebration), the "gas ready" box shown only when gas is actually missing,
    and "Pay from" as a plain two-chip row that appears only when the user has
    task USDT to choose. **No server call changed** — KYC / step-up / gas /
    ConnectWallet logic is all preserved.
  - **Per-token history lists cap at 3 + "See more"** (`/wallet/usdt`,
    `/wallet/bnb`; `/wallet`'s merged preview 2 → 3 to match).
  - ⚠️ **BNB HISTORY IS NOW AN ON-DEMAND BscScan READ, NOT A SCANNER.**
    `GET /wallet/bnb/history` (`api/src/bscscan.ts`) looks up the user's own
    derived BEP20 address on BscScan **only when they open the BNB screen** —
    25 rows, 60s per-address cache, never throws. This is how incoming BNB
    shows up at all: the native BNB deposit scanner stays **off** (the
    2026-08-13 billing entry). Needs a free `BSCSCAN_API_KEY`; empty key → the
    screen just shows our own withdrawal rows, no error. `unifyHistory` folds
    the rows in, deduped against our own withdrawal / native-deposit rows by
    tx hash.
  - **The mining hourglass sits full while a session runs.** New
    `HourglassClaim working` mode: every coin settled in the bottom bulb (the
    "ready" look), a breathing glow, a spark through the neck. It used to drain
    one coin an hour from the top bulb, which read as a broken half-empty
    glass. The countdown text still says how far in; the "0 of 14 coins
    dropped" line is gone.
  - **`/mine` "Mine faster" cards are half the height** (smaller padding/icon,
    15px title, xs body, the "N left today" count folded into the ad card's one
    body line). "Speed up mining" tile → "Speed up".
  - ⚠️ **TASK TITLES ARE BACK TO ONE LINE**, truncated — reversing the
    2026-08-28 "wrap to two lines" change (founder). A wrapping title pushed
    `/tasks` down to ~3 cards a screen; the full title lives on the task detail
    page.
  - ⚠️ **CUSTOM/RoziPay TASK REWARDS ARE SET IN ROZI AND/OR USDT NOW, AND ROZI
    HERE IS THE REAL MINED TOKEN.** The word "points" is gone from the earner
    app. A custom task's ROZI reward credits **`rozi_ledger`**
    (`source_type='task_reward'`, non-withdrawable), and it **counts against
    the 21M cap** — `totalEmittedMicro()` folds in `task_reward`, and
    `creditCompletion()` mints it only if there is room (the task still
    completes and any USDT portion still pays if the cap is full). **Network
    offerwall postbacks (CPX etc.) are untouched** — they still credit
    withdrawable points/earned-USDT, or the earn→withdraw loop breaks.
    - `db.ts`: `reward_rozi_micro` on `tasks` / `task_proofs` /
      `task_completions`; `reward_type` CHECK gains `'rozi'`; a one-time
      migration folds every existing `source='custom'` "N points" row into
      "N ROZI" 1:1 (the founder's own framing) and zeroes its `points`;
      `rozi_ledger` CHECK + `RoziSource` gain `'task_reward'`.
    - `credit.ts`: `roziMicro` path → `postRozi` under the cap; referral
      L1/L2/first-task bonuses are paid **in the same currency as the task's
      main reward** (ROZI → ROZI via `task_reward`, points/USDT otherwise).
      ⚠️ **The first-task flat bonus (`referral_first_task_bonus`, default
      100) is now 100 ROZI on a ROZI task** — proportionally the same as the
      old 100-points-vs-50-points ratio, admin-tunable per network in `/staff`.
    - `staffTasks.ts`: the reward selector is **ROZI only / USDT only /
      ROZI + USDT**; `"points"` is still accepted on the wire and normalised
      to ROZI 1:1 (`normalizeReward`) so an older client / test does not 400.
    - `taskBudget.ts`: the "Max ROZI to pay" cap (`budget_points`, relabelled
      in the admin panel) now counts a custom task's `reward_rozi_micro` as
      whole ROZI — it previously counted only `points`, which is 0 for a ROZI
      task, so a points budget on a ROZI task did nothing.
    - Earner display: `RewardPill` / `TaskFlow` / `tasks-admin` /
      `walletHistory` all show ROZI, never "points". Network-task `points`
      still render as ROZI via the app-wide 100:1 `formatPointsAsRozi`.
  - ⚠️ **KNOWN, ACCEPTED at launch scale:** `credit.ts` cap-checks the *main*
    task ROZI reward before minting but not the referral ROZI bonuses stacked
    on top, so cumulative emission can exceed 21M by one task's referral
    bonuses (~20%+100 ROZI). Unreachable at launch emission (~0). Tighten if
    real volume ever approaches the cap.

- **USDT IN AND OUT OF A USER'S OWN WALLET IS STRAIGHT-THROUGH UP TO $100
  (founder, 2026-08-29).** The founder's rule, stated plainly: a user deposits
  to their own RoziPay wallet address and withdraws from it with **no KYC, no
  staff queue, no fee, any amount, any time** — the *only* exceptions are
  **amount over $100 → manual admin approval**, and **a staff withdrawal-hold
  on the account → manual admin approval**. Implemented as four config
  defaults in `api/src/config.ts` (no route logic changed — the gates were
  already there, only their thresholds moved):
  - `kycRequiredForWithdrawal` **true → false**. This **reverses the
    2026-07-13 "KYC gate" decision** for `POST /withdrawals` (points +
    earned-USDT) and `POST /usdt/refunds`. It does **not** touch ROZI
    transfers (`transferRequireKyc`, separate) or the KYC feature itself
    (`/staff → Verify IDs` still works; `kyc.ts` unchanged). Set
    `KYC_REQUIRED_FOR_WITHDRAWAL=true` on Railway to bring it back.
  - `autoWithdrawMaxPoints` **50000 → 100000** ($50 → $100) and
    `autoWithdrawMaxPointsPer24h` **50000 → 100000** — one $100 line, per
    request and per rolling 24h. Above it, the request stays `pending` in the
    **unchanged** manual Agent→Manager queue (`/staff` withdrawal queue) —
    that is the "goes for admin approval" path, nothing about it changed.
  - `autoRefundMaxMicroPer24h` **$15 → $100** (per-request `autoRefundMaxMicro`
    was already $100).
  - `stepUpMinPoints` **4000 → 100000** — the emailed step-up code now never
    fires below the auto ceiling; anything above it is going to a human anyway.
  - ⚠️ **THIS ONLY CHANGES BEHAVIOUR ONCE THE MONEY EXISTS TO SEND.**
    (a) `getAutoWithdrawMaxPoints()` / `getAutoRefundMaxMicro()` read
    `app_settings` FIRST, falling back to the config default — if the ceiling
    was ever set in `/staff → Withdrawal fee`, that row still wins; confirm it
    reads 100000 / $100 there. (b) The **deposit-refund** path signs from the
    user's own derived address and needs no treasury — it works now. (c) The
    **earned-USDT / points withdrawal** path still prefunds from the treasury,
    which holds **$0/0 BNB** — those still fail-and-return until it is funded.
    (d) Fees: the relay refund path is already $0; for `/withdrawals` confirm
    `withdrawal_fee_points` + gas fee read 0/0%/$0 in `/staff`.
  - Verified: `test:usdt` (85), `test:autowithdraw` (16), `test:autorefund`
    (8), `test:withdrawcontrols` (21), `test:fees` (24), `test:payoutrelay`
    (48), `test:kyc` (43), `test:wallet` (52), `test:stage4` (48),
    `test:deposits` (37), `test:mining:e2e` (62) — all green; api + web
    typecheck clean.

- **STAFF-PANEL SEARCH (founder, 2026-08-29: "the admin panel is confusing —
  a search box so I can go straight to the thing I want").** New
  `web/src/components/staff-search.tsx` — a box in the `/staff` header that
  filters a flat index of ~30 destinations (every section + every sub-panel)
  and, on pick, switches section and scrolls the panel into view. Focus it
  from anywhere with `/` or Ctrl/Cmd+K; arrow keys + Enter; Esc clears.
  - **The index is filtered exactly like the sidebar** — a destination whose
    section the role can't see, or whose own `needs` it lacks, is never
    offered, so search can't send anyone to a screen that 403s.
  - `Panel` (`components/boundary.tsx`) gained an optional `id` — the scroll
    target (`scroll-mt-24` keeps it clear of the sticky header). Every panel
    in `staff/page.tsx` now has a `p-*` id.
  - New `SearchIcon` in `components/icons.tsx`. Verified: web typecheck,
    eslint, production build all clean.

- **ADMIN CONSOLE REBUILD — PHASE A: THE FOUNDATION (founder, 2026-08-29).**
  The founder signed off a full staff-panel rebuild to a "professional" bar
  (contract: the navigation tree + 6 phases, A→F). Decisions locked: no 2FA /
  no impersonation, no dark mode (product is light-only), timezone = Pakistan
  (UTC+5), no internal-notes feature, no editable push-copy screen, no
  force-logout, activity timeline only if cheap (it is — a read-only union).
  Phase A ships the shared primitives every later screen is built on; no
  feature screens yet beyond migrating the Users list as the proof.
  - **`web/src/components/staff/DataTable.tsx`** — the one list component.
    Controlled (parent fetches rows from a `useTableQuery`, passes them back):
    search box, filter bar, sortable headers, pagination + page-size, row
    count, per-page CSV export, row-select + bulk-action bar, and the four
    states (loading / empty / error / no-permission) built in. Every staff
    list will use this.
  - **`web/src/lib/staffTable.ts`** — `useTableQuery(storageKey, defaults)`:
    page / pageSize / sort / dir / search / filters. Sort + pageSize + filters
    persist per browser under the key; page number and search do not.
  - **`web/src/components/staff/DetailLayout.tsx`** — the one record-page
    shell: breadcrumb → header (title + copyable ids + badges + actions) →
    tab strip → body → a visually-separated Danger zone that is always last.
    Not wired to a screen yet — Phase B (User 360) is its first consumer.
  - **`web/src/components/staff/primitives.tsx`** — one status-badge
    vocabulary (`StatusBadge`), one time format (`TimeCell` — PKT, full UTC on
    hover, "3h ago"), `Points` / `UsdtMicro`, `CopyId`, and the shared
    empty/error/no-permission blocks.
  - **`web/src/components/staff/toast.tsx`** — `ToastProvider` + `useToast()`,
    mounted once in `staff/page.tsx`. Replaces scattered `window.alert` for
    action *results* (input prompts stay `window.prompt` until Phase F).
  - **Command palette now finds RECORDS, not just screens.** New
    `GET /staff/search?q=` (`routes/staff.ts`, `requireStaff` + per-type
    permission filter — a support role's search never returns a withdrawal
    row) searches users (email · @handle · invite code · id), withdrawals /
    refunds / deposits (id · tx · address), tickets (id · subject), tasks
    (title), networks. `staff-search.tsx` merges these above the page
    destinations; a user hit deep-links to the existing lookup, other types
    jump to their section (real detail pages arrive in B–E).
  - **Users list migrated to `DataTable`** as Phase A's visible output —
    real offset pagination + page size, CSV of all matching rows (server
    export) + the current page (client), bulk suspend/restore, per-row quick
    actions. ⚠️ Columns are **not sortable yet** and there are no server-side
    filters — `GET /staff/users` still only takes `q` / `limit` / `offset`;
    Phase B grows that endpoint and turns both on rather than faking a
    one-page client sort.
  - Verified: web typecheck + eslint + production build clean; api typecheck
    clean; `test:usersadmin` now 39 (7 new for `/staff/search` incl. the
    permission-filter and non-staff-refused cases), `test:admin` (15),
    `test:permissions` (16), `test:stage4` (48), `test:stage6` (70),
    `test:stage7` (78) all green.
  - **Next: Phase B** — the new Dashboard and the full tabbed User 360 page.

- **ADMIN CONSOLE REBUILD — PHASE B (part 1): THE USER 360 PAGE + A REAL
  USERS LIST (founder, 2026-08-29).** The Dashboard (part 2) is the next
  commit.
  - **`GET /staff/users` now takes server-side SORT + FILTERS.** `sort` /
    `dir` map through a whitelist to a column literal (never interpolated);
    `status` / `kyc` / `country` / `flagged` / `held` / `review` assemble a
    bound-param WHERE used for BOTH the row page and the COUNT, so `total`
    always matches the filter. `web/src/lib/api.ts` `searchUsers` takes an
    options object now (old positional `(q, limit, offset)` still works). The
    Users `DataTable` gets sortable headers + a filter bar.
  - **`GET /staff/users/:id` grew four things** for the tabbed detail page,
    every one DERIVED (analytics.ts's rule, no new table / write path):
    `roziLedger`, `usdtLedger`, an `audit` slice (`admin_audit_log` where
    `target_user_id` = this user, with the actor's email + before→after), and
    a merged `activity` timeline — a JS merge of six small already-indexed
    queries (points / withdrawals / deposits / refunds / ROZI / tasks) plus
    the audit rows, sorted desc, capped 80. Plus a `referral` block
    (`earnedPoints` from the points ledger, `joined2Count`).
  - **`web/src/components/staff/UserDetail.tsx`** — the User 360 on
    `DetailLayout`: tabs Overview · Activity · Balances · Money · Referrals ·
    Tickets · Audit, and a Danger zone (suspend/restore · hold/lift payouts ·
    mark/clear review · adjust points · adjust ROZI). ⚠️ **Still three
    balance boxes, never a total** (guardrail #7) — there is a test asserting
    the endpoint serves no `totalBalance`. `UserLookupScreen` (find-a-user
    box + the detail) replaces the old ~290-line inline `UserLookup` /
    `UserHeader` / `Badge` in `staff/page.tsx`, which were deleted.
  - **Anonymise is NOT built** this pass — it needs careful multi-table data
    handling and a dedicated decision; deferred (Phase F or a separate ask).
    Every other Danger-zone action reuses an endpoint that already existed.
  - Verified: web typecheck + eslint + build clean; api typecheck clean;
    `test:usersadmin` now **50** (11 new — filter/sort incl. an
    unknown-sort-key-is-ignored check, and the User 360 endpoint incl. the
    no-total guardrail), `test:admin` (15), `test:stage4` (48),
    `test:stage5` (55), `test:analytics` (40) all green.

- **ADMIN CONSOLE REBUILD — PHASE B (part 2): THE DASHBOARD LANDING
  (founder, 2026-08-29).** Phase B is now complete.
  - **`GET /staff/dashboard`** (`analytics.view`) — one request the landing
    page opens with: the size of every work queue (withdrawals new / ready,
    deposits, refunds, BNB-failed, relay-failed, fraud open, KYC waiting,
    tickets open), a per-chain reconciliation shortfall count (latest
    `treasury_balance_snapshots` per chain, `delta < 0`), and the last 15
    admin actions with actor + target email. All counts, all derived.
  - **`web/src/components/staff/DashboardOverview.tsx`** — a "Needs
    attention" tile grid (each tile is a button that jumps to its section;
    all-zero collapses to one "every queue is clear" line), the
    reconciliation-shortfall callout, and a recent-admin-activity table.
    Renders ABOVE the existing `AnalyticsDashboard` charts + `KpiDashboard`
    strip, both unchanged. Polls every 30s.
  - ⚠️ **Still not looked at in a browser** — same standing caveat as the
    Stage 3 dashboard. Numerically covered by tests; the visual layer wants
    a logged-in admin session.
  - Verified: web typecheck + eslint + build clean; api typecheck clean;
    `test:analytics` now **45** (+5 for the dashboard endpoint incl. the
    non-staff-403 case), `test:stage6` (70), `test:stage7` (78) re-run green.
  - **Next: Phase C** — Money & payouts: all five queues on `DataTable` +
    detail pages + reconciliation history.

- **ADMIN CONSOLE REBUILD — PHASE C: MONEY & PAYOUTS (founder, 2026-08-29).**
  All five money queues on the shared `DataTable`, plus two surfaces that
  never had a screen before, plus reconciliation history. New
  `web/src/components/staff/MoneyQueues.tsx` (`WithdrawalsPanel`,
  `DepositsPanel`, `RefundsPanel`, `BnbWithdrawalsPanel`, `RelayJobsPanel`,
  `ReconciliationPanel`); the old inline `WithdrawalQueue` in `staff/page.tsx`
  and `TopupPanel` / `RefundPanel` in `mining-admin.tsx` are deleted.
  Verified: api + web typecheck, eslint, web production build clean;
  new `npm run test:moneyadmin` (**31 checks**) + `test:usersadmin` (50) +
  `test:stage4` (48) + `test:analytics` (45) + `test:usdt` (85) +
  `test:withdrawcontrols` (21) + `test:autowithdraw` (16) + `test:autorefund`
  (8) + `test:admin` (15) + `test:permissions` (16) + `test:stage6` (70) +
  `test:stage7` (78) + `test:payoutrelay` (48) + `test:deposits` (37) +
  `test:fees` (24) all green.
  - ⚠️ **THE DECISION PATHS ARE UNCHANGED — this is a presentation migration.**
    Approve / reject / mark-paid / confirm still `POST` the same endpoints with
    the same prompts and the same "net is what gets sent, gross is what was
    debited" wording. Row-click opens a `DetailLayout` detail built **from the
    row already in hand** (no new `:id` endpoint), with the decision buttons in
    its Danger zone and an "Open this user" jump.
  - **`GET /staff/withdrawals`, `/staff/mining/topups`, `/staff/mining/refunds`
    grew server-side `q` / `sort` / `dir` / `limit` / `offset` and now return
    `total`** — same idiom as `GET /staff/users` (sort whitelist → column
    literal, one WHERE for the row page AND the count). Existing fields
    (`treasury`, `pendingTotal`, `topups`, `refunds`, …) are untouched;
    `total`/`offset`/`limit` are additive.
    ⚠️ **The agent-approval cap is now a bound WHERE condition, not a
    post-fetch JS filter** — otherwise `total` and the page size are wrong for
    a capped approver. `pendingTotal` is a dedicated aggregate over the whole
    filtered set, never the current page.
  - **NEW: `GET /staff/bnb-withdrawals` + `GET /staff/relay-jobs`**
    (`withdrawals.view`). BNB gas-out requests and the per-user payout relay
    jobs had no staff screen — the dashboard only ever counted their `failed`
    rows. Both default to the `failed` tab (the needs-attention view) and are
    **read-only on purpose**: a failed native send / relay job is terminal
    (`db.ts`) and the compensating action is decided per case, never a retry
    button that could double-spend a live on-chain balance.
  - ⚠️ **`GET /staff/mining/reconciliation` had a latent bug: `limit` was
    `z.number()`, so any `?limit=…` 400'd** — which is every call the new
    panel makes. Fixed to `z.coerce.number()`. The panel is a table over that
    endpoint (bep20), with shortfall rows highlighted.
  - ⚠️ **Still not looked at in a browser** — same standing caveat as every
    dashboard entry since Stage 3. Numerically covered; the visual layer wants
    a logged-in admin session.
  - **Next: Phase D** — Tasks & offers.

- **A PHONE-REVIEW PASS: A "MONEY ON ITS WAY" LINE, THE HOURGLASS FILLS
  TOP→BOTTOM AGAIN, AND THE AD BOOST STOPS DOUBLING YOUR SPEED (founder,
  2026-08-30).** Four asks off screenshots. Verified: `npm run test:mining`
  (42, +1), `npm run test:mining:e2e` (63, +1), `test:referrals` (26),
  `test:conversion` (25), `test:store` (29) all green; api + web typecheck,
  eslint (0 errors), web production build (36 routes) all clean.
  - **Pending wallet rows now say they are normal.** `HistoryList` +
    `TxDetailSheet` show a small muted line — "Usually arrives in 5–30
    minutes" (`wallet.tx.eta`) — under the time on any `pending`/`sending`
    row. No layout change, no bigger card. Deposits and withdrawals settle
    in a few minutes now; the founder's ask was purely the reassurance copy
    so a "Processing" row for 20 minutes does not read as stuck.
    ⚠️ **Scoped to USDT/BNB rows only** (cross-check pass): the wait it
    describes is blockchain settlement, not a staff review queue, so it must
    not appear on a task-points row that is ever `pending`.
  - ⚠️ **THE `/mine` SESSION HOURGLASS REVERSES THE 2026-08-29 "settled at
    the bottom" LOOK.** It now uses `HourglassClaim`'s `progress` mode
    (which already existed, built 2026-08-28): coins start in the TOP bulb
    and drop one by one, newest through the neck, as the 8h session
    elapses. `sessionProgress` = elapsed / session length, recomputed each
    second off the existing `useCountdown` re-render. Still **purely
    decorative** — it tracks elapsed TIME, never the real ROZI amount (the
    countdown text is the exact figure), and `HOURGLASS_COIN_COUNT` stays a
    fixed 14: the founder asked for "36 coins for a 36 speed", but 36 real
    coins overflow the glass and a 0.004 claim would round to zero visible
    coins — the same reason `HourglassClaim.tsx`'s header already gives for
    not wiring the count to a number. `working` mode is left in the
    component, now unused by any caller.
  - **The ad-watch dwell is now Admin-tunable.** New `adMinWatchSeconds`
    (default 15, `/staff → Mining`), used by `redeemAdNonce`,
    `/mining/ad/issue` and the bot-pattern flag. The 15s server dwell was
    **already enforced** — Monetag has no S2S postback, so this is the only
    real "was it watched" check and always was (the honesty note in
    `routes/mining.ts` is unchanged) — this just lets the floor be raised
    without a redeploy.
  - ⚠️ **THE AD BOOST IS A FLAT +1 SPEED PER AD NOW, NOT +100%.** It used
    to double the miner's hashrate per ad (18 → 36 → 72…); ROZI came too
    easily. `adBoostPct` 100 → **0**, new `adBoostFlat` = **1** added to the
    hashrate AFTER every multiplier (`computeHashrate`'s new optional
    `flatBonus`), `adBoostMaxStack` 3 → **4** so "watch four ads, mine four
    faster" is the whole ceiling. `adBoostPct` survives as a separate,
    still-tunable knob (set it > 0 for a percentage ad boost on top) but
    ships at 0. `splitBoosts()` in `mining/engine.ts` adds `adBoostFlat` per
    capped `kind='ad'` row AND still passes through that row's stored
    `multiplier_pct` when it is non-zero (cross-check pass — the first cut
    dropped it, which would have made the "still-tunable" claim a lie);
    task/points boosts are unchanged percentages. The `/mine` breakdown row
    shows `+50% · +4`; the ad card + `mine.ad.done` copy read `{flat}` from
    the API, never an invented number.
  - **Task boost (+50%/48h) left alone** — the founder was not specific and
    it is "the most important number in the file" (it makes big miners do
    surveys); tunable in `/staff` if it should come down. **Referral mining
    hashrate untouched** — the founder started to raise it, then said "okay,
    I got it" and moved on.

- **TASK BOOST HALVED, AND ITS STACK CEILING RAISED (founder, 2026-08-30,
  follow-up to the phone-review pass above).** Two `mining/core.ts` default
  changes plus one config bump, all Admin-tunable in `/staff → Mining`:
  - **`taskBoostPct` 50 → 25.** One credited task is now +25% mining speed for
    48h, not +50%. The founder's framing: "cut it by fifty percent" — ROZI was
    coming too easily even after the ad-boost fix above. Stacking is still
    additive-then-multiplicative, so a user at speed 17 who does one task mines
    at 21 (×1.25) rather than 25 (×1.5).
  - **`taskBoostMaxStack` 3 → 8.** The founder wanted "+25% for EVERY task,
    even if more tasks are present" — so more tasks keep adding boost past
    where the old +150% ceiling sat. ⚠️ **A hard cap still exists on purpose**
    — it is the one anti-farm guardrail on task boosts (the
    `a survey farm cannot stack boosts forever` e2e test) — it is just higher:
    8 tasks ⇒ +200%, nothing beyond. The founder was offered "no cap at all"
    and chose the raised-but-finite ceiling.
  - **`adMinWatchSeconds` 15 → 20.** Raised alongside, since that dwell timer
    is the ONLY "was the ad watched" check (Monetag has no S2S postback) — a
    few more seconds is the only real friction on parking the tab open to farm
    the flat ad boost. Tunable toward 30 in `/staff` if it is still farmed
    once live.
  - The `/mine` task-boost line reads `{pct}` from the API, so it now shows
    "+25%" with no copy edit. One e2e assertion that hardcoded "×1.5" was
    changed to derive the multiplier from `cfg.taskBoostPct`.
  - Verified: api typecheck clean, `test:mining` 42/42, `test:mining:e2e`
    63/63 (incl. "10 task boosts are capped at 8").

- **DEEP VAULT IS NOW THE DEFAULT LOOK, AND `/mine`'s DIAL IS THE HERO
  (founder, 2026-08-30).** The founder reviewed the "RoziPay Screen Redesign"
  artifact (the dark "Deep Vault" mockup) and asked to make that skin the
  default. Shipped as its own commit, separate from the hourglass→funnel swap
  below, so the glass change can be reverted on its own. Verified: web `tsc
  --noEmit` clean, `eslint` 0 errors (7 pre-existing `<img>` warnings, none in
  touched files), `next build` clean (36 routes). ⚠️ Not yet reviewed in a
  real browser — same standing caveat as every visual change since the Stage 3
  dashboard.
  - ⚠️ **THIS REOPENS THE DOCUMENTED "APP IS LIGHT-ONLY" CALL, ON PURPOSE.**
    `lib/theme.tsx` `readStored()` + the `layout.tsx` blocking script now
    resolve anything other than an explicit stored `"light"` to `"vault"`.
    Light is the OPT-OUT — one tap in `/profile/settings` (the picker now
    lists Dark first and calls it "The normal look"). `viewport.themeColor`
    → `#0b1517`. **Nothing about the ledgers, copy, or any guardrail changes
    with the skin** — it is only the `--color-*` tokens in the
    `[data-theme="vault"]` block. A user who opts to light keeps the dark
    address-bar tint (one static value, accepted).
  - **`/mine`'s dial rebuilt as the screen's hero.** The `MiningReactor` went
    from an 84px chip inside a tint box to a 168px core sitting on the card,
    with "MINING SPEED" (uppercase, tracked) + the speed number under it —
    matching the mockup. New `.r-arc` span on the reactor: a short STATIC
    marigold arc on the rim (a gauge flourish from the mockup — static so it
    can never read as "progress toward" anything). The balance, the
    "what you'll get" estimate line and its hedge, the start/running controls
    are all unchanged.
  - **Untouched, deliberately**: the `mine.notcash` disclosure banner
    (guardrail — ROZI still says plainly it cannot be cashed out), all mine
    copy, the boosts/tiles/breakdown/activity sections below the dial
    ("rest is good" — founder), and every other screen. Home / Wallet were
    NOT re-themed screen-by-screen — they already pick up the vault tokens
    via `.app-frame`, which is the whole point of that mechanism.

- **THE FLAT FUNNEL IS REVERTED — THE HOURGLASS IS BACK (founder, 2026-08-30).**
  `git revert` of `ec3feae` ("Replace the ornate hourglass with a flat
  RoziFunnel"). The founder wanted the hourglass with coins dropping from the
  upper bulb through the neck into the lower bulb as the session runs, i.e. the
  `progress` mode of `HourglassClaim.tsx`. `components/RoziFunnel.tsx` is
  deleted again; `components/HourglassClaim.tsx` is restored, along with the
  `.hg-*` CSS in `globals.css` (including the `[data-theme="vault"] .hg-wrap
  svg` rim override) and the three `/mine` call sites. The Deep-Vault-default
  theme commit (`11b0e7c`) and the `/mine` dial-as-hero change are untouched —
  only the glass swap is undone. The two commits that landed after `ec3feae`
  (staff dashboard, welcome animation) touch different files and were not
  affected; only this CLAUDE.md entry needed a manual merge.
  - Verified: web `tsc --noEmit` clean, `eslint` 0 errors, `next build` clean.
    Not browser-reviewed.

- **THE DASHBOARD SHOWS PROGRESS, NOT JUST A RED COUNT — AND FRAUD FLAGS /
  TREASURY SHORTFALL / FAILED RELAY JOBS GET REAL FIXES (founder, 2026-08-30).**
  The founder's three complaints from the live `/staff#dashboard`: resolved
  fraud flags still showed as open, "treasury shortfall (bep20: −2.00)" was
  unexplained and unfixable from the panel, and a "payout relay job failed"
  tile with no way to clear it. Root cause of the recurring flag: the hourly
  `deposits/reconcile.ts` re-creates a `reconciliation_mismatch` fraud flag
  every hour the shortfall exists, and `flagOnce` only dedupes among
  *unresolved* rows — so resolving it guarantees a fresh one next tick. Fix the
  shortfall and the flag stops. Verified: `npm run test:moneyadmin` now **48**
  (+17 — the handled endpoints + the USDT-adjust reconciliation path incl.
  cap/zero/permission/goes-negative cases), `test:analytics` **46** (+1, the
  `{ open, cleared }` signal shape), `test:stage4` (48), `test:usersadmin`
  (50), `test:admin` (15), `test:permissions` (16), `test:stage6` (70),
  `test:stage7` (78), `test:usdt` (85), `test:wallet` (52), `test:deposits`
  (37) all green; api + web typecheck, eslint, web production build (36 routes)
  clean.
  - **`GET /staff/dashboard` — the four signals you can work to zero carry
    `{ open, cleared }`, not a bare count.** `fraudOpen`, `relayFailed`,
    `bnbFailed`, `reconciliationShortfall` each report how many are still open
    and how many were cleared in the last 7 days. `DashboardOverview.tsx` shows
    the tile **red only while `open > 0`**, **green ("✓ all N cleared") once
    `open === 0 && cleared > 0`**, plain otherwise, with a
    "N total · N cleared · N open" sub-line — the founder's own "5 frauds, 3
    checked, 2 left" framing. The other six tiles are self-clearing queues and
    stay simple counts. Every tile now deep-links to its actual panel
    (`goToSection` gained an optional anchor → routed through the existing
    `goToDest` scroll), so "click Open fraud flags" lands **on** the fraud
    panel, not just the section.
  - ⚠️ **`resolved_at` added to `fraud_flags`** (backfilled from `created_at`
    for already-resolved rows), stamped by `POST /staff/fraud/:id/resolve`.
    `handled_at`/`handled_by`/`handled_note` added to `payout_relay_jobs` and
    `bnb_withdrawal_requests`.
  - **`POST /staff/relay-jobs/:id/handled` + `POST /staff/bnb-withdrawals/:id/handled`**
    (`withdrawals.decide`) — a staff acknowledgement, **not a retry and not a
    money move**. A failed relay job is terminal: a refund that gave up before
    value moved was already auto-credited back by the tick; a withdrawal whose
    prefund leg confirmed is settled on-chain. This just records "a human
    checked which case it was" and takes the row out of the red count. Only a
    `failed` row, once each. Surfaced as a "Mark as handled" button in the
    Money → Payout relay jobs / BNB withdrawals detail Danger zone; the row
    stays listed, now green with the note.
  - **`POST /staff/users/:id/usdt-adjust`** (`users.adjust`, admin-tier) —
    posts a `usdt_ledger` `admin_adjustment` (append-only, advisory-locked,
    audit-logged `usdt_adjusted`, capped $200/call, `chain` defaults `bep20`).
    ⚠️ **UNLIKE the points adjust, a debit MAY take the balance negative — on
    purpose**: the recorded balance was wrong and the true entitlement is
    lower. This is the fix for the −2.00 shortfall (the 2026-08-12
    double-credit residue): post a −2.00 debit to the affected test user and
    the hourly check stops flagging, which stops the recurring fraud flag. New
    "Adjust USDT" button in the User 360 Danger zone next to Adjust points /
    Adjust ROZI. ⚠️ **There is still no *automatic* reconciliation correction**
    — a human identifies the user (join `usdt_topups`↔`chain_deposits` on
    `tx_hash`) and posts the adjustment.

- **TASK/NETWORK + MINE/GROWTH ADMIN OVERHAUL + ROZI RETUNE (founder,
  2026-09-01).** A founder review produced ~20 asks across a hard bug, admin
  UX debt, missing task analytics, and tokenomics. Verified: full backend
  matrix from a fresh DB — **90 unit + ~1,200 e2e checks across 29 suites, 0
  failures** (mining 42, custody/signer/custodyseeds 8 ea, permissions 16,
  flags 8; usdt 85, moneyadmin 82, stage7 78, stage6 70, stage5 67, mining
  e2e 65, tasksadmin 57, wallet 52, usersadmin 50, stage4 48, payoutRelay 48,
  taskbudget 46, analytics 46, telegram 45, kyc 43, deposits 37, profile 31,
  store 29, referrals 26, conversion 25, fees 24, withdrawControls 21, admin
  15, autoWithdraw 16, taskmarketplace 14, messagesadmin 14, push 9,
  autoRefund 8, proxy 5); api + web typecheck, eslint, web production build
  (37 routes); `security-review` — no findings.
  - **THE ADMIN LOGOUT-ON-BACK BUG IS FIXED.** Root cause: `web/src/lib/
    api.ts` cleared the session on **any** 401 from **any** request, and the
    staff panel runs many background pollers through that one interceptor —
    one transient/expired-token 401 silently wiped `localStorage`, and
    nothing noticed until a page remounted (browser Back/Forward being the
    common trigger), at which point `useRequireAuth` redirected to `/login`.
    Now a 401 is **confirmed against `/auth/me`** before the session is
    cleared (401/404 there ⇒ dead; otherwise a transient blip, session
    kept + error surfaced); `onSessionEnded` redirects **immediately** when a
    token is proven dead instead of deferring to the next nav;
    `login/page.tsx` sends an authed staff user to `/staff` not `/`;
    `getStoredUser` is try/catch-hardened; and `/staff` now uses
    `history.pushState` + a `popstate` handler so Back walks the panel's
    sections and the open task detail closes on Back instead of leaving
    `/staff`.
  - **Task & Rewards admin correctness.** ⓐ **No more double-create** —
    Save is disabled while a create/update request is in flight
    (`TaskForm` `busy`), and `POST /staff/tasks` now **rejects a duplicate
    normalised title (409)**, which also makes a double-submit a no-op. ⓑ The
    admin **status filter now agrees with the status badge**:
    `GET /staff/tasks` filters on the *computed* effective status (a SQL
    `CASE` mirroring `campaignState`), plus a 15-min sweep in `server.ts`
    writes `status='ended'`/`'active'` when a schedule lapses/opens — an
    expired campaign no longer shows only under "active" and never under
    "ended". ⓒ **Tasks are deletable** — `DELETE /staff/tasks/:id` soft-sets
    `status='deleted'` (new value in the CHECK + `taskLifecycle`), hidden
    from the earner feed and the default admin list, blocked if the task has
    paid out and isn't ended; wired to the `DataTable` bulk action + the
    task-detail Danger zone. ⓓ **Per-field red validation** in `TaskForm`
    (`validateTask` mirrors `upsertSchema` — e.g. minutes 0–600) turns a box
    red at entry and blocks Save. ⓔ **Searchable country picker**
    (`components/CountryPicker.tsx` + `lib/countries.ts`) replaces the
    free-text "one per line" box and the users-list country filter.
  - **Per-task metrics.** New `task_opens` table (a view-level signal,
    separate from `task_participation` so it never changes the earner feed)
    incremented on `GET /tasks/:id`. `GET /staff/tasks/:id/metrics` returns
    the funnel — opened → started → proof submitted → approved → rejected →
    credited — with step-to-step %s, this campaign's revenue/margin (reusing
    `campaignMoney`), and a 30-day daily series; a **Metrics** and a
    task-scoped **Proofs** tab were added to the task detail.
    `GET /staff/tasks/overview` + a card on the list give the same funnel
    across all own tasks; `analytics.ts`'s task block gained `opened` +
    `proofsRejected`.
  - **Mine admin readability.** Economy settings render as **individually
    bordered field boxes** with a one-line plain-English explainer under each
    (sourced from the new `docs/MINING_GLOSSARY.md`, which also answers the
    founder's "what does emission model / halving / hashrate / boosts /
    boosters / conversion mean" questions). New `GET /staff/mining/epochs`
    (paginated) + a "Show all days" expander give the **full day-1-to-now**
    economy history. Top-miner rows already deep-link to the User 360.
  - **TOKEN ALLOCATION MODEL (editable + vesting).** New `rozi_allocations`
    table seeded from `MINING_SPEC.md` §3.1 (mining 21M / liquidity / team
    w/ 6-mo cliff + 24-mo vest / ecosystem / reserve — 32.3M total), an
    **Allocation** tab under Mine with full CRUD
    (`GET/POST/PATCH/DELETE /staff/mining/allocations`), a %-sum-to-100
    check, and simulated released-to-date from each bucket's schedule.
    ⚠️ **A PLANNING / BOOKKEEPING VIEW ONLY** — ROZI is not on-chain, nothing
    is minted or moved, and `supplyCap` (21M) stays the one number enforced
    at settlement and equals the mining bucket. The `mining` bucket cannot be
    deleted and its "released" figure is real emission, not a schedule.
  - ⚠️ **ROZI RETUNE — piBaseRate 0.5 → 2.5, and RIG PRICES RE-BASED TO A
    FIXED $0.10/ROZI (founder, both knowing decisions).** The founder wants a
    normal miner to see **2–3 ROZI/day at launch** (streak / referral /
    boosts / rigs stack on top). Supply cap **UNCHANGED at 21M**; the runway
    is preserved by making `piHalvingUsers` steeper/earlier
    (`2000,10000,50000,250000,900000`) so the baseline halves five times to
    ~0.078/day by ~1M verified users — the `daysOfSupply > 120` tripwire in
    `mining.test.ts` still holds, and both pinned tests were updated in the
    same change. Rig ROZI price is now `base_cost_usdt ÷ 0.10` (a $5 Old
    Phone = 50 ROZI), via `SEED_RIGS` + one-time `migrateRigPricesDime`.
    ⚠️ **This is a KNOWING re-open of guardrail #7** — a fixed ROZI↔USD basis
    publishes an implied ~$2.1M valuation — recorded as a dated decision in
    `MINING_SPEC.md` §6.2a. It aligns rig prices to the rate `POINTS_PER_ROZI`
    + `POINTS_PER_USDT` *already* imply on screen rather than adding a new
    claim. **ROZI stays non-withdrawable; no buy-back; no ROZI→USD cash
    conversion.**
  - **Growth / Messages / Features.** Top-inviter table (now "Top partners")
    gained **inactive count + %** and column sorting — the shape of a
    fake-signup farm on one row. In-panel explainers added to "Send a
    message" and "Home screen cards". **Feature flags / Global settings /
    Staff alerts are now three separate sidebar sections** (were sub-tabs of
    one), each on its own permission.
  - **Earner app.** "My tasks" and "History" now **group their cards** by
    where each stands (Needs another try · In progress · Under review /
    Completed · Closed). New flag-gated **`/earnings`** screen ("what you've
    earned from the platform") + `GET /me/earnings` (lifetime totals by
    source, derived from the ledgers) — ships **OFF** (`earnings_view`,
    `defaultOff`) until real USDT payouts start; the profile link is hidden
    while off and the endpoint 403s. Two example **boosters** are seeded
    **disabled** so an Admin has something concrete to price, and
    `/mine/boosters` explains that a booster is a temporary speed multiplier
    bought with Points (not ROZI).

- **ADMIN-DRIVEN REWARD DISBURSEMENT — a "send the rewards out" layer
  (founder, 2026-09-02).** Until this, the ONLY way money left the platform
  was a user-filed withdrawal request; there was no admin-initiated payout and
  no batching. Now a staff member (`disbursements.manage` — admin + finance
  only) groups approved-but-unreleased custom-task rewards into a **batch** and
  pushes them out. Full plan + checklist: `docs/DISBURSEMENT_PLAN.md`. Verified:
  new `npm run test:disbursements` (65 checks) + the full backend matrix
  (36 suites) + api/web typecheck + eslint + `next build` + `security-review`
  (no findings) all green.
  - **Eligible = an approved custom-task proof whose reward has NOT been
    released** (`task_proofs.reward_status='pending'` — the existing two-step
    release, `routes/staffTasks.ts`, made batchable). ⚠️ **Network-postback
    credits (CPX etc.) are deliberately NOT eligible** — they credit
    immediately at postback time and must keep doing so or the earn→withdraw
    loop breaks.
  - **Four modes, admin picks per batch** (founder decision A):
    - `balance` (the default, the safe one) — per recipient, runs the EXACT
      `releaseProof()`/`creditCompletion()` path. Credits the in-app balance.
      No address, no gas, no treasury. Append-only credits, idempotent on the
      completion's `(network, external_id)` = `proof:<id>` index.
    - `onchain` — releases to balance, then creates a `withdrawal_request`
      (`source_kind='earned_usdt'`) to the user's **saved** payout address and
      calls `tryAutoSettle()`. Reuses the whole settle/relay/queue/24h-cap/hold
      machinery unchanged.
    - `manual` / `csv` — same, but the request is left in the manual
      Agent→Manager queue; staff mark it paid with a tx hash. `csv` adds a
      recipient-list export + a `{disbursementId, txHash}` re-upload that
      reconciles rows and reports paid / unknown / notPayable / badHash.
  - ⚠️ **DECISION B: an admin push NEVER collects a destination address.**
    `balance` needs none. `onchain`/`manual`/`csv` fall back to the user's
    saved `payout_addresses` row; a recipient with none is marked
    `needs_address` and **skipped** — it never blocks the rest of the batch,
    and the reward still lands on their in-app balance for them to withdraw
    themselves. No new forced address-collection step.
  - ⚠️ **EACH RECIPIENT IS ITS OWN DECISION** (the Stage-7 bulk-proof-decide
    rule). `runBatch` loops rows, each in its own transaction; one blocked
    recipient (velocity cap, exhausted campaign budget, missing address) is
    recorded `failed`/`needs_address` and the loop carries on. Never one big
    transaction. A `failed`/`needs_address` row is retried on the next run;
    `released`/`paid`/`sending` rows are not.
  - ⚠️ **Guardrail #8**: `runPayoutRow`'s request-creation + USDT hold runs
    under `pg_advisory_xact_lock(hashtext(userId))` so a concurrent user-filed
    withdrawal serializes with it. `balance` mode needs no lock (append-only
    credits, unique-index idempotency); concurrent runs of one batch are
    serialized by a conditional `UPDATE … status='sending' WHERE status IN (…)`
    claim per row.
  - ⚠️ **Orphan recovery**: a row stuck at `sending` with `withdrawal_request_id
    IS NULL` = a run that crashed mid-processing (a real in-flight payout always
    gets its request id set in the same tx as `sending`). `runBatch` resets
    those to `pending` before each run, and wraps every row processor in
    try/catch — without both, a throw (vs a returned `{ok:false}`) left the row
    invisible forever (`sending` is deliberately not retryable).
  - ⚠️ **RELATED FIX in `payoutRelay.ts` `failJob`**: it credited **points**
    back for a failed withdrawal regardless of `source_kind` — wrong ledger for
    an `earned_usdt` withdrawal (which is what this feature creates in bulk, and
    what a USDT-paying task's own withdrawal already was). Now branches on
    `source_kind`, mirroring `staff.ts`'s manual reject. Regression test added.
  - New tables `payout_batches` + `payout_disbursements` (workflow state, not
    ledgers). New permission `disbursements.manage` (W/admin tier → `admin` +
    `finance`). UI: `/staff → Money & payouts → Disbursements`
    (`web/src/components/staff/Disbursements.tsx`), plus a "Rewards waiting to
    be paid" card with one-click Send on the User 360.

- **STAFF-PANEL PHONE REVIEW, PART TWO: TWO REAL BUGS, MONEY & PAYOUTS
  REGROUPED, WHATSAPP-STYLE TICKETS (founder, 2026-09-02, same day).**
  Verified: tasksAdmin (57), moneyAdmin (82), usersAdmin (50), admin (15),
  stage7 (96), messagesAdmin (46), stage6 (70), permissions (17), stage4
  (48), mining unit (42), mining e2e (65), all green; api + web typecheck,
  eslint, web production build (37 routes) all clean; `security-review` —
  no findings.
  - ⚠️ **BUG: A TASK'S OWN PROOFS TAB SHOWED SITE-WIDE COUNTS.** "Paid 1 /
    Rejected 1" chips sat next to an empty list because `GET
    /staff/task-proofs`'s counts query had no `task_id` filter — it was
    always counting every task's proofs, on purpose, for the GLOBAL Proofs
    screen (`ProofReviewPanel`'s "counts never follow the filter" rule,
    stage 6), and the per-task tab (`TaskProofsTab`) was reusing the same
    endpoint response unmodified. Fixed with a `scopeCounts` param sent only
    by the per-task tab; the global screen's behavior is untouched.
  - ⚠️ **BUG: TOP MINERS SHOWED "TELEGRAM USER" FOR ACCOUNTS WITH A REAL
    NAME ON FILE.** `displayIdentity()`'s fallback chain was correct; the
    top-miners SQL in `staffMining.ts` simply never selected `display_name`/
    `telegram_name`. Fixed at the query. `displayIdentity()` also gained an
    opt-in `{ full: true }` mode that shows a handle AND a name together
    (founder: "if they have a name, show that too") — used only where
    there's room (User 360's header, the top-miners table); every narrow
    table-cell caller is unchanged.
  - **Approving a task proof no longer re-asks the amount.** The reward is
    already whatever the task was configured to pay, and the server-side
    `decideProof()` already defaulted to the full ceiling when the client
    sent nothing (proven by the bulk-approve path, which always has). The
    primary Approve button is now one click at full reward; "Approve a
    different amount" is a small secondary action for the rare case a staff
    member wants to trim a suspect submission below the ceiling.
  - **A real "All" tab** on both proof-review screens (was Pending / Reward
    pending / Paid / Rejected only).
  - **Money & payouts: 11 flat sub-tabs → 6.** `Withdrawals` (USDT / BNB /
    relay jobs — all three already shared the `withdrawals.view`
    permission), `Deposits` (USDT deposits queue / USDT refunds queue /
    top-up settings — three different permissions, an inline note explains
    the deposits-queue-vs-top-up-settings distinction the founder asked
    about), and `Treasury` (treasury balance / reconciliation history) each
    now own an internal tab bar — same nested-tab pattern
    `MiningAdminSection` already established, so the top-level
    `SubTabs`/`SECTION_PANELS` mechanism didn't need to learn to nest.
    `Overview`, `Disbursements` and `Fees & limits` are unchanged, flat.
    ⚠️ **Every internal panel kept its own exact permission gate** — a
    grouped tab is visible if the role holds ANY of its children's
    permissions (`PanelDef.need` now also accepts an array), but each child
    component still individually checks its own permission before
    rendering, so nobody sees more than before. Dashboard tiles, the
    "recent money out" jump links and the command-palette search entries
    that used to deep-link to an exact old sub-tab now land on its new
    group's first internal tab instead of the precise one — an accepted,
    disclosed trade for fewer top-level tabs, not a bug.
  - **User 360's Balances tab gained a 4th box: live BNB (gas)**, an
    on-demand `GET /staff/users/:id/bnb-balance` read (reuses
    `hasEnoughGasForDisplay`, never throws, never polls — the same billing
    lesson the 2026-08-13/08-27 Alchemy entries above are about), split out
    of the main user-detail endpoint so a slow RPC can never hold up the
    rest of the page. Still four clearly labeled boxes, never a total
    (guardrail #7) — BNB is explicitly captioned "for network fees only —
    not spendable balance" since no ledger backs it on our side. The
    points-as-USDT sub-line under the Points box was removed per explicit
    request.
  - **Support ticket thread, closer to a real chat**: Send reply / Send &
    close now sit directly beside the input as one bar (photo-attach and
    the internal-note checkbox moved to a smaller row underneath); a
    message over 320 characters collapses with a "Show more" toggle instead
    of pushing the input off screen; the ticket list shows open (left
    accent) vs. closed (muted) at a glance regardless of which status tab
    is active, via a new `rowClassName` prop on the shared `DataTable`
    (additive — every other caller is unchanged).
  - **Ticket auto-close moved from Global settings to its own card atop
    Feature flags** (founder: "shift it... as a sub tab of the feature
    flags"). Stays a plain admin-tunable number under the hood — same
    `PATCH /staff/settings` call, 0 still means off — rather than being
    forced into the strictly-boolean `FeatureFlag` row shape.
  - **Two conceptual questions answered in conversation, not in code**:
    (1) points vs. ROZI stays two ledgers by guardrail #7 — the earner app
    already shows one number (ROZI); the fix here was making sure every
    remaining staff-panel number is labeled with which ledger it's from,
    same as User 360's boxes already were. (2) the conversion window is a
    pot split pro-rata by burn share, never a fixed exchange rate — its
    admin panel already states this in plain terms, confirmed by reading
    it; no code change needed.

- **SUPPORT BECOMES ONE CHAT; THE TREASURY GETS A REAL LEDGER; EVERY TX HASH
  IS CLICKABLE (founder, 2026-09-03).** Seven asks from a phone review, plus a
  review pass over the first commit that found ten real defects. Plan and full
  checklist: `docs/SUPPORT_AND_MONEY_PLAN.md`. Verified: 36 suites from a fresh
  database — 91 unit + ~1340 e2e, 0 failures (stage6 99, moneyAdmin 100,
  disbursements 81, usersAdmin 59); api + web typecheck, eslint 0 errors, web
  production build; `security-review` — no findings.
  - **`/help` is a conversation with "RoziPay Official", not a ticket form.**
    New `GET`/`POST /support/chat`. The user types and sends — no subject to
    invent, no list of past tickets to pick from. Staff get a two-pane **Inbox**
    beside the existing table view.
    ⚠️ **A TICKET IS NOW AN INVISIBLE *SEGMENT* OF ONE THREAD, AND THE TABLES
    ARE UNTOUCHED.** Assignment, close, rating, the auto-close timer and the
    internal-note filter all still work exactly as they did. Replacing
    `support_tickets` would have thrown all of that away to change what a screen
    looks like.
    ⚠️ **`author_role <> 'internal'` HAD TO BE RE-APPLIED HERE.** `/support/chat`
    is a **second** read path over `ticket_messages`; the filter guarding the
    first one does nothing for it. A regression test writes a real staff note
    and reads the chat back as the user.
    ⚠️ **`?since=` IS NOT AN OPTIMISATION.** `ticket_messages.image` holds a
    base64 data URL up to 2MB, and the screen polls every 15s — without a delta
    a user who has sent three screenshots re-downloads a megabyte a tick, on
    mobile data, in the markets this app is built for. The screen loads once and
    appends; `delta` is decided by the SERVER, never inferred from the request.
    ⚠️ **A PHOTO WITH NO WORDS IS A VALID MESSAGE.** A screenshot of the error
    *is* the report for most people here; requiring text made the attach button
    a trap.
    ⚠️ **The thread is walked in TIME order, never segment by segment.** Staff
    can reopen a closed ticket, so a reply can land on an older conversation
    after a newer one started — grouping by segment rendered it above messages
    sent days later, with the date separators walking backwards.
    **A user can close their own chat** (founder: "get the reply, be happy, and
    then close the chat") — which is also what unlocks the rating, since the
    prompt only exists on a closed segment. Typing again opens a new segment, so
    it is "I'm done", never "I can't ask again".
    ⚠️ Two concurrent sends could open two conversations — the live-segment read
    was a plain SELECT. Serialised on the user with `pg_advisory_xact_lock`, the
    same tool guardrail #8 uses for balances, for the same reason.
  - **A Telegram user is never labelled "Telegram user" again.** The username
    was always captured at *login* — but `bindTelegramToUser` (the website
    "Connect Telegram" path) wrote `telegram_id` and **nothing else**, so any
    account that connected that way had no identity on file, ever. It stores
    username and name now. `POST /staff/users/telegram/refresh` backfills older
    accounts via the Bot API, behind a button in Users.
    ⚠️ **`users.telegram_checked_at` IS WHAT LETS THE BACKFILL FINISH.**
    Telegram genuinely has nothing for some accounts (no username, no last
    name). Without recording the *attempt*, those rows keep matching the same
    query — the first batch of unfixable accounts occupies it forever, nothing
    past them is ever reached, and the count never drops.
    ⚠️ **The COUNT endpoint is gated on `users.review`, not the looser
    `users.list`** — the button's visibility *is* that count, so a looser gate
    put a button in front of `marketing` and `finance` that 403s every time.
    Last-resort label is `Telegram #<id>`: an identifier a staff member can
    search for, not a category name.
  - **Disbursements live next to the task that owes the money.** `listEligible`
    and `listBatches` take a `taskId`, and so does `DisbursementsPanel` — **one
    component, three mount points** (Money & payouts, Tasks & networks, and a
    task's own Rewards tab). ⚠️ **The scope is server-side on all three reads
    including "batch everything eligible"**, or one click on a task page sweeps
    in every other campaign's rewards. A batch now has a **name**, auto-filled
    from the campaign it pays and editable; the uuid stays on the row as a
    copyable chip, it just is not the thing you read first.
  - **The treasury screen is BEP20 only, with a QR**, and coin and network are
    two labelled facts rather than one sentence — BNB is a real token in the
    same wallet and sending it instead of USDT is unrecoverable. ⚠️
    `KNOWN_CHAINS` is untouched: this is a display narrowing on one panel, and
    historical rows on Base/Aptos must keep labelling.
  - **New Treasury → "Wallet" tab.** `GET /staff/treasury/wallet` reads the
    treasury address's real USDT and BNB movement from the chain and annotates
    each row from our own tables. ⚠️ **THE CHAIN IS THE SOURCE; OUR ROWS ARE
    ONLY THE LABELS** — a ledger built from our own tables could only ever show
    movement we started, and the whole point of the screen is the movement we
    did not. A row with no label is the interesting one. ⚠️ **On demand only,
    never polled** (the two Alchemy billing incidents above). ⚠️ Each rail is
    capped separately and the merge is NOT re-sliced — 50 newer USDT transfers
    would otherwise hide every BNB row on a panel that promises both.
  - ⚠️ **`labelTreasuryHashes` HAD NEVER EXECUTED, AND THAT IS WHY IT MOVED TO
    MODULE SCOPE.** Tests short-circuited on the missing explorer key, so five
    hand-written queries over five tables would have shipped unrun — the
    `networks.label` bug class, twice-burned in this repo. Exported and driven
    against real Postgres, the new test immediately caught `IN ()` on an empty
    list: a Postgres **syntax error**, guarded only at the call site. Do not
    push it back inside the route.
  - **Every transaction hash is one tap from BscScan** — new `TxHash` primitive
    plus an explorer link on `Addr`, across withdrawals, deposits, refunds, BNB,
    relay jobs, disbursements, the treasury wallet and User 360's three money
    tables. ⚠️ **The chain is passed per row, never defaulted at the call
    site**: an unknown chain gets no link rather than a wrong one, and sending
    someone to BscScan for a Base hash shows "not found" — which reads as money
    that never moved. `withdrawal_requests.tx_hash` had been written by every
    mark-paid since payouts existed and was simply never SERVED; it is now.
  - **"No all withdrawals" on a queue that should not be empty.** That endpoint
    really does drop every filter — but it only reads `withdrawal_requests`, and
    money leaves on **three** rails. New read-only **All money out** view merges
    withdrawals, deposit refunds and BNB sends into one time-ordered list.
    ⚠️ **The three rails have three different permissions, and one `Promise.all`
    made that one failure.** The tab sits under `withdrawals.view` (agent tier)
    but refunds need `refunds.view` (manager tier), so a legacy `agent` 403'd
    and lost the rows they *were* allowed to see. Refunds are skipped with a
    line saying so — the same defect class as Finance in Stage 4.
  - ⚠️ **`formatUsdtMicro` AND `formatBnbWei` ALREADY CARRY THEIR UNIT.** Both
    new panels appended a second one — "12.00 USDT USDT" on every row.
    `MoneyOverview.tsx` already carried a comment warning about exactly this.
  - **Not built, and the screen does not pretend otherwise:** a live treasury
    balance. The Wallet tab shows in/out totals **over the transactions it
    fetched**, in those words — a partial sum labelled "balance" would be a
    number that disagrees with the wallet.

**Founder collection list → `docs/LAUNCH_CHECKLIST.md`.** The real launch blockers
are things only the founder can obtain: (1) a **real ad-network account** + its
postback secret (offerhub/tapvid/surveyx are spec adapters, not live), (2) a
**Resend API key + verified email domain**, (3) a **funded USDT treasury wallet**.
Then 🟡 Sentry auth, ⚪ custom domain, ⚪ Telegram.

**Still open (business decisions):** ✅ all three locked (60% split / Pakistan / RoziPay — domain rozipay.xyz).

**Phase 2 remaining:** Sentry is ❌ **declined by the founder (2026-08-01)** — closed, do not re-raise it as outstanding. Further fraud tuning is open Phase 3 work. (Urdu is no longer on the list — it was dropped, see above.)

**What is actually still blocked on the founder (2026-08-08):** the xpub is
done — `CUSTODY_XPUB_BEP20` is set and live, per-user deposit addresses work.
**Automatic on-chain payout is now LIVE too** (see the entry above) — that
item is no longer blocked, it was activated without the testnet step, on the
founder's explicit informed choice. What actually remains:
(1) **A real ad network approval** — applications are in and none have landed;
the unlock is daily users, not code. Send me the four postback items for any
network that says yes and the adapter + smoke test is one session.
(2) **The treasury wallet needs to actually hold funds.** Automatic payout
being "on" is not the same as it having anything to pay with — a request
under the ceiling will simply fail to send if the treasury has no USDT (to
pay out) or no BNB (for gas). Confirm what's actually funded before assuming
withdrawals/refunds will succeed.
~~(3) The deposit scanner's RPC issue — needs a paid `RPC_BEP20` endpoint.~~
**RESOLVED, confirmed live 2026-08-12.** Two independent things closed this,
both already shipped and deployed before this note was written: the
`eth_getLogs`-refusing/limit-exceeded crash was fixed in code the same day
(commit `c63d0ed`, adaptive block-range shrinking + reordered public
fallbacks) — AND, separately, `RPC_BEP20` on Railway now leads with a real
Alchemy BSC endpoint (not a public node), verified by calling it directly
(`eth_blockNumber` returned a real, current block). Confirmed by reading
Railway's live logs: zero `"Deposit scan tick failed"` errors across 100+
ticks (20s interval) since the last deploy, where before it repeated every
tick. **Do not re-flag this as an open item** — if it recurs, it's a new
regression, not the original bug. (Treasury funding, item (2) above, is
UNCHANGED and still $0/0 BNB — confirmed the same way, via a direct
`eth_getBalance`/`balanceOf` call against the treasury address.)
Everything else on the old checklist is done, deferred by decision, or declined.

- **A PHONE-REVIEW PASS: THE WELCOME SCREEN STOPS LEAKING THE PAGE BEHIND IT,
  FEATURE FLAGS AND GLOBAL SETTINGS ARE ONE SCREEN AGAIN, "GET MY MONEY" IS
  GONE FROM /wallet, AND A DISBURSEMENT QUEUE STOPS IMPLYING A BLOCKCHAIN SEND
  THAT NEVER HAPPENED (founder, 2026-09-03).** Four asks off screenshots.
  Verified: api + web typecheck, eslint (0 errors, pre-existing `<img>`
  warnings only), web production build (37 routes) all clean;
  `test:disbursements` (81), `test:admin` (15), `test:usersadmin` (59),
  `test:moneyadmin` (100), `test:wallet` (52), `test:flags` (8),
  `test:permissions` (17) — all green.
  - **The welcome overlay now renders through a React portal straight onto
    `document.body`**, not inline in the component tree
    (`WelcomeExperience.tsx`). The screenshot showed the real home screen's
    own bottom nav bar peeking through under the "Let's start" button — the
    overlay is `position: fixed; inset: 0`, which is *supposed* to be
    containing-block-proof, but a portal removes the question entirely by
    mounting outside `.app-frame` altogether. `.we-root` also gained explicit
    `100dvh`/`100dvw` sizing alongside `inset: 0` as a second, independent
    guard.
  - **The tagline moved above the button, not below it.** "Your RoziPay
    journey starts here" used to trail the CTA, which read as a second,
    separate row bolted under the screen rather than part of one full-bleed
    screen. The fade-in delays were swapped in the CSS so the button — the
    one action on the screen — is still the last thing to visually settle in,
    even though it's no longer last in the markup.
  - **The welcome screen's repeat interval is now admin-tunable**
    (`/staff → Feature flags → Global settings`): once only (unchanged
    default), every 24 hours, every 7 days, every 30 days, or every year. A
    closed set of presets, not a free-form number — picked, not typed.
    `WelcomeExperience.tsx`'s localStorage value changed from a bare `"1"` to
    an ISO timestamp, which `decideShow()` now counts `repeatDays` forward
    from; the earner client reads the setting off `GET /features`
    (`welcomeRepeatDays`, alongside the existing feature-flag map — one more
    "what should the app show right now" global answer on the same call), and
    home does not mount the overlay until that call resolves, so it can never
    flash open and then decide it should have stayed shut. Backend:
    `settingsRuntime.ts`'s `welcomeRepeatDaysNow()`, `GET`/`PATCH
    /staff/settings`.
  - **"Feature flags" and "Global settings" are one sidebar section again**
    (`flags`), Global settings as its second sub-tab — reversing the
    2026-09-01 split into two top-level pages. `SectionId` dropped `"settings"`
    as its own value; every deep link (`staff-search.tsx`, the dashboard's
    jump links) that used to point at it now points at `flags` /
    `p-settings`.
  - **"Get my money" is gone from `/wallet`.** It sat below the token list,
    pointing at the exact same `/wallet/withdraw` screen the Withdraw button
    right at the top of the page already opens — a second button for the same
    destination, further down the page a user has to scroll to see.
  - ⚠️ **A DISBURSEMENT'S STATUS NOW SAYS WHAT ACTUALLY HAPPENED TO THE
    MONEY, AND THE FIX IS A DISTINCTION, NOT A RENAME.** The screenshot was a
    `balance`-mode batch — Address and Detail both blank, status "RELEASED" —
    read by the founder as "we already sent the USDT". For that mode, nothing
    ever touches a chain: `balance` mode credits the user's in-app balance
    only, on purpose (`disbursements.ts`'s own header: "No address, no gas,
    no treasury"). Relabelling "released" to "Sent" would have put a false
    on-chain claim in front of whoever reads that queue next. Instead:
    `released` now reads **"Credited"** (money reached the balance, nothing
    more) and `paid` — the state that only exists once a real payout has a tx
    hash, across withdrawals, BNB withdrawals, refunds and disbursements
    alike — now reads **"Sent"** (`primitives.tsx`'s `STATUS_LABEL`). A
    balance-mode row's Address cell now says "In-app balance" instead of a
    bare dash, and its Detail cell says "No transfer — credited to balance
    only" instead of one, so the blank cells read as intentional rather than
    broken. Rows from `onchain`/`manual`/`csv` batches are unchanged — they
    already carry a real address (`Addr`, with its BscScan link) and, once
    paid, a real clickable tx hash (`TxHash`) via the block-explorer
    primitives built 2026-09-03 earlier the same day.

- **CROSS-CHECK ON THE PASS ABOVE, SAME DAY: TWO REAL BUGS FOUND AND FIXED
  BEFORE EITHER SHIPPED FURTHER (founder asked for a depth review, 2026-09-03).**
  Verified: api + web typecheck, eslint (0 errors), web production build
  (37 routes) clean; `test:tasksadmin` (57), `test:stage7` (96),
  `test:disbursements` (81) all green.
  - ⚠️ **BUG 1 — "PAID" TABS FULL OF "SENT" BADGES.** `primitives.tsx`'s new
    `STATUS_LABEL` override (`released`→"Credited", `paid`→"Sent") only
    patched `StatusBadge`. Three OTHER places rendered the exact same status
    values with their own independent `.replace(/_/g," ")` copy that never
    learned about the override: `StatusTabs` (the filter-tab buttons
    themselves), and two hand-written empty-state strings in
    `TasksAdmin.tsx`/`MoneyQueues.tsx`. The result, on four different queues
    (task proofs, withdrawals, refunds, BNB withdrawals): a tab button
    labelled **"Paid"** sitting directly above a column of rows all badged
    **"SENT"** — the exact "nothing formatted two ways" failure
    `primitives.tsx`'s own file header warns against, self-inflicted the same
    day. Fixed by extracting the shared logic into one exported
    `statusLabel()` function and routing all four call sites through it —
    `StatusBadge`, `StatusTabs` (Title-Cased on top, for its own convention),
    and both empty-state strings (lower-cased into their sentence). One
    function, four callers, so a future override can never repeat this.
  - ⚠️ **BUG 2 — TURNING ON A WELCOME-REPEAT INTERVAL WOULD HAVE RE-SHOWN THE
    OVERLAY TO EVERY EXISTING USER AT ONCE.** Every account that had already
    dismissed the welcome screen under the pre-2026-09-03 code has the bare
    string `"1"` in localStorage, not a timestamp — and `Date.parse("1")`
    does not fail, it silently resolves to 1 Jan 2001. `decideShow()`'s
    elapsed-time math would have read every one of those accounts as "last
    shown a quarter-century ago," so the first time an admin picked ANY
    repeat interval (even "every year"), the whole existing user base would
    have seen the welcome screen again on their very next visit, all in the
    same moment — not the staggered, per-user cadence the setting is supposed
    to produce. Fixed: the legacy `"1"` sentinel is now detected explicitly,
    treated as "already seen, exact time unknown" (so it does not re-show
    right now), and upgraded in place to a real timestamp so the interval
    starts counting correctly from today for that account.
  - Not a bug, considered and left alone: swapping the tagline/button fade-in
    delays (the button-final change above) also means the button's own
    fade-in and its separate shine-sweep animation now start at the same
    moment (1900ms) instead of the sweep trailing 200ms after the fade — a
    cosmetic timing nuance, not a glitch, and not touched because nudging the
    sweep later would push its end past the `ENTRANCE_MS` invariant the file
    header documents (sweep must end by ~2.8s, matching the idle-loop
    handoff) for a purely aesthetic gain.

- **THE WALLET USDT TOTAL DROPS POINTS AGAIN — REVERSES THE 2026-08-08 BLEND
  (founder, 2026-09-03, later the same day).** The founder reviewed the live
  `/wallet` screen (a real test account reading "2.94 USDT") and objected:
  part of that figure was task/referral points converted at the fixed rate,
  which is real, owed money, but settles from the TREASURY, not from
  anything the user or a network actually deposited — showing it pre-blended
  into "you have X USDT" implied money was sitting somewhere it wasn't.
  ⚠️ **SUPERSEDES the "THE WALLET SCREEN BECOMES A REAL WALLET" entry above
  (2026-08-08, third pass) and the earlier-today commit that orchestrated
  `POST /wallet/withdraw` as a deposit→earned-USDT→points waterfall (commit
  `38be4e0`, "Wallet withdraw becomes one USDT balance" — no CLAUDE.md entry
  of its own was written for it, which is itself the gap this entry closes)
  — both described Total Balance as deposit + earned USDT + points. It is
  now deposit + earned USDT ONLY.**
  - `GET /wallet/balance` (`api/src/routes/app.ts`): `usdtAvailableMicro` /
    `usdtTotalMicro` sum only `usdt_ledger` (real deposits) and
    `earned_usdt_ledger` (task USDT paid directly in USDT). Points are still
    returned as `pointsAsUsdtMicro`, informationally, never summed in.
  - `POST /wallet/withdraw` (`api/src/routes/withdrawals.ts`): the waterfall
    dropped its third leg — it now only ever draws deposit → earned USDT.
    Points are structurally invisible to this route: a points-only balance
    is refused exactly as if it were zero, even when the points alone would
    cover the request (regression test: `wwd-big-points-tiny-real`, a $50
    points / $2 real account can withdraw the $2 but never the $50).
  - Points cash out exactly as before this pass started, through the
    separate, **untouched** `POST /withdrawals` (`source_kind: "points"`) —
    same queue, same KYC/step-up/fee rules — now reachable from its own
    screen, **`/wallet/earnings/withdraw`**, linked from a new "Task &
    referral earnings" card on `/wallet`.
  - **Max + 25/50/75% quick-fill chips** added to both withdraw amount
    inputs (founder: "most exchanges have this on withdraw"), extracted into
    one shared `web/src/components/QuickFillChips.tsx` — the two screens
    draw on different balances and call different endpoints, but the chip
    row itself is identical, so it is not two copies that can drift apart.
  - `GET /wallet/balance`'s independent reads (gas rate, gas check, points,
    deposit micro, earned micro, min-withdraw, the fee setting) now run
    under one `Promise.all` instead of six sequential round-trips — this
    endpoint is polled from the TopBar on every screen.
  - Verified: `test:usdt` (112, the waterfall test block rewritten for two
    sources instead of three) + `test:wallet` (52) + `test:withdrawcontrols`
    (21) + `test:autowithdraw` (16) + `test:autorefund` (8) +
    `test:payoutrelay` (48) + `test:fees` (24) + `test:stage4` (48) +
    `test:moneyadmin` (100) all green; api + web typecheck, eslint, web
    production build (38 routes) clean; `security-review` — no findings; a
    follow-up correctness/efficiency/duplication pass across three angles
    found no functional bugs (the waterfall math and the removed
    floor→ceil clamp were both proven safe by brute-force and by algebra)
    and two real but non-functional issues, both fixed in the same pass:
    stale comments in three other files still describing the blended model
    (this entry), and the duplicated quick-fill chip markup (the shared
    component above). ⚠️ **Not extracted, flagged as a follow-up**: the fee-
    preview formula and the KYC/step-up card JSX are ALSO duplicated between
    `/wallet/withdraw` and `/wallet/earnings/withdraw` — worth a shared
    `useWithdrawForm` hook or `<WithdrawForm>` component if a third
    withdraw-shaped screen (e.g. a future ROZI cash-out) ever needs the same
    shape, deliberately not done here to keep this pass to what was asked.

- **THE WALLET'S "TASK & REFERRAL EARNINGS" CARD IS HIDDEN, NOT REMOVED
  (founder, 2026-09-03, later the same day).** The founder's reasoning: there
  is no points-based referral programme actually live right now — a new
  referral would be paid directly in ROZI into the user's mining wallet, not
  as points — so a wallet card advertising "Task & referral earnings · Cash
  out" points at money nobody currently earns that way, and competes for
  attention with ROZI, which is where new money actually lands. The founder
  was explicit: **do not destroy the function**, only hide the entry point,
  so it can come back later with real settings (a per-referral rate, etc.)
  once there is an actual points-based referral offer to show.
  - New flag `wallet_earnings_card` in `flagsCore.ts` — **display-only,
    defaults OFF**. It is the SECOND flag in the registry (after
    `bnb_deposits`) that is legitimately `displayOnly`: there is nothing to
    refuse server-side, because nothing about the underlying feature changed.
    `/wallet/earnings/withdraw` and `POST /withdrawals` (`source_kind:
    "points"`) are **completely untouched** and keep working exactly as they
    did before this — a user who already knows the URL (or is sent there by
    a future push/notification) can still cash out. Only the card on
    `/wallet` that surfaces it is gated, via `GET /features` →
    `features.wallet_earnings_card`, read in `web/src/app/wallet/page.tsx`.
  - **Turning it back on needs no redeploy** — it is the same
    `/staff → Feature flags` panel every other flag lives in, since the
    registry auto-lists any row added to `FLAGS` (`flagsCore.ts`). No new
    admin screen was built.
  - `flags.test.ts`'s "only the flag that genuinely cannot be enforced is
    display-only" guard was updated to allow exactly these two flags, with
    the reasoning for each spelled out in the test itself — the rule is
    "nothing left to refuse," not "exactly one flag may ever qualify."
  - Verified: `npm run test:flags` (8/8), api + web typecheck, eslint (0
    errors), web production build (38 routes) — all clean.

- **A FULL BUG/DISCONNECTION AUDIT PASS FOUND NOTHING BROKEN (self-directed,
  2026-09-03, same day, per the founder's "go find any bugs" ask).** api +
  web typecheck clean, eslint 0 errors, web production build (38 routes)
  clean, and 14 e2e/unit suites re-run from a fresh database each time —
  mining, mining e2e, wallet, flags, usdt, deposits, withdrawControls,
  autoWithdraw, autoRefund, payoutRelay, fees, permissions, moneyAdmin,
  stage4 — **~640 checks, 0 failures.** The documented frontend/backend
  drift method (grep every `api.ts` export for its call-site count, and the
  reverse: every backend route for a caller) was re-run in both directions;
  guardrail #8 (`pg_advisory_xact_lock`) was spot-checked on the newest money
  path, admin disbursements. No crash, no wrong-column query, no missing
  lock, no broken build. **No code was changed** — inventing a fix to look
  productive was deliberately avoided.
  - ⚠️ **ONE REAL GAP FOUND, LEFT AS-IS BY EXPLICIT FOUNDER DECISION.** The
    Connect-Wallet signature-proof flow (2026-08-01 — a user signs a message
    with their own wallet so the SERVER, not the user's typed claim, decides
    the payout address; see that entry above for why it was built) has had
    **zero render call sites anywhere in the app** since the 2026-08-12
    "Profile got simpler" pass removed it from `/profile/settings` and never
    re-added it to `/wallet/withdraw`. `web/src/components/ConnectWallet.tsx`
    and the backend routes (`/withdrawals/addresses/challenge`, `/verify`)
    are still live and tested — a user just has no button that reaches them,
    so every withdrawal today goes through the plain typed-address box only.
    **Told plainly and asked; the founder chose to leave it as is** — the
    typed-address path stays the only one, same as it's been since
    2026-08-12. Recorded here as a decision with a date, not a bug that
    slipped through — do not re-flag this as a defect in a future audit
    unless the founder changes their mind.
  - Minor, left alone as harmless: three unused-but-not-wrong `api.ts`
    exports (`savePayoutAddress`, `notifyOneUser`,
    `createEarnedUsdtWithdrawal`), one diagnostic-only staff endpoint with no
    panel (`GET /staff/mining/rpc`), and `/staff/{bnb-withdrawals,relay-jobs}/:id/handled`
    superseded by `/resolve` but left in place.

- **THREE LOW-CONTRAST UI BUGS FOUND ON A PHONE PASS, ALL TOKEN/CLASS-LEVEL,
  NOT DESIGN CHANGES (founder, 2026-09-03).** Verified: `npx tsc --noEmit`,
  `eslint`, `next build` (38 routes) all clean; the compiled Tailwind CSS was
  read back to confirm every class used resolves to one real, non-conflicting
  rule. ⚠️ **NOT reviewed in a live authenticated browser session** — these
  pages read balances off the live API/DB, and standing this up just to
  screenshot a CSS fix was out of scope; verified instead by reading the
  compiled CSS output and the token values behind each affected element.
  - **`LogoMark` (`components/Logo.tsx`) applied `bg-white` UNCONDITIONALLY
    and then ALSO applied `bg-brand` conditionally while the real logo file
    hasn't loaded** — two `bg-*` utilities on one element. Tailwind resolves
    same-specificity utility conflicts by their order in the COMPILED
    stylesheet, not by their order in the className string, so `bg-white`
    could silently win, leaving the white "R" fallback glyph on a white box —
    invisible in light mode (visible in dark only because the page behind it
    is dark). Fixed to a single ternary — `bg-white` only once the real image
    has loaded, `bg-brand` only while it hasn't — so the two can never apply
    together regardless of build order.
  - **The `ghost` Button variant (`components/ui.tsx`) relied on
    `border-line` alone for its shape** (`bg-transparent … border border-line`)
    — used for every secondary action next to a primary one, wallet's Deposit
    button (next to Withdraw) included. In the dark "vault" skin,
    `--color-line` (#1e3a3f) sits almost on top of `--color-card`/page
    background, so the border was nearly invisible — only the text read.
    Same button also looked washed out in light mode next to the solid
    primary button. Fixed to a visible fill instead of a border-only outline:
    `bg-brand-tint text-brand border border-brand/15` — reusing the exact
    `bg-brand-tint` pattern already used (and already legible in both themes)
    for icon chips throughout the app, rather than tuning the global
    `--color-line` token, which is used in 340+ places across the staff panel
    too and wasn't touched to avoid an unreviewed, wide-blast-radius change.
  - **`/tasks`'s Available/My activity/History segmented control** had the
    same shape of problem — an active white/`bg-card` pill inside a
    `bg-brand-tint` track with no border on either, reading as flat/washed
    out in light mode. Gave both the track and the active pill a
    `border-brand/10` / `border-brand/15` edge (inactive tabs get a
    `border-transparent` of the same width so they don't shift size on
    switch) — same fix shape as the Button change, deliberately not a
    `--color-line` token edit for the same reason.
  - Grepped for the same "static `bg-*` + conditionally-applied second
    `bg-*` on one element" anti-pattern that caused the logo bug elsewhere in
    `web/src` — no other instance found; the Logo component was the only one.

- **A FULL PRODUCT AUDIT, THEN ITS FIXES: A ONE-TIME-CODE REUSE BUG AND SIX
  MEASURED CAPACITY LIMITS (2026-09-03/04).** A senior-auditor pass over the
  whole product (`audit/`, committed) followed by the founder authorising fixes.
  Two commits: `50ea7a3` (the fixes) and `9b0c457` (the audit + its raw
  evidence). Verified: **38 suites, 1,497 checks, 0 failures**, every e2e suite
  from a genuinely fresh database; api + web typecheck, web production build,
  lint all clean. Read `audit/FIXES_APPLIED.md` for the before/after on every
  item and `audit/FINDINGS.md` for what is still open.
  - ⚠️ **THE SECURITY BUG: A ONE-TIME EMAIL CODE COULD BE REDEEMED SEVERAL
    TIMES AT ONCE.** `consumeCode` (`api/src/auth.ts`) read the row, compared
    the hash in JS, then wrote `consumed = 1` **unconditionally** — so twelve
    simultaneous confirmations of ONE valid code were all hash-matched and
    **four were accepted**. It hit signup verification, password reset, account
    linking, and the **withdrawal step-up code**, which is consumed OUTSIDE the
    per-user lock that guards the debit — so one emailed code could satisfy
    several concurrent withdrawal requests. The five-attempt guess cap had the
    same shape: the count was read BEFORE the increment, so a burst of wrong
    guesses all saw zero and walked past it. The claim is now the atomic act
    (`UPDATE … WHERE id = ? AND consumed = 0 RETURNING …`; zero rows means
    someone else spent it), and the attempts counter is read from its own
    `RETURNING`.
    ⚠️ **NO EXISTING SUITE COULD EVER HAVE CAUGHT THIS, AND THAT IS THE
    LESSON.** PGlite has a single connection, so it serialises the exact
    interleaving that breaks and the broken code **passes** there. Run the
    sequence one request at a time and the old version is correct. This is why
    `test:otprace` carries a **structural tripwire** that reads `auth.ts`'s own
    source and fails if either write is turned back into a blind one — on the
    default driver that tripwire is the only thing protecting the fix. The fix
    was also reverted in place and the suite re-run against the old code to
    prove the test can fail (3 of 12 accepted, attempts reached 12 against a
    cap of 5): a regression test nobody has watched fail is not evidence.
  - **Three money races were run against real multi-connection Postgres for the
    first time** — the checks the project's own suites had always skipped.
    Withdrawal double-spend **passed**, mining claim double-credit **passed**,
    one-time code single-use **failed** (above). So guardrail #8's per-user
    `pg_advisory_xact_lock` genuinely works where it is applied; `consumeCode`
    was the path that had none.
  - **The pool now sheds load instead of queueing forever.** `max: 10` with no
    `connectionTimeoutMillis` and no `statement_timeout` meant overload produced
    an unbounded queue, not errors: offered load 100 → 150 → 220
    screen-loads/second moved throughput not at all (426 / 407 / 438 req/s)
    while p95 went 38 ms → 22 s → 41 s. Now bounded, env-tunable
    (`PG_POOL_MAX`, `PG_CONNECT_TIMEOUT_MS`, `PG_STATEMENT_TIMEOUT_MS`), with a
    `pool.on("error")` handler so a dropped idle connection replaces itself
    instead of killing the process.
    ⚠️ **BOOT DDL IS DELIBERATELY EXEMPT FROM `statement_timeout`** —
    `CREATE INDEX` on a large table can legitimately outlast any request
    deadline, and a deadline there means the bigger the database gets, the
    likelier the API is to fail to boot **at all**. `driver.exec` sets
    `statement_timeout = 0` on its own client and destroys that connection
    rather than returning it if the DDL throws.
  - **All five background timers now go through one no-overlap guard**
    (`everyNoOverlap` in `server.ts`), which also logs tick duration — the
    audit's closing note was that nothing here would tell you which limit you
    were approaching, and a tick quietly exceeding its interval is the first
    symptom of most of them. The two **global** advisory locks became
    **try**-locks (`hashtext('rozi-settlement')`, `hashtext('deposit-scan')`),
    matching what `payoutRelay.ts` already did: a blocking wait held a pooled
    connection for the holder's whole duration, and declining costs nothing
    because settlement is idempotent on the `mining_epochs` PK and the deposit
    scan is cursor-based.
  - ⚠️ **`users.referred_by` HAD NO INDEX.** Mining walks it twice per hashrate
    calculation and `/mining/state` computed the hashrate three times — **six
    sequential scans of the whole `users` table on the app's most-visited
    screen**, plus two per accrual, getting worse fastest exactly when growth
    is working. Three indexes added (`idx_users_referred_by`,
    `idx_mining_sessions_user_started`, `idx_completions_task_credited`) and
    **verified with `EXPLAIN` against the real queries**, not assumed.
    ⚠️ `idx_mining_sessions_user_started` lives in **`MINING_SCHEMA`, not
    `MIGRATIONS`**, because MIGRATIONS runs first and `mining_sessions` does not
    exist yet — putting it there fails `initDb()` outright on a fresh database,
    the **same mistake that already shipped once** with `rigs.base_cost_usdt`.
    Caught by booting a genuinely empty database, not by reading the code.
  - **`/mining/state`: 32 statements → 15**, measured. Settings are read once
    and threaded through, and accrual's own hashrate is reused for display
    rather than computed twice more (`sessionState` now carries `breakdown`).
    Reusing it is correct, not a shortcut: accrual claims the device and writes
    shares — it touches no rig, boost, streak or referral row.
  - **The mining accrual sweep at 100k: 998,601 statements / 6.0 min →
    400,625 / 3.4 min.** Over a real network that is ~4.7 minutes of round
    trips instead of ~11.6, inside a 15-minute interval that settlement queues
    behind. The reads are set-wise now (`hashrateOfBatch`).
    ⚠️ **THE PER-SESSION WRITES ARE DELIBERATELY STILL PER-SESSION** — each
    claims the device for the day via a PK conflict (how one-device-one-account
    is enforced) and each sits in its own try/catch, which is what makes the
    sweep safe to run unattended. Batching the reads is a pure win; batching
    the writes trades that isolation away for less than it costs.
    ⚠️ **CHUNKING IS A CORRECTNESS REQUIREMENT, NOT TUNING** — Postgres refuses
    a statement past 65,535 bound parameters and these bind one per user id, so
    a 100k sweep *cannot* be one query however well written.
    ⚠️ **READ `MINING_PLAN.md` M9.5 BEFORE TOUCHING THIS AGAIN.** The batch is
    only safe because `test:miningbatch` **runs both implementations against the
    same data and requires identical results** — hashrate *and* breakdown — for
    a population built to make disagreement possible (rigs at several levels,
    more boosts than the stack cap allows, streaks either side of the cap, a
    two-level downline, invitees that must not count, a referral **cycle**, and
    an input list long enough to cross the chunk boundary). **That test
    immediately caught a real bug in the new code**: `SELECT DISTINCT` is per
    STATEMENT and the query runs once per chunk, so an id in two chunks
    contributed its invitees twice and its referral component was **summed
    twice** — users would have quietly mined faster than they should, with
    nothing on any screen to show it. Both paths now assemble through one
    shared `hashrateFromParts()` so they cannot drift apart later.
  - **Measured effect:** 100 screens/s went from **p95 7.06 s with 219 dropped**
    to **p95 49 ms with none**; the ceiling moved from a flat ~430–470 req/s to
    ~600; the knee moved from between 60 and 100 screen-loads/second to between
    125 and 150. At 125 (598 req/s) **all four of the audit's own provisional
    gates pass** (p95 229 ms, p99 487 ms, 0.00% failures, nothing dropped) where
    the previous build failed every one at 100. **The 10,000-active-user model
    now clears the gates; the 100,000 model still does not** — and the reason is
    **not the database**: at the new ceiling only 1.1 of 20 connections were
    busy on average, zero lock waits. That needs a second replica and the timers
    out of the API process (`audit/REMEDIATION_PLAN.md` § P2).
    ⚠️ **The rig was ONE Windows machine shared with the load generator,
    loopback Postgres and a stub RPC.** Loopback removes the per-query round
    trip production has; the co-located generator takes CPU the API would
    otherwise get. These are **floors of confidence, not a Railway forecast** —
    which is why the accrual result is stated in **statements**, not seconds.
  - ⚠️ **STILL OPEN, UNCHANGED, and five of them are High:** email fail-open +
    OTP logging in production logs (A-01), non-revocable 30-day JWTs — a
    password reset does not invalidate an old token (A-03), replica-local rate
    limits (A-04), database TLS verification disabled on the public proxy
    (A-05), and 13 high-severity dependency advisories (A-06). Three of those
    are infrastructure decisions rather than code (a Redis add-on, Railway TLS,
    a dependency-upgrade window with a full re-run). Also open: splitting the
    staff DB pool (B10) and bounding the unbounded list endpoints (B12).
  - **Two local-rig traps, both recorded in `audit/TESTING.md`** because each
    looks exactly like a broken migration: a fresh test database must be created
    **UTF-8** (`CREATE DATABASE x WITH ENCODING 'UTF8' TEMPLATE template0` — the
    schema blocks hold 491 non-ASCII characters that WIN1252 cannot encode), and
    **wait for the boot-time ticks to finish before measuring** (a stage started
    25 s after boot reported p95 941 ms where the same stage warm reported
    22 ms — the accrual sweep was still running).

- **A STUCK WITHDRAWAL, A CLEAR TIMEOUT, AND ONE WITHDRAWAL = ONE TRANSACTION
  (founder, 2026-09-05).** Traced from a live stuck payout: a user's $0.20
  task-USDT reward and $2.09 deposit refund both showed "Processing"; the
  refund (paid from the user's OWN on-chain wallet) went through fine, the
  task-USDT withdrawal did not, because it needs a "prefund" leg from
  **treasury**, and treasury holds $0 / 0 BNB — confirmed again, unchanged
  from the 2026-08-08 entries above. Three fixes shipped; treasury funding is
  still the founder's own action, not a code fix. Verified: 603 e2e checks
  across every money-path suite (usdt 112, payoutrelay 66, moneyadmin 100,
  disbursements 81, wallet 52, stage4 48, withdrawcontrols 21, autowithdraw
  16, autorefund 8, fees 24, admin 15, usersadmin 59), all from a fresh DB;
  api + web typecheck, eslint, web production build (38 routes) all clean.
  - **ONE WITHDRAWAL, ONE TRANSACTION.** `POST /wallet/withdraw` used to
    split a request spanning both a real deposit and task earnings into TWO
    rows — a `usdt_refund_requests` row and a `withdrawal_requests` row —
    each its own relay job, each its own on-chain send, each its own history
    line for what the user did as ONE action. It is now a single
    `withdrawal_requests` row (`source_kind='mixed'`, new
    `deposit_component_micro` / `deposit_fee_micro` columns) settled as ONE
    relay job that forwards the FULL combined amount in a single
    transaction. `payoutRelay.ts`'s `createRelayJob` gained an optional
    `prefundMicro` — how much of the job's total must be moved from
    treasury first (the deposit portion never needs this: it already sits at
    the user's own derived address). ⚠️ **Omitting `prefundMicro` (every call
    site before this) means "prefund the whole thing" — the exact old
    behaviour, unchanged**, which is what let every existing test pass with
    zero changes to any other call site. `failJob` and the staff reject/pay
    paths both learned the `'mixed'` branch: a failure credits BOTH
    components back, in their own ledgers, together.
  - **A wall-clock give-up, alongside the existing attempt-count one.** A
    stuck relay job already gave up after `relayMaxAttempts` (15) — but that
    was ~22 minutes only because `payoutRelayIntervalMs` happened to share
    `depositScanIntervalMs` (90s, tuned purely for the Alchemy billing
    incidents above), so raising THAT for cost reasons would have silently
    stretched out how long a doomed withdrawal sits stuck. The relay tick now
    has its own `payoutRelayIntervalMs` (config.ts, same 20s default), and a
    new `relayMaxAgeMs` (20 minutes, inside the founder's own "ten, twenty,
    or thirty" ask) gives up on AGE alone even when attempts are still low —
    closing the exact shape the original production bug had (few attempts,
    old job, never surfaced).
  - ⚠️ **STILL BLOCKED ON THE SAME THING AS 2026-08-08: THE TREASURY HOLDS
    $0 AND 0 BNB.** Nothing above changes that — a task-USDT withdrawal will
    keep failing-and-refunding (safely, with nothing lost) until the
    treasury wallet is actually funded. That is the founder's own action,
    not a code fix.
  - **Two architecture questions the founder answered, recorded so they are
    not re-litigated:** (1) ad-network (CPX-style) task-USDT rewards stay
    balance-only until withdrawal — sending real USDT the instant a reward
    is credited would remove the ability to claw it back if the network
    reports it as fraud up to 60 days later. (2) our own RoziPay task
    rewards ARE meant to go on-chain, but only when staff deliberately runs
    a disbursement batch ("Send") — never automatically the instant a proof
    is approved. That admin-triggered on-chain send already exists (the
    2026-09-02 disbursements feature, `mode: "onchain"`) and needed no new
    code; it is unused today only because the treasury has nothing to send.

See `docs/` for the full spec.

- **COST CEILINGS FIRST, THEN FOUR OF THE FIVE REMAINING HIGH AUDIT FINDINGS
  (founder, 2026-09-04, second pass).** The founder's ordering, in their own
  words: control anything that could run up Railway or blockchain-API cost
  first, then fix what can be fixed without them. Verified: **41 backend
  suites, all green, each from a genuinely fresh PGlite store**; api + web
  typecheck; eslint 0 errors; web production build (38 routes); `npm audit
  --omit=dev` now reports **0 vulnerabilities on both projects** (was 3 high in
  the API, 4 in the web). Full before/after: `audit/FIXES_APPLIED.md` §§ 8-14.
  - ⚠️ **`TRUST_PROXY_HOPS` IS DEAD AND `req.ip` SILENTLY BROKE WHEN FASTIFY WAS
    UPGRADED. READ THIS BEFORE TOUCHING PROXY CONFIG.** Fastify 5.12.1's fix for
    `GHSA-3m5p-2c4r-xxw2` was to neuter numeric `trustProxy`, so on 5.12.3 a hop
    count **stops resolving `X-Forwarded-For` at all** — `req.ip` becomes the
    socket peer, i.e. the edge's address, identical for every request, with no
    error anywhere. `req.ip` feeds the per-IP rate limits, `ip_reuse`,
    referral-ring-by-IP, the audit log and the postback IP pin, so per-IP
    limiting would have collapsed into ONE GLOBAL BUCKET — the login limiter
    turning into a self-inflicted lockout — and every IP fraud rule would have
    compared everyone to everyone. It looks exactly like "lots of users behind
    one NAT", which is real in our markets, so the data would never have shown
    it. **`npm run test:proxy` was the only thing that caught it** (5 checks →
    11), which is the argument for keeping small suites that assert an
    infrastructure property rather than a feature. Replaced with
    `config.trustProxy` — a list of trusted NETWORKS, default
    `loopback, linklocal, uniquelocal, 100.64.0.0/10`, the last because
    carrier-grade NAT is not in `uniquelocal` and several hosts use it
    internally. **NEVER set `TRUST_PROXY=true`**: that trusts the left-most
    `X-Forwarded-For` entry, which the client writes. A wrong list is silent
    too, so `server.ts` warns (≤ once per 10 min) when an `X-Forwarded-For`
    arrives and `req.ip` still equals the socket peer.
  - ⚠️ **THE GAS READ ON `GET /wallet/balance` IS OPT-IN (`?gas=1`) AND THAT IS
    A COST CONTROL, NOT A MICRO-OPTIMISATION.** It was the ONE paid call in this
    system whose cost grew with the USER BASE rather than with a fixed tick:
    `personalGasReady` reaches the chain, and that endpoint is loaded by home,
    `/mine`, `/wallet` and `/wallet/usdt` — none of which render it. Only the
    two withdraw screens do, and they now use `fetchBalanceWithGas`. An
    on-chain call was the price of opening the app. **If you "simplify"
    `fetchBalance` back into one function, you put that cost back.** Also: in
    that handler `relayReady` does double duty — it decides the gas SURCHARGE
    too — so the read is gated on a *separate* `readGas`, or every screen that
    skips the read starts previewing a fee this deployment does not charge.
    **`GET /usdt` has the same read and it is opt-OUT (`?gas=0`,
    `fetchUsdtNoGas`) — the asymmetry is deliberate**: only two of six callers
    of `/wallet/balance` wanted the gas fields, but four of six callers of
    `/usdt` do, so the safe default is the other way round there. A new screen
    forgetting to ask must not be shown "no BNB" when the user has some.
  - **`api/src/costGuard.ts` — one ceiling that holds when a specific safeguard
    has a gap.** This project has shipped two real billing incidents, both the
    same shape (a loop polling a paid provider at a rate set by code, found by
    looking at a bill — the 2026-08-13 and 2026-08-27 entries above). Each was
    fixed at its call site, which is the right fix and also the one that only
    arrives afterwards. `RPC_MAX_CALLS_PER_HOUR` (5,000, against a steady state
    of ~80-100) and `EXPLORER_MAX_CALLS_PER_DAY` (20,000, a DAY window because
    that is the shape of the allowance it runs out against); `0` disables.
    ⚠️ **TWO TIERS, AND THE SPLIT IS LOAD-BEARING.** Low priority is cut off at
    80% of the limit; the rest is reserved for money in flight, or a cost
    control becomes an outage — the relay unable to confirm a broadcast it has
    already made, a withdrawal gate failing closed on an innocent user.
    **A NEW `rpcCall` DEFAULTS TO `low`. If you add one on a money path, pass
    `{ priority: "high" }`** — same class of thing to remember as `lockUser()`
    and its `LOCKED_PATHS` list. Live usage is on `GET /staff/mining/rpc`.
  - **Three unbounded per-user caches were bounded** (Railway bills memory):
    `payoutRelay`'s gas balances (expiry sweep + 5,000 cap, TTL now
    `GAS_BALANCE_CACHE_MS`, 20s → 60s) and both `bscscan` caches (sweep + 2,000
    cap). `RECONCILE_INTERVAL_MS` is env-tunable now — its cost is one multicall
    per 300 deposit addresses, so it grows with the user base too — and that
    tick charges its whole estimate against the budget before spending, because
    viem's transport bypasses `rpc.ts` and was invisible to the per-call charge.
  - ⚠️ **A-03 CLOSED: TOKENS ARE REVOCABLE NOW, AND `requireActiveUser` TAKES
    THE REQUEST.** The audit signed a token, reset the password, and got HTTP
    200 from `/auth/me` with the old one — so the single action a worried user
    can take on their own did not take their account back. `users.session_epoch`
    is stamped into every token as `se` and compared on every authenticated
    request; bumping it kills every token that account has ever held. Bumped on
    **password reset** (in the SAME statement as the new password, so there is
    no window), on **staff suspension**, and by `POST /auth/logout-all` ("Sign
    out everywhere" on `/profile`). The check lives in `requireActiveUser`,
    which already read the user row so it costs no extra query — **and
    independently in `/auth/me`**, because that is what the web client uses to
    decide a token is dead; if the two disagreed the user would sit in an app
    where nothing worked and nothing signed them out. **The `req` argument is
    REQUIRED, not optional**: an optional one lets a new route silently skip the
    check, and the compiler is the only thing that can guarantee coverage.
    **Deploying it signs nobody out** — tokens in the wild carry no `se`, read
    as 0, and the column defaults to 0 (which is also why 40 other suites needed
    no change). ⚠️ **Revocation is all-or-nothing per account**, because nothing
    distinguishes one device's token from another's — which is exactly why the
    ORDINARY sign-out button was deliberately NOT wired to it. Per-device
    sign-out needs a real session record. Regression: `npm run test:sessions`
    (27 checks + a structural tripwire); the fix was reverted in place and the
    suite re-run against the old code, reproducing the audit's 200.
  - ⚠️ **A-01 CLOSED: EMAIL FAILS CLOSED IN PRODUCTION AND NEVER LOGS A CODE.**
    `sendLoginCode` printed the recipient and the plaintext code and then
    RETURNED NORMALLY, in every environment — a one-time auth secret in
    centralised logs, and signup reporting success while no email existed
    anywhere. The console sink is development-only now; production without
    `RESEND_API_KEY` **throws**, so the route returns a real error. **This is
    not a behaviour regression**: with no key nobody could ever receive a code,
    so every email flow was already broken — it just said otherwise. Boot warns
    (not fatal, deliberately: Telegram sign-in does not touch email, and
    refusing to boot would take down a working deployment over a feature that
    has its own fallback).
  - **A-05 code-complete, one operator step left.** `pgSslOptions` (`db.ts`)
    turns certificate verification ON whenever a CA is supplied —
    `DATABASE_CA_CERT` / `DATABASE_CA_CERT_PATH`, plus `DATABASE_TLS_SERVERNAME`
    for the hostname mismatch that caused this in the first place. Railway's
    private network needs none of it. With nothing set the API still connects
    (refusing to boot would take down a live deployment over a change only the
    operator can make) but warns on every boot instead of being silent.
  - **A-06 closed; A-09 bounded.** fastify 5.10.0 → 5.12.3, sharp 0.34.3 →
    0.35.4 (a major — smoke-tested against the exact
    `rotate → resize(256) → webp` pipeline `staffTasks.ts` uses, not just
    installed), next 16.2.10 → 16.3.4. `/wallet/ledger` and
    `/wallet/usdt-task-rewards` cap at 500 rows, `/support/tickets` at 50
    tickets / 200 messages — every cap far above what any screen renders. The
    support one mattered most: each message carries a base64 data URL of up to
    2MB, so the unbounded response was every screenshot a user had ever sent, in
    one JSON body. The earner app stopped calling it when `/support/chat`
    landed, and a route nobody calls is the one nobody notices going wrong.
  - **Still open, and three of them are the founder's call, not code**: A-02
    (email queue/retry — nothing to queue against until there is a provider
    key); **A-04's second half — a shared rate-limit store, which is a SPENDING
    decision**: a Redis add-on costs money every month to defend against an
    attack that only becomes possible once a second replica exists, and this
    runs one; A-08, A-10, A-11, A-12, A-13; A-07's remaining half (a second
    replica + the timers out of the API process — the binding constraint was
    never the database); and B10 (splitting the staff pool).
  - ⚠️ **`security-review` FOUND A HOLE IN THE SESSION FIX BEFORE IT SHIPPED, IN
    THE WORST POSSIBLE PLACE — READ THIS BEFORE ADDING A ROUTE TO `auth.ts`.**
    Four routes there call `getUserId()` and hand-roll their own
    `try { … } catch` instead of going through a shared guard, so nothing forced
    them to opt in to the new check: `/auth/telegram/link`,
    `/auth/telegram/link-code`, `/auth/email/link-start`,
    `/auth/email/link-confirm`. They are also **the four routes that attach a NEW
    CREDENTIAL to an existing account**, so the bypass defeated the whole
    feature: hold a stolen token, let the victim reset their password, then POST
    the revoked token to `/auth/telegram/link-code`, open the binding code in
    **your own** Telegram, and the bind returns a fresh token at the NEW epoch —
    permanent access no later revocation can touch. All four now call
    `requireActiveUser(userId, req)`, which also closes a pre-existing gap: a
    **suspended** account could link credentials, already untrue of every other
    earner route. And `/auth/email/link-confirm` writes a `password_hash`, so it
    now bumps the epoch like `/auth/reset` — **and returns a replacement token**,
    or a user signs themselves out by adding their own email.
    ⚠️ **THE REGRESSION TEST FOR THIS IS STRUCTURAL, AND IT HAD TO BE.**
    Request-level checks on all four passed *even with a guard removed* — the
    Telegram routes answer 503 before they authenticate when no bot token is
    set, so "did not succeed" is all a request can prove there. The tripwire in
    `sessions.e2e.ts` reads `auth.ts`'s source and asserts every
    `getUserId(req)` is followed by the check, `/auth/me` excepted (it must
    serve a suspended user their own account, and repeats the comparison
    inline). Comment lines are stripped first, or the answer depends on how much
    explanation sits between the two statements. Proven by removing one guard:
    the four behavioural checks stayed green, the tripwire failed and named the
    line. Same family as `otp-race.e2e.ts`'s tripwire and `LOCKED_PATHS`.
  - ⚠️ **AN INDEPENDENT CORRECTNESS REVIEW OF THAT SAME WORK FOUND FIVE MORE
    REAL DEFECTS, ONE OF WHICH WOULD HAVE RE-CREATED THE VERY BILLING INCIDENT
    THE WORK EXISTS TO PREVENT.** All fixed; full write-up in
    `audit/FIXES_APPLIED.md` § 16. The four worth carrying forward:
    1. **`Number("")` IS 0, AND THAT IS THE CASE THAT ACTUALLY HAPPENS.** A NaN
       guard does not catch it. On Railway, *clearing a variable's value*
       (rather than deleting the variable) is routine and leaves `""` — which
       would have switched the spend ceiling off, and dropped
       `DEPOSIT_SCAN_INTERVAL_MS` from the **90000 it is set to live because of
       a past billing incident** to the 5s floor, an 18x cost rise. `num()` in
       `config.ts` trims and falls back on empty; an explicit `0` still means
       what it is documented to mean. Use `num()` for every numeric env var.
    2. **A COST REFUSAL MUST NOT LOOK LIKE A FAILURE.** `payoutRelay.ts` and
       `bnbWithdraw.ts` count every thrown error toward `relayMaxAttempts` (15)
       and then mark the job **failed** — and past the prefund leg that is not
       auto-recoverable. So ~22 minutes at the ceiling would have retired every
       live payout. `CostCeilingError` is its own type and both loops `return`
       without spending an attempt. **A new retry loop that catches broadly must
       do the same.**
    3. **A REFUSED READ MUST NOT BE CACHED AS AN EMPTY SUCCESS.** `bscscan.ts`
       returned `[]` on refusal; `[]` is indistinguishable from "no
       transactions", so the caller took its success path and overwrote a good
       25-row cache entry with an empty one. It throws now, landing in the
       existing catch that returns cached rows and leaves the cache alone —
       which is what already happened when the provider was down.
    4. ⚠️ **SUSPENDING NO LONGER REVOKES SESSIONS — THIS REVERSES THE FIRST CUT
       AND MUST NOT BE PUT BACK.** The epoch is compared BEFORE the status
       check, so bumping it on suspend turned the 403 *"This account is
       suspended. Please contact support."* into a 401 *"Session expired"*, and
       `/auth/me` — whose documented job is letting a suspended user load their
       account and be told why — signed them out instead. The status check was
       always the mechanism. Revocation is for the three places credentials
       really change or the user asks: password reset, email linking,
       logout-all. `test:sessions` pins the 403.
    Also: the deposit scanner moved to the **`"high"`** tier (it shared `"low"`
    with per-user screen reads, so ~4,000 wallet loads in an hour could stall
    deposit crediting — and `rpc.ts`'s header calls that outcome unacceptable);
    the sweep loop now charges an estimate and the meter's comment states
    exactly what is and is not counted; both bounded caches evict LRU rather
    than FIFO (a plain `set` on an existing key does not move it in a JS `Map`).

- **BIMI — GETTING THE ROZIPAY LOGO TO SHOW NEXT TO OUR EMAILS (founder,
  2026-09-05, request only — the DNS/provider work is still ahead of us).**
  The founder pointed at another company's email showing a real logo icon in
  Gmail next to the sender name, where our own emails show a generic gray
  avatar, and asked for the same. This is **BIMI (Brand Indicators for
  Message Identification)**, not a code fix — it needs DNS records and an
  email-authentication policy, not an app change. Founder's choice: **do the
  free path (DMARC + BIMI record), explicitly WITHOUT a VMC** — so this will
  show the logo in Yahoo/AOL and similar, but **not in Gmail specifically**,
  since Gmail requires a paid Verified Mark Certificate (~$1,300–2,500/yr,
  usually needs a registered trademark on the mark) on top of everything
  else. Revisit the VMC only if that's worth it later.
  - **Shipped this pass**: `web/public/brand/bimi-logo.svg` — a square SVG
    Tiny-PS-profile wrapper (`baseProfile="tiny-ps" version="1.2"`, a `<title>`,
    solid white background, no scripting/external refs) embedding the existing
    `icons/apple-touch-icon.png` brand mark as a base64 `<image>`. ~12KB, well
    under BIMI's practical size guidance. Once deployed this is reachable at
    `https://rozipay.xyz/brand/bimi-logo.svg`. ⚠️ **This is a raster image
    wrapped in an SVG shell, not true vector artwork** — it satisfies the Tiny
    PS profile (raster via `<image>` is permitted) and should pass validation,
    but a real vector master (e.g. exported from Canva) would render crisper
    at very small sizes if the founder wants to swap it in later.
  - **The full ordered checklist is now in `api/.env.example`** (right after
    the email config block, since step 1 depends on `RESEND_API_KEY` /
    `EMAIL_FROM` actually being set): verify rozipay.xyz as a sending domain
    in Resend (gives SPF+DKIM DNS records) → add those in GoDaddy → let real
    mail flow and confirm SPF/DKIM pass → add a `_dmarc.rozipay.xyz` TXT
    record at `p=quarantine` (never jump straight to `p=reject`) → validate
    the SVG against a BIMI validator → add the `default._bimi.rozipay.xyz`
    TXT record pointing at the SVG's URL.
  - ⚠️ **NONE OF THE DNS/PROVIDER STEPS WERE DONE THIS PASS — THEY CAN'T BE
    FROM HERE.** No GoDaddy MCP tool was available in this session (despite
    it being named in this file's tech-stack list) and no Resend
    dashboard/API access exists either — `RESEND_API_KEY` is still unset, so
    real email isn't even flowing from rozipay.xyz yet, which is a
    prerequisite for all of this. **Someone with GoDaddy + Resend access
    needs to actually walk the checklist above.** If a GoDaddy MCP is
    connected in a future session, this is a five-step job at that point:
    read the Resend-issued records, write them via that MCP, then the two new
    TXT records once DKIM/SPF are confirmed passing.

- **A CROSS-CHECK ON THE "ONE WITHDRAWAL, ONE TRANSACTION" COMMIT FOUND AND
  FIXED THREE REAL GAPS (founder, 2026-09-05, same day).** An independent
  review pass (`code-review` at high effort) over the previous commit found
  four issues; three were real and are fixed here, one was considered and
  deliberately left as-is. Verified: 528 e2e checks across every affected
  suite (payoutrelay 66, usdt 112, moneyadmin 100, disbursements 81,
  withdrawcontrols 21, autowithdraw 16, autorefund 8, fees 24, wallet 52,
  stage4 48), api + web typecheck, all clean.
  - ⚠️ **FIXED: a 'mixed' withdrawal's forward leg signed the FULL combined
    amount with no on-chain balance check, unlike the refund path a few lines
    above it which explicitly re-verifies `balanceOf` before ever signing
    ("never trust the row").** The deposit portion of a mixed job is money
    that's sat at the user's derived address since their original deposit —
    exactly the kind of balance that could drift from the ledger (a sweep,
    a prior partial send) if unchecked. `payoutRelay.ts`'s `prefund_confirmed`
    branch now reads the address's real on-chain balance and refuses to sign
    if it's short, mirroring the refund path's own discipline. Deliberately
    `safe: false` on failure — the prefund already confirmed, so treasury's
    USDT genuinely sits at this address for real; auto-refunding the row on
    top of that would double-pay the earned portion. Staff must check the
    chain if a job gets stuck here, same as every other `NOT safe` case in
    this file.
  - ⚠️ **FIXED: the withdrawal queue's `pendingTotal` (the "fund the treasury
    with this much" figure) never subtracted a mixed row's `deposit_fee_micro`
    — only its per-row `netUsdt` did.** Currently unreachable in production
    (relay-available mixed rows always carry a $0 deposit fee — see
    `routes/withdrawals.ts`'s `relayReady ? 0 : gasFeeMicro(...)`), but a real
    aggregate-vs-per-row disagreement waiting for the day relay is
    unavailable AND a gas fee rate is set. Fixed by computing the whole total
    in one micro-USDT unit (no round-trip through `pointsToUsdt`'s string),
    same "one division, no accumulation" discipline `microToDecimalString`
    already documents.
  - ⚠️ **FIXED: `payoutRelayIntervalMs`'s new default (20s) would have
    silently reintroduced a 4.5x jump in relay-tick RPC calls on deploy** —
    production has `DEPOSIT_SCAN_INTERVAL_MS=90000` (raised for the exact
    billing reasons in the two Alchemy entries above), and the whole point of
    giving the relay tick its own variable was to stop the two from being
    coupled BY ACCIDENT, not to silently drop back to a hardcoded default the
    moment nobody remembers to set the new one. It now falls back to
    `DEPOSIT_SCAN_INTERVAL_MS`'s own value when unset, so deploying this
    changes NOTHING until an operator deliberately sets
    `PAYOUT_RELAY_INTERVAL_MS` to decouple it on purpose.
  - **Considered and NOT changed**: the review also flagged that the new
    wall-clock give-up (like the pre-existing attempt-count one) can fire
    even while `payoutMode` is set to `"manual"` — an operator's "emergency
    stop." Checked against `disbursements.e2e.ts`'s own regression test
    ("payoutRelay.failJob returns the right currency"), which already
    exercises and relies on give-up firing without onchain mode configured —
    this is existing, intentional, tested behaviour, not something this
    commit introduced. It is also directionally safe: give-up only ever
    CREDITS a held balance back to the user (undoes a hold); it never sends
    money anywhere. Reordering it behind the payoutMode check would have
    broken that existing test and contradicted the founder's own explicit
    ask that a stuck job resolve on its own — so it was left alone.

- **THE DISBURSEMENT QUEUE STOPS LOOKING LIKE IT COULD DOUBLE-PAY, PLATFORM
  PAYOUTS GET A LONGER LEASH, AND ONE RECIPIENT CAN BE SENT AT A TIME
  (founder, 2026-09-05, later the same day).** A voice-memo review of the
  live `/staff#tasks/p-task-rewards` screen: seeing **"Mark paid"** sitting
  right next to a batch already set to **"Send on-chain"** read as if the app
  might let staff pay the same reward twice — once by the automatic relay,
  once by a human. The backend already refused that exact double-send
  (`markRowPaid` already checked for a live relay job first) — the UI just
  never said so. Verified: `npm run test:disbursements` (96, was 81) +
  `npm run test:payoutrelay` (69, was 66) + `npm run test:moneyadmin` (100)
  all green from a fresh database; api + web `tsc --noEmit`, `next build`
  (38 routes) clean.
  - **Platform-initiated payouts (this disbursement feature) now get a
    longer give-up window than a user's own withdrawal** — the founder's own
    ask: "extend this window of the retry ... to one hour" for platform
    money, while a user's own withdrawal keeps its existing ceiling
    unchanged. New `relayMaxAttemptsDisbursement` (180) /
    `relayMaxAgeMsDisbursement` (1 hour) in `config.ts`, checked in
    `payoutRelay.ts`'s `advanceRelayJob` — BOTH numbers move together,
    deliberately: `attempts` only increments on a genuine thrown error per
    tick (not every tick), so raising only the age ceiling would have done
    nothing if the tighter, unchanged attempts cap (15 ≈ 5 min) fired first.
    ⚠️ **Which relay job is "a disbursement" can't be read off
    `withdrawal_requests.reviewed_by`** — `autoWithdraw.ts`'s `tryAutoSettle`
    overwrites that column to `'system:auto'` in the very same transaction
    that creates the relay job, so the `'system:disbursement'` marker
    `runPayoutRow` sets at creation is already gone by the time any tick
    runs. The check instead joins through the existing
    `payout_disbursements.withdrawal_request_id` link, which survives the
    whole job's life untouched.
  - **One recipient can be sent at a time** — `POST
    /staff/disbursements/:id/rows/:rid/send` (`sendDisbursementRow` in
    `web/src/lib/api.ts`, a **"Send reward"** button per row for any row
    still `pending`/`failed`/`needs_address`), instead of only ever running
    the whole batch. `staffDisbursements.ts`'s `dispatchRow()` is the ONE
    pipeline both this route and `runBatch`'s loop now call — never two
    copies of the same per-row decision. Same "each row is its own decision"
    rule Stage 7's bulk-proof-decide already established: a batch stays
    untouched apart from the one row sent.
    ⚠️ **A batch sent one row at a time, never via "Send reward to all",
    needed its own fix to leave `draft` at all** — `recomputeBatchTotals`
    deliberately never rolls up a `draft` batch's status, so without
    explicitly flipping it to `processing` first (same line `runBatch`
    already had), a batch's status field would sit at `draft` forever even
    once every row had been sent individually. The same orphan-recovery
    `runBatch` does batch-wide (a row stuck `sending` with no
    `withdrawal_request_id` behind it can only be a crashed prior attempt)
    is applied here scoped to the one row being sent.
  - **The screen says plainly when a payout is already sending itself.** A
    new derived, read-only `DisbursementRow.relayInFlight` field
    (`disbursements.ts`'s `getDisbursements` — an `EXISTS` against
    `payout_relay_jobs` in a non-terminal status, naturally `false` for
    every `manual`/`csv` row since those never get a relay job at all) drives
    one small muted line under the **"Manual reward send"** button — renamed
    from **"Mark paid"** — whenever it's true: *"Sending automatically right
    now — only use this if it's stuck. Sending it twice is blocked
    automatically."* The button itself still shows either way, deliberately
    — the founder's own call: the existing backend refusal stays the real
    safety net, this is presentation on top of it, not a new gate. The
    batch-level **"Run"** button is renamed **"Send reward to all"**.
  - **Not changed**: any batch mode's actual behaviour (`balance` / `onchain`
    / `manual` / `csv`), the eligible pool, CSV export/reconcile, cancel,
    rename, or `markRowPaid`'s existing double-send guard.

- **CROSS-CHECK ON THE DISBURSEMENT-QUEUE COMMIT ABOVE: THREE REAL DEFECTS
  CAUGHT AND FIXED (2026-09-05, same day).** An independent review pass over
  the commit found three issues, all fixed here. Verified: `test:disbursements`
  (96) + `test:payoutrelay` (69) + `test:moneyadmin` (100) all re-run green
  (identical counts — none of these are new checks, they prove the fixes
  didn't change behaviour for anything already covered); api + web
  `tsc --noEmit`, `next build` (38 routes) clean.
  - ⚠️ **FIXED: `relayMaxAttemptsDisbursement` was parsed with a raw
    `Number()`, not this file's own `num()` helper — the EXACT bug class
    `config.ts`'s header already names as a repeat offender.** `Number("")`
    is `0`, and clearing (not deleting) a Railway env var routinely leaves
    exactly that; a cleared `RELAY_MAX_ATTEMPTS_DISBURSEMENT` would have made
    `job.attempts >= maxAttempts` true (`0 >= 0`) on every admin disbursement
    payout's very first tick — every one would "give up" and refund before
    ever signing, silently defeating the whole longer-leash feature two
    entries above. Fixed to `num(process.env.RELAY_MAX_ATTEMPTS_DISBURSEMENT,
    180, 1)`. ⚠️ **The pre-existing `relayMaxAttempts` line right above it
    carried the identical bug and was NOT part of that commit's diff** — same
    review pass fixed it too (`num(process.env.RELAY_MAX_ATTEMPTS, 15, 1)`)
    rather than leave a known-live footgun sitting one line above a freshly
    fixed one. `num()`'s own empty-string behaviour is already unit-tested
    (`costGuard.test.ts`), so no new dedicated test was needed for either line
    — same as every other `num(...)` call in this file.
  - ⚠️ **FIXED: the new per-row "Send reward" button was gated only on the
    row's own status, not the batch's** — `Disbursements.tsx` already has a
    `canRun` (`!!batch && ["draft","processing","partly_failed"].includes(
    batch.status)`) guarding the batch-level "Send reward to all" button, and
    the per-row button needed the same check. Without it: a batch can be
    cancelled while its rows still sit `pending`/`failed`/`needs_address`
    (`cancel` only refuses when a row is already released/sending/paid, and
    never touches the surviving rows' own status) — so a cancelled batch kept
    showing an active "Send reward" button that always 409'd on click. Fixed
    by adding `canRun` to the same condition.
  - **FIXED (efficiency, not correctness): the new send-one-row route pulled
    every row in the batch — including the `payout_relay_jobs` EXISTS check
    added for `relayInFlight` — just to `.find()` one id.** At
    `disbursementMaxRecipients`'s default cap of 500, a single click could
    scan 500 rows with a per-row subquery to locate one. New
    `getDisbursementRow(batchId, rowId)` in `disbursements.ts` (a targeted
    single-row query sharing the same `DISBURSEMENT_SELECT` SQL and
    `mapDisbursement()` mapper `getDisbursements()` now also uses — one query
    shape, not two copies) replaces the full-batch fetch at the one call site
    that only ever needed one row.

- **DISBURSEMENTS NOW PAY THE RECIPIENT'S OWN ROZIPAY WALLET, NEVER THEIR
  SAVED EXTERNAL ADDRESS — AND THE RELAY CUTS OUT A NEEDLESS HOP (founder,
  2026-09-05, traced from a live stuck "Follow X Account" reward).** Two real
  findings from one stuck job: (1) the prefund tx had reverted because the
  address the founder had funded (`treasury_address_bep20`, a plain
  admin-typed `app_settings` field shown on the Treasury tab) is a SEPARATE
  value from the address that actually SIGNS every payout (derived from
  `TREASURY_KEY_ENCRYPTED`) — nothing ever kept them in sync, so "I funded
  the treasury wallet" and "the signer has money" were silently two different
  claims. (2) the disbursement was paying out to the recipient's SAVED
  EXTERNAL payout address (`payout_addresses`, whatever the user typed for
  their own withdrawals) — an admin-initiated reward has no business trusting
  a string the recipient typed for an unrelated purpose. Verified:
  `test:disbursements` 96 (rewritten "on-chain / manual mode" block to prove
  the new targeting, including a recipient with NO saved address, which used
  to be `needs_address` and now just works) + `test:payoutrelay` 69 +
  `test:moneyadmin` 100, all green from a fresh database; api + web
  typecheck, eslint, web production build (38 routes) all clean.
  - **Fix 1 — the signer/configured-address mismatch is now visible.** New
    `treasurySignerAddress()` (`signer.ts`) derives the real signing address
    from the key; `GET /staff/treasury/wallet` now also does a LIVE on-chain
    read (USDT + BNB) of both the signer address and the configured one, and
    flags a mismatch in bold red on the Treasury → Wallet panel — the exact
    question "which address do I actually need to fund" now has a direct
    on-screen answer instead of requiring a support session to work out.
  - **Fix 2 — an admin reward disbursement (`onchain`/`manual`/`csv` mode)
    now ALWAYS targets the recipient's own custody-derived deposit wallet**
    (`custody.ts`'s `getOrCreateDepositWallet` — the exact address the user
    themselves sees on `/wallet/usdt`), in both `disbursements.ts`'s
    `createBatch` and `staffDisbursements.ts`'s `runPayoutRow`. Every account
    always has a derivable custody wallet, so `needs_address` is now
    unreachable for a fresh disbursement (kept in the status enum only for
    historical rows). `address_verified` is set to `1` on the resulting
    `withdrawal_requests` row — the address is guaranteed correct by
    construction, more so than a typed or even a signed one.
  - ⚠️ **THIS COLLAPSES THE RELAY'S TWO-HOP PASS-THROUGH INTO ONE HOP FOR
    DISBURSEMENTS, AND THAT IS WHAT MAKES THEM FASTER TOO.** The relay's
    prefund leg already sends treasury's USDT into the recipient's own
    derived address (payoutRelay.ts, 2026-08-08) — since that address is now
    ALSO the disbursement's final destination, `advanceRelayJob` (in the
    `prefund_confirmed` phase) short-circuits straight to done the instant
    `job.to_address === job.from_address`, reusing the prefund's own tx hash
    as the record of what moved the money. This means a disbursement no
    longer needs a second signed transaction, and — because there is no
    forward leg — **no longer needs the recipient to already hold any BNB
    gas at all**, which a brand-new reward recipient almost never does. A
    REGULAR user-initiated withdrawal to an external address is completely
    unaffected — this path is only reachable when destination equals the
    user's own derived address, which only a disbursement (never a normal
    withdrawal) sets up.
  - **The money nets out correctly through the EXISTING deposit scanner, not
    a new credit path.** The reward is released to `earned_usdt_ledger`
    (credit) then immediately held for the payout (debit) — net zero — and
    the real on-chain USDT that lands at the recipient's custody address is
    picked up by the already-running, already-idempotent BEP20 deposit
    scanner (`deposits/credit.ts`, keyed on `(chain, tx_hash, log_index)`,
    same as any other deposit) a scan tick or two later, crediting
    `usdt_ledger` for the same amount. **Nothing new was written to credit
    this money directly** — deliberately, to avoid inventing a second,
    unproven idempotency key that could double-pay against the scanner's own
    later detection of the exact same on-chain transfer. ⚠️ **The accepted
    cost: for roughly the scan interval + confirmation depth (order of a
    couple of minutes), the reward briefly does not show in the recipient's
    Total Balance even though the withdrawal already reads "paid"** — it is
    not lost, it lands the moment the scanner's next tick confirms it. Don't
    "fix" this by having the relay credit `usdt_ledger` itself unless a real
    log-index-safe idempotency key is worked out first; done carelessly that
    is a genuine double-credit, not a UX nicety.
  - **Speed, the other half of the ask**: `PAYOUT_RELAY_INTERVAL_MS` already
    exists as its own env var, independent of `DEPOSIT_SCAN_INTERVAL_MS`
    (which stays at 90s for the Alchemy-cost reasons recorded above) —
    lowering it (e.g. to 20s) is safe to do on Railway and, combined with the
    one-hop collapse above, cuts a disbursement's total time from up to four
    ticks down to about two. Not changed here — it's a live Railway env var,
    a production config change, left for the founder to set (or ask for)
    rather than done unilaterally in the same pass as a money-path fix.
  - **`manual`/`csv` mode disbursements are unaffected in behaviour** (still
    land in the staff queue / CSV export for a human to send by hand) — only
    the destination address changed, for all three non-`balance` modes alike.
