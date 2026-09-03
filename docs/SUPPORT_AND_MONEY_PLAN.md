# Founder phone review — 2026-09-03

Seven asks, from a voice memo plus eight screenshots (RupChain's support chat as
the reference design, and six `/staff` screens). This file is the checklist; the
reasoning that survives the work goes into `CLAUDE.md` when each phase lands.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[-]` deliberately
not done (with the reason on the line).

---

## Phase 1 — Support becomes one chat, not a ticket system

**The ask.** A user should tap "Help", land in a conversation with **RoziPay
Official**, type, and send. No subject line, no "create a ticket" step, no list
of past tickets to choose between. Staff see an inbox: people on the left, the
open conversation on the right, exactly like the RupChain admin screenshot.

**The constraint that shapes it.** The `support_tickets` / `ticket_messages`
tables, the staff queue, the assignment/close/rating machinery, the auto-close
timer and the `author_role <> 'internal'` filter are all correct and tested.
This is a **conversation layer over the existing tickets**, not a new table:
one user has one continuous thread, and a "ticket" becomes an invisible
*segment* of it (opened on the first message after a close, closed by staff).
Nothing about the internal-note protection or the rating rules changes.

### 1.1 Backend — the conversation endpoints
- [x] `GET /support/chat` — the whole thread for the signed-in user: every
      non-internal message across every ticket, oldest first, each carrying its
      `ticketId`; plus `segments` (id, status, closedAt, rating) so the client
      can draw "Chat closed" dividers and a rating prompt in the right place.
- [x] `POST /support/chat` — `{ message, image? }`, **no subject**. Appends to
      the user's newest non-closed ticket; if there is none, opens one and
      derives the subject from the first line of the message (trimmed to 80
      chars, "New chat" if the message is only an image).
- [x] Rating stays `POST /support/tickets/:id/rating` — unchanged rules, now
      addressed by segment id from the chat screen.
- [x] The old `/support/tickets` endpoints stay exactly as they are. The staff
      panel and `test:stage6` read them; removing them buys nothing.
- [x] Tests: first message opens a segment; second message reuses it; a message
      after a close opens a NEW segment; an internal note never appears in
      `GET /support/chat`; subject derivation from an image-only message.

### 1.2 Earner UI — `/help` is a chat screen
- [x] Full-height layout: header (avatar + "RoziPay Official" + verified tick +
      "Support & account help — we usually reply within a few hours"), a
      scrolling message area, a sticky composer.
- [x] Composer: image button on the left, one-line growing input, send button.
      Enter sends on desktop, newline on mobile.
- [x] Bubbles: user right (brand), staff left (card). Date separators
      ("09/07/2026"), "New chat" markers, "Chat closed" dividers, and the
      rating row inline where the segment closed — the RupChain layout.
- [x] Auto-scroll to the newest message on open and after sending; poll while
      the tab is visible so a reply lands without a manual refresh.
- [x] Works on desktop: the thread is width-capped and centred, not stretched.
- [x] `/profile` → "Help & support" still lands here; no route change.

### 1.3 Staff UI — a real inbox
- [x] `SupportQueuePanel` gets two views: **Inbox** (default) and **Table**.
- [x] Inbox: left column = conversations (identity, last message, time, unread
      dot, open/closed tint); right column = the thread. Desktop is two panes;
      on a narrow screen picking a row replaces the list, with a back arrow.
- [x] The thread pane is the existing `TicketThread` — reply, internal note,
      take / hand back, reopen, close all unchanged.
- [x] Table view keeps everything the DataTable already gives (search, status
      tabs, counts over ALL tickets, sort, pagination, CSV) — an inbox is
      better for answering, a table is better for auditing, and neither
      replaces the other.

---

## Phase 2 — A Telegram user is never called "Telegram user"

**The ask.** Top miners row 2 reads `Telegram user`. Show the person's Telegram
username instead — it is captured at login and it is the only identifier that
means anything for a Telegram-only account.

**What is actually wrong.** `displayIdentity()` and the top-miners SQL are both
correct and already select `telegram_username` / `telegram_name`. The row is
blank because of two real gaps:

1. `bindTelegramToUser()` (`api/src/auth.ts`) — the "Connect Telegram" path
   from the website — writes `telegram_id` and **nothing else**. Any account
   that connected that way has no username on file, forever.
2. Accounts created before the columns existed were never backfilled, and
   nothing refreshes them.

- [x] `bindTelegramToUser` takes and stores `username` / `name`, from the same
      verified payload the caller already has. Both call sites
      (`/auth/telegram/link`, `loginViaLinkCode`) pass them.
- [x] Backfill: `POST /staff/users/telegram/refresh` (admin) walks users with a
      `telegram_id` and no `telegram_username`, calls the bot API `getChat` for
      each, and stores what comes back. Capped per call, never throws — a
      Telegram outage must not 500 a staff screen.
- [x] A button for it in **Users & IDs → Users**, with the count it would touch.
- [x] Last-resort label: `displayIdentity()` returns `Telegram #<id>` instead of
      `Telegram user` when there is genuinely nothing else. An identifier a
      staff member can search for beats a category name. ⚠️ Telegram genuinely
      allows an account with no username — the fallback has to exist, it just
      has to be useful.

---

## Phase 3 — Disbursements live next to the task that owes the money

**The ask.** Clone the whole Disbursements mechanism — batches, "Waiting to be
paid", modes, run, CSV — into **Tasks & networks**, and also onto a single
task's detail page beside Overview / Metrics / Proofs / Edit. The reward is
owed *because of a task*, so paying it should be reachable from the task.

- [x] `listEligible()` takes `taskId`; `GET /staff/disbursements/eligible`
      passes it through.
- [x] `listBatches()` takes `taskId` (EXISTS over `payout_disbursements` →
      `task_proofs` → `tasks`), so a task's batches are its own.
- [x] `DisbursementsPanel` takes an optional `taskId`; every child
      (`EligiblePool`, `BatchList`) scopes to it. **One component, three mount
      points** — a second copy would drift within a week.
- [x] Mount 1: `Tasks & networks → Disbursements` (top-level sub-tab, same
      permission `disbursements.manage`).
- [x] Mount 2: a **Rewards** tab on the task detail, scoped to that task.
- [x] Mount 3: `Money & payouts → Disbursements` — unchanged, unscoped.
- [x] Storage keys for `useTableQuery` are per-mount (`disb:pool:<taskId>`), or
      a filter set on the task page leaks onto the global one.

### 3.1 A batch has a name
- [x] `payout_batches.name TEXT` (migration; existing rows keep NULL).
- [x] Auto-named at creation from what is in it: the task title when every row
      is one task ("Bitget Wallet — 1 recipient"), otherwise
      "N rewards · <date>". The raw uuid `82b5e8d6` is not a name.
- [x] `PATCH /staff/disbursements/:id` — rename, audit-logged. Inline
      rename on the batch detail; the id stays visible as a `CopyId` chip.
- [x] `listBatches` search covers `name` as well as `note` and id.

---

## Phase 4 — The treasury screen tells the truth about the money

### 4.1 One chain, with a QR
- [x] `TreasuryPanel` shows **BEP20 only**. Base and Aptos are removed from the
      screen. ⚠️ `KNOWN_CHAINS` in `chains.ts` is NOT touched — historical rows
      on those chains must keep labelling (the 2026-07-29 entry in `CLAUDE.md`
      is the whole reason that list is split from `CHAINS`). This is a display
      narrowing on one panel, nothing else.
- [x] The saved address renders as a QR code (`components/QrCode.tsx`, already
      client-side and network-free) next to the field, so a top-up can be
      scanned rather than pasted.
- [x] Copy names the coin and the network as two separate labelled facts —
      "Coin: USDT", "Network: BNB Smart Chain (BEP20)" — the same rule the
      earner deposit screen already follows, and for the same reason: BNB is a
      real token in the same wallet and an unrecoverable mistake.

### 4.2 A "Wallet" tab: every in and out of the treasury
- [x] `GET /staff/treasury/wallet` (`treasury.view`) — the treasury address's
      real on-chain movement: USDT token transfers **and** native BNB, both
      directions, newest first, each with amount, counterparty, time and hash.
- [x] Source of truth is the **chain**, read through the existing
      `api/src/bscscan.ts` (Etherscan V2, `chainid=56`) — extended with a
      `tokentx` reader. Reading our own tables would only ever show movements we
      initiated; the point of this screen is to catch the ones we did not.
- [x] Each row is annotated from our own tables where the hash matches — "USDT
      withdrawal · <user>", "deposit sweep", "refund" — so an unexplained row
      stands out by having no label.
- [-] Live balances at the top — **not built, and the panel does not claim
      one.** It shows in/out totals **over the transactions it fetched**, in
      those words. A real balance needs a second source (an RPC or an
      explorer balance call); showing a partial sum labelled "balance" would
      be a number that disagrees with the wallet.
- [x] ⚠️ **On demand only, never a poller.** This app has shipped two real
      billing incidents from background chain reads (`CLAUDE.md`, 2026-08-13
      and 2026-08-27). This is one read when a staff member opens the tab, with
      a 60s cache, exactly like `/wallet/bnb`'s history. No auto-refresh toggle.
- [x] Renders "add a `BSCSCAN_API_KEY`" rather than an error when the key is
      missing.

---

## Phase 5 — Every transaction hash is one tap from the block explorer

- [x] New `TxHash` primitive (`staff/primitives.tsx`): middle-truncated, copy,
      and an "open" link to `bscscan.com/tx/…`. `Addr` gains the same for
      addresses (`/address/…`).
- [x] One helper, `explorerTxUrl(hash, chain)` — BEP20 only today, and a chain
      it does not know gets no link rather than a wrong one.
- [x] Applied across the staff panel: withdrawals, deposits, refunds, BNB
      withdrawals, relay jobs (gas / prefund / forward), disbursement rows,
      the treasury wallet tab, and User 360's money tables.
- [x] The earner app already links out from `TxDetailSheet` — left alone.

---

## Phase 6 — "No all withdrawals" on a queue that should not be empty

- [x] Reproduce first. `GET /staff/withdrawals?status=all` has no status filter
      and no cap for an admin — if it returns nothing, `withdrawal_requests` is
      genuinely empty and the founder's transactions are **refunds** and **BNB
      sends**, which are different tables behind different tabs.
- [x] Fix the copy either way: "No all withdrawals" is wrong English on every
      tab. The empty state names where money-out actually lives.
- [x] Add an **All money out** view to the Withdrawals group: USDT withdrawals
      + USDT refunds + BNB withdrawals in one time-ordered list, each row
      labelled with which queue it belongs to. Read-only — deciding still
      happens in that rail's own tab, one click along the top. One screen
      that can answer "did anything leave?" without checking three tabs.
- [x] If a real defect is found instead, it gets its own regression test and a
      ⚠️ entry in `CLAUDE.md`.

---

## Phase 7 — Verify, then ship

- [x] `npm run typecheck` in `api` and `web`; `eslint`; `next build`.
- [x] Re-run every affected suite from a **fresh** database
      (`rm -rf api/data/pg` between suites — see the PGlite note in `CLAUDE.md`).
- [x] `security-review` — the chat endpoints (a new read path over messages)
      and the treasury read are the parts worth a second look.
- [x] `CLAUDE.md` gets one dated entry per decision that outlives the code.
- [x] Commit in phase-sized commits, push to `main`.

---

## Phase 8 — the review pass (2026-09-03, after the first commit)

An independent read of the shipped commit found real defects. Each is fixed
and, where it could be, pinned by a test.

- [x] **The chat's poll was re-downloading every attached photo, every 15
      seconds.** `ticket_messages.image` is a base64 data URL up to 2MB.
      `GET /support/chat` now takes `?since=` and serves a delta, capped at
      300 messages on a full load; the screen loads once and appends. On
      mobile data in our markets this was the most expensive line in the
      commit.
- [x] **"All money out" was broken for the `agent` role.** The tab sits under
      `withdrawals.view` (agent tier) but called the refunds endpoint, which
      needs `refunds.view` (manager tier) — one `Promise.all`, so the 403
      threw away the rows they *were* allowed to see. Refunds are now skipped
      with a line saying so. Same defect class as Finance in Stage 4.
- [x] **Two concurrent sends could open two conversations.** The read that
      picks the live segment was a plain SELECT. Serialised on the user with
      `pg_advisory_xact_lock`, the same tool guardrail #8 uses for balances.
- [x] **`formatUsdtMicro` / `formatBnbWei` already carry their unit**, and the
      new panels appended a second one — "12.00 USDT USDT" on every row of
      both new screens. `MoneyOverview.tsx` already carried a comment warning
      about exactly this.
- [x] **`TxHash`'s "never a wrong link" promise was defeated by its own
      callers.** `chain` defaults to `bep20`, and only one call site passed a
      real one. Every site now passes the row's chain.
- [x] **The thread rendered out of order after a staff reopen.** `buildRows`
      grouped by segment; staff can reopen a closed ticket, so a reply could
      render above messages sent days later, with the date separators walking
      backwards. It now walks messages in time order and derives the segment
      boundaries from them.
- [x] **A photo could be attached but not sent.** `message` was required, so
      the attach button was a trap — and § 1.1's "'New chat' if the message is
      only an image" was unreachable. Both fixed, both tested.
- [x] **The Telegram backfill could never finish and never disappeared.** No
      offset and no marker, so the first 25 accounts Telegram has nothing for
      occupied the batch forever. New `users.telegram_checked_at` records the
      attempt; the count endpoint is gated on `users.review` (not the looser
      `users.list`) so the button hides for roles that cannot press it; and
      the calls run in a small pool instead of 25 sequential 8s timeouts.
- [x] **`labelTreasuryHashes` had never executed.** Tests short-circuited on
      the missing explorer key, so five hand-written queries over five tables
      would have shipped unrun — the `networks.label` bug class. It is module
      scope and exported now, and a test drives it against real Postgres. It
      immediately caught `IN ()` on an empty list: a Postgres **syntax error**,
      guarded only at the call site.
- [x] **The treasury ledger could drop every BNB row.** Two rails were merged
      and then sliced to one limit, so 50 newer USDT transfers hid all BNB
      movement on a panel that promises both.
- [x] `Addr` gained the explorer link § 5 promised; User 360's three money
      tables now render the `tx_hash` the API had always served; the command
      palette learned the three new destinations; the withdrawals empty-state
      hint no longer overrides "no search results"; the treasury row key can
      no longer collide; `/help`'s height calc subtracts the safe-area inset.
- [x] Dead code from the rewrite removed: three API client functions with zero
      call sites and 20 orphaned copy-deck keys.

