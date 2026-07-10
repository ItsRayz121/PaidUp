# Rewards & Offerwall App — Project Memory

This file is the entry point. Read this first on every session. Full detail lives in `/docs`:

| File | Contains |
|---|---|
| `docs/PROJECT_SPEC.md` | The PRD — problem, goals, non-goals, user stories, requirements, phasing |
| `docs/ARCHITECTURE.md` | System design — data model, ad-network adapters, fraud layer, deploy topology |
| `docs/DESIGN_BRIEF.md` | Visual direction, simple-English copy rules, accessibility |
| `docs/TEAM_AND_AGENTS.md` | The 15-role virtual team, mapped to real Claude Code agents/skills/MCPs |

## What this product is

A rewards app: users complete offers (app installs, surveys, rewarded video) supplied by ad networks and earn points redeemable for local cash. Revenue = network payout to us, minus points paid to users. Growth = referral loops, not ad spend. Primary markets: Pakistan, India, Bangladesh, Indonesia, Nigeria.

## Tech stack (decided)

- **Frontend**: Next.js, deployed on **Vercel**. Use the Vercel MCP for deploys/previews. Lives in `web/`.
- **Backend**: Node (Express or Fastify), deployed on **Railway**, Postgres + Redis (Railway add-ons). Will live in `api/`.
- **Auth**: **Email verification as primary** (6-digit code by email). Founder decision (2026-07-10): phone SMS OTP is **dropped** for launch — per-SMS cost in these markets is too high. **Telegram login/verification** is the planned cheaper fallback if email hurts signup. (Original spec said phone-OTP-primary; this supersedes it.)
- **Graphics/icons**: Canva MCP for icon sets and marketing assets.
- **Domain**: GoDaddy MCP for DNS once a domain is chosen.
- **Error monitoring**: Sentry — currently unauthorized in this workspace. Authorize before Phase 2.
- **Not used on this project**: TradingView MCP, twitterapi-mcp — leave these idle.
- ⚠️ **No Railway MCP is connected.** Backend deploys must go through the Railway CLI via bash, or a Railway API token set as an env var.

## Non-negotiable guardrails

These override convenience or speed at every step:

1. **Every point credited must trace to a verified server-to-server postback**, never a client-side "I finished the offer" call.
2. **Every points transaction is an append-only ledger entry**, never a mutable balance field. Balance = sum of ledger.
3. **Disclose that offers are sponsored and rewards come from third parties**, in-product, before a user starts a task.
4. **Never design a payout threshold to be effectively unreachable.**
5. **Rate-limit and fingerprint at the device level from day one.**
6. **Simple English + icon-first UI everywhere user-facing.** No jargon in any user-facing string.

## Working conventions

- Treat `docs/PROJECT_SPEC.md` as the source of truth for scope. Flag conflicts rather than silently expanding scope.
- Before writing code for a new feature, check `docs/ARCHITECTURE.md` for the data model and adapter pattern.
- After any change touching auth, payments, or ad-network postback endpoints, run the `security-review` skill.
- Before marking a feature done, run `verify`/`run` to confirm it works end-to-end.

## Current build status

- **Phase 0**: docs + architecture + design system. ✅ docs on disk.
- **Phase 1 (MVP)**: in progress. Frontend Earner app (`web/`) built first with mock data; backend to follow.

See `docs/` for the full spec. Open business decisions (commission split, launch payout rail) are tracked in `docs/PROJECT_SPEC.md` → Open Questions.
