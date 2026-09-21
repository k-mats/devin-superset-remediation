# Issue #24 — Remediation evidence ledger real-run evidence

## Purpose

Show that the remediation evidence ledger in `GET /api/report` (`ledger[]`) and
`GET /dashboard` ("Remediation evidence ledger") lets an evaluator answer, from
one row and without reading logs: what happened to a remediation, what
evidence supports its current outcome, and where the underlying artifacts are.

## Evidence classes

- **Real persisted run** — the meaningful remediation `k-mats/superset#13` →
  PR #14, re-adopted from the existing Devin session (no new session was
  created). Everything in "Real run" below comes from that database.
- **Seeded/test verification** — `FAILED`, `NEEDS_HUMAN`, `NO_ACTION`,
  `CANCELLED`, retries with stale evidence, missing ACU, attemptless tasks and
  raw-output redaction are verified by `tests/report-model.test.ts` and
  `tests/report-routes.test.ts` against a seeded SQLite database, not by live
  runs. The ledger itself has no real/test classification column; separation
  is by database path, as elsewhere in the project.

## Real run

### Subject

- GitHub issue: https://github.com/k-mats/superset/issues/13
- Devin session (adopted): https://app.devin.ai/sessions/5957ce490e56465b930e0349ace6db68
- Remediation PR: https://github.com/k-mats/superset/pull/14
- Orchestrator branch: `devin/1790017013-issue-24-evidence-ledger` (PR #60)

### Setup

- Fresh SQLite database `DATABASE_PATH=./data/evidence-issue-24.db`.
- `GITHUB_REPO_OWNER=k-mats`, `GITHUB_REPO_NAME=superset`,
  `GITHUB_INTAKE_LABEL=devin-ready`, `VERIFICATION_ENABLED=true`,
  `VERIFICATION_WORKSPACE_ROOT=./data/verification`, `DEVIN_API_URL=https://api.devin.ai/v3`.
- `DEVIN_API_KEY`, `DEVIN_ORG_ID`, `GITHUB_TOKEN` supplied via environment
  (read-only use); values are not recorded here and do not appear in any
  report response.
- Host: `uv` (pip), Python 3.12, and the Superset native build packages from
  `docs/operations.md` were installed before the passing verification run.

### Sequence

```bash
pnpm db:migrate
pnpm demo:intake                                             # task 1 / attempt 1 (k-mats/superset#13)
pnpm demo:adopt-session --attempt 1 --session 5957ce49…      # attach existing session
pnpm demo:tracking --attempt 1                               # PR #14 recorded, github_checks -> unverified/no_checks
pnpm verification:propose --attempt 1 --command \
  "pytest tests/unit_tests/mcp_service/dataset/tool/test_query_dataset.py::test_query_dataset_reversed_time_range -q"
pnpm verification:approve --attempt 1 --spec-hash 590eadd1…
pnpm demo:verification --attempt 1 --rerun                   # command verification passed (exit 0)
pnpm demo:tracking --attempt 1                               # attempt completed / succeeded -> VERIFIED
pnpm dev                                                     # /api/report, /dashboard
```

Earlier `demo:verification` passes in the same database recorded
`uv_not_found`, `install_failed` (missing `pkg-config` / MySQL headers) and a
failed run of a wrongly-pathed command that was proposed and approved by
mistake (`.../test_query_dataset_reversed_time_range` without the
`test_query_dataset.py::` prefix). They are retained as verification history for
head `f22d3d3…`; the ledger shows only the latest `command` row for the current
head, so they do not affect the displayed evidence or the normalized state.

### Ledger row (`/api/report` → `ledger[0]`, structured facts only)

| Field                               | Value                                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue                               | `k-mats/superset#13`                                                                                                                                     |
| Normalized state / reason           | `VERIFIED` / `command_verification_passed`                                                                                                               |
| Attempt                             | 1 of 1 (`attemptCount: 1`, history has one entry)                                                                                                        |
| Devin session                       | `5957ce490e56465b930e0349ace6db68`, status `suspended` (`inactivity`)                                                                                    |
| ACU                                 | `0` — the persisted value returned by the Devin API (`acus_consumed: 0.0`) for this suspended session; shown as observed, not as unknown                 |
| PR                                  | #14, `open`, head `f22d3d3f55b19803542416f4150a62cbc7607fc0`                                                                                             |
| Command verification (current head) | `passed`, exit `0`, spec `590eadd10bdffac99af35dcba67a28c4330b33bca2fda534b812b58711dc13df`, started 2026-09-21T19:11:15Z, finished 2026-09-21T19:11:29Z |
| GitHub Checks (current head)        | `unverified` / `no_checks` (PR #14 head has zero check-runs and zero statuses), evidence URL https://github.com/k-mats/superset/pull/14/checks           |
| Stale verifications                 | none (no earlier PR head was tracked)                                                                                                                    |
| Approval                            | `approved`, spec `590eadd1…`, by `operator`, at 2026-09-21T19:11:09Z; candidate source `operator`                                                        |
| Outcome (orchestrator)              | `completed` / `succeeded` / `independent_verification_passed: f22d3d3…`                                                                                  |
| Agent-reported (separate)           | outcome `remediated`, PR URL #14, `needsHumanReason: null`                                                                                               |

The `VERIFIED` state is derived by Issue #14's `projectTaskState()` from the
passing command verification on the current head; the open PR link and the
agent-reported `remediated` are displayed but are not the success basis, and
`unverified` GitHub Checks is shown separately and does not contribute.

### Boundary check

`report.json` captured from `/api/report` contains no `evidenceSummary`,
`specScript`, `specShell`, or raw command output; the dashboard renders only
status / reason / head / spec hash / exit code / evidence URL / timestamps.

## Seeded verification of non-success behaviour

`pnpm test` (`tests/report-model.test.ts`, `tests/report-routes.test.ts`) covers:

- one ledger row per task with the latest attempt as `current` and all
  attempts in `history`, including a task with zero attempts
  (`current: null`, `QUEUED` / `task_without_attempt`);
- `FAILED`, `NEEDS_HUMAN` (with `needsHumanReason`), `NO_ACTION` and
  `CANCELLED` rows retained with their reasons;
- verification of a previous PR head listed as `stale` (with kind) and not used
  as current-head evidence;
- `acusConsumed: null` rendered as `—`, never `0`;
- `/api/report` and `/dashboard` built from the same `Report` model, with raw
  scripts and command output absent from both.
