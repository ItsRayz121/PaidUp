# Per-user deposit & withdrawal wallets — spec and cost

**Status: NOT BUILT. Specified only.** Founder decision 2026-07-30: give every
user their own wallet address on USDT BEP20 + TRC20, which they can deposit to
and withdraw from.

This document exists because the answer to *"if this will not cost us"* is that
it does cost, in three separate currencies — gas, engineering time, and legal
exposure — and each one needs a decision only the founder can make. Nothing here
is a refusal. It is the list of things that must be true before the first line
of this code is worth writing, and the order to build it in once they are.

---

## 1. What was asked for

> Every user who sets up an account gets a unique wallet, extracted from the
> official wallet. With that wallet the user can deposit money and even withdraw
> from that wallet. Initially USDT BEP20; additionally USDT TRC20.

"Extracted from the official wallet" is the right instinct and has a real name:
a **hierarchical deterministic (HD) wallet**. One master seed deterministically
derives an unlimited number of child addresses (`m/44'/60'/0'/0/N` for BEP20,
`m/44'/195'/0'/0/N` for TRON). We store only the index per user, never a key.
Generating addresses is genuinely free and genuinely unlimited.

That is the only free part.

---

## 2. What it costs

### 2a. Gas — a real, recurring, per-user bill

Money that lands on a user's derived address is stuck there until we move it.
Collecting it into treasury is called **sweeping**, and a sweep is not one
transaction:

**BEP20 (BNB Smart Chain)**
1. Send BNB to the user's address to pay for its own sweep (~$0.02–0.05).
2. Send the USDT from that address to treasury (~$0.10–0.20).

≈ **$0.15–0.25 per deposit swept.** On a $1 minimum top-up that is 15–25% of the
deposit, before we have earned anything on it. The `usdtMinTopup` floor would
have to rise, or small deposits lose money outright.

**TRC20 (TRON)** — materially worse, and it surprises people:
- A brand-new TRON address must be **activated** before it can hold anything
  (~1 TRX).
- A USDT TRC20 transfer burns ~32,000 energy. Unstaked, that is **~13 TRX,
  roughly $2–3 per transfer**, and it has spiked far higher.
- The way out is staking TRX for energy, which means locking up capital
  (thousands of dollars) to buy the throughput, and managing it as it depletes.

**TRC20 should not be in the first version.** Same product, one chain, a tenth of
the operational cost. If TRC20 is wanted for user familiarity — and in Pakistan
it genuinely is the chain people know — it is a phase 2 that starts by pricing
the TRX stake.

### 2b. Engineering — roughly 2–3 weeks, and a permanent on-call surface

New components, none of which exist in this codebase today:

| Component | What it does | Why it is not trivial |
|---|---|---|
| HD derivation | address per user, per chain | easy; the only easy one |
| Key custody | protects the master seed | see 2c — this is the whole problem |
| Chain listener | notices incoming deposits | needs an RPC provider, must survive reorgs, restarts, and gaps |
| Confirmation policy | when a deposit counts | a deposit credited before finality can be reversed on us |
| Sweeper | moves funds to treasury | must be idempotent, gas-aware, and never double-send |
| Gas funder | keeps BNB on child addresses | a second hot wallet with its own balance to monitor |
| Withdrawal signer | sends money out | the highest-risk code in the entire product |
| Reconciliation | chain balance vs ledger | without this, a bug is silent until someone is short |

Note what the withdrawal side means: today, paying a user is a **human** action
(`payout.ts` manual mode — staff check, staff mark paid, tx hash recorded). Auto
withdrawal replaces that human with code holding a private key. Every bug in it
is a bug that moves real money without anyone watching.

### 2c. Custody — the cost that is not measured in money

Right now this system holds **no private keys at all**. That is not an accident,
it is the design, and it is stated in `CLAUDE.md`:

> No hot wallet, no chain listener, no private key in this system.

Per-user wallets end that. Concretely:

- **We become a custodian.** Holding user funds and moving them on demand is the
  licensed activity — PVARA in Pakistan. Every other decision in this product
  routes around that on purpose: the ROZI store is a shop rather than an
  exchange, USDT top-up is spend-only, there is no in-app P2P market. This
  feature walks straight into it.
- **The master seed becomes the single point of total failure.** Not "a breach
  costs us some money" — a leaked seed drains every user's address, current and
  future, and it cannot be rotated after the fact because the addresses are
  already published to users.
- **It changes what a hack costs.** Today the worst case is a corrupted ledger,
  which is recoverable from an append-only history. With custody the worst case
  is other people's money, which is not recoverable at all.

---

## 3. What must be decided before any code

These are founder decisions. None of them are engineering choices.

1. **Where does the master seed live?** Realistic options: a cloud KMS/HSM (AWS
   KMS, GCP Cloud KMS) that signs without ever exposing the key; or an encrypted
   seed with the decryption key held outside the database and outside the repo.
   "In an env var on Railway" is what will be reached for, and it means anyone
   with dashboard access owns every user's funds.
2. **Hot/cold split.** What maximum is allowed to sit in the hot signing wallet,
   and who moves the excess to cold storage, how often.
3. **Withdrawal approval.** Does auto-send keep the current Agent→Manager
   approval chain, or is there an auto-approve limit? A limit is where an
   attacker will aim, repeatedly, just under it.
4. **TRC20 now or later.** See 2a. Recommendation: later, and only after pricing
   the TRX stake.
5. **Who is accountable at 3am** when the sweeper is stuck and deposits are not
   crediting. Custody is an operational commitment, not a feature that ships.
6. **Legal position on PVARA.** Not a question this document can answer. It needs
   someone qualified, in Pakistan, before launch — not after.

## 4. What must be obtained

- An **RPC provider** account with real rate limits (Alchemy / QuickNode /
  Ankr). Public endpoints will silently drop deposits under load.
- A **KMS or HSM** (decision 1 above).
- A **funded gas wallet** in BNB, topped up on a schedule.
- For TRC20: **staked TRX** for energy, or an accepted ~$2–3/sweep bill.
- **Testnet runway.** This does not go to mainnet until deposits, sweeps and
  withdrawals have all run end-to-end on BSC testnet, including the failure
  cases — a sweep that runs out of gas mid-way, a listener restarted between a
  deposit and its confirmation, a double-submitted withdrawal.

---

## 5. Build order, once section 3 is answered

Each step ships and is verified before the next starts. Do not compress this —
the ordering is chosen so that the riskiest code (signing withdrawals) arrives
last, on top of infrastructure already proven by the deposit side.

1. **HD derivation + address display, read-only.** Every user gets an address.
   Nothing sweeps, nothing credits. Deposits are still confirmed manually by
   staff exactly as they are today. Zero new risk, and it delivers the visible
   half of the feature immediately.
2. **Chain listener + auto-credit**, behind confirmations, still no sweeping.
   Funds sit on child addresses; the manual staff confirmation becomes a
   fallback rather than the only path.
3. **Sweeper + gas funder.** Money starts consolidating into treasury.
   Reconciliation job lands with this step, not after it.
4. **Auto-withdrawal**, behind the existing approval chain and a hard per-day
   ceiling, BEP20 only.
5. **TRC20**, repeating steps 1–4 with TRON's energy model, only if step 4 has
   been stable for a meaningful period.

Step 1 alone satisfies most of what the founder actually described — "every user
gets a unique wallet, and can deposit to it" — with none of the custody risk,
because until step 3 we are not moving anyone's money. **If this feature is
wanted soon, step 1 is the thing to build.**

---

## 5b. What "connect wallet" already delivered (built 2026-08-01)

Before any of section 5, the **withdrawal** side got the part of this that needs
no keys, no gas and no listener: the user connects the wallet they already have,
signs a message we wrote, and the server recovers the address from the
signature. `api/src/wallet.ts`, `web/src/lib/wallet.ts`, 52 checks in
`npm run test:wallet`.

It is worth being precise about what that does and does not cover, because the
two get conflated:

| | connect wallet (built) | per-user wallets (§ 5) |
|---|---|---|
| Where money goes **out** to | an address the user proved is theirs | same, plus auto-send |
| Where money comes **in** to | unchanged — one published treasury address | an address per user |
| Identifies a deposit sent from an exchange | **no** | yes — that is its whole point |
| Private keys in this system | **none** | the master seed |
| Makes us a custodian | **no** | yes |

So connect-wallet is not a smaller version of section 5 and does not postpone
it. It closes a **fraud** hole on the payout side (an address that was merely
pasted proves nothing, and the common theft in our markets is a fake "support
agent" supplying one). Deposits are untouched: a user topping up from a Binance
hot wallet still arrives as an unidentifiable transfer that a human has to match
by tx hash, and **only § 5 step 1 fixes that.**

The proof is snapshotted onto each withdrawal request (`address_verified`) and
shown in the staff queue, for the same reason the fee is snapshotted — the
person approving an irreversible on-chain payout must see what was true when the
user asked, not a value that can move while the request sits in the queue.

⚠️ **It is a signal, never a gate.** A smart-contract wallet cannot
`personal_sign` and an exchange deposit address has no signer the user controls,
so requiring a proof would lock out legitimate users. Typing an address in still
works and says so on screen.

---

## 6. The narrower thing that already works

For contrast, the current design (`CLAUDE.md`, "ONE CHAIN IN, ONE CHAIN OUT"):
one published treasury address, the user pastes a tx hash, a human checks the
chain and credits the amount **they** verified. No keys, no gas, no listener, no
custody, and one transaction can only ever be claimed once (unique index on
`(chain, tx_hash)`).

It is manual and it does not scale past a few dozen deposits a day. Scaling it
is a real reason to build section 5. Convenience alone is not.
