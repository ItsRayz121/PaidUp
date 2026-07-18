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
    TRC20/Tron is a quick future add — one validator).
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
    - ⚠️ **Keep the effective rate above ~10.** Payouts floor to whole ROZI, so
      once `piBaseRate` has been halved into single digits, anyone who mined only
      *part* of a day rounds to **zero**. This is the one way the model quietly
      stops paying people. The admin panel raises `rateTooLow` when it happens;
      there is a unit test pinning the behaviour.
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
  28-check e2e (`npm run test:telegram`): tamper/wrong-bot/replay/cross-scheme/
  linking/shell-takeover. Founder steps left: BotFather "Enable Mini App" +
  /setdomain, and a Monetag Rewarded zone (see LAUNCH_CHECKLIST § 6).

**Founder collection list → `docs/LAUNCH_CHECKLIST.md`.** The real launch blockers
are things only the founder can obtain: (1) a **real ad-network account** + its
postback secret (offerhub/tapvid/surveyx are spec adapters, not live), (2) a
**Resend API key + verified email domain**, (3) a **funded USDT treasury wallet**.
Then 🟡 Sentry auth, ⚪ custom domain, ⚪ Telegram.

**Still open (business decisions):** ✅ all three locked (60% split / Pakistan / RoziPay — domain rozipay.xyz).

**Phase 2 remaining:** Sentry authorization (still **blocked** — needs founder to authorize the connector in claude.ai settings; non-interactive session can't run the OAuth flow). Further fraud tuning is open Phase 3 work. (Urdu is no longer on the list — it was dropped, see above.)

See `docs/` for the full spec.
