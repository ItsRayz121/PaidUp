# Virtual Team — Real Claude Code Tooling

Claude Code doesn't have 15 named subagents — it has a small set of general agents plus skills and MCPs. This doc maps each "hat" to what to actually invoke.

There's no dedicated "architecture reviewer," "document creator," or "test writer" agent. Those hats are covered by `Plan` + `general-purpose` + the `code-review`/`verify` skills. Don't invoke agent names that don't exist.

| # | Role | Route to |
|---|---|---|
| 1 | Product / spec owner | `Plan` agent, from `PROJECT_SPEC.md` |
| 2 | Solution architect | `Plan` agent, from `ARCHITECTURE.md` |
| 3 | UX researcher / IA | `general-purpose` + `ui-ux-pro-max` skill |
| 4 | UI designer | `ui-ux-pro-max` skill, checked against `DESIGN_BRIEF.md` |
| 5 | Graphic/icon designer | **Canva MCP** |
| 6 | Copywriter (simple English) | `general-purpose` with the simple-English rules, then `humanizer` skill |
| 7 | Frontend engineer (Next.js) | `general-purpose` agent, previews via **Vercel MCP** |
| 8 | Backend engineer (Node/Railway) | `general-purpose` agent + Railway CLI via bash |
| 9 | Database/schema engineer | `general-purpose` agent, from data model in `ARCHITECTURE.md` |
| 10 | Auth & security engineer | `general-purpose` agent, then mandatory `security-review` skill |
| 11 | Ad network integration engineer | `general-purpose` agent, one network at a time |
| 12 | Payments/payout engineer | `general-purpose` agent, one country's rail at a time |
| 13 | Fraud & risk engineer | `general-purpose` agent + `security-review` skill |
| 14 | QA / test writer | `general-purpose` to write tests, then `verify`/`run`, then `code-review` |
| 15 | DevOps / release engineer | Vercel MCP + Railway CLI, `loop`/`schedule` for recurring jobs |

## Skills across roles

- `code-review` / `simplify` / `review` — after any non-trivial change.
- `security-review` — mandatory after anything touching auth, money, or postback endpoints.
- `verify` / `run` — confirm features actually work.
- `dataviz` — Manager panel's KPI dashboard.
- `update-config` — set up hooks/permissions once; pair with `fewer-permission-prompts`.

## MCPs relevant here

- **Vercel** — frontend deploys, preview URLs.
- **Canva** — icon sets, marketing graphics.
- **GoDaddy** — domain purchase/DNS.
- **Google Drive** — optional doc/export parking.
- **Sentry** — error monitoring, needs authorization first (before Phase 2).
- **Not relevant**: TradingView, twitterapi-mcp. Leave idle.

## Known gaps

1. **No Railway MCP.** Backend deploys need Railway CLI authenticated in bash, or a Railway API token env var.
2. **Sentry unauthorized.** Defer to Phase 2 but don't forget.
3. **SMS OTP provider not chosen.** Needed for Phase 1 auth. Compare Twilio vs a regional aggregator on cost.

## Recommended sequencing

1. Plan + Product confirm scope — done.
2. UX/UI + Copywriter produce design system and core copy.
3. Backend (schema, auth, one network adapter with postback verification) in parallel with Frontend scaffolding.
4. Fraud/risk and Payments layer in once the core loop works end to end.
5. QA and security-review gate every phase transition.
6. DevOps wires up CI/monitoring once there's something worth monitoring.
