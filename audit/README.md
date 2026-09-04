# RoziPay product audit

Audit dates: 2026-09-03 (static pass), 2026-09-04 (capacity and real-Postgres concurrency pass)

Scope: the repository at `G:\Earning App`, covering the Next.js PWA, Fastify API,
Postgres/PGlite persistence, in-process workers, email verification, Telegram
authentication/linking, money flows, mining, staff tools, deployment configuration,
security, reliability, capacity, and user experience.

The audit is evidence-first. No application code was changed **during the audit
phase**. The founder then authorised fixes; what was changed, and what it measurably
did, is in `FIXES_APPLIED.md`. The original findings are left as written.
Isolated test artifacts may be added here. Live-provider, production, destructive,
high-volume, and active security tests require a separately approved target and
credentials.

## Deliverables

- `FIXES_APPLIED.md` — **the fixes made on 2026-09-04, with before/after measurements.** Read this alongside any finding.
- `EXECUTIVE_REPORT.md` — verdict, principal risks, and next actions.
- `ARCHITECTURE_AND_COVERAGE.md` — system/data-flow map, trust boundaries, and coverage.
- `PROMISE_MATRIX.md` — documented/user-facing promises versus implementation evidence.
- `FINDINGS.md` — evidence-backed confirmed and suspected findings.
- `REMEDIATION_PLAN.md` — prioritized fix plan for review; no fixes applied yet.
- `BLOCKED_AND_UNVERIFIED.md` — checks that require access, infrastructure, or permission.
- `SURFACE_INVENTORY.md` — route, integration, state, and worker inventory.
- `LOAD_TEST_PLAN_AND_VERDICTS.md` — the 10k/100k models and the **measured** verdicts.
- `CAPACITY_BOTTLENECKS.md` — ranked bottleneck analysis with file/line evidence, and a
  banner recording the three predictions the 2026-09-04 measurement corrected.
- `TESTING.md` — reproducible commands, setup, cleanup assumptions, and retained evidence.
- `tests/` — reproducible audit-only test and load-test scaffolding.
- `results/` — captured outputs from checks executed during this audit.

## Status labels

- **Inspected**: source/configuration was reviewed.
- **Exercised**: a reproducible check was executed and its output retained.
- **Blocked**: required access or an approved environment was unavailable.
- **Unverified**: evidence was insufficient to make a pass/fail claim.
- **Not applicable**: the capability does not exist in this product.
