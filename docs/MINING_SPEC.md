# ROZI Mining — Spec & Tokenomics

Status: **design locked, build in progress** (2026-07-12)
Owner: founder decision on every number in § 3; all of them are Admin-tunable at
runtime, so none of this needs a redeploy to change.

---

## 0. Why this exists

CPX (our only live network) has **no survey fill for Pakistani traffic for large
parts of the day**. A user opens RoziPay, sees "no tasks available", and leaves.
That is the single biggest retention hole in the product.

Mining fills the empty hours. It gives a reason to open the app **every day**,
even when there is nothing to earn from — and, critically, it is designed so that
mining *feeds* the revenue engine rather than replacing it (see § 4.3, § 4.4).

It also gives us a **second and third revenue line** (§ 8), so the business no
longer depends on one offerwall's fill rate.

---

## 1. Two currencies. They never touch.

| | **Points** | **ROZI** |
|---|---|---|
| What it is | The cash currency | The mined token |
| Backed by | Real ad-network revenue | Nothing. It is minted. |
| Earned by | Verified S2S postbacks only | Mining (§ 4) |
| Redeemable for | USDT, 1000 pts = 1 USDT, fixed | **Nothing at launch.** See § 6. |
| Ledger table | `ledger_entries` | `rozi_ledger` |
| Balance | `SUM(ledger_entries.amount)` | `SUM(rozi_ledger.amount)` |

### GUARDRAIL #7 (new, non-negotiable)

> **The ROZI ledger and the Points ledger are separate append-only ledgers and
> the only path between them is a Conversion Window (§ 6), which is funded from a
> fixed, pre-committed pot of Points and can never mint more Points than that pot.**

This is the whole safety property of the design. ROZI is free to mint because it
is *not* a claim on the treasury. The moment ROZI has a fixed exchange rate into
Points, we have created an unfunded debt — that is how every one of these apps
dies. There is no fixed rate anywhere in this system. There is only a pot of real
money, divided among whoever shows up.

**Naming:** the cash currency stays **Points**. The mined currency is **ROZI**
(`$ROZI`) — *rozi* is livelihood / daily bread in Urdu, which is the promise.
It is **not** called "airdrop points": that phrase attracts bot farmers and
pump-chasers, not earners.

---

## 2. The model in one paragraph

Every day is a **block**. The block has a fixed **emission** of ROZI (§ 3), which
halves over time. Every miner earns a share of that day's emission equal to
**their share of the day's total network hashrate-seconds**. Hashrate is earned —
by streaks, by doing real tasks, by watching ads, by buying rigs, and by
referrals — never by tapping. Because your reward is a *share of a fixed pot*,
adding more miners makes mining harder for everyone (difficulty self-adjusts,
exactly like real mining) and **it is arithmetically impossible for us to
over-issue**.

---

## 3. Tokenomics

### 3.1 Supply

Total supply: **1,000,000,000 ROZI** (fixed, hard cap).

| Allocation | % | ROZI | Notes |
|---|---|---|---|
| **Community mining** | **65%** | 650,000,000 | Emitted per § 3.2. Never minted any other way. |
| Liquidity | 10% | 100,000,000 | Only if a listing ever happens (§ 7). Locked until then. |
| Team / founder | 10% | 100,000,000 | **6-month cliff, then 24-month linear vest.** Not mintable early. |
| Ecosystem & partnerships | 10% | 100,000,000 | Contests, community rewards, network deals. Admin-gated, audit-logged. |
| Reserve | 5% | 50,000,000 | Emergencies, exchange requirements. |

65% to the community is deliberately high (founder: *"give maximum to
community"*). It is also the honest number: the community is the only reason the
token has any narrative at all.

### 3.2 Emission (the halving schedule)

- **Epoch** = 1 day (UTC midnight to UTC midnight). One epoch = one "block".
- **Epoch 0 emission (E₀)** = **3,000,000 ROZI**.
- **Halving** every **100 epochs** (~3.3 months).
- Emission at epoch *e*: `E(e) = E₀ / 2^floor(e / 100)`

The sum of that series converges to `E₀ × halving_period × 2` =
`3,000,000 × 100 × 2` = **600,000,000**, leaving ~50M of the mining allocation as
headroom for the referral/bonus overhead in § 4.6 without ever breaching the
650M cap. A hard cap check at settlement refuses to emit past 650M, whatever the
settings say.

Plain-English version for the app: **"3 million ROZI are mined every day. Every
100 days that halves. Mine early — it never gets easier."**

All three numbers (E₀, halving period, cap) are Admin-tunable. Changing E₀
changes future epochs only; settled epochs are immutable.

### 3.3 Sinks — where ROZI is destroyed

A mined currency with no sink inflates to zero. ROZI has three:

1. **Rig upgrades** (§ 4.4) — the main sink. Costs grow *faster* than the power
   they give (cost ×1.6/level vs power ×1.5/level), so a rig tree is a
   permanently accelerating burn.
2. **Conversion Windows** (§ 6) — ROZI is **burned**, not transferred, when
   converted to Points.
3. **Transfer fee** (§ 7) — an Admin-settable % of every P2P transfer is burned.

Burns are recorded as debit rows in `rozi_ledger` with `source_type='burn'` and
are subtracted from circulating supply in the admin dashboard.

---

## 4. Hashrate — how mining power is earned

```
hashrate = (base + rigs + flat_boosts)
           × streak_multiplier
           × task_multiplier
           × ad_multiplier
           × (1 + referral_share)
```

Capped at `max_hashrate_per_user` (default 100,000) so no single account — real
or farmed — can dominate an epoch.

### 4.1 Base
Everyone gets **10 H/s**, but only while a mining **session** is running.

### 4.2 Sessions (the retention loop)
- Tap **Start Mining** → a session runs for `session_hours` (default **8**).
- Hashrate only accrues while a session is live. When it expires, mining
  **stops** until the user comes back and starts another one.
- This is deliberately friction: 3 opens per day is the target behaviour, and
  each open is an ad impression (§ 8).
- One active session per user, enforced in the DB.

### 4.3 Streak
`streak_multiplier = 1 + 0.05 × min(streak_days, 20)` → **up to 2.0×** at 20
consecutive days. Miss a day, it resets to 1.0×. A day counts if the user ran at
least one session.

### 4.4 Task multiplier — the link to real revenue
A **credited** task/survey completion (CPX or any network, via the existing
verified postback path) grants **+50% hashrate for 48 hours**, stacking up to
`task_boost_max_stack` (default 3) → up to **2.5×**.

This is the most important line in the spec. It means the highest-hashrate miners
are the people doing the surveys that actually pay us. Mining does not cannibalise
the offerwall — it recruits for it.

### 4.5 Rigs (the upgrade tree)
Rigs are bought with **ROZI itself**. Each rig has levels:

- Cost of level *L*: `base_cost × 1.6^(L-1)`
- Power of level *L*: `base_power × 1.5^(L-1)` (flat H/s, added before multipliers)

Because cost growth (1.6) > power growth (1.5), each level is worse value than
the last. That is the point: the tree is a treadmill that burns ROZI forever and
can never be "solved" into infinite hashrate.

Launch rigs (Admin CRUD, so this list is just the seed):

| Rig | Base cost | Base power | Max level |
|---|---|---|---|
| Old Phone | 500 ROZI | 5 H/s | 10 |
| Laptop | 3,000 ROZI | 25 H/s | 10 |
| Mining Rig | 20,000 ROZI | 150 H/s | 10 |
| Server Rack | 120,000 ROZI | 800 H/s | 10 |
| Data Centre | 750,000 ROZI | 5,000 H/s | 10 |

### 4.6 Referral hashrate
- **L1**: +10% of each *direct* invitee's hashrate.
- **L2**: +3% of each indirect invitee's hashrate.
- Only **active** invitees count — someone who has not mined in the last 24h
  contributes **zero**. Dead signups are worth nothing (anti-farm).
- The whole referral component is capped at `referral_share_cap` (default
  **100%** of the user's own pre-referral hashrate) so an account cannot be
  purely a referral parasite.
- This is a *bonus*, not a deduction: the invitee loses nothing. It is paid from
  the same epoch emission, which means it dilutes everyone slightly — that is
  the honest cost, and it's why the emission has 50M of headroom.

### 4.7 Points-priced boosters (a sink for the CASH currency)
Users may spend **Points** (the real currency) on a temporary big multiplier —
e.g. **2× hashrate for 7 days, 500 Points**.

This is quietly one of the most valuable mechanics in the product: it converts
cash-currency liability into a token-currency promise, i.e. it **reduces
withdrawal pressure on the USDT treasury**. Admin CRUD, off by default until the
founder decides on prices.

---

## 5. Accrual & epoch settlement

### 5.0 Accrual — three rules that are easy to get wrong

These were all real bugs, caught in review. Do not undo them.

1. **A session's time is split at UTC midnight.** Sessions are 8 hours, so one
   started in the evening routinely runs into the next day. Booking the whole
   session to the day it *started* would credit tomorrow's mining to today — and
   if today is already settled, that share is gone forever (the `mining_epochs`
   row exists, so settlement never revisits it). `splitByEpoch()` chops the
   elapsed time at the boundary and books each slice to the day it happened in.
   The device claim is per-day too, so a session crossing midnight re-claims.

2. **The server sweeps every open session; it does not wait for the user to poll.**
   Accrual used to happen only when the user hit the API. That meant someone who
   tapped "Start mining" and closed the app had *nothing* in `mining_shares` when
   their day was settled, and earned zero for a session they legitimately ran.
   `accrueAllSessions()` runs on the settlement timer (every 15 min) and puts
   every open session's time on the books whether or not its owner is looking.

3. **A day is only settled after a grace period** (`SETTLE_GRACE_MS`, 1 hour).
   The sweep runs every 15 minutes, so an hour of grace guarantees all of a day's
   mining is recorded before that day pays out. Settling the moment a day closed
   would race the sweep and pay people for a partial day.

Accrual also refuses to write into an already-settled day, and **logs loudly** if
it ever tries — that should be impossible given (2) and (3), so it means one of
them has broken.

### 5.1 Settlement

At UTC midnight (plus grace), a settlement job runs for the epoch that just closed:

1. Sum every user's accrued `hashrate_seconds` for the epoch.
2. `total_shares = Σ user_shares`. If zero, the epoch emits nothing.
3. `emission = E(e)`, clamped so cumulative emission never exceeds the 650M cap.
4. Each user is credited `emission × user_shares / total_shares` ROZI, as an
   append-only `rozi_ledger` row (`source_type='mining'`, `source_ref_id=epoch`).
5. The epoch row is marked settled. **Idempotent**: a unique index on epoch
   number means a re-run credits nobody twice.
6. Accounts that are **suspended or under an unresolved high-severity fraud flag**
   have their share **withheld** (not voided) — staff can release or cancel it
   from the fraud queue. Their shares still count in the denominator, so
   withholding does not inflate everyone else's payout.

Settlement runs inside one DB transaction. A crash mid-settlement rolls back and
the next tick retries the epoch cleanly.

It also takes a **global advisory lock** (`rozi-settlement`). The per-epoch primary
key stops the same day being settled twice, but it does nothing about two API
instances settling *different* days at the same moment: both would read the same
`totalEmitted`, both would believe they had the same room under the supply cap, and
together they could mint past it. The cap is the one promise about ROZI that has to
be literally true, so it gets a real lock rather than an argument about why it
probably cannot happen.

---

## 6. Conversion: ROZI → Points

**Disabled at launch.** `mining_conversion_enabled = false`. Founder decision:
users mine for **2–3 months** with nothing tradeable and nothing convertible.
This is correct and it is what makes the whole thing safe — real usage builds
before any value is claimed.

When it is switched on, conversion happens **only** through a **Conversion
Window**:

1. Admin opens a window (e.g. weekly) and commits a **pot of Points**.
   The panel *computes a suggested pot* from the real net margin of the period
   (`pot = margin_points × conversion_share_pct`), so the founder cannot
   accidentally commit money the business did not earn. The Admin can override,
   but the suggestion is right there next to the input.
2. During the window, users **burn** ROZI into it.
3. At close, each participant receives `pot × (their_burn / total_burn)` Points,
   posted to the **Points** ledger as `source_type='mining_conversion'`.
4. The rate **floats**. The UI shows it live and says so in plain English:
   *"This week's pot is 200,000 points. Everyone who converts shares it. The more
   people convert, the smaller each share."*

**The pot is a hard ceiling enforced in code**, not a guideline. The sum of Points
minted by a window is asserted `<= pot` inside the settlement transaction. There
is a test for this and it is the most important test in the codebase.

Why not a fixed rate? Because a fixed rate is a promise to buy back an asset we
mint for free. That is an unfunded liability that grows with our own success, and
it is the exact mechanism by which these products go insolvent.

---

## 7. Trading — what we will and will not build

| | |
|---|---|
| ✅ **Wallet-to-wallet transfer** | Send ROZI to another RoziPay user (by referral code or email). Rate-limited, min account age, both accounts unflagged, % burn fee, fully audit-logged, fraud-checked for transfer rings. **We will build this.** |
| ❌ **In-app P2P market / order book** | Users buying and selling ROZI from each other for money, with us matching them or holding the money leg. **We will not build this.** |

The refusal is not squeamishness, so it's worth writing down once:

> If we run the order book, match the trades, or custody the money leg, **we are
> an exchange** — an unlicensed one. Under Pakistan's PVARA regime that is the
> most prosecutable thing in this entire product, far more than paying survey
> rewards in USDT. That other mining apps do it is true, and is not a defence;
> several of them are why the rules exist.

The `rozi_ledger` is designed so that a licensed order book **could** be added
later behind an admin flag, without a migration. Nothing is lost by waiting.

**Listing (§ future):** if ROZI is ever listed, it happens on an external DEX
where we are neither the venue nor the counterparty, funded from the 10%
liquidity allocation. A thin pool gets drained on day one and the chart goes to
zero, so this needs real capital — it is not a two-week job and the spec does not
pretend otherwise. Until then, the **Conversion Window is the value bridge**, and
it plays identically to the user.

---

## 8. Revenue models

Three lines, so no single one can starve us:

1. **Offerwall / surveys (live)** — CPX Research. 60/40 split. Existing.
2. **Our own ad inventory (new, § 8.1)** — rewarded video + interstitials served
   on our site. Every mining session is an ad impression.
3. **App-install CPI offers (later)** — the "download and play" model. This is
   just another adapter + a network account; the machinery already exists.

### 8.1 Ad-watch mining — how it actually works

- Users watch a **rewarded video** on our site. The reward is a **hashrate boost**
  (default **+100% for 4 hours**, max `ad_watch_daily_cap` = 10/day) — *not*
  Points, and *not* ROZI directly.
- Rewarding a **boost** rather than currency is what keeps **guardrail #1**
  intact. Guardrail #1 says every credited **point** traces to a verified
  postback. A boost is not a point; it is a multiplier on a fixed pot that is
  shared out anyway. So even if a bot fakes ad views perfectly, it steals a
  slightly bigger slice of a pot that was going to be emitted regardless — it
  cannot mint anything, and it costs the treasury **nothing**.
- Where the ad network **does** offer S2S postbacks, we verify them exactly like
  a completion (signed callback → `ad_impressions` row → boost granted).
- Where it does not (many display networks), we fall back to: server-issued
  signed nonce + minimum dwell time + per-user rate limit + device fingerprint.
  This is weaker, and it is **only** acceptable because of the paragraph above.
- **Ad network choice**: Google AdSense will not approve an incentivised rewards
  site. Realistic providers: **Monetag**, **Adsterra**, **PropellerAds**. This is
  a founder task (account + tag), like the CPX account was.

Ad revenue is what funds the Conversion Window pot (§ 6). The loop closes:
**ads pay for mining, mining brings people back, people do surveys.**

---

## 9. Anti-abuse

Free-to-mint currency is a bot magnet. This is make-or-break, and it is stricter
than the rules for Points because the incentive to farm is higher.

| Rule | Behaviour |
|---|---|
| **One miner per device per epoch** | A `device_id` accrues mining shares for **one** user per epoch. A second account on the same device may run a session but accrues **zero shares**, and is flagged `mining_device_share` (high). This is the single most important rule in this section. |
| Verified email required | Unverified accounts cannot mine at all. |
| Hashrate cap | `max_hashrate_per_user`, default 100,000. |
| Active-invitee-only referral | Invitees who have not mined in 24h contribute 0 referral hashrate. |
| Referral share cap | Referral component ≤ 100% of own base hashrate. |
| Bot-pattern detection | Sessions started at near-identical clock offsets every day, or ad-watches at machine-regular intervals → `mining_bot_pattern` (medium). |
| Transfer rings | Many accounts funnelling ROZI to one wallet → `rozi_transfer_ring` (high), reusing the existing ring-detection approach. |
| Withheld settlement | Suspended / high-flagged accounts accrue but do not receive; staff release or void. |

All new flags land in the **existing** `fraud_flags` table and the existing staff
fraud queue. No parallel system.

---

## 10. Admin panel — everything tunable, no redeploy

A new **Mining** tab in `/staff` (admin role), matching how `networks` and
`app_settings` already work:

- **Emission**: E₀, halving period, epoch length, supply cap. Live readout of
  emitted / remaining / circulating (emitted − burned).
- **Hashrate**: base, session hours, streak step + cap, task boost % + duration +
  max stack, ad boost % + duration + daily cap, referral L1/L2 %, referral cap,
  per-user hashrate cap.
- **Rigs**: full CRUD (name, icon, base cost, cost growth, base power, power
  growth, max level, active/disabled).
- **Boosters** (Points-priced): full CRUD.
- **Conversion**: master on/off, open/close a window, pot size **with a
  suggested-pot calculator driven by real margin**, window history, per-window
  payout audit.
- **Transfers**: on/off, daily cap, min account age, burn fee %.
- **Ads**: on/off, provider config, daily watch cap.
- **Manual ROZI adjustment**: capped and audit-logged, exactly like
  `adminAdjustMaxPoints` is for Points.
- **Dashboard**: active miners, total network hashrate, emitted supply, burned
  supply, ROZI per miner, ad revenue, and **pool coverage** (what the current
  ROZI float would cost in Points at the last window's rate) — the number that
  tells the founder whether the economy is healthy.

Every write goes through the existing `admin_audit_log`.

---

## 11. Earner UI

- **`/mine`** — hashrate dial, Start Mining (session countdown), today's estimated
  ROZI, streak flame, active boosts, **Watch Ad** button, rig shop, referral
  hashrate breakdown.
- **Wallet** — a **second, clearly separate** card for ROZI, with an unmissable
  plain-English banner: *"ROZI is not cash yet. You cannot withdraw it. You are
  mining it early."* Lying about this — or letting the UI imply a USDT value —
  is the fastest way to burn the brand.
- **English only** (founder, 2026-07-12 — Urdu was dropped). Every string lives in
  the copy deck at `web/src/lib/i18n.tsx` and must be short, plain, everyday
  English. No jargon: the UI says *"mining speed"*, never *"hashrate"*, and `H/s`
  does not appear on screen at all.

---

## 12. Open founder decisions

| Decision | Default in code | Needs founder |
|---|---|---|
| Lock period before conversion opens | Disabled indefinitely | Pick a date (2–3 months from launch) |
| Ad network account (Monetag / Adsterra) | — | 🔴 **Blocker for revenue line #2** |
| % of margin committed to a Conversion Window | 10% (suggested, not enforced) | Confirm |
| Points-priced booster prices | Off | Confirm before enabling |
| Whether ROZI ever lists | Not planned | Later, from strength |
