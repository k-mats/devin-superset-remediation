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

| Normalized state      | Derived from                                                                                    | Reason codes                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `QUEUED`              | `attempt.state = pending`                                                                       | `attempt_pending`                                                                   |
| `DISPATCHING`         | `attempt.state = dispatching`                                                                   | `attempt_dispatching`                                                               |
| `RUNNING`             | `attempt.state = session_created` / `running`                                                   | `attempt_session_created`, `attempt_running`                                        |
| `PR_OPEN`             | `verifying` with a live PR but nothing decisive yet                                             | `no_verification_spec`, `pr_head_unknown`                                           |
| `CI_PENDING`          | `verifying` + latest `github_checks` row for the current head is `unverified`/`checks_pending`  | `github_checks_pending`                                                             |
| `VERIFYING`           | `verifying` with verification activity underway but no decisive result                          | `command_verification_error`, `approved_spec_awaiting_run`, `spec_pending_approval` |
| `VERIFICATION_FAILED` | `verifying` + latest `command` row for the current head is `failed` against the _approved_ spec | `command_verification_failed`                                                       |
| `VERIFIED`            | `completed` + `outcome = succeeded`                                                             | `outcome_succeeded`                                                                 |
| `NEEDS_HUMAN`         | `completed` + `outcome = escalated`, or `verifying` with `pr_state = closed`                    | `outcome_escalated`, `pr_closed_without_merge`                                      |
| `NO_ACTION`           | `completed` + `outcome = no_action`                                                             | `outcome_no_action`                                                                 |
| `FAILED`              | `completed` + `outcome = failed`                                                                | `outcome_failed`                                                                    |
| `CANCELLED`           | `completed` + `outcome = cancelled`                                                             | `outcome_cancelled`                                                                 |

## Precedence

`deriveTaskState` applies these rules in order; the first match wins.

1. **Staleness filter (defensive).** Any evidence row whose
   `head_sha != attempt.pr_head_sha` is discarded before evaluation, so a
   result recorded for a superseded head can never drive the projection.
   `raw.githubChecks` / `raw.command` expose only the surviving rows.
2. **Terminal.** `state = completed` maps purely from `outcome`:
   `succeeded → VERIFIED`, `no_action → NO_ACTION`, `cancelled → CANCELLED`,
   `escalated → NEEDS_HUMAN`, `failed → FAILED`. (`outcome` can never be
   NULL while `completed` — enforced by a DB check constraint — so this
   branch throws if it somehow happens.)
3. **Active, pre-verification.** `pending → QUEUED`,
   `dispatching → DISPATCHING`, `session_created`/`running → RUNNING`.
4. **Verifying**, in order:
   1. `pr_state = closed` → `NEEDS_HUMAN` (`pr_closed_without_merge`) — a
      closed-without-merge PR outranks any recorded command failure.
   2. Latest `command` row is `failed` and its `spec_sha256` equals the
      _approved_ spec hash → `VERIFICATION_FAILED`. A failed row for a
      superseded spec (hash mismatch) is not decisive and falls through.
   3. Latest `github_checks` row is `unverified`/`checks_pending` →
      `CI_PENDING`. `github_checks` `failed` or `unverified`/`no_checks`
      never change the normalized state on their own — checks are
      supplementary and stay visible under `raw.githubChecks`.
   4. Latest `command` row is `error` → `VERIFYING`
      (`command_verification_error`); else `approved` spec awaiting a run →
      `VERIFYING` (`approved_spec_awaiting_run`); else a candidate awaiting
      operator approval → `VERIFYING` (`spec_pending_approval`).
   5. Otherwise (`no_candidate`) → `PR_OPEN` (`no_verification_spec`), or
      `pr_head_unknown` when `pr_head_sha` is defensively NULL.

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

`tests/normalized-task-state.test.ts` — 26 tests: a table-driven sweep over
`deriveTaskState` fixtures (all states plus the non-success paths) and one
DB-backed test exercising `loadTaskStateEvidence`/`projectTaskState`
staleness across a real head change:

```
 RUN  v5.0.1 /home/ubuntu/repos/devin-superset-remediation

 Test Files  1 passed (1)
      Tests  26 passed (26)
   Start at  12:28:27
   Duration  595ms
```

Command: `pnpm vitest run tests/normalized-task-state.test.ts`

## Acceptance criteria mapping

| Criterion (Issue #14)                                              | Where satisfied                                                                                                        |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `PR_OPEN` is not considered equivalent to verified success         | `PR_OPEN` is its own state for `verifying` without decisive evidence; `VERIFIED` requires `completed`/`succeeded` only |
| Missing CI remains pending or unverified                           | `checks_pending` → `CI_PENDING`; `no_checks` → `PR_OPEN`/`VERIFYING`, never `VERIFIED`                                 |
| Human escalation is represented explicitly                         | `NEEDS_HUMAN` from `outcome = escalated` and from `pr_closed_without_merge`                                            |
| No-action outcomes are distinct from failures                      | `NO_ACTION` vs `FAILED` map from distinct outcomes                                                                     |
| Raw provider status retained separately from normalized task state | `TaskStateProjection.raw` carries `devinSessionStatus`, `prState`, outcome reason, and raw verification evidence       |

Verification section of the issue ("test representative state transitions,
including at least one non-success path"): the table covers
`VERIFICATION_FAILED`, `NEEDS_HUMAN`, `NO_ACTION`, `FAILED`, `CANCELLED`,
and the stale-head/superseded-spec paths, plus the DB-backed head-move test.
