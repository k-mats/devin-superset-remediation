# Issue #64 — operator verification UI

The operator page is available at
`GET /operator/attempts/:attemptId/verification`. Operators can review the
task, candidate and approved specs, agent-reported tests, and append-only
independent verification history. POST forms provide candidate proposal,
exact-hash approval, and an explicit synchronous rerun.

The UI reuses the existing candidate/approval and verification functions. The
general `/api/report` and `/dashboard` surfaces continue to exclude candidate
scripts and raw `evidenceSummary`; only the dedicated operator page renders
the exact candidate and approved script.

Tests run:

```text
Targeted operator/rerun/report/startup tests:
Test Files  4 passed (4)
Tests       18 passed (18)

Full Vitest suite:
Test Files  28 passed (28)
Tests       415 passed (415)
```

`pnpm check`:

```text
format:check passed
lint passed
type-check passed
test passed — 28 files, 415 tests
build passed
```

Reporting-boundary regression coverage verifies that script and raw-output
sentinels remain absent from the general report/dashboard while the operator
page can show the script sentinel.

Screenshot: (added by lead)
