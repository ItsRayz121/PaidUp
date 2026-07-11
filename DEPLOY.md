# Deploying PaidUp

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
    `@paidup.app` default, since the provider would reject every send.

> These are the values generated during setup. You can rotate them anytime —
> just generate new random hex strings and update both here and any ad-network
> config that uses the postback secret.

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
`{"ok":true,"service":"paidup-api"}`.

### Applying launch config (commission split)
The launch default is **60% of net network payout to users** (40% margin).
`initDb()` only inserts a network row if absent — it never overwrites an existing
one — so to push the decided split to networks already in the live DB, run the
seed once against production:
```
railway run --service api npm run seed   # updates commission/referral on existing rows
```
Admins can still tune each network's split live in `/staff` afterward; a re-seed
resets those to the launch numbers (status/disabled state is preserved).

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

## Local development (free, no accounts needed)
```
cd api && npm install && npm start      # backend on :4000, codes print to console
cd web && npm install && npm run dev     # frontend on :3000
```
Open http://localhost:3000. Local dev ignores the production secret checks.
