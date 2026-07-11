# Founder Launch Checklist — what only YOU can collect

The app is built and verified. What stands between it and real users is a set of
**accounts, keys, and approvals that only you (the founder) can obtain** — a
non-interactive Claude session cannot create third-party accounts or run OAuth
flows. This is the single to-do list. Work top to bottom; the first three are the
real launch blockers.

Legend: 🔴 launch blocker · 🟡 strongly recommended · ⚪ optional

---

## 🔴 1. Sign up with a real ad network (no offers = no product)

`offerhub`, `tapvid`, `surveyx` in the code are **adapters built to a spec**, not
live accounts. Until a real network is connected there are no offers to show and
no revenue. Pick at least one offerwall to start.

**Networks that accept publishers in PK/IN/BD/ID/NG and pay by postback:**
- **AdGate Media**, **Ayet-Studios**, **BitLabs** (surveys), **OfferToro / Torox**,
  **AdGem**, **CPX Research** (surveys), **Pollfish**.

**Steps:**
1. Apply as a **publisher/app owner**. You'll describe the app (rewarded offerwall,
   web app on Vercel). Approval can take a few days.
2. In their dashboard, get: your **publisher/app ID**, and their **postback
   (server-to-server) secret / signing key**.
3. Set their **postback URL** to our endpoint:
   `https://paidup-production-a25f.up.railway.app/webhooks/<network>` (the network
   id, e.g. `/webhooks/offerhub`). I'll confirm the exact path when we wire the
   real adapter.
4. Give me the network's **signature scheme** (what they sign, which header/param
   holds the HMAC). I map it to an adapter file — that's the only code step left.
5. Set the secret on Railway as `POSTBACK_SECRET_<NETWORK>` **before** the deploy
   (the API fail-fasts on boot if a network's secret is still a default).

> Tell me which network you're approved on and paste their postback docs — I'll
> build the matching adapter and a smoke test in one session.

---

## 🔴 2. Resend account + verified email domain (no email = nobody can log in)

Without `RESEND_API_KEY`, signup codes only print to the Railway logs — real users
never receive them.

**Steps:**
1. Create an account at **resend.com** (free tier is enough to start).
2. **Verify a domain** you own (add the DNS records Resend shows). Gmail/personal
   addresses cannot be senders. `onboarding@resend.dev` only mails your own Resend
   account, so it's not usable for real users.
3. Create an **API key**.
4. On **Railway** set:
   - `RESEND_API_KEY=<the key>`
   - `EMAIL_FROM=login@<your-verified-domain>`
5. Redeploy. The API refuses to boot if `EMAIL_FROM` is still the `@paidup.app`
   default, so this is enforced.

> You already have `login@creatorxbot.site` noted in DEPLOY.md — if that domain is
> verified in Resend, you only need the API key.

---

## 🔴 3. Fund a USDT treasury wallet (no wallet = nobody gets paid)

v1 payouts are **manual and approval-gated** (a non-goal is automated payout in
v1). An admin approves a withdrawal, sends USDT from the treasury wallet, and now
**pastes the on-chain transaction hash** to mark it paid — the user sees that hash
as proof. (This is the new payout flow I just built; see below.)

**Steps:**
1. Create/choose a **hot wallet** you control on the chains you'll support
   (BEP20 / Polygon / Base — all EVM, one address; plus Aptos if you offer it).
2. **Fund it** with USDT + a little native gas token (BNB / MATIC / ETH) on each
   chain.
3. Decide the **points → USDT rate** and tell me. Default in code is
   `POINTS_PER_USDT=1000` (1000 points = 1 USDT). Set the real number on Railway.
4. That's it for manual mode. When you later want the API to **auto-send** on
   approval, we first prove it on a **testnet**, then set `PAYOUT_MODE=onchain` +
   `PAYOUT_SIGNER_KEY` + `RPC_*`. The on-chain sender is scaffolded but
   deliberately disabled until tested — moving mainnet funds with untested code is
   exactly what the guardrails forbid.

---

## 🟡 4. Authorize Sentry (error monitoring before you have real users)

Blocked from my side: it needs an **OAuth flow** I can't run in a non-interactive
session.

**Steps:** Open **claude.ai → Settings → Connectors**, authorize the **Sentry**
connector. Once done, tell me and I'll wire error monitoring into the API + web.

---

## ⚪ 5. Custom domain (optional, nicer than *.vercel.app)

Currently `paid-up-one.vercel.app`. If you want `paidup.app` (or similar):
1. Tell me the name — I can check availability via the GoDaddy/Vercel tools.
2. Buy it, then add it in **Vercel → Project → Domains** and point DNS.
3. Update `WEB_ORIGIN` (Railway) and `NEXT_PUBLIC_API_URL` if the API domain moves.

---

## ⚪ 6. Telegram login (optional cheaper-than-email fallback)

Only if email hurts signup. Off until configured.
1. Create a bot via **@BotFather**, get its token.
2. BotFather `/setdomain` → your web origin.
3. Railway `TELEGRAM_BOT_TOKEN=<token>`; Vercel `NEXT_PUBLIC_TELEGRAM_BOT=<username>`
   and redeploy with build cache off.

---

## What I already built this session (so the above plugs straight in)

- **USDT payout settlement flow** (`api/src/payout.ts`): manual mode is live —
  marking a withdrawal paid now records the on-chain **tx hash** and the computed
  **USDT amount** as proof of payment; the on-chain auto-send is scaffolded and
  config-gated for later. The staff panel now prompts for the hash on "Mark paid".
- **New fraud rule** `payout_address_reuse`: flags (never blocks) when 3+ accounts
  cash out to the same wallet — the classic account-farm signal.
- **Urdu localization foundation** (Phase 3): language toggle (English / اردو),
  RTL support, and the Home/Tasks screen + bottom nav translated. More screens to
  follow.

All verified: typecheck (api + web), web production build, payout unit tests,
fraud DB test, and a security review — all clean.
