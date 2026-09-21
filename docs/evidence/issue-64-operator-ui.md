# Issue #64 — operator verification UI

The operator page is available at
`GET /operator/attempts/:attemptId/verification`. Operators can review the
task, candidate and approved specs, agent-reported tests, and append-only
independent verification history. POST forms provide candidate proposal,
exact-hash approval, and an explicit synchronous rerun.

| Method | Path                                                 | Success      | Error codes                                                                                             |
| ------ | ---------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| GET    | `/operator/attempts/:attemptId/verification`         | 200 HTML     | 400, 404                                                                                                |
| POST   | `/operator/attempts/:attemptId/verification/propose` | 303 redirect | 400, 404, 409                                                                                           |
| POST   | `/operator/attempts/:attemptId/verification/approve` | 303 redirect | 400, 404, 409                                                                                           |
| POST   | `/operator/attempts/:attemptId/verification/rerun`   | 200 HTML     | 400, 404, 409, 502 (`pull_request_refresh_failed`), 503 (`verification_disabled`, `github_unavailable`) |

The UI reuses the existing candidate/approval and verification functions. The
general `/api/report` and `/dashboard` surfaces continue to exclude candidate
scripts and raw `evidenceSummary`; only the dedicated operator page renders
the exact candidate and approved script.

Tests run:

```text
Targeted operator/rerun/report/startup tests:
Test Files  4 passed (4)
Tests       29 passed (29)

Full Vitest suite:
Test Files  28 passed (28)
Tests       426 passed (426)
```

`pnpm check`:

```text
format:check passed
lint passed
type-check passed
test passed — 28 files, 426 tests
build passed
```

Reporting-boundary regression coverage verifies that script and raw-output
sentinels remain absent from the general report/dashboard while the operator
page can show the script sentinel.

Screenshot: (added by lead)
