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
    `GET /staff/mining/reconciliation`. ⚠️ **This IS the alerting** — no
    Sentry, no paging, so a mismatch at 3am is silent until a human opens the
    panel. `CUSTODY_SPEC.md` § 3.5's "who is accountable at 3am" is still open.
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
  - ⚠️ **THE DEPOSIT SCANNER IS FAILING IN PRODUCTION RIGHT NOW, SEPARATELY.**
    Railway logs show a repeating `Deposit scan tick failed … eth_getLogs
    failed: limit exceeded` every ~20s — almost certainly the free public
    BEP20 RPC hitting a block-range/result cap, exactly the risk
    `RPC_BEP20` (a LIST with failover, `rpc.ts`) was built to reduce by
    putting a paid endpoint first — which was never done. This does not
    affect the manual "paste your tx hash" topup flow, but it does mean the
    newer auto-detect/sweep pipeline (`deposits/scanner.ts`) is not
    currently doing its job. Not yet fixed — needs a paid RPC endpoint added
    to `RPC_BEP20` on Railway.

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
    RosiPay wallet before withdrawing USDT."*
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
(3) **The deposit scanner's RPC issue** (see the entry above) — needs a paid
`RPC_BEP20` endpoint added on Railway.
Everything else on the old checklist is done, deferred by decision, or declined.

See `docs/` for the full spec.
