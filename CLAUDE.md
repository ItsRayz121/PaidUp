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

See `docs/` for the full spec.
