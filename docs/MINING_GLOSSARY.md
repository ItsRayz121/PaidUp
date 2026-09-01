# ROZI mining — plain-English glossary

The words that appear in `/staff → Mining`, explained without jargon. The staff
panel shows a one-line version of each of these under its field.

## Emission model
The rule that decides how much ROZI everyone earns each day.

- **"pi"** (default): you earn `piBaseRate × your multipliers × the fraction of a
  full day you mined`. Your payout does **not** shrink when more people mine —
  no dilution. The throttle is the halving (below).
- **"pool"** (fallback): a fixed daily pot of ROZI, split between miners in
  proportion to their share of the day's total mining power. More miners = a
  smaller slice each. Over-issuing is arithmetically impossible here, which is
  why it is kept as the safe fallback.

## Pi base rate (`piBaseRate`)
ROZI per day a **baseline** miner earns for a full day — before streak, rigs,
boosts or referral bonuses. The headline "how fast is mining" number.

⚠️ Rig prices are set as a function of this. Retune one, retune the other, or
the first rig becomes unaffordable and the ROZI sink stops working.

## Halving (`piHalvingUsers`)
The base rate is cut in **half** each time the count of verified users crosses
one of these milestones (e.g. `10000,50000,250000,...`). People are what drain
the pool, so people are what slow the tap. It is **not** calendar-based.

## Supply cap (`supplyCap`)
The most ROZI that mining can **ever** create — 21,000,000. Enforced in the
settlement transaction under both emission models. It can be raised but **never
lowered**: cutting it after people have mined against it retroactively devalues
what they hold.

## Hashrate ("mining speed")
A user's personal mining power. Shown to users as "mining speed" (the word
"hashrate" is kept out of the earner app). It is:

```
(base hashrate + rig power) × streak multiplier × boost multiplier + flat ad bonus
```

Higher hashrate → more ROZI per session.

## Boosts
Temporary multipliers (or flat additions) to a user's mining speed:

| Boost | How it's earned | Effect |
|---|---|---|
| Streak | Mining on consecutive days | +5%/day up to ×2, automatic |
| Task boost | Finishing a credited task | +`taskBoostPct`% for `taskBoostHours` |
| Ad boost | Watching a rewarded ad | +`adBoostFlat` flat, after multipliers |
| Referral | Your active invitees' mining | a capped % of your downline's hashrate |

The **task boost** is the important one: it is what makes mining *feed* the
offerwall instead of competing with it.

## Boosters (`/staff → Mining → Boosters`)
An admin-created **shop item bought with Points** (the cash currency — NOT ROZI)
that grants a temporary percentage speed multiplier for a set number of hours.
Purpose: a sink for Points that quietly reduces USDT withdrawal pressure. Ships
disabled; the admin sets the price, the multiplier and the duration.

## Rigs vs the ROZI Store
- **Rigs** are virtual machines bought with ROZI (or, where enabled, USDT) that
  **permanently** raise a user's mining speed. A cost-growth curve steeper than
  the power-growth curve makes the upgrade tree a permanent ROZI burn.
- **The Store** sells **real goods** (mobile top-up, data bundles) for ROZI at a
  price we set. It is a shop, never a buy-back — we sell items, we never offer to
  buy ROZI back — so exposure is bounded by stock, not by an open-ended promise.

They are deliberately separate.

## Conversion window / "ROZI ↔ Points conversion" (`conversionEnabled`)
The **only** path from the ROZI ledger to the Points ledger. Currently **off**.

When an admin *opens* a window they commit a fixed pot of Points. Users burn
ROZI into the window. At close, each user receives
`pot × (their burn ÷ everyone's burn)`.

There is deliberately **no fixed ROZI→Points rate**: the split floats with how
much everyone burned. A fixed rate would be a promise to buy back an asset we
mint for free — an unfunded liability that grows with our own success.

## "Speed ups" on the earner mining screen
The user-facing name for the boost cards (do a task, watch an ad) plus the
automatic streak. Each raises the user's mining speed for a while.

## ROZI value estimate (`roziUsdtDisplayRate`)
A display-only dollar figure shown next to a rig's ROZI price so a user pricing a
machine sees an approximate cost. It is **not** a real rate — nothing backs it,
and it is never offered as a buy-back price.
