# RoziPay web client — load profile audit

Scope: `web/` (Next.js App Router, single `layout.tsx` at `web/src/app/layout.tsx`). Read-only
audit — no application code changed. Goal: an accurate per-active-user request/response
profile to drive a load test.

**Headline finding, before the detail**: this app is not a background-polling app. Outside
of `/help` (support chat) and the staff panel, no earner screen re-fetches on a timer. The
dominant traffic driver is **screen navigation** — every route mount re-fetches everything
that screen needs, with no client-side cache and no `?since=` delta on almost every endpoint
except support chat. So the right load-test mental model is "cost per navigation", multiplied
by how often a real user switches screens, not "cost per idle minute".

---

## 1. Polling inventory (every timer that can fire a network request)

| # | Timer | Endpoint(s) | Interval | Screen / component | Pauses when tab hidden? | Cite |
|---|---|---|---|---|---|---|
| 1 | `useApi`'s optional poll | whatever `fn` the caller passes | caller-supplied `pollMs` | any screen that passes `pollMs` | **Yes** — gated on `document.visibilityState === "visible"` | `web/src/lib/hooks.ts:121-130` |
| 2 | Support chat delta poll | `GET /support/chat?since=` | **15,000 ms** (`POLL_MS`) | `/help` | **Yes** — same visibility check, inline | `web/src/app/help/page.tsx:32` (constant), `:168-177` (interval + visibility gate) |
| 3 | Staff queue auto-refresh | whichever queue (`GET /staff/withdrawals`, `/staff/mining/topups`, `/staff/mining/refunds`, `/staff/bnb-withdrawals`, `/staff/relay-jobs`, `/staff/task-proofs`, `/staff/tickets`, `/staff/disbursements*`, …) | **20,000 ms** (`QUEUE_POLL_MS`) | `/staff` panels, opt-out toggle per panel (`auto`) | **Yes** — same `useApi` mechanism, and additionally the whole toggle can be switched off in the UI | `web/src/components/staff.tsx:33` (constant); consumed at e.g. `web/src/components/staff/MoneyQueues.tsx:291,479,600,733,825,1005,1216`, `TasksAdmin.tsx:117,479,611`, `SupportQueue.tsx:64,181`, `Disbursements.tsx:114,222,281` |
| 4 | Staff dashboard | `GET /staff/dashboard` | **30,000 ms** | `/staff` → Dashboard | Yes (same hook) | `web/src/components/staff/DashboardOverview.tsx:33` |
| 5 | Install-prompt "5 minutes of visible time" tracker | *(none — localStorage only)* | 15 s ticks (`TICK_SECONDS`), gate at 300 s (`MIN_SECONDS_ON_SITE`) | every earner screen (mounted by `Shell`) | Ticks only while visible, but **fires zero network requests** — pure `localStorage` accounting | `web/src/components/InstallPrompt.tsx:19-20` (constants), `:99-114` (timer) |
| 6 | Telegram account-link poll | `GET /auth/me` | 4,000 ms, capped at 45 polls (~3 min) then gives up | Profile page, **only** while the "connect via Telegram" hand-off is in progress (rare, one-shot per link attempt, not a steady-state cost) | Not visibility-gated, but self-terminates after ~3 min or on success | `web/src/components/ConnectTelegramCard.tsx:78-88` |
| 7 | Session/ad countdown, hourglass animation | *(none)* | 1,000 ms (`useCountdown`), 1,000 ms (mine page ad-claim tick), ~130-1800 ms (hourglass coin-drop) | `/mine`, home | N/A — no network call in any of these, they only force a re-render for `Date.now()` / drive a CSS/SVG animation | `web/src/lib/hooks.ts:141-159` (`useCountdown`); `web/src/app/mine/page.tsx:88-92` (ad tick); `web/src/components/HourglassClaim.tsx:302-322` (coin animation) |

**No other `setInterval`/`setTimeout` in `web/src` re-arms a fetch.** Grepped the whole tree for
`setInterval`, `pollMs`, `useApi(`, `setTimeout`, `useCountdown` — rows 1-7 above are the complete
set of timers, and only rows 2-4 ever touch the network on a recurring basis.

**TopBar does NOT poll, and does not fetch balance/mining state.** `web/src/components/TopBar.tsx`
comments (lines 27-31) describe fetching both a balance and `fetchMiningState` "so this bar shows
the SAME combined figure as home and /wallet" — but the code that follows only calls
`useApi(fetchNotifications, [])` (`TopBar.tsx:26`) and renders a static "coming soon" string
(`TopBar.tsx:70-72`). The comment is stale relative to the code (the ROZI-on-`/wallet` display was
pulled later, per CLAUDE.md's 2026-08-03/09-03 entries, and TopBar's own fetch calls were trimmed
down to just notifications without the comment being updated). **For the load model this matters**:
TopBar contributes exactly one endpoint, `GET /notifications`, not three.

**TopBar/BottomNav mount ONCE per browser session, not once per screen.** There is exactly one
`layout.tsx` in the whole app (`web/src/app/layout.tsx`) — confirmed by `find web/src/app -name
layout.tsx`. `Shell` (`web/src/components/Shell.tsx:39-51`) renders `<TopBar/>` unconditionally
for every non-auth, non-offline route, and because there is no nested layout, client-side
navigation between `/`, `/mine`, `/wallet`, `/tasks`, `/help`, `/refer` **never unmounts Shell**.
So `fetchNotifications` fires once when the app first loads in the browser tab, not once per
screen visited. Its per-user rate should be modelled as "once per session start" (amortized to a
small fraction of a request per minute over a session), not multiplied by navigation count like
every other endpoint below.

---

## 2. Per-screen request fan-out (on mount)

Every `useApi(fn, [])` call below fires exactly once when that page component mounts (i.e. once
per navigation TO that route — App Router remounts the page component, even though the shared
`Shell`/`TopBar`/`BottomNav` do not). None of these six screens re-fetch after mount except `/help`
(row 2 above).

### `/` Home — `web/src/app/page.tsx`
| Call | Endpoint | Line |
|---|---|---|
| `fetchBalance` | `GET /wallet/balance` | `page.tsx:41` |
| `fetchTasks` | `GET /tasks?view=available&cursor=0&limit=12` | `page.tsx:42` |
| `fetchMiningState` | `GET /mining/state` | `page.tsx:43` |
| `fetchFeatures` | `GET /features` | `page.tsx:47` |
| `fetchHomeContent` (via `<HomeContent/>`) | `GET /content/home` | `components/HomeContent.tsx:37` |

**5 calls, all parallel** (no sequential `await` chain — React fires all five `useEffect`-driven
requests on the same tick). No duplicate calls. `WelcomeExperience` (mounted alongside, gated on
`!features.loading`) makes zero network calls of its own.

### `/mine` — `web/src/app/mine/page.tsx`
| Call | Endpoint | Line |
|---|---|---|
| `fetchMiningState` | `GET /mining/state` | `page.tsx:35` |
| `fetchBalance` | `GET /wallet/balance` | `page.tsx:40` |
| `fetchLedger` | `GET /wallet/ledger` | `page.tsx:44` |
| `fetchRoziHistory` | `GET /mining/history` | `page.tsx:45` |

**4 calls, all parallel.** One conditional *reload* (not a new endpoint) fires once if the mining
session's countdown expires while the screen is open (`page.tsx:73-76`) — a rare, one-shot event
tied to session length (hours), not a recurring poll.

### `/wallet` — `web/src/app/wallet/page.tsx`
| Call | Endpoint | Line |
|---|---|---|
| `fetchBalance` | `GET /wallet/balance` | `page.tsx:48` |
| `fetchLedger` | `GET /wallet/ledger` | `page.tsx:49` |
| `fetchRoziHistory` | `GET /mining/history` | `page.tsx:50` |
| `fetchMiningState` | `GET /mining/state` | `page.tsx:51` |
| `fetchWithdrawals` | `GET /withdrawals` | `page.tsx:52` |
| `fetchBnbWithdrawals` | `GET /wallet/bnb/withdrawals` | `page.tsx:53` |
| `fetchBnbOnchainHistory` | `GET /wallet/bnb/history` (**external BscScan read**, see §3) | `page.tsx:54` |
| `fetchUsdtTaskRewards` | `GET /wallet/usdt-task-rewards` | `page.tsx:55` |
| `fetchFeatures` | `GET /features` | `page.tsx:56` |
| `fetchUsdt` (conditional) | `GET /usdt` | `page.tsx:59`, gated on `usdtOn = Boolean(mining.data?.usdtTopup)` |

**9 calls fire in parallel immediately; a 10th (`fetchUsdt`) is a genuine two-stage waterfall** —
it is `enabled` only once `mining.data` has resolved and reports `usdtTopup: true`
(`page.tsx:58-59`), so on an instance/user where top-ups are on this is: [9 parallel calls] → wait
for `fetchMiningState` → [1 more call]. This is the one real sequential dependency found across
the six screens. No duplicate calls within the screen.

**This is the heaviest screen in the app by call count** — 9-10 distinct endpoints on one mount.

### `/tasks` — `web/src/app/tasks/page.tsx`
| Call | Endpoint | Line |
|---|---|---|
| `fetchTasks(view, 0, limit)` | `GET /tasks?view=…&cursor=0&limit=…` | `page.tsx:40` |

**1 call.** Re-fires (new mount-equivalent request, same `useApi` instance) when the user switches
the Available/My activity/History tab (`view` changes) or taps "Load more" (`limit` changes,
`page.tsx:39,125-127`). Category filtering is client-side only (`page.tsx:50`) — no request.
⚠️ **"Load more" is not incremental** — each tap increases `limit` and refetches `cursor=0` through
the new, larger limit, i.e. it re-downloads everything already shown plus 12 more rows, rather than
requesting only the next page. Inefficient but bounded (task catalogs are small), not a growth risk.

### `/help` — `web/src/app/help/page.tsx`
| Call | Endpoint | Line |
|---|---|---|
| `fetchSupportChat()` (initial, full load) | `GET /support/chat` | `page.tsx:135-144` (`load`) |
| `fetchSupportChat(since)` (poll, delta) | `GET /support/chat?since=<newest message ts>` | `page.tsx:155-158` (`refresh`), driven by the 15 s interval at `page.tsx:170-177` |

**1 call on mount, then 4 calls/minute (60/15) for as long as the screen stays open and visible.**
This is the only earner screen with steady-state recurring traffic. Sending a message or closing
the chat also triggers one extra `refresh()` (delta) each, on top of the timer.

### `/refer` — `web/src/app/refer/page.tsx`
| Call | Endpoint | Line |
|---|---|---|
| `fetchReferrals` | `GET /referrals/me` | `page.tsx:16` |
| `fetchTelegramConfig` | `GET /auth/telegram/config` (bot username, cached server-side per CLAUDE.md) | `page.tsx:17` |

**2 calls, parallel.**

### Not in the requested six, but one tap away (noted for completeness, not fully modelled)
`/wallet/bnb`, `/wallet/usdt`, `/wallet/rozi`, `/wallet/withdraw`, `/wallet/earnings/withdraw` each
re-issue `fetchMiningState` and/or `fetchBalance` again (e.g. `wallet/bnb/page.tsx:27`,
`wallet/usdt/page.tsx:25-27`) — confirming these two endpoints are hit by essentially every screen
in the wallet section, not just the six audited screens.

---

## 3. Response-size risks

| Endpoint | Bound? | Risk | Cite |
|---|---|---|---|
| `GET /wallet/ledger` (`fetchLedger`) | **None.** `SELECT le.*, w.status … WHERE le.user_id = ? ORDER BY le.created_at DESC` — no `LIMIT`, no `?since=`. | **Unbounded growth.** Every task credit, referral credit, and withdrawal debit is a row. A long-tenured, active user could accumulate thousands of rows; full JSON re-sent on every `/mine` and `/wallet` mount. | `api/src/routes/app.ts:463-471` |
| `GET /withdrawals` (`fetchWithdrawals`) | **None.** `SELECT * … ORDER BY created_at DESC`, no `LIMIT`. | Unbounded in principle, but withdrawal requests are naturally low-cardinality per user (real money events, not per-task) — lower practical risk than the ledger. | `api/src/routes/withdrawals.ts:502-505` |
| `GET /wallet/bnb/withdrawals` (`fetchBnbWithdrawals`) | **None.** Same `SELECT * … ORDER BY created_at DESC` pattern, no `LIMIT`. | Same low-cardinality reasoning as above. | `api/src/routes/withdrawals.ts:838-841` |
| `GET /wallet/usdt-task-rewards` (`fetchUsdtTaskRewards`) | **None.** No `LIMIT` in the query. | Grows with every USDT-denominated task completion; same shape of risk as the ledger, scoped smaller. | `api/src/routes/app.ts:484-495` |
| `GET /mining/history` (`fetchRoziHistory`) | **Capped**, `LIMIT 100`. | Bounded, but no `?since=` — always re-sends the full 100 rows on every mount even if nothing changed since the last visit. Efficiency waste, not a growth risk. | `api/src/routes/mining.ts:390-397` (`LIMIT 100` at line 395) |
| `GET /notifications` (`fetchNotifications`) | **Capped**, `LIMIT 50`, unread count via separate `COUNT(*)`. | Bounded, low risk. | `api/src/routes/app.ts:762-773` |
| `GET /support/chat` (`fetchSupportChat`) | **Capped**, `MESSAGE_CAP = 300`, and uses `?since=` correctly for the 15 s poll (only the first, non-delta load pulls the full capped history). | ⚠️ **The 300-message cap has no separate cap on embedded images.** `ticket_messages.image` can be a base64 data URL up to ~2 MB (per the route's own comment). A worst-case first load for a heavy support user (300 messages, many with screenshots) could be a very large single response — the delta mechanism protects the *steady-state* poll cost, not the *initial* load. `segments` (ticket list) is always sent in full, unbounded by count, but is lightweight (a handful of scalar fields per row, no images). | `api/src/routes/app.ts:962-1015` (cap + delta logic, image-size comment at `:963-967`) |
| `GET /leaderboard` (`fetchLeaderboard`) | Bounded top-N, server-cached (~1 min, per CLAUDE.md's leaderboard entry). | Low risk. | `api/src/routes/app.ts:743-754` |
| `GET /wallet/bnb/history` (`fetchBnbOnchainHistory`) | Bounded (~25 rows per CLAUDE.md), 60 s **per-address** server cache. | Response size is fine; the real risk is **operational, not size** — see next section. | `api/src/routes/withdrawals.ts:855-864` |

**Ranked by risk to a load test**: `wallet/ledger` first (truly unbounded, hit by two of the six
screens on every mount), then `wallet/usdt-task-rewards` and `withdrawals`/`bnb/withdrawals`
(same unbounded pattern, smaller in practice), then `support/chat`'s image payload on cold load.
If seeding test accounts, a "heavy user" fixture should include a large `ledger_entries` history
specifically to exercise this.

### The one endpoint that is a bigger risk than any response size: `GET /wallet/bnb/history`
This is an **on-demand call to a third-party API (BscScan)**, not our own database — see
`api/src/routes/withdrawals.ts:850-864` and CLAUDE.md's 2026-08-29 "REAL TOKEN LOGOS" entry. It is
called unconditionally on every `/wallet` mount (`wallet/page.tsx:54`) and again on every
`/wallet/bnb` mount (`wallet/bnb/page.tsx:31`). The 60-second cache is keyed **per deposit
address**, i.e. per user — it does nothing to protect against N different users hitting the
endpoint in the same 60 seconds, which is exactly the shape a load test produces. BscScan's free
tier is rate-limited (order of 5 req/s per CLAUDE.md's own account of testing free RPC providers
elsewhere in this codebase); a load test that drives real `/wallet` navigation at the volumes
below will hit that ceiling almost immediately and start seeing failures/latency on this one
endpoint that have nothing to do with our own backend's capacity. **Recommendation for the load
test: either mock/stub this endpoint at the boundary, or model it as a separate, much lower
ceiling than the rest of the mix, so its failures aren't misread as an application bottleneck.**

---

## 4. Service worker (`web/public/sw.js`)

- **Cached**: `/offline` and `/icons/icon-192.png` (precached at install, `sw.js:16`); any
  `/_next/static/*` or `/icons/*` GET is cache-first-then-network with the response stored back
  (`sw.js:101-115`) — safe because Next's static assets are content-hashed (a new build is a new
  URL), so nothing ever goes stale.
- **Network-only**: every page navigation (`req.mode === "navigate"`) always tries the network
  first when online, falling back to the cached `/offline` page only when `navigator.onLine` is
  false or the fetch fails (`sw.js:89-96`). All cross-origin requests (the API, ad networks) are
  explicitly passed through untouched — `if (url.origin !== self.location.origin) return;`
  (`sw.js:79`) — the service worker never intercepts, caches, or retries an API call.
- **No repeated-request behaviour.** The worker itself never re-fetches anything on a timer; it
  only reacts to requests the page already made, plus push events. It is not a source of any
  additional load beyond what §1-2 already count.

---

## 5. Derived request/second model

### Model inputs (grounded vs. assumed)
- Per-screen call counts (§2) and the two real polling loops (§1 rows 2-4) are **read directly
  from the code** — not estimates.
- What is **not** in the code, and has to be assumed for a "requests per minute" figure: how often
  a real user switches screens. That assumption is stated explicitly below and should be treated
  as the one knob the load-test team may want to revisit.

### 5a. Idle-on-one-screen (no navigation, screen just left open)
| Screen | Steady-state req/min |
|---|---|
| Home | 0 (all 5 calls happen once at mount, nothing recurs) |
| Mine | 0 |
| Wallet | 0 |
| Tasks | 0 |
| Refer | 0 |
| **Help** | **4** (15 s poll, §1 row 2) |

If a population is idling and, say, 5% of concurrently-active users have `/help` open at any
moment (a generous assumption — support is not most people's steady state) and the rest are
parked on Home/Mine/Wallet/Tasks, the population-average idle rate is `0.05 × 4 = 0.2` req/min
per user. This is the honest floor: **outside of active chat, an idle earner app generates
essentially zero background traffic.**

### 5b. Engaged session (mining + tasks — actively navigating)
Assumption made explicit: an engaged user switches screens roughly every 20 seconds (**3
navigations/minute**), distributed non-uniformly — mining is the main draw, tasks browsing is
frequent, wallet checks and home landings are less frequent, refer is rare. Assumed mix, summing
to 3.0 navigations/min: **Mine 1.0, Tasks 0.8, Wallet 0.7, Home 0.4, Refer 0.1.**

Per-endpoint hits/min = sum of (screen's per-mount call count × that screen's navigation rate), for
every screen that calls it:

| Endpoint | Screens hitting it (calls/mount) | Hits/min per engaged user | Share of total |
|---|---|---|---|
| `GET /mining/state` | Home(1)+Mine(1)+Wallet(1) → 0.4+1.0+0.7 | **2.1** | 15.4% |
| `GET /wallet/balance` | Home(1)+Mine(1)+Wallet(1) → 0.4+1.0+0.7 | **2.1** | 15.4% |
| `GET /wallet/ledger` | Mine(1)+Wallet(1) → 1.0+0.7 | **1.7** | 12.5% |
| `GET /mining/history` | Mine(1)+Wallet(1) → 1.0+0.7 | **1.7** | 12.5% |
| `GET /tasks` | Home(1)+Tasks(1) → 0.4+0.8 | **1.2** | 8.8% |
| `GET /features` | Home(1)+Wallet(1) → 0.4+0.7 | **1.1** | 8.1% |
| `GET /withdrawals` | Wallet(1) → 0.7 | **0.7** | 5.1% |
| `GET /wallet/bnb/withdrawals` | Wallet(1) → 0.7 | **0.7** | 5.1% |
| `GET /wallet/bnb/history` ⚠️ external | Wallet(1) → 0.7 | **0.7** | 5.1% |
| `GET /wallet/usdt-task-rewards` | Wallet(1) → 0.7 | **0.7** | 5.1% |
| `GET /content/home` | Home(1) → 0.4 | **0.4** | 2.9% |
| `GET /referrals/me` | Refer(1) → 0.1 | **0.1** | 0.7% |
| `GET /auth/telegram/config` | Refer(1) → 0.1 | **0.1** | 0.7% |
| `GET /notifications` | once per session, amortized over an assumed 10-min session | **~0.1** | 0.7% |
| `GET /support/chat` | only while `/help` open; averaged across the whole population at the 5% assumption from §5a | **~0.2** | 1.5% |
| **Total** | | **≈13.6 req/min per engaged user** | 100% |

*(`GET /usdt` omitted from the table — it only fires when `usdtTopup` is enabled for the account/
instance, a feature flag most instances have off; add it back in at ~0.7/min if top-ups are live
in the environment under test.)*

### 5c. Total requests/second at scale

| Concurrently-active users | Idle model (0.2 req/min/user) | Engaged model (13.6 req/min/user) |
|---|---|---|
| **10,000** | 10,000 × 0.2 = 2,000 req/min = **33 req/s** | 10,000 × 13.6 = 136,000 req/min = **2,267 req/s** |
| **100,000** | 100,000 × 0.2 = 20,000 req/min = **333 req/s** | 100,000 × 13.6 = 1,360,000 req/min = **22,667 req/s** |

Arithmetic: `req/s = users × req/min ÷ 60`. E.g. 10,000 × 13.6 ÷ 60 = 2,266.7; 100,000 × 13.6 ÷ 60
= 22,666.7.

**A realistic mixed population sits between these two lines** — most users are idle most of the
time, some fraction is actively engaged. If the load test wants one blended number, a reasonable
starting split is 20% of concurrent users "engaged" (actively switching screens) and 80% "idle":
`0.2 × 2,267 + 0.8 × 33 = 480` req/s at 10,000 users, and `4,800` req/s at 100,000 — but this 20/80
split is a further assumption on top of the ones already stated, offered only as a starting point,
not a finding.

### Ranked hottest endpoints (by share of engaged-session traffic, from the table above)
1. **`GET /mining/state`** (15.4%) and **`GET /wallet/balance`** (15.4%) — tied hottest. Called by
   three of the six audited screens each, and by every wallet sub-screen too (§2's "not in the
   requested six" note). These two should be the first thing a load test's cache/index tuning
   targets.
2. **`GET /wallet/ledger`** and **`GET /mining/history`** (12.5% each) — high frequency **and**
   the first is the one unbounded-response endpoint in the hot path (§3). Worth seeding a
   heavy-history test account specifically for this pair.
3. **`GET /tasks`** (8.8%) — moderate frequency, response is small and bounded.
4. **`GET /features`** (8.1%) — cheap, likely a small key-value payload; frequency is the whole
   cost here.
5. **`GET /withdrawals`, `/wallet/bnb/withdrawals`, `/wallet/bnb/history`, `/wallet/usdt-task-rewards`**
   (5.1% each) — moderate frequency, but `/wallet/bnb/history` carries the external-API rate-limit
   risk flagged in §3 and should be treated as a separate, harder ceiling in the test plan rather
   than lumped in with the rest of this list.
6. **`GET /support/chat`** (1.5% averaged, but **4 req/min continuously for whoever has `/help`
   open** — the only endpoint with real steady-state-without-navigation traffic; its share grows
   if the test's idle population is more support-heavy than assumed in §5a).
7. Everything else (`/content/home`, `/referrals/me`, `/auth/telegram/config`, `/notifications`)
   — under 3% each, low priority for load-test tuning.

---

## Appendix: files read for this audit
`web/src/lib/hooks.ts`, `web/src/components/TopBar.tsx`, `web/src/components/Shell.tsx`,
`web/src/app/layout.tsx`, `web/src/app/page.tsx`, `web/src/app/mine/page.tsx`,
`web/src/app/wallet/page.tsx`, `web/src/app/tasks/page.tsx`, `web/src/app/help/page.tsx`,
`web/src/app/refer/page.tsx`, `web/src/app/wallet/{bnb,usdt,rozi,withdraw,earnings/withdraw}/page.tsx`,
`web/src/components/{HomeContent,WelcomeExperience,InstallPrompt,ConnectTelegramCard,HourglassClaim}.tsx`,
`web/src/components/staff.tsx`, `web/src/components/staff/{DashboardOverview,MoneyQueues,TasksAdmin,SupportQueue,Disbursements}.tsx`,
`web/src/lib/api.ts`, `web/public/sw.js`,
`api/src/routes/app.ts`, `api/src/routes/mining.ts`, `api/src/routes/withdrawals.ts`.
