# Founder Launch Checklist — what only YOU can collect

The app is built and verified. What stands between it and real users is a set of
**accounts, keys, and approvals that only you (the founder) can obtain** — a
non-interactive Claude session cannot create third-party accounts or run OAuth
flows. This is the single to-do list. Work top to bottom; the first three are the
real launch blockers.

Legend: 🔴 launch blocker · 🟡 strongly recommended · ⚪ optional

---

## 🔴 1. Sign up with more ad networks (CPX alone = surveys only)

**Status: CPX Research is LIVE** (app id 34405) — real surveys, real postbacks,
real revenue. That unblocked the product. But CPX sells **surveys only**, and its
inventory is thin and swings hard (measured 5 surveys one minute, 1 the next). One
survey network is not a business.

`offerhub`, `tapvid`, `surveyx` in the code are **adapters written to an imagined
spec with no account behind them**. They can never pay a user. Don't count them,
and don't seed their demo tasks into production (the seed no longer does).

**To get installs, game offers and rewarded video, sign up for these** (all work
on a web app — no Android SDK needed):

| Network | Gives you | Why |
|---|---|---|
| **AdGate Media** | app installs, play-to-level game offers, sign-ups, surveys | Best single addition. Strong PK/South-Asia fill, web iframe wall, clean S2S docs. |
| **AyeT Studios** | offerwall **+ real rewarded video** | The legitimate "watch videos for points". Good South Asia coverage. |
| **BitLabs** | surveys | Second survey source, to cover CPX's supply gaps. Adds no task variety. |
| **Lootably / Torox** | installs, games, video | Fallback — they approve new/small publishers more readily if AdGate says no. |

> ⚠️ **Do not pay users to watch YouTube videos.** Incentivised views violate
> YouTube's Terms of Service and can get the site banned and a payment processor
> pulled. "Watch video, earn points" must come from a **rewarded-video ad network**
> (AyeT), where the ads themselves are the videos.

**For each network, collect exactly these four things and send them to me:**

1. **App / publisher ID.**
2. **Postback secret / signing key** (their "secure hash", "postback key", etc.).
3. **Their postback signature scheme** — what string they sign, with which
   algorithm, and which parameter carries the signature. Paste their postback doc
   page; that is what I turn into an adapter.
4. **The reward conversion rate** you set in their dashboard.

**Set their postback URL to (exact path — a wrong path silently drops every
conversion and users never get paid):**

```
https://paidup-production-a25f.up.railway.app/webhooks/<network>/postback
```

e.g. `/webhooks/adgate/postback`, `/webhooks/ayet/postback`,
`/webhooks/bitlabs/postback`, `/webhooks/lootably/postback`.

**Enforce the 60/40 split in THEIR dashboard**, the way CPX does it. CPX's Reward
Settings say `1 USD = 600 points`, so CPX pays us $1 → the user gets 600 points
(= $0.60) → we keep $0.40. Since our rate is **1000 points = 1 USDT**, the rule for
any network is:

> **set the dashboard rate to `1 USD = 600 points`.**

Then set the secret on Railway as `POSTBACK_SECRET_<NETWORK>` **before** deploying
(the API fail-fasts on boot if a live network's secret is still a default).

> Send me the four items above for a network and I'll build the adapter + an
> end-to-end smoke test (accept, replay, forged-signature, reversal) in one
> session. Adding a network is one adapter file + one registry line — the ledger,
> fraud layer, referral payouts and postback plumbing are already network-agnostic.
> **I will not write another adapter without real credentials** — that is precisely
> how offerhub/tapvid/surveyx became dead code.

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
5. Redeploy. The API refuses to boot if `EMAIL_FROM` is still the
   `@rozipay.invalid` sentinel default, so this is enforced.

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

## 🟡 5. Point the domain — `rozipay.xyz` (chosen, final)

The app currently serves from `paid-up-one.vercel.app`. To move it to **rozipay.xyz**:
1. Buy/own `rozipay.xyz`, then add it in **Vercel → Project → Domains**.
2. Add the DNS records Vercel shows (at your registrar) and wait for it to verify.
3. Set `WEB_ORIGIN=https://rozipay.xyz` on **Railway** (so CORS accepts the new
   origin), and redeploy the API.
4. Leave `NEXT_PUBLIC_API_URL` pointing at the Railway API URL unless you also
   move the API to a custom subdomain (e.g. `api.rozipay.xyz`).

> Trust note: `.xyz` reads as less trustworthy for a money app. Consider adding
> `rozipay.app` or `rozipay.pk` later and redirecting — your referral growth
> depends on looking legitimate.

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
