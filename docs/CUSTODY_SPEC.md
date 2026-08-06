# Per-user deposit & withdrawal wallets — spec and cost

**Status (2026-08-05): deposit side is step 1 (BEP20, read-only, live).
Withdrawal side now has a real signer — step 4's signing engine, built and
unit-tested, NOT YET LIVE. Steps 2–3 (chain listener, sweeper) still do not
exist.** Founder decision 2026-07-30: give every user their own wallet address
on USDT BEP20 + TRC20, deposit and withdraw. Founder decision 2026-08-03: the
deposit side ships the safe way — an offline seed, an xpub-only server (§
5b-2). Founder decision 2026-08-05, after being told exactly what it costs:
build the withdrawal signer too, encrypted-at-rest (not a KMS — cost was the
deciding factor), fully automatic, with a per-account hold as the safety valve
instead of a per-request approval gate. See § 5c below for what that is and,
just as important, what it still is not.

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

### 2d. ⚠️ AMENDED 2026-08-01 — deposits are now refundable

The sentence above, *"USDT top-up is spend-only"*, **is no longer true**, and
this section exists so nobody reads the rest of this document believing it is.

**The founder's decision:** a user may ask for their own deposited USDT back.
It was put to them that this is custody in the plain sense — we hold money and
return it on request — and they chose it anyway, on the reasoning that money a
user can never get back is a harder sell than the licence question is a risk.
That is a business judgement, not an engineering one, and it is recorded here so
it is not mistaken for drift and quietly reverted by a later reader.

**What that does and does not change:**

| | before | now |
|---|---|---|
| Deposit credit buys machines | yes | yes |
| Deposit credit can be returned to the depositor | **no** | **yes**, staff-sent |
| Deposit credit can be sent to another user | no | **still no** |
| Deposit credit can become Points or ROZI | no | **still no** |
| **Earnings** can leave via this path | no | **still no** |
| Private keys in this system | none | **still none** |

The refund is deliberately the narrowest shape that honours the decision:

1. **Capped by the deposit ledger**, not by anything the user is owed. The
   ceiling is `SUM(usdt_ledger)` — topups minus machine purchases minus earlier
   refunds. Mined ROZI and earned Points are different ledgers and cannot reach
   the route at all. There is a regression test that a ROZI-rich account with no
   deposit cannot refund a cent, and it is there because that is the laundering
   shape: deposit nothing, withdraw something.
2. **Sent by hand, from the treasury, by staff** — unless auto-settlement is
   proven and turned on, exactly like a withdrawal. ⚠️ **UPDATED 2026-08-06**:
   `api/src/autoRefund.ts` now mirrors `autoWithdraw.ts` — a refund at or under
   `autoRefundMaxMicro` (default $5) settles itself instantly when
   `PAYOUT_MODE=onchain` and a treasury signer exists, same gate, same rolling
   24h cap idea (`autoRefundMaxMicroPer24h`), same reused withdrawal-hold
   safety valve. It adds **zero new key material** — it calls the exact § 5c
   signer, not a second one — and it is exactly as dormant as § 5c is: nothing
   auto-sends anything real until `PAYOUT_MODE` leaves `manual`, which needs
   the same testnet proof named there.
3. **Debited at request time, under `pg_advisory_xact_lock`** (guardrail #8), so
   a queued refund cannot be spent on a machine while it waits. A rejection
   writes the compensating credit; marking it sent writes no ledger row at all,
   because the money already left.
4. **ID check required**, the same gate as a withdrawal, for the same reason.
5. **Minimum 1 USDT**, because a BEP20 transfer costs real gas and below about a
   dollar the send costs more than it returns.
6. **Not gated on `usdtTopupEnabled`.** Switching deposits off must never strand
   money people already sent us — that is exactly when being unable to ask for
   it back would be worst.

A general `withdrawal` source type is **still refused by the `usdt_ledger` CHECK
constraint**, and that gap is load-bearing: it is what stops "refund your own
deposit" drifting into "withdraw any balance" by one careless commit. Code:
`POST /usdt/refunds` in `api/src/routes/mining.ts`, the queue in
`api/src/routes/staffMining.ts`, checks in `npm run test:usdt` (manual-queue
behaviour) and `npm run test:autorefund` (the auto-settle gates in point 2
above).

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
  > **Partly answered 2026-08-01.** `config.payoutRpc` now holds a **list** of
  > endpoints per chain with failover (`api/src/rpc.ts`), defaulting to five
  > public BSC nodes, and `/staff/mining/rpc` pings them so an operator can see
  > which are alive. That is enough for **occasional reads** — checking whether a
  > transaction exists. It is **not** enough for step 2's listener: a public node
  > that drops a block does so silently, and a silently-missed deposit is a user
  > who paid us and got nothing. When a paid endpoint exists, put it **first** in
  > `RPC_BEP20` and the public ones become the fallback rather than the primary.
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

## 5b-2. Step 1, shipped (2026-08-03) — read-only addresses, BEP20

`api/src/custody.ts` derives a deterministic BEP20 address per user from ONE
account-level xpub (`CUSTODY_XPUB_BEP20`), using public-only (CKDpub)
derivation. `getOrCreateDepositAddress()` in `db.ts` finds-or-creates the row
in `deposit_wallets` the first time a user asks; `GET /usdt` returns it as
`personalAddress`, additive alongside the existing shared `treasuryAddress`,
and `/mine/topup` shows it in place of the shared address once present. 7
checks in `npm run test:usdt`.

**What this is:** exactly step 1 as scoped above, no more.
- ✅ Every user with the feature on gets a real, unique, deterministic BEP20
  address, derived, stored, shown.
- ✅ Zero new private key material anywhere in this process — verified by the
  test suite deriving from a throwaway public xpub with no funds behind it.
- ❌ Nothing watches the chain. Nothing auto-credits. A deposit to a personal
  address is confirmed **exactly the same way it always has been** — the user
  pastes a tx hash, staff checks it, staff confirms it. That is unchanged by
  this feature on purpose; the address is a display upgrade over the old
  shared-pool address, not a new pipeline.
- ❌ Nothing sweeps. Funds sitting on a derived address stay there; nobody has
  moved anything into treasury by writing this code.
- ❌ No withdrawal side. Paying a user is still `payout.ts` manual mode, same
  as it was before this file existed.

**Why the xpub, not the seed, even though the founder asked for the seed:**
the founder's stated reason for wanting the seed was multi-chain support (TRC20
today's ask, "Apple"/Aptos mentioned too) — the belief that only the raw seed
can unlock other chains later. That's not quite right: a *chain-type branch*
xpub (`m/44'/195'/0'` for TRON, derived offline from the same seed, whenever
TRC20 is actually wanted) gets the same multi-chain outcome with the seed never
leaving wherever it was generated. Aptos is Ed25519, not secp256k1 — it was
never going to derive from this seed either way, xpub or not, so that part of
the ask doesn't change the recommendation. Recorded here so a future reader
doesn't see "founder wanted the seed" in history and assume this doc lost that
argument; the founder heard the tradeoff and chose the xpub-only path.

**Adding TRC20 later:** repeat this exactly — generate the TRON branch xpub
OFFLINE from the same seed, add `CUSTODY_XPUB_TRC20` to config, add a `"trc20"`
case to `custody.ts` (TRON also uses secp256k1, so `deriveChild` is identical;
only the address ENCODING differs — base58check with a 0x41 prefix instead of
a checksummed hex string). Nothing else in this file needs to change; the seed
still never enters this codebase.

---

## 5c. The withdrawal signer, built (2026-08-05) — NOT YET LIVE

The founder was told plainly what this reverses: real custody, the licensed
activity (PVARA) every other decision in this product routes around, and the
first private key this codebase has ever held that can actually spend. They
chose to proceed anyway, on the reasoning that a legal opinion is obtainable
and a stuck product is not — recorded here as a decision with a date, the same
way § 2d records the refund decision, not as drift to be quietly reverted.

**What exists:**

- **`api/src/signer.ts`** — AES-256-GCM encrypted-at-rest storage for ONE
  treasury private key, in the exact pattern `kyc.ts` already used for ID
  photos: two SEPARATE env vars (`TREASURY_KEY_ENCRYPTED`, the ciphertext;
  `TREASURY_KEY_SECRET`, the AES key), so a leak of either alone is not enough
  to reconstruct the key. ⚠️ **This is explicitly NOT a KMS/HSM** — decision 1
  of § 3 above was answered "free" over "small monthly cost", so anyone with
  real Railway dashboard access to this service can read both variables the
  same way the running process does. That gap is what a KMS closes and this
  does not; upgrading later means changing this one file.
- **`api/src/payout.ts`**'s `onchainProvider` — the ERC-20 `transfer` signer
  that was scaffolded and deliberately left unimplemented is now real, via
  `viem`. Per-chain USDT contract address + decimals live in one map
  (`ONCHAIN_CHAINS`) specifically because BSC's USDT has **18 decimals**, not
  the 6 most USDT deployments use — the exact silent-wrong-amount bug this map
  exists to prevent. Only `bep20` is filled in, matching "ONE CHAIN IN, ONE
  CHAIN OUT".
- **`api/src/autoWithdraw.ts`** — the "fully automatic" half. Every new
  withdrawal request tries to settle itself the instant it's created. It
  succeeds only when ALL of: `PAYOUT_MODE=onchain`, a treasury key is
  configured, the amount is at or under `AUTO_WITHDRAW_MAX_POINTS` (defaults
  to 5000 — the founder deferred a real number for this; it needs revisiting
  with actual withdrawal volume), and the account is not held. Fail any one of
  those and the request drops into the **exact same manual Agent→Manager
  queue** withdrawals have always used — nothing about that path changed.
- **The hold, `POST /staff/users/:id/withdrawal-hold`** — manager/admin only,
  a mandatory reason to set one, `null` to clear it, an optional `until` for a
  timed hold that lifts itself the instant the date passes (checked at the
  point of use, nothing scheduled). Narrower than suspending the whole
  account: a held user still mines, earns, and receives ROZI — only their
  withdrawals stop auto-paying and fall back to manual review.

**What does NOT exist yet, and this is load-bearing:** a chain listener, a
sweeper, and a gas funder (§ 5, steps 2–3). Nothing watches for deposits or
consolidates them into the treasury automatically — deposits are still
confirmed by a staff member reading a pasted tx hash, exactly as before this
section existed. The treasury wallet this signer pays FROM has to be funded by
hand, on a schedule, by a human, until steps 2–3 exist. "Fully automatic"
describes the withdrawal side only.

**What is proven and what is not.** `npm run test:signer` pins the exact
address and ERC-20 calldata this signer produces against a public secp256k1
test vector — the cryptography is verified. `npm run test:autowithdraw` proves
every refusal path (mode off, no key, over the ceiling, held account) never
reaches a network call. **Neither test, nor anything else in this repo, has
broadcast a real transaction.** Per the standing rule in `payout.ts`'s header
comment — unchanged by any of this — `PAYOUT_MODE` must stay `manual` until
this has been run end-to-end on BSC testnet with a funded test wallet,
including the failure cases (insufficient gas mid-send, a duplicate trigger,
an RPC endpoint going down mid-broadcast). Moving mainnet funds with code that
has never been exercised is exactly what guardrail #1/#4 exist to prevent.

**To actually turn this on, in order:**
1. Generate a NEW wallet for the treasury (not the deposit-derivation seed —
   a separate key, whose only job is holding and sending USDT/BNB).
2. Encrypt its private key locally (a script mirroring `derive-xpub.mjs`'s
   pattern will be provided when this step is reached) and set the resulting
   ciphertext + AES key as `TREASURY_KEY_ENCRYPTED` / `TREASURY_KEY_SECRET`.
3. Fund that wallet: real USDT for payouts, real BNB for gas.
4. Prove the whole path on BSC **testnet** first — testnet BNB, a testnet
   USDT-like token, real withdrawal requests, real failures induced on
   purpose.
5. Only then set `PAYOUT_MODE=onchain` on the real deployment.

---

## 6. The narrower thing that already works

For contrast, the current design (`CLAUDE.md`, "ONE CHAIN IN, ONE CHAIN OUT"):
one published treasury address, the user pastes a tx hash, a human checks the
chain and credits the amount **they** verified. No keys, no gas, no listener, no
custody, and one transaction can only ever be claimed once (unique index on
`(chain, tx_hash)`).

It is manual and it does not scale past a few dozen deposits a day. Scaling it
is a real reason to build section 5. Convenience alone is not.
