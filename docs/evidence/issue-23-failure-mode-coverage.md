# Issue #23 — Failure-mode coverage audit and gap tests

## Purpose

Audit the automated test suite against the orchestration failure modes listed
in Issue #23, add deterministic regression tests only where an externally
observable invariant was not pinned, and record whether any test exposed a
production correctness defect.

Method for every new test: define the invariant first, run it against the
unmodified implementation, and only then decide between "coverage addition"
and "minimal production fix". No real GitHub or Devin credentials are used;
every test runs on the in-memory/temp SQLite database with mocked HTTP.

## Result

- New tests: 14 (`tests/devin-dispatcher.test.ts`, `tests/devin-client.test.ts`,
  `tests/session-tracker.test.ts`, `tests/verify-remediation.test.ts`).
- Production code changed: **none**. Every new test passed against the current
  implementation on first run, so all additions are coverage-only.
- No contradiction with the documented state model (`architecture.md`,
  `docs/evidence/issue-14-task-states.md`) was found.

## Coverage matrix

Classification: **covered** (already pinned by an existing test), **indirect**
(covered sufficiently through another test), **conservative** (intentionally
unsupported and handled conservatively), **gap** (was missing; test added here).

| Failure mode                                   | Classification                                           | Test(s)                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate GitHub discovery / repeated intake   | covered                                                  | `github-intake.test.ts` (repeat polling, active-attempt skip, concurrent conflict); `devin-dispatcher.test.ts` "exactly once across repeated intake and dispatch runs" (`createSession` 1×)                                                                                                                                                                             |
| Concurrent dispatch of the same attempt        | covered                                                  | `devin-dispatcher.test.ts` same-process and separate-connection claim races (`createSession` 1×, `claim_lost`)                                                                                                                                                                                                                                                          |
| Duplicate paid Devin session creation          | covered                                                  | dispatcher tests above; "does not dispatch a task whose attempt history is completed" (`createSession` 0×)                                                                                                                                                                                                                                                              |
| Application / database restart persistence     | covered                                                  | `task-state.test.ts` "recovers identical rows after reopening"; `migrations.test.ts`; `startup.test.ts`                                                                                                                                                                                                                                                                 |
| GitHub intake / eligibility API failures       | covered                                                  | `github-intake.test.ts` API/network errors leave rows unchanged; dispatcher terminal vs transient eligibility errors (`createSession` 0×, retried 1×)                                                                                                                                                                                                                   |
| Devin session creation failure or timeout      | gap → added                                              | `devin-dispatcher.test.ts` "keeps an uncertain createSession result (%s) in dispatching and never redispatches it" — network error, `TimeoutError`, `AbortError`, 5xx `DevinApiError`; 3 further intake+dispatch runs keep `createSession` at 1×, row stays `dispatching` with no session id, projection `DISPATCHING`                                                  |
| Ambiguous `dispatching` after uncertain create | conservative (reconciliation is Issue #20) + gap → added | same test as above; `task-state.test.ts` `findStaleDispatchingAttempts`, release-claim-only-without-session; projection `DISPATCHING`                                                                                                                                                                                                                                   |
| Missing GitHub Checks                          | covered                                                  | `verify-remediation.test.ts` `no_checks` row deduped, `checks_lookup_failed`; projection `no_checks`                                                                                                                                                                                                                                                                    |
| Failed GitHub Checks                           | gap → added                                              | `verify-remediation.test.ts` "persists a failed github_checks row …" (row `failed` with evidence url/summary, attempt stays `verifying`, projection not `VERIFIED`, `raw.githubChecks.status = 'failed'`) and "… even when the independent command passes" (both rows persisted and exposed; command result decides `VERIFIED` — documented policy boundary, unchanged) |
| Stale / superseded PR head SHA                 | covered                                                  | `verify-remediation.test.ts` head moved mid-pass; `task-state.test.ts` `completeVerifiedAttempt` different head; projection stale evidence ignored / demotes on head move                                                                                                                                                                                               |
| Verification result for the wrong head         | covered                                                  | as above (`headSha` scoped rows)                                                                                                                                                                                                                                                                                                                                        |
| Spec changed while verification is running     | covered                                                  | `verify-remediation.test.ts` spec superseded during run / after pass / re-approval on issue change                                                                                                                                                                                                                                                                      |
| Missing / unapproved verification spec         | covered                                                  | `verify-remediation.test.ts` pending_approval never runs, `agent_tests_run` never auto-approved, `no_candidate`                                                                                                                                                                                                                                                         |
| Failed / errored independent verification      | covered + gap (setup) → added                            | existing failed/error/checkout_failed tests; added "records a setup failure (%s) as an error row and stays verifying" for `SetupError` (reason preserved) and unexpected error (`setup_failed`); `runCommand` never invoked; projection `VERIFYING`/`command_verification_error`                                                                                        |
| Invalid or missing structured Devin output     | covered                                                  | `collect-structured-output.test.ts` (missing, invalid, session_error, concurrent collectors)                                                                                                                                                                                                                                                                            |
| Unknown Devin session status / status_detail   | gap → added                                              | `devin-client.test.ts` rejects unknown `status` and unknown `status_detail`; `session-tracker.test.ts` "leaves a running attempt non-terminal when Devin reports an %s" — row unchanged, no PR lookup, projection `RUNNING`, error logged                                                                                                                               |
| Closed or otherwise invalid PR state           | covered + gap → added                                    | `verify-pull-request.test.ts` (missing/unrelated/wrong-base PR); projection closed/merged; added `session-tracker.test.ts` "records a plain closed PR while verifying and projects NEEDS_HUMAN" and `verify-remediation.test.ts` "never projects VERIFIED for a PR that was closed without merge"                                                                       |

## Observations (not defects)

- **Closed PR + passing command.** `verifyRemediationOnce` does not consult
  `prState`; a passing approved spec on a closed PR still records the historical
  attempt outcome `completed/succeeded`. The operator-facing normalized state is
  `NEEDS_HUMAN` / `pr_closed_without_merge`, which is the documented judgement
  layer, so this is pinned as-is rather than rewriting the attempt outcome
  model.
- **Failed GitHub Checks + passing command.** Both rows are persisted and
  exposed via `projectTaskState().raw`; `VERIFIED` is decided by independent
  command verification. Whether red CI should block completion is a policy
  decision outside Issue #23.

## Commands

```bash
pnpm vitest run tests/devin-dispatcher.test.ts tests/devin-client.test.ts \
  tests/session-tracker.test.ts tests/verify-remediation.test.ts
pnpm check
```
