# ROZI Mining — Build Plan & Checklist

Companion to `docs/MINING_SPEC.md` (the design). This is the execution list.
Tick items as they land. Nothing is "done" until it is **verified end-to-end**,
not just typechecked.

---

## Phase M0 — Design ✅

- [x] `docs/MINING_SPEC.md` — model, tokenomics, emission, hashrate, sinks,
      conversion, anti-abuse, admin surface, revenue lines
- [x] Guardrail #7 written down (the two ledgers never touch except through a
      funded, capped Conversion Window)
- [x] Decided **against** an in-app P2P market (unlicensed exchange). Transfers
      only. Reason recorded in the spec so it does not get re-litigated.
- [x] `docs/MINING_PLAN.md` (this file)

---

## Phase M1 — Core mining engine (backend) ✅

The skeleton everything else hangs off. Nothing user-visible yet.

- [x] **M1.1 Schema** — `rozi_ledger` (append-only, mirrors `ledger_entries`),
      `mining_sessions`, `mining_epochs`, `mining_shares`, `mining_settings`
      (key-value, like `app_settings`), `user_rigs`, `rigs`, `user_boosts`
- [x] **M1.2 `roziBalanceOf()` + `postRozi()`** — the *only* way ROZI moves.
      Signed rows, never an UPDATE. Mirrors `postLedger()` exactly.
- [x] **M1.3 Settings module** — typed getters with defaults for every number in
      the spec; all Admin-writable at runtime
- [x] **M1.4 Hashrate calculator** — pure function, unit-testable:
      `(base + rigs + flat) × streak × task × ad × (1 + referral)`, capped
- [x] **M1.5 Sessions** — start / status / expiry; one active per user; accrues
      `hashrate_seconds` into `mining_shares`
- [x] **M1.6 Epoch settlement job** — pro-rata split of `E(e)`, halving,
      650M hard cap, idempotent per epoch, single transaction, withholding for
      flagged accounts
- [x] **M1.7 Unit tests** — emission curve sums to 600M; settlement is
      idempotent; pro-rata shares sum to ≤ emission; hashrate cap holds

## Phase M2 — Earning hashrate ✅

- [x] **M2.1 Streak** — daily streak tracking, multiplier, reset on miss
- [x] **M2.2 Task multiplier** — hook the **existing** credited-completion path
      in `webhooks.ts` to grant a 48h boost. Must not disturb the Points flow.
- [x] **M2.3 Rigs** — seed catalogue, buy/upgrade endpoint, ROZI burn, cost/power
      curves, max level
- [x] **M2.4 Referral hashrate** — L1 10% / L2 3%, active-invitee-only, capped
- [x] **M2.5 Points-priced boosters** — spend Points → multiplier (Points sink)
- [x] **M2.6 Tests** — rig curve, referral cap, boost stacking + expiry

## Phase M3 — Ad-watch mining (revenue line #2) ✅

- [x] **M3.1 `ad_impressions` table** + verified-view flow (signed nonce, dwell
      time, per-user + per-device rate limit)
- [ ] **M3.2 S2S postback adapter** for the ad network — **NOT built.** Blocked on
      the founder choosing a provider (each signs differently). The nonce + dwell
      + single-use + cap flow in M3.1 is what ships meanwhile, and it is safe to
      ship *only* because the reward is a boost, never currency (§ 8.1).
- [x] **M3.3 Reward = hashrate boost, never currency** (keeps guardrail #1 intact)
- [x] **M3.4 Daily cap + bot-pattern detection**
- [x] **M3.5 Provider config in Admin** (Monetag / Adsterra — founder supplies the
      account; ships behind a feature flag, off until then)

## Phase M4 — Admin panel (Mining tab) ✅

Everything tunable with **no redeploy**. Every write audit-logged.

- [x] **M4.1 Emission controls** + live emitted / remaining / circulating readout
- [x] **M4.2 Hashrate controls** (every multiplier and cap in the spec)
- [x] **M4.3 Rig CRUD**
- [x] **M4.4 Booster CRUD**
- [x] **M4.5 Conversion controls** — master switch, open/close window, pot size,
      **suggested-pot calculator driven by real margin**, window history
- [x] **M4.6 Transfer controls** — on/off, caps, burn fee
- [x] **M4.7 Manual ROZI adjustment** — capped + audit-logged
- [x] **M4.8 Mining dashboard** — active miners, network hashrate, supply,
      burned, ad revenue, **pool coverage ratio**

## Phase M5 — Earner UI ✅

- [x] **M5.1 `/mine`** — hashrate dial, Start Mining + countdown, today's estimate,
      streak, active boosts, Watch Ad
- [x] **M5.2 Rig shop**
- [x] **M5.3 Referral hashrate breakdown** — shown on `/mine`. Still to do: surface
      it on `/refer` too, where people go to recruit.
- [x] **M5.4 Wallet** — separate ROZI card + the unmissable **"ROZI is not cash
      yet, you cannot withdraw it"** banner
- [x] **M5.5 Bottom nav** (6 tabs). PWA manifest shortcut for `/mine` not added yet.
- [x] **M5.6 Copy** — every string in the copy deck. **English only**: Urdu was
      dropped by the founder on 2026-07-12, mid-build, and the `ur` dictionary +
      `LangToggle` + RTL were removed.

## Phase M6 — Anti-abuse ✅

- [x] **M6.1 One-miner-per-device-per-epoch** (the load-bearing rule)
- [x] **M6.2 Verified-email gate**
- [x] **M6.3 `mining_bot_pattern` detection**
- [x] **M6.4 Withheld settlement** for suspended / high-flagged accounts, with
      staff release/void in the existing fraud queue
- [x] **M6.5 Tests** — device sharing earns zero; withholding does not inflate
      other miners' payouts

## Phase M7 — ROZI transfers (P2P wallet-to-wallet) ✅

- [x] **M7.1 `POST /mining/transfer`** — by referral code or email
- [x] **M7.2 Limits** — daily cap, min account age, both accounts unflagged,
      burn fee, atomic debit+credit in one transaction
- [x] **M7.3 `rozi_transfer_ring` fraud rule**
- [ ] **M7.4 Earner-facing transfer UI** — the API (`POST /mining/transfer`) and the
      `rozi_transfers` record exist and are tested, but there is **no screen** for
      it yet. Transfers ship OFF (`transfersEnabled=0`), so nothing is reachable
      without a UI anyway; build the screen when you switch them on.
- [x] ❌ **NOT building**: order book, price matching, escrow, money leg. See
      `MINING_SPEC.md` § 7.

## Phase M8 — Conversion Windows ✅

**Ships disabled.** Built now so it is not rushed later under pressure.

- [x] **M8.1 `conversion_windows` + `conversion_burns` tables**
- [x] **M8.2 Burn endpoint** (ROZI debit → window)
- [x] **M8.3 Window settlement** — pro-rata Points from the committed pot
- [x] **M8.4 THE critical test**: Points minted by a window can **never** exceed
      the committed pot, under any input, including concurrent burns
- [ ] **M8.5 Earner-facing conversion screen** — the API (`GET /mining/conversion`,
      `POST /mining/conversion/burn`) is built and tested, and the **Admin** side
      is complete, but there is **no earner screen** yet. Conversion ships OFF, so
      it is unreachable regardless; build the screen when the lock period ends —
      and it must show the floating rate as an estimate, in plain en + ur.
- [x] **M8.6 Master flag off at launch**

## Phase M9 — Verify & ship ✅

- [x] **M9.1** 29-check e2e against a real DB + 15 unit tests on the economy maths
- [x] **M9.2** `api` + `web` typecheck, `web` production build
- [x] **M9.3** Copy deck: 203 keys, English only, no jargon
- [x] **M9.5 Senior review pass** — 9 real defects found and fixed after the first
      "done", every one with a regression test:
  1. **Epoch-boundary accrual loss.** A session crossing UTC midnight booked the
     whole thing to the day it *started*, so mining after midnight was credited to
     a day that may already have been settled — silently lost. → `splitByEpoch()`.
  2. **Closing the app earned nothing.** Shares were only written when the user
     polled the API, so someone who tapped Start and locked their phone had an
     empty `mining_shares` row at settlement. → `accrueAllSessions()` sweep on the
     timer + a 1h settlement grace period so accrual always lands first.
  3. **Referral hashrate was O(downline) queries** on every poll AND every
     accrual — a 10k downline meant ~30k queries per request. Success would have
     been the outage. → `ownHashrateBatch()`, 3 aggregate queries flat.
  4. **No global settlement lock.** Two instances settling *different* epochs both
     read the same `totalEmitted` and could jointly mint past the supply cap. →
     `pg_advisory_xact_lock('rozi-settlement')`.
  5. **Ad-nonce redemption was check-then-act** (security review). Fifty concurrent
     POSTs with the same nonce all read `status='issued'` and all granted a boost;
     the daily cap had the same hole. Hashrate sets your share of emission, and
     ROZI is a claim on Conversion Window pots that pay real Points — so this was
     theft from honest miners, not cosmetic. → advisory lock + a conditional
     `UPDATE … AND status='issued'` whose row count is the only authority.
  6. **Conversion settlement denormalised payouts**: each user's TOTAL was stamped
     onto every one of their burn rows, so `SUM(points_paid)` multi-counted real
     money. → settle per burn row; the column now reconciles 1:1 with the ledger.
  7. **`adsEnabled=1` with no ad provider** handed out free boosts for a video
     nobody watched. → ads require the flag AND a configured provider.
  8. **Admin "burned" stat undercounted**: transfer fees are burned but leave no
     ledger row by design, so summing by `source_type` missed them. → circulating
     is now read straight from the ledger sum.
  9. **The unit tests never exited.** They imported `MINING_DEFAULTS` from
     `settings.ts`, which imports `db.ts`, which opens a DB connection at module
     scope — node:test hung for 112s and reported the file as failed even though
     every assertion passed. → `MINING_DEFAULTS` moved to `core.ts`, which has no
     imports at all. Unit tests now run in 0.5s. **`core.ts` must stay
     import-free.**
- [x] **M9.4** `security-review` — found and fixed **two real bugs**:
      - **Missing double-spend lock** on all four new debit paths. The Points
        ledger serializes money moves with `pg_advisory_xact_lock` (see
        `routes/withdrawals.ts`); none of the new ROZI/Points debits did. The
        booster purchase debits the **real Points** ledger, so a concurrent
        buy-and-withdraw could have overspent USDT-redeemable money. Fixed with
        `lockUser()` on all four, plus a structural test so it cannot be deleted.
      - **Ad daily-cap bypass**: the cap was checked at nonce *issue* (which
        counts only `rewarded` rows), so 50 nonces could be issued while the
        count was 0 and all redeemed after one dwell period. Now re-checked at
        redemption.
- [x] **M9.5** `DEPLOY.md` — settings, settlement timer, what ships OFF
- [x] **M9.6** `CLAUDE.md` updated

---

## Founder blockers (only you can unblock these)

| # | Item | Blocks |
|---|---|---|
| 1 | **Ad network account** (Monetag or Adsterra) + tag/secret | Revenue line #2 (Phase M3 ships flagged-off without it) |
| 2 | Lock-period end date | Phase M8 stays off until you say so — no code needed |
| 3 | Booster prices in Points | Phase M2.5 ships off |

Everything else can be built and verified without you.
