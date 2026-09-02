# Admin-driven reward disbursement — build plan & checklist

Founder ask (2026-09-02): today the only way money leaves is a **user-filed
withdrawal request**. There is no admin-initiated "send rewards" step, no batch
disbursement, no CSV round-trip. This adds that layer.

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| A | What "send a reward" does | **Both — admin picks per batch.** `balance` (credit in-app) is the default; `onchain` / `manual` / `csv` also supported. |
| B | Destination address for an admin push | **In-app balance needs none.** For `onchain`/`manual`/`csv` the destination falls back to the user's **saved payout address**; a recipient with none is marked `needs_address` and skipped — it never blocks the rest of the batch. No new forced address-collection step. |
| C | Modes in scope | All four: bulk "send all", admin one-by-one, manual + tx hash, CSV export→pay→re-upload. |

## Architecture — maximise reuse

A **batch** groups **disbursements** (one row per recipient). Eligible items are
approved-but-unreleased custom-task proofs (`task_proofs.reward_status='pending'`)
— the existing two-step release mechanism, made batchable. Network-postback
credits (CPX etc.) are **untouched** — they must keep crediting immediately or the
earn→withdraw loop breaks.

- **`balance` mode** — per recipient, run the existing `releaseProof()` /
  `creditCompletion()` path under `lockUser()`. This is "bulk release". Default,
  zero gas, zero treasury, instant, safe.
- **`onchain` mode** — release to balance, then create a `withdrawal_request`
  (`source_kind='earned_usdt'`) to the user's saved address and let the existing
  `tryAutoSettle()` → relay / provider machinery run. Reuses fees, 24h cap, hold,
  KYC gate, step-up — all of it.
- **`manual` mode** — same as `onchain` but the withdrawal_request is left in the
  manual Agent→Manager queue (no auto-settle); staff mark it paid with a tx hash.
- **`csv` mode** — same as `manual`, plus an export of `{disbursementId, email,
  chain, address, usdtAmount}` and a re-upload of `{disbursementId, txHash}` that
  reconciles rows and flags mismatches. CSV is parsed to JSON **client-side** — no
  multipart dependency added.

Every per-recipient action is **N independent decisions**, never one transaction:
one blocked user (velocity cap, budget exhausted, missing address) must not undo
the others.

## New DB objects (in `api/src/db.ts`, migration block, after `earned_usdt_ledger`)

- `payout_batches(id, mode, status, source, note, created_by, created_at,
  completed_at, count_total, points_total, usdt_micro_total)`
  status ∈ draft | processing | completed | partly_failed | cancelled
- `payout_disbursements(id, batch_id, user_id, proof_id, amount_points,
  usdt_micro, rozi_micro, source_kind, dest_chain, dest_address, status, tx_hash,
  error, withdrawal_request_id, created_at, settled_at)`
  status ∈ pending | needs_address | released | sending | paid | failed | skipped
  UNIQUE(batch_id, user_id) — idempotency.

## New permission

`disbursements.manage` (W, tier `admin`). Added to roles: `admin`, `finance`,
`operations`. `test:permissions` expectations updated.

---

## Phases

### Phase 0 — schema + core module + permission ✅
- [x] 0.1 `payout_batches` + `payout_disbursements` tables, indexes, CHECKs, appended to `MIGRATIONS`
- [x] 0.2 `disbursements.manage` permission (W/admin) + `finance` role + `test:permissions` case
- [x] 0.3 `api/src/disbursements.ts` — types, `listEligible()`, `createBatch()`, `recomputeBatchTotals()`, `listBatches()`/`getBatch()`/`getDisbursements()`. `releaseProof` exported from `staffTasks.ts` for reuse.
- [x] 0.4 config: `disbursementMaxRecipients` (default 500)
- [x] **Cross-check 0** — api `tsc --noEmit` clean; `test:permissions` 17/17; fresh-DB boot creates both tables

### Phase 1 — balance mode (bulk + one-by-one), the default ✅
- [x] 1.1 `runBalanceRow()` — claim row → `releaseProof()` → stamp row (`released`/`failed`)
- [x] 1.2 `POST /staff/disbursements` (selected proof ids or `allEligible`, with `mode`)
- [x] 1.3 `POST /staff/disbursements/:id/run` — loop rows, per-row outcome, `recomputeBatchTotals()` roll-up, audit
- [x] 1.4 `GET /staff/disbursements`, `GET /staff/disbursements/:id`, `GET /staff/disbursements/eligible`, `POST /staff/disbursements/:id/cancel`
- [x] 1.5 `POST /staff/disbursements/quick` — one recipient, balance mode
- [x] 1.6 `api/src/tests/disbursements.e2e.ts` — 32 checks: pool, gating, create/run, idempotency (409 on completed, no double credit, proof can't rejoin), per-row isolation, partly_failed retry, quick send, cancel, audit
- [x] **Cross-check 1** — new suite 32/32; `test:stage7` 96/96; `test:tasksadmin` 57/57; `test:permissions` 17/17; api `tsc` clean

### Phase 2 — on-chain / manual mode ✅
- [x] 2.1 `runPayoutRow` — release → (points/ROZI-only ⇒ `released`) → saved address (`needs_address` if none) → create `withdrawal_request` (`source_kind='earned_usdt'`) + hold USDT under `pg_advisory_xact_lock` → `onchain`: `tryAutoSettle()`; `manual`/`csv`: leave in the queue
- [x] 2.2 `syncBatchFromRequests()` — pulls withdrawal-queue outcomes back onto the disbursement (`paid`→`paid`+hash, `rejected`→`failed`); called on `/run` and detail read
- [x] 2.3 `runBatch` dispatches on `batch.mode`
- [x] 2.4 **Related fix**: `payoutRelay.failJob` credited **points** back for a failed `earned_usdt` withdrawal — wrong ledger. Now branches on `source_kind` (mirrors `staff.ts` reject). Regression test added.
- [x] 2.5 tests — 16 new checks: needs_address up-front + on run, request created with right currency/amount/address, decision-B (unaddressed keeps balance), re-run picks up newly-addressed, sync paid/rejected, batch roll-up, failJob currency regression
- [x] **Cross-check 2** — disbursements 48/48; `test:payoutrelay` 48; `test:autowithdraw` 16; `test:autorefund` 8; `test:usdt` 85; `test:wallet` 52; `test:withdrawcontrols` 21; `test:moneyadmin` 82; `test:fees` 24; api `tsc` clean

### Phase 3 — manual + tx hash ✅
- [x] 3.1 `POST /staff/disbursements/:id/rows/:rid/mark-paid` `{txHash}` — `looksLikeTxHash` gate, refuses a live relay job, stamps `withdrawal_request` + disbursement `paid` in one tx, push after commit, audit
- [x] 3.2 The bulk path is `POST …/reconcile` (Phase 4) — a plain bulk `/mark-paid` was built then removed in the final cross-check as redundant with reconcile (same loop, poorer report)
- [x] 3.3 tests — bad hash, happy path (both rows stamped), double-pay refused
- [x] **Cross-check 3** — disbursements green; `test:moneyadmin` 82; `test:stage7` 96; `test:permissions` 17; api `tsc` clean

### Phase 4 — CSV round-trip ✅
- [x] 4.1 `GET /staff/disbursements/:id/export` → `text/csv` (`disbursement_id,user_email,chain,address,usdt_amount,status`), injection-safe cell escaper
- [x] 4.2 `POST /staff/disbursements/:id/reconcile` `{rows:[{disbursementId,txHash}]}` → `{paid, unknown, notPayable, badHash}` report; dupes collapsed; audited
- [x] 4.3 `web/src/lib/csv.ts` — `parseCsv` / `parseCsvRecords` / `reconcileRowsFromCsv` (quotes, `""` escape, CRLF, BOM, header-spelling tolerance)
- [x] 4.4 tests — 10 checks: export headers/row-count/content-type, reconcile good+dup+unknown+bad-hash, paid row stamped, bad-hash row untouched, re-reconcile → notPayable, audited
- [x] **Cross-check 4** — disbursements 66/66; parser sanity-checked; api `tsc` clean

### Phase 5 — frontend ✅
- [x] 5.1 `disbursements.manage` in web `UiPermission`; added to `money` section `needs`
- [x] 5.2 `web/src/components/staff/Disbursements.tsx` — `DisbursementsPanel` (Batches / Waiting-to-be-paid tabs), eligible pool on `DataTable` w/ bulk "Add to a new batch" + mode picker + "Batch everything eligible", batch list on `DataTable`, `BatchDetail` on `DetailLayout` (Run / Cancel / Export CSV / Upload tx hashes / per-row Mark paid), `RefreshBar` polling
- [x] 5.3 `web/src/lib/api.ts` — 11 client fns + types; `web/src/lib/csv.ts` reconcile parser
- [x] 5.4 `p-disbursements` panel in `SECTION_PANELS.money` (need `disbursements.manage`)
- [x] 5.5 User 360 `WaitingRewards` card + one-click "Send now" (`canDisburse` threaded from `page.tsx`); staff-search "Reward disbursements" destination
- [x] **Cross-check 5** — web `tsc` clean; eslint 0 errors (7 pre-existing `<img>` warnings); `next build` clean (24 routes)

### Phase 6 — final in-depth cross-check + commit ✅
- [x] 6.1 Full backend matrix from a fresh DB (`rm -rf api/data/pg` between suites) — **36 suites green** (disbursements 65, + every other e2e + 6 unit); api `tsc` clean; web `tsc` + eslint (0 errors) + `next build` clean
- [x] 6.2 `security-review` on the branch diff — **no HIGH/MEDIUM findings** (SQLi: all bound params, no dynamic ORDER BY; authz: all routes `disbursements.manage`; double-spend: advisory lock + conditional claims; CSV injection: shared cell escaper; header injection: UUID-only reaches the filename)
- [x] 6.3 Guardrail re-read: #8 `pg_advisory_xact_lock(hashtext(userId))` in `runPayoutRow` step 4; #2 all money via `postLedger`/`postEarnedUsdt`/`releaseProof`; idempotency (`payout_disbursements_one_per_proof`, claim UPDATE, `proof:<id>` completion key, 409 on completed batch); every route audited; push after commit in `markRowPaid`; saved-address-only; per-row isolation
- [x] 6.4 Disconnection sweep — **found + fixed 3**:
  - dead `GET /staff/disbursements-modes` (no caller, frontend hard-codes the enum) → **removed**
  - redundant bulk `POST …/mark-paid` (superseded by `/reconcile`) → **removed** with its test
  - **orphan bug**: a row processor that *throws* (vs returns `{ok:false}`) left the row stuck at `'sending'`, invisible to every future run (`'sending' ∉ RUNNABLE`) → added a per-row `try/catch` in `runBatch` **and** an "orphan recovery" pass (`status='sending' AND withdrawal_request_id IS NULL` → `'pending'`); regression test added
  - every `api.ts` export has ≥1 call site; every remaining endpoint reachable from the UI; nav + permission + staff-search wired; migration appended after `task_proofs` in `MIGRATIONS`, idempotent, fresh-boot verified
- [x] 6.5 Update `CLAUDE.md` build-status + tick this file
- [x] 6.6 `git commit` + push `feat/admin-disbursements`

## Endpoints (all `staffGuard("disbursements.manage")` → admin / finance)

| Method | Path | Purpose |
|---|---|---|
| GET | `/staff/disbursements/eligible` | approved rewards awaiting release (`q`, `userId`, paging) |
| POST | `/staff/disbursements` | create a batch (`mode`, `proofIds[]` or `allEligible`) |
| GET | `/staff/disbursements` | list batches |
| GET | `/staff/disbursements/:id` | batch + recipient rows (syncs from the withdrawal queue) |
| POST | `/staff/disbursements/:id/run` | process runnable rows (per mode) |
| POST | `/staff/disbursements/:id/cancel` | cancel a batch that has paid nothing; frees its proofs |
| POST | `/staff/disbursements/quick` | one recipient, balance mode, create + run |
| POST | `/staff/disbursements/:id/rows/:rid/mark-paid` | record an external payment `{txHash}` |
| GET | `/staff/disbursements/:id/export` | CSV of recipients + addresses |
| POST | `/staff/disbursements/:id/reconcile` | upload `{rows:[{disbursementId,txHash}]}` → paid / unknown / notPayable / badHash report |
