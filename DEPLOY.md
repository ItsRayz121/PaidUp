# Deploying RoziPay

> **Brand:** the app is **RoziPay**, domain **rozipay.xyz** (final). The Vercel
> project slug (`paid-up-one`) and the live Vercel/Railway hostnames below are the
> *existing* deploy targets and are unchanged — renaming the brand does not move
> the infrastructure. To actually serve the app from `rozipay.xyz`, add it as a
> custom domain in Vercel and update `WEB_ORIGIN` (see the Frontend section).

Two separate deploys, both auto-deploy from GitHub `main` on every push:

- **Frontend** (`web/`) → **Vercel** (project `paid-up-one`)
- **Backend** (`api/`) → **Railway** (`paidup-production-a25f.up.railway.app`)

You only need to touch the **dashboard settings** below. Code deploys happen on push.

---

## Backend — Railway

### Settings → Source
- **Root Directory:** `api`  (the backend lives in the `api/` subfolder)

### Variables  (REQUIRED — the backend refuses to boot in production without these)
The server fail-fasts if any secret is still a default, to prevent token forgery
and forged postbacks. Set all of these:

```
JWT_SECRET=<64-char random hex>
OTP_PEPPER=<64-char random hex>
POSTBACK_SECRET_OFFERHUB=<64-char random hex>
WEB_ORIGIN=https://paid-up-one.vercel.app
```
Never commit real secret values here — this repo is public. Generate each with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and
set it only in the Railway dashboard / CLI. The live values are already set on
Railway.
- Do **not** set `PORT` — Railway provides it automatically.
- **Email:** set `RESEND_API_KEY` and `EMAIL_FROM`. Without the key, codes print
  to the Railway logs instead of being emailed.
  - Resend requires a verified **domain** for `EMAIL_FROM` — currently
    `login@creatorxbot.site`. Gmail is not allowed as a sender, and
    `onboarding@resend.dev` only sends to your own Resend account email.
  - In production the API refuses to boot if `EMAIL_FROM` is still the
    `@rozipay.invalid` sentinel default, since the provider would reject every send.

> These are the values generated during setup. You can rotate them anytime —
> just generate new random hex strings and update both here and any ad-network
> config that uses the postback secret.

### CPX Research (the live survey network) — REQUIRED before this build deploys
`cpx` is a **real** network, so the API **will not boot** until its secret is set.
On Railway set:
```
POSTBACK_SECRET_CPX=<the "app secure hash" from the CPX dashboard>
CPX_APP_ID=34405
```
In the **CPX dashboard**:
- **Postback Settings → Main Postback URL:**
  `https://<api-host>/webhooks/cpx/postback?status={status}&trans_id={trans_id}&user_id={user_id}&amount_local={amount_local}&amount_usd={amount_usd}&hash={secure_hash}&ip_click={ip_click}&type={type}`
  (Leave the three "Expert Settings" boxes empty — the main URL covers everything.)
- **Reward Settings:** currency `points`, **1 USD = 600 points**. That single number
  is what enforces the 60/40 split: CPX pays us $1 → the user is credited 600
  points (= $0.60 at 1000 points = 1 USDT) → we keep $0.40.

How it's secured: CPX signs `md5(trans_id + "-" + secret)` — note the signature
covers **only** `trans_id`, **not the amount**. So a captured postback could
otherwise be replayed with a bigger number. Three things stop that: the unique
`(network, external_id)` index makes a replay a no-op **duplicate**; minting a new
`trans_id` requires the secret; and `CPX_MAX_POINTS` caps any single survey.
Optionally set `CPX_ENFORCE_IP=true` to pin CPX's source IPs — but only after
confirming the IP the app observes behind Railway's proxy, or you'll reject real
completions. **status=2** postbacks are CPX reversing a survey it later judged
fraudulent; we automatically claw back the user's reward *and* the referral
bonuses it paid, and raise a `network_reversal` fraud flag.

**Every ad-network adapter needs its own postback secret.** Each network in
`api/src/adapters/index.ts` reads `POSTBACK_SECRET_<NAME>` (and some also a
`POSTBACK_TOKEN_<NAME>`); the API **fail-fasts on boot** if any is still a
default. Currently required: `POSTBACK_SECRET_OFFERHUB`, `POSTBACK_SECRET_TAPVID`,
`POSTBACK_TOKEN_TAPVID`, `POSTBACK_SECRET_SURVEYX`. When you add a network, set
its secret in Railway **before** (or with) the deploy, or the new build won't
start. Generate one with:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

### Payout / USDT send
v1 payout is **manual**: an admin approves, sends USDT from the treasury wallet,
and pastes the on-chain **transaction hash** to mark the request paid (stored as
proof, shown to the user). Config:
- `POINTS_PER_USDT` — points-to-USDT rate at pay time. Default `1000` (1000 points
  = 1 USDT). Set the real number here.
- On-chain **auto-send** is scaffolded but OFF. Do not enable on mainnet until
  proven on a testnet. To turn on later: `PAYOUT_MODE=onchain`,
  `PAYOUT_SIGNER_KEY=<funded EVM hot-wallet key>`, and `RPC_BEP20` / `RPC_POLYGON`
  / `RPC_BASE` for the chains you auto-settle (Aptos stays manual). Until the
  broadcast in `api/src/payout.ts` is implemented + tested, onchain mode refuses
  to settle and falls back to requiring a manual hash.

### Optional — Telegram login fallback
A cheaper alternative to email at signup. Off by default; leave unset to keep it
hidden. To turn it on:
1. Create a bot with **@BotFather** → get its token.
2. In BotFather, set the bot's **domain** to your web origin (`/setdomain` →
   `paid-up-one.vercel.app`), or the Login Widget won't render.
3. Railway → set `TELEGRAM_BOT_TOKEN=<bot token>`.
4. Vercel → set `NEXT_PUBLIC_TELEGRAM_BOT=<bot username, no @>` and redeploy with
   build cache off (it's a `NEXT_PUBLIC_*` value, baked in at build time).

The backend re-verifies Telegram's signature server-side, so the button is inert
until both values are set. Telegram gives no email, so a Telegram-only account
gets a synthetic `tg<id>@telegram.local` address and can sign in via Telegram only.

### After setting variables
Redeploy (Railway → Deployments → Redeploy, or push any commit). Then check:
`https://paidup-production-a25f.up.railway.app/health` → should return
`{"ok":true,"service":"rozipay-api"}`.

### Applying launch config (commission split + referral)
Launch defaults: **60% payout to users** (40% margin); referral **L1 15% + L2 5%**
and a **100-point bonus** when an invited user finishes their first task.
`initDb()` only inserts a network row if absent — it never overwrites an existing
one — so to push these to networks already in the live DB, run the seed once
against production (do this after deploying this build, or existing rows keep the
old 10% / no-L2 values):
```
railway run --service api npm run seed   # updates split + L1/L2/first-task bonus on existing rows
```
Admins can still tune each network's split and referral numbers live in `/staff`
afterward; a re-seed resets those to the launch numbers (status/disabled preserved).

### Persistence — Postgres (required)
1. Railway → your project → **New** → **Database** → **Add PostgreSQL**.
2. On the **api** service → Variables → **New Variable** → **Add Reference** →
   pick the Postgres service's `DATABASE_URL`. (Referencing it uses the private
   network, which is free and needs no TLS.)
3. Redeploy.

The API **refuses to boot in production without `DATABASE_URL`**. That is
deliberate: without it the data would sit on the container's disk, which Railway
wipes on every redeploy — losing users, balances, and the ledger.

Locally, leave `DATABASE_URL` empty. The API then runs **PGlite**, Postgres
compiled to WASM, stored in `api/data/pg`. Same SQL, no install.

Schema is created on boot (`initDb()`), so there is no separate migration step.

---

## Frontend — Vercel

### Settings → Environment Variables
```
NEXT_PUBLIC_API_URL=https://paidup-production-a25f.up.railway.app
```
Without this, the deployed site calls `http://localhost:4000` and login/data fail.
Type the value by hand — a trailing slash, space, or newline pasted in here ends
up in every request path (`//tasks`) and makes the whole API 404.

Optional: `NEXT_PUBLIC_TELEGRAM_BOT=<bot username>` turns on the Telegram login
button (see the backend Telegram section). Leave unset to hide it.

Optional but recommended: `NEXT_PUBLIC_SITE_URL=<the live web origin, no trailing
slash>` — feeds the social-share (OpenGraph) tags, robots.txt and sitemap.xml.
Set it to the live `*.vercel.app` URL today; change it to `https://rozipay.xyz`
when the domain is pointed. Unset, it falls back to `https://rozipay.xyz`, so
WhatsApp link previews can't load their image until that domain is actually live.

`NEXT_PUBLIC_*` values are baked into the JS **at build time**. After changing
this, you must redeploy with **"Use existing build cache" unticked**, or the old
value stays live.

### Settings → Build
- **Root Directory:** `web`

### After setting the variable
Redeploy (Vercel → Deployments → Redeploy). Then open the site and sign in with
an email — you should get a code (emailed if `RESEND_API_KEY` is set on Railway,
otherwise visible in the Railway logs).

---

## Staff / admin access
Sign in with an email listed in `ADMIN_EMAILS` (default: the founder email) to be
auto-promoted to `admin` and land on `/staff`. To add more staff, set
`ADMIN_EMAILS` on Railway to a comma-separated list, or insert rows into
`admin_users` with role `agent` / `manager` / `admin`.

## ROZI mining

Full design: `docs/MINING_SPEC.md`. Deploy notes only here.

**No new environment variables.** Every number in the mining economy lives in the
`app_settings` table under a `mining.*` key and is tunable from `/staff` → Mining
at runtime, with no redeploy. The defaults in `api/src/mining/settings.ts` apply
until an Admin overrides them. Tables and the rig catalogue are created on boot
by `initDb()`, so a deploy is all that is needed.

**Settlement runs inside the API**, not as an external cron: a timer every 15
minutes settles any closed-but-unsettled day, and it also runs once on boot so a
day the process spent asleep is caught up on wake. Settlement is **idempotent**
on the `mining_epochs` primary key, so running two API instances is safe — the
loser of the race is a no-op. There is no lock to configure.

**Things that ship OFF and must be switched on deliberately, in `/staff`:**

| Setting | Default | Turn on when |
|---|---|---|
| `conversionEnabled` | `0` (off) | The lock period ends. This is the ONLY path from ROZI to real Points — see § 6 of the spec before touching it. |
| `transfersEnabled` | `0` (off) | You want wallet-to-wallet ROZI sends. |
| `adsEnabled` | `0` (off) | You have a Monetag/Adsterra account and have dropped the real ad tag into `web/src/app/mine/page.tsx` (`onWatchAd`). |
| Boosters (Points-priced) | none seeded | You have decided on prices. Create them in `/staff`. |

⚠️ **Opening a Conversion Window commits real, cash-redeemable Points.** The panel
shows a suggested pot computed from the margin you actually earned in the last 7
days — the pot is a hard ceiling the system cannot exceed, but it *can* pay out
all of it. Do not commit a pot larger than money the business actually made.

**Testing the concurrency guard.** Local dev uses PGlite, which is a single
Postgres session and therefore cannot isolate concurrent transactions, so the
double-spend race in `npm run test:mining:e2e` is skipped there. To exercise it
for real, point `DATABASE_URL` at a real Postgres and re-run.

## Local development (free, no accounts needed)
```
cd api && npm install && npm start      # backend on :4000, codes print to console
cd web && npm install && npm run dev     # frontend on :3000
```
Open http://localhost:3000. Local dev ignores the production secret checks.

Mining tests:
```
cd api
npm run test:mining       # the economy maths (emission cap, pro-rata, conversion pot)
npm run test:mining:e2e   # the plumbing, against a real DB
```
