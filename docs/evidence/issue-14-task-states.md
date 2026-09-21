# Issue #14 — Honest task states (normalized projection)

## Purpose

The persisted `attempts` schema stores several separate facts — the attempt
lifecycle (`state`/`outcome`), the raw Devin session status
(`devin_session_status`/`devin_session_status_detail`), the tracked pull
request (`pr_state`/`pr_head_sha`), and append-only `verifications` rows —
but nothing collapsed them into a single honest answer to "where is this
task right now?". Issue #14 adds that answer as a **derived projection**
(`src/tracking/normalized-task-state.ts`): `projectTaskState(attempt)` reads
the current attempt row plus the latest `command` and `github_checks`
verification rows for the _current_ PR head and returns a normalized state
with a machine-readable reason. Nothing is persisted — no new columns, no
migrations, no routes — and the existing `attempts.state`/`outcome` state
machine is unchanged. The projection is emitted as a structured log line at
the end of each tracking pass and printed by `pnpm verification:show`.

## State model

| Normalized state      | Derived from                                                                         | Reason codes                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `QUEUED`              | `attempt.state = pending`                                                            | `attempt_pending`                                                                                                        |
| `DISPATCHING`         | `attempt.state = dispatching`                                                        | `attempt_dispatching`                                                                                                    |
| `RUNNING`             | `attempt.state = session_created` / `running`                                        | `attempt_session_created`, `attempt_running`                                                                             |
| `PR_OPEN`             | live PR with nothing decisive yet (or a superseded verified head)                    | `no_verification_spec`, `pr_head_unknown`, `verified_head_superseded`                                                    |
| `CI_PENDING`          | latest `github_checks` row for the current head is `unverified`/`checks_pending`     | `github_checks_pending`                                                                                                  |
| `VERIFYING`           | verification activity underway but no decisive result                                | `command_verification_error`, `approved_spec_awaiting_run`, `spec_pending_approval`, `current_head_verification_pending` |
| `VERIFICATION_FAILED` | latest `command` row for the current head is `failed` and _decisive_                 | `command_verification_failed`                                                                                            |
| `VERIFIED`            | latest `command` row for the **current** `pr_head_sha` is `passed` and decisive      | `command_verification_passed`                                                                                            |
| `NEEDS_HUMAN`         | `completed` + `outcome = escalated`, or PR `closed`/`merged` without a decisive pass | `outcome_escalated`, `pr_closed_without_merge`, `pr_merged_before_verification`                                          |
| `NO_ACTION`           | `completed` + `outcome = no_action`                                                  | `outcome_no_action`                                                                                                      |
| `FAILED`              | `completed` + `outcome = failed`                                                     | `outcome_failed`                                                                                                         |
| `CANCELLED`           | `completed` + `outcome = cancelled`                                                  | `outcome_cancelled`                                                                                                      |

## Precedence

`deriveTaskState` applies these rules in order; the first match wins.

1. **Staleness filter (defensive).** Any evidence row whose
   `head_sha != attempt.pr_head_sha` is discarded before evaluation, so a
   result recorded for a superseded head can never drive the projection.
   `raw.githubChecks` / `raw.command` expose only the surviving rows.
2. **Terminal, non-success.** `state = completed` with `outcome` of
   `no_action`/`cancelled`/`escalated`/`failed` maps to
   `NO_ACTION`/`CANCELLED`/`NEEDS_HUMAN`/`FAILED` from the outcome alone.
   (`outcome` can never be NULL while `completed` — enforced by a DB check
   constraint — so this branch throws if it somehow happens.)
   `completed` + `succeeded` does **not** resolve here: see "VERIFIED is a
   current-head property" below.
3. **Active, pre-verification.** `pending → QUEUED`,
   `dispatching → DISPATCHING`, `session_created`/`running → RUNNING`.
4. **Verifying or completed-succeeded** — current-head evidence decides.
   A row is _decisive_ when its `spec_sha256` equals
   `verification_approved_sha256` **and** approval status is still
   `approved` — a run of a spec superseded by a new pending candidate is
   never decisive:
   1. `pr_state = closed` → `NEEDS_HUMAN` (`pr_closed_without_merge`),
      including when a decisive passed command row exists.
   2. Latest `command` row is `passed` and decisive → `VERIFIED`
      (`command_verification_passed`), unless the PR was closed without merge.
   3. `pr_state = merged` → `NEEDS_HUMAN` (`pr_merged_before_verification`)
      — the merge itself is not verification evidence; a decisive passed row
      still wins for merged PRs.
   4. Latest `command` row is `failed` and decisive → `VERIFICATION_FAILED`
      (`command_verification_failed`).
   5. Latest `github_checks` row is `unverified`/`checks_pending` →
      `CI_PENDING`. `github_checks` `failed` or `unverified`/`no_checks`
      never change the normalized state on their own — checks are
      supplementary and stay visible under `raw.githubChecks`.
   6. Latest `command` row is `error` → `VERIFYING`
      (`command_verification_error`).
   7. While `verifying`: `approved` spec awaiting a run → `VERIFYING`
      (`approved_spec_awaiting_run`); a candidate awaiting operator
      approval → `VERIFYING` (`spec_pending_approval`). While
      `completed`/`succeeded` the verifier no longer runs, so approval
      status alone is not activity — only a recorded `command`/`unverified`
      row for the current head → `VERIFYING`
      (`current_head_verification_pending`).
   8. Otherwise → `PR_OPEN`: `verified_head_superseded` when
      `completed`/`succeeded`, `pr_head_unknown` when `pr_head_sha` is
      defensively NULL, else `no_verification_spec`.

### VERIFIED is a current-head property

`completed`/`succeeded` records that a `passed` command run existed for the
head verified at completion time (`completeVerifiedAttempt` guarantees that
row). If the PR head later moves, the passed row belongs to the old head,
the staleness filter drops it, and the projection demotes to `PR_OPEN` /
`verified_head_superseded` (or `CI_PENDING`/`VERIFICATION_FAILED` if new
evidence arrives for the new head). `raw.outcome` still shows `succeeded` —
the historical fact is preserved; the normalized state describes now.

## Raw provider status stays separate

The projection never rewrites the underlying facts. Example covered by
test: an attempt in `verifying` whose Devin session reports
`status = suspended`, PR open, checks `unverified`/`no_checks` projects to:

```
state: PR_OPEN   reason: no_verification_spec
raw: { attemptState: 'verifying', devinSessionStatus: 'suspended',
       prState: 'open', githubChecks: { status: 'unverified', reason: 'no_checks' } }
```

The raw session status, outcome reason, and verification rows remain
queryable beside the normalized value (`raw` in the projection, and the
`Raw provider facts` table in `pnpm verification:show`).

## State transition tests

`tests/normalized-task-state.test.ts` — 36 tests: a table-driven sweep over
`deriveTaskState` fixtures (all states plus the non-success paths,
including superseded-head and superseded-spec regressions) and two
DB-backed tests exercising `loadTaskStateEvidence`/`projectTaskState`
across real head changes, including a full `completeVerifiedAttempt`
lifecycle:

```
 RUN  v5.0.1 /home/ubuntu/repos/devin-superset-remediation

 Test Files  1 passed (1)
      Tests  36 passed (36)
   Start at  12:54:54
   Duration  627ms
```

Command: `pnpm vitest run tests/normalized-task-state.test.ts`

### Verification level

This is **automated test verification only**. The table-driven cases run the
pure `deriveTaskState` against in-memory fixtures; the DB-backed cases run
`runMigrations` and the real `task-state.ts` functions against a local
SQLite file. No live Devin session, GitHub API call, or tracker poll was
exercised for this change — the tracker log line and `verification:show`
output are type-checked and covered indirectly by the existing mocked
tracker suite (`tests/session-tracker.test.ts`), not observed against a
real remediation run.

## Acceptance criteria mapping

| Criterion (Issue #14)                                              | Where satisfied                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `PR_OPEN` is not considered equivalent to verified success         | `PR_OPEN` is its own state for a live PR without decisive evidence; `VERIFIED` requires a decisive `passed` row for the current head |
| Missing CI remains pending or unverified                           | `checks_pending` → `CI_PENDING`; `no_checks` → `PR_OPEN`/`VERIFYING`, never `VERIFIED`                                               |
| Human escalation is represented explicitly                         | `NEEDS_HUMAN` from `outcome = escalated` and from `pr_closed_without_merge`                                                          |
| No-action outcomes are distinct from failures                      | `NO_ACTION` vs `FAILED` map from distinct outcomes                                                                                   |
| Raw provider status retained separately from normalized task state | `TaskStateProjection.raw` carries `devinSessionStatus`, `prState`, outcome reason, and raw verification evidence                     |

Verification section of the issue ("test representative state transitions,
including at least one non-success path"): the table covers
`VERIFICATION_FAILED`, `NEEDS_HUMAN`, `NO_ACTION`, `FAILED`, `CANCELLED`,
merged/closed PRs, stale-head and superseded-spec evidence, and the
`VERIFIED → PR_OPEN` demotion when the verified head moves — the last also
exercised end-to-end through `completeVerifiedAttempt` and
`recordPullRequest`.
