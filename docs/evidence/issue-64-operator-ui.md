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

Verification execution is serialized in-process per repository workspace. The
tracker and browser rerun share the same lock, and a waiter re-reads attempt
state after acquiring it. The remaining limitation is cross-process:
`demo:verification` / CLI runs in a separate process against a live service
are not covered by the in-process lock.

Tests run:

```text
Targeted operator/rerun/report/startup tests:
Test Files  4 passed (4)
Tests       35 passed (35)

Full Vitest suite:
Test Files  30 passed (30)
Tests       437 passed (437)
```

`pnpm check`:

```text
format:check passed
lint passed
type-check passed
test passed — 30 files, 437 tests
build passed
```

Reporting-boundary regression coverage verifies that script and raw-output
sentinels remain absent from the general report/dashboard while the operator
page can show the script sentinel. Workspace-lock unit coverage verifies
same-key serialization, different-key interleaving, and rejection release;
verification-concurrency coverage verifies serialized execution, the no-op
lock interleaving, and stale waiter skipping.

Screenshot: (added by lead)
