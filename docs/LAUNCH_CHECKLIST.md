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
   (BEP20 / Base — both EVM, one address; plus Aptos if you offer it. Polygon
   was dropped from the withdraw screen).
2. **Fund it** with USDT + a little native gas token (BNB / ETH / APT) on each
   chain.
3. Decide the **points → USDT rate** and tell me. Default in code is
   `POINTS_PER_USDT=1000` (1000 points = 1 USDT). Set the real number on Railway.
4. That's it for manual mode. When you later want the API to **auto-send** on
   approval, we first prove it on a **testnet**, then set `PAYOUT_MODE=onchain` +
   `PAYOUT_SIGNER_KEY` + `RPC_*`. The on-chain sender is scaffolded but
   deliberately disabled until tested — moving mainnet funds with untested code is
   exactly what the guardrails forbid.

---

## 🔴 3b. Set the KYC encryption key (or ID uploads will not boot in prod)

We now collect a selfie + both sides of a national ID card and store the photos
**AES-256-GCM encrypted**. The key lives only in the environment, never in the
database, so a leaked DB backup alone decrypts to nothing. Production **refuses to
boot** without a real key — deliberately, because encrypting real IDs under the
public dev key (it is in the git history) would only *look* safe.

**Steps:**
1. Generate a key:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. On **Railway** set `KYC_ENCRYPTION_KEY=<the 64-hex-char output>`.
3. ⚠️ **Back this key up somewhere safe and never rotate it casually.** If it is
   lost, every stored ID photo is unrecoverable and every user must re-verify.

> KYC gates three things: withdrawals (you must know who you pay), referral
> earnings, and the mining halving count — so a farm of fake signups can no longer
> inflate a referrer or drag everyone through a halving. Set
> `KYC_REQUIRED_FOR_WITHDRAWAL=false` only if you deliberately want to allow
> unverified cash-out (not recommended).

---

## ✅ 3c. Monetag account + zones (the website ad revenue you chose)

**Account is live (2026-07-17): site 3411999 (`rozipay.xyz`) verified via meta
tag.** One important discovery from the real account: Monetag's **Rewarded
Interstitial (the `show_zone()` SDK with a "user finished watching" promise) is
Telegram-Mini-App-only** — a website account does not get it. The app therefore
uses the formats a website actually gets:

- **Vignette zone** (`11331636`, created) — the full-screen ad around the
  "Start mining" tap. Passive, no completion signal, so it grants **no boost**;
  it is the impression revenue on session starts.
- **Direct Link zone** — powers the "watch an ad, mine faster" button: the ad
  opens in a new tab, the server's nonce + minimum-watch timer + daily cap decide
  the boost. Same server-side teeth as before; only the ad surface changed.
- **In-Page Push zone (the "banner", 2026-07-18)** — a small dismissible bar
  Monetag floats over the **/mine screen only** (never wallet/login/withdraw —
  an ad there reads as part of the product). Passive impressions, no boost.

All remain **soft**: an ad blocker or empty fill never stops mining or breaks a
streak.

**Remaining steps:**
1. Create a **Direct Link** zone in the Monetag dashboard; copy its **URL**.
2. Create an **In-Page Push** zone; copy its **zone id**. If the tag Monetag
   generates uses a different script host than `n6wxm.com/tag.min.js`, tell
   Claude the tag so the constant in `web/src/lib/ads.ts` can be matched.
3. In **/staff → Mining** set `adProvider = monetag`,
   `monetagZoneId = 11331636`, `monetagDirectLink = <the URL>`,
   `monetagBannerZone = <the zone id>`, and `adsEnabled = 1`. (Flag + provider
   are both needed; each empty Monetag value disables its own part.)
4. ⚠️ **Read Monetag's terms on incentivised/rewarded traffic first.** We are not
   paying cash to watch an ad — we unlock mining, and ROZI has no fixed cash value
   by design — but confirm their policy before you rely on the revenue.
5. When testing, turn **off** your VPN and DNS ad-blocking: Monetag serves by
   the visitor's country, VPN/datacenter IPs often get zero fill or junk fill,
   and your own DNS blocks Monetag hosts entirely (the code fails open, so you
   see "nothing happened", not an error).

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

## 🟢 6. Telegram — login DONE, Mini App built (2026-07-18)

The founder created the bot and its token is set on Railway
(`TELEGRAM_BOT_TOKEN`). The old Vercel `NEXT_PUBLIC_TELEGRAM_BOT` step is
**gone**: the web app now asks the API which bot to use
(`GET /auth/telegram/config`, backed by getMe), so there is nothing to
configure on Vercel and no cache-off redeploy.

**The site is also a Telegram Mini App now** — same codebase; inside Telegram
it signs the user in automatically from the webview's signed `initData`
(`POST /auth/telegram/miniapp`), hides the install prompt, and can play
Monetag's REAL rewarded video (the Telegram-only format) for the mining boost.
Referrals ride `?startapp=<code>` inside the signed payload.

**Founder steps left (all in Telegram, needs VPN on this network):**
1. BotFather → `/setdomain` → `rozipay.xyz` (turns on the login-widget button).
2. BotFather → `/newapp` (choose the bot) → Web App URL `https://rozipay.xyz`
   → pick a short name. Share link becomes `t.me/<bot>/<shortname>`; referral
   links are `t.me/<bot>/<shortname>?startapp=<REFCODE>`.
3. BotFather → `/setmenubutton` → same URL, so the bot's menu button opens the
   app.
4. (For real video ads) Monetag dashboard → create a **Rewarded Interstitial**
   zone for the Telegram Mini App → paste its id into `/staff → Mining →
   monetagRewardedZone`. In a normal browser the boost button keeps using the
   direct link; inside Telegram it plays the video.

---

## What I already built this session (so the above plugs straight in)

- **USDT payout settlement flow** (`api/src/payout.ts`): manual mode is live —
  marking a withdrawal paid now records the on-chain **tx hash** and the computed
  **USDT amount** as proof of payment; the on-chain auto-send is scaffolded and
  config-gated for later. The staff panel now prompts for the hash on "Mark paid".
- **New fraud rule** `payout_address_reuse`: flags (never blocks) when 3+ accounts
  cash out to the same wallet — the classic account-farm signal.
- ~~**Urdu localization**~~ — **dropped by the founder on 2026-07-12** and removed
  from the code. The app is **English only**, in deliberately simple English;
  phones translate for anyone who wants it. Every user-facing string now lives in
  one copy deck (`web/src/lib/i18n.tsx`) so the wording can be reviewed in a
  single pass. **Nothing to collect for this — it is a decision, not a blocker.**

All verified: typecheck (api + web), web production build, payout unit tests,
fraud DB test, and a security review — all clean.
