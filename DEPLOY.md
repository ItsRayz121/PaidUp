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
JWT_SECRET=a9844b339faa7819dd35e037d82d1d4ef790b1c6b1b4eedb798a32993bbabf87
OTP_PEPPER=824e9bc615acd8bd47d64d86274c0fa0f3adad9dd70164e3ce4ffdd2b78ccc2c
POSTBACK_SECRET_OFFERHUB=7aae0e63c2522cb19c168e28aa06c8770069931a39ec3b1f8a3e40deb744a91d
WEB_ORIGIN=https://paid-up-one.vercel.app
```
- Do **not** set `PORT` — Railway provides it automatically.
- **Email:** set `RESEND_API_KEY` (preferred) or `BREVO_API_KEY`, plus
  `EMAIL_FROM`. Without either key, codes print to the Railway logs.
  - **Resend** requires a verified **domain** for `EMAIL_FROM` (Gmail is not
    allowed; `onboarding@resend.dev` only sends to your own account email).
  - **Brevo** allows a single verified sender (a Gmail works), e.g.
    `EMAIL_FROM=fazalelahi5577@gmail.com`.
  - If both keys are set, Resend wins.

> These are the values generated during setup. You can rotate them anytime —
> just generate new random hex strings and update both here and any ad-network
> config that uses the postback secret.

### After setting variables
Redeploy (Railway → Deployments → Redeploy, or push any commit). Then check:
`https://paidup-production-a25f.up.railway.app/health` → should return
`{"ok":true,"service":"paidup-api"}`.

### ⚠️ Persistence
The backend currently uses local SQLite, which **resets on every redeploy** on
Railway. For real use, add the **Railway PostgreSQL** plugin and migrate the DB
layer (the SQL is written to port cleanly). Until then, treat data as temporary.

---

## Frontend — Vercel

### Settings → Environment Variables
```
NEXT_PUBLIC_API_URL=https://paidup-production-a25f.up.railway.app
```
Without this, the deployed site calls `http://localhost:4000` and login/data fail.

### Settings → Build
- **Root Directory:** `web`

### After setting the variable
Redeploy (Vercel → Deployments → Redeploy). Then open the site and sign in with
an email — you should get a code (emailed if `BREVO_API_KEY` is set on Railway,
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
