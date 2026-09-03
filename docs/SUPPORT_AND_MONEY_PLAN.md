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
- [ ] `GET /support/chat` — the whole thread for the signed-in user: every
      non-internal message across every ticket, oldest first, each carrying its
      `ticketId`; plus `segments` (id, status, closedAt, rating) so the client
      can draw "Chat closed" dividers and a rating prompt in the right place.
- [ ] `POST /support/chat` — `{ message, image? }`, **no subject**. Appends to
      the user's newest non-closed ticket; if there is none, opens one and
      derives the subject from the first line of the message (trimmed to 80
      chars, "New chat" if the message is only an image).
- [ ] Rating stays `POST /support/tickets/:id/rating` — unchanged rules, now
      addressed by segment id from the chat screen.
- [ ] The old `/support/tickets` endpoints stay exactly as they are. The staff
      panel and `test:stage6` read them; removing them buys nothing.
- [ ] Tests: first message opens a segment; second message reuses it; a message
      after a close opens a NEW segment; an internal note never appears in
      `GET /support/chat`; subject derivation from an image-only message.

### 1.2 Earner UI — `/help` is a chat screen
- [ ] Full-height layout: header (avatar + "RoziPay Official" + verified tick +
      "Support & account help — we usually reply within a few hours"), a
      scrolling message area, a sticky composer.
- [ ] Composer: image button on the left, one-line growing input, send button.
      Enter sends on desktop, newline on mobile.
- [ ] Bubbles: user right (brand), staff left (card). Date separators
      ("09/07/2026"), "New chat" markers, "Chat closed" dividers, and the
      rating row inline where the segment closed — the RupChain layout.
- [ ] Auto-scroll to the newest message on open and after sending; poll while
      the tab is visible so a reply lands without a manual refresh.
- [ ] Works on desktop: the thread is width-capped and centred, not stretched.
- [ ] `/profile` → "Help & support" still lands here; no route change.

### 1.3 Staff UI — a real inbox
- [ ] `SupportQueuePanel` gets two views: **Inbox** (default) and **Table**.
- [ ] Inbox: left column = conversations (identity, last message, time, unread
      dot, open/closed tint); right column = the thread. Desktop is two panes;
      on a narrow screen picking a row replaces the list, with a back arrow.
- [ ] The thread pane is the existing `TicketThread` — reply, internal note,
      take / hand back, reopen, close all unchanged.
- [ ] Table view keeps everything the DataTable already gives (search, status
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

- [ ] `bindTelegramToUser` takes and stores `username` / `name`, from the same
      verified payload the caller already has. Both call sites
      (`/auth/telegram/link`, `loginViaLinkCode`) pass them.
- [ ] Backfill: `POST /staff/users/telegram/refresh` (admin) walks users with a
      `telegram_id` and no `telegram_username`, calls the bot API `getChat` for
      each, and stores what comes back. Capped per call, never throws — a
      Telegram outage must not 500 a staff screen.
- [ ] A button for it in **Users & IDs → Users**, with the count it would touch.
- [ ] Last-resort label: `displayIdentity()` returns `Telegram #<id>` instead of
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

- [ ] `listEligible()` takes `taskId`; `GET /staff/disbursements/eligible`
      passes it through.
- [ ] `listBatches()` takes `taskId` (EXISTS over `payout_disbursements` →
      `task_proofs` → `tasks`), so a task's batches are its own.
- [ ] `DisbursementsPanel` takes an optional `taskId`; every child
      (`EligiblePool`, `BatchList`) scopes to it. **One component, three mount
      points** — a second copy would drift within a week.
- [ ] Mount 1: `Tasks & networks → Disbursements` (top-level sub-tab, same
      permission `disbursements.manage`).
- [ ] Mount 2: a **Rewards** tab on the task detail, scoped to that task.
- [ ] Mount 3: `Money & payouts → Disbursements` — unchanged, unscoped.
- [ ] Storage keys for `useTableQuery` are per-mount (`disb:pool:<taskId>`), or
      a filter set on the task page leaks onto the global one.

### 3.1 A batch has a name
- [ ] `payout_batches.name TEXT` (migration; existing rows keep NULL).
- [ ] Auto-named at creation from what is in it: the task title when every row
      is one task ("Bitget Wallet — 1 recipient"), otherwise
      "N rewards · <date>". The raw uuid `82b5e8d6` is not a name.
- [ ] `PATCH /staff/disbursements/batches/:id` — rename, audit-logged. Inline
      rename on the batch detail; the id stays visible as a `CopyId` chip.
- [ ] `listBatches` search covers `name` as well as `note` and id.

---

## Phase 4 — The treasury screen tells the truth about the money

### 4.1 One chain, with a QR
- [ ] `TreasuryPanel` shows **BEP20 only**. Base and Aptos are removed from the
      screen. ⚠️ `KNOWN_CHAINS` in `chains.ts` is NOT touched — historical rows
      on those chains must keep labelling (the 2026-07-29 entry in `CLAUDE.md`
      is the whole reason that list is split from `CHAINS`). This is a display
      narrowing on one panel, nothing else.
- [ ] The saved address renders as a QR code (`components/QrCode.tsx`, already
      client-side and network-free) next to the field, so a top-up can be
      scanned rather than pasted.
- [ ] Copy names the coin and the network as two separate labelled facts —
      "Coin: USDT", "Network: BNB Smart Chain (BEP20)" — the same rule the
      earner deposit screen already follows, and for the same reason: BNB is a
      real token in the same wallet and an unrecoverable mistake.

### 4.2 A "Wallet" tab: every in and out of the treasury
- [ ] `GET /staff/treasury/wallet` (`treasury.view`) — the treasury address's
      real on-chain movement: USDT token transfers **and** native BNB, both
      directions, newest first, each with amount, counterparty, time and hash.
- [ ] Source of truth is the **chain**, read through the existing
      `api/src/bscscan.ts` (Etherscan V2, `chainid=56`) — extended with a
      `tokentx` reader. Reading our own tables would only ever show movements we
      initiated; the point of this screen is to catch the ones we did not.
- [ ] Each row is annotated from our own tables where the hash matches — "USDT
      withdrawal · <user>", "deposit sweep", "refund" — so an unexplained row
      stands out by having no label.
- [ ] Live balances (USDT + BNB) at the top.
- [ ] ⚠️ **On demand only, never a poller.** This app has shipped two real
      billing incidents from background chain reads (`CLAUDE.md`, 2026-08-13
      and 2026-08-27). This is one read when a staff member opens the tab, with
      a 60s cache, exactly like `/wallet/bnb`'s history. No auto-refresh toggle.
- [ ] Renders "add a `BSCSCAN_API_KEY`" rather than an error when the key is
      missing.

---

## Phase 5 — Every transaction hash is one tap from the block explorer

- [ ] New `TxHash` primitive (`staff/primitives.tsx`): middle-truncated, copy,
      and an "open" link to `bscscan.com/tx/…`. `Addr` gains the same for
      addresses (`/address/…`).
- [ ] One helper, `explorerTxUrl(hash, chain)` — BEP20 only today, and a chain
      it does not know gets no link rather than a wrong one.
- [ ] Applied across the staff panel: withdrawals, deposits, refunds, BNB
      withdrawals, relay jobs (gas / prefund / forward), disbursement rows,
      the treasury wallet tab, and User 360's money tables.
- [ ] The earner app already links out from `TxDetailSheet` — left alone.

---

## Phase 6 — "No all withdrawals" on a queue that should not be empty

- [ ] Reproduce first. `GET /staff/withdrawals?status=all` has no status filter
      and no cap for an admin — if it returns nothing, `withdrawal_requests` is
      genuinely empty and the founder's transactions are **refunds** and **BNB
      sends**, which are different tables behind different tabs.
- [ ] Fix the copy either way: "No all withdrawals" is wrong English on every
      tab. The empty state names where money-out actually lives.
- [ ] Add an **All money out** view to the Withdrawals group: USDT withdrawals
      + USDT refunds + BNB withdrawals in one time-ordered list, each row
      labelled with which queue it belongs to and linking into it. One screen
      that can answer "did anything leave?" without checking three tabs.
- [ ] If a real defect is found instead, it gets its own regression test and a
      ⚠️ entry in `CLAUDE.md`.

---

## Phase 7 — Verify, then ship

- [ ] `npm run typecheck` in `api` and `web`; `eslint`; `next build`.
- [ ] Re-run every affected suite from a **fresh** database
      (`rm -rf api/data/pg` between suites — see the PGlite note in `CLAUDE.md`).
- [ ] `security-review` — the chat endpoints (a new read path over messages)
      and the treasury read are the parts worth a second look.
- [ ] `CLAUDE.md` gets one dated entry per decision that outlives the code.
- [ ] Commit in phase-sized commits, push to `main`.
