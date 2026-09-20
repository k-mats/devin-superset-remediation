# Issue #10 — Structured output evidence

## Purpose

Exercise the structured output contract end-to-end with one real Devin
session: dispatch a session with `structured_output_required` and the version 1
JSON Schema, collect the session's `structured_output` once the turn is
complete, and verify it is validated and persisted into the agent-reported
columns without touching the orchestrator's `outcome`/`pr_url`.

## Setup

- Target: `k-mats/superset`, label `devin-ready`; issue `#1` is the
  intake-verification test issue, so the expected agent outcome was
  `no_action` or `needs_human` (the contract, not the remediation, is under
  test).
- Fresh SQLite database (`DATABASE_PATH=./data/issue-10-evidence.db`).
- PR #51 branch (`devin/1789924764-issue-10-…`, name kept for continuity) at `956f921`.
- `.env` did not provide `DEVIN_API_KEY`, `DEVIN_ORG_ID`, `GITHUB_TOKEN`,
  `GITHUB_REPO_OWNER`, or `GITHUB_REPO_NAME`; all were supplied via the
  environment at run time. Values are not recorded here.

## Sequence

```bash
pnpm demo:intake                  # creates task + pending attempt
pnpm demo:dispatch                # creates session (poll 0 below)
pnpm demo:structured-output --attempt 1     # poll 0: turn incomplete
pnpm demo:structured-output --attempt 1     # poll 1 (~2 min later): recorded
curl GET .../sessions/<id>        # independent read of the response shape
```

## Result

| Step           | Outcome                                                                           |
| -------------- | --------------------------------------------------------------------------------- |
| intake         | 1 task created, attempt 1 `pending`                                               |
| dispatch       | `dispatched: 1`, attempt -> `session_created`                                     |
| outcome poll 0 | `session_not_finished`, nothing persisted                                         |
| outcome poll 1 | `recorded`, `agent_outcome = no_action`                                           |
| session GET    | `status: running`, `status_detail: waiting_for_user`, `structured_output` present |

Created session: `959dbaeaede348cea8eef5692d402dc1`
(https://app.devin.ai/sessions/959dbaeaede348cea8eef5692d402dc1).

The returned `structured_output` validated against the zod schema
(`schema_version: 1`, `outcome: "no_action"`, `pr_url: null`,
`needs_human_reason: null`, non-empty `diagnosis`, empty `tests_run`, one
`risks` entry) and was persisted to `structured_output_raw`, `agent_outcome`,
`agent_pr_url`, `agent_diagnosis`, `agent_tests_run`, `agent_risks`, and
`needs_human_reason`. The orchestrator fields were untouched: `state` stayed
`session_created`, `outcome`/`outcome_reason`/`pr_url` stayed NULL.

Notes:

- The dispatch log does not print the `createSession` request body, so
  `structured_output_schema`/`structured_output_required: true` on the request
  is covered by unit tests (`tests/devin-dispatcher.test.ts`,
  `tests/devin-client.test.ts`); the presence of a schema-conforming
  `structured_output` in the GET response is the live-run evidence.
- `waiting_for_user` counted as turn-complete, matching the Issue #5 smoke
  observation: the session kept `status: "running"` while already carrying
  the final `structured_output`.

## Post-run changes

The session-phase handling was refined after this run (same PR): the boolean
turn-complete check became `classifySessionPhase` (`in_progress`,
`waiting_for_user`, `suspended`, `finished`, `error`) and the collector's
decision names were extended (`awaiting_user_without_output`,
`session_suspended_without_output`, `escalated_session_error`,
`already_recorded`); `structured_output_accepted_at` was added for idempotent
acceptance. Under the current code, the run's poll 0 maps to
`session_not_finished` and poll 1 maps to `recorded` — the live session's
`running`/`waiting_for_user` plus valid `structured_output` still records.
The migration was regenerated and squashed into `0003_yielding_lily_hollister`
(columns) + `0004_stormy_purifiers` (CHECK constraint).

## Not verified

- No PR was opened (`no_action`), so the `remediated`/`needs_human` paths were
  not exercised live; their invariants are covered by unit tests.
- Periodic outcome polling (Issue #11) and independent verification of
  agent-reported PRs/CI were not performed.

## Raw log (tokens redacted)

```text
### intake
$ tsx scripts/intake-demo.ts
issue_number: 1, title: '[intake-test] Verify periodic GitHub intake discovery'
attempt_id: 1, correlation_id: 'c44b6398-4ab6-49b1-b4eb-8ba78b02c700'
attempt 1 state: 'pending'

### dispatch
$ tsx scripts/dispatch-demo.ts
{ attempt_id: 1,
  correlation_id: 'c44b6398-4ab6-49b1-b4eb-8ba78b02c700',
  devin_session_id: '959dbaeaede348cea8eef5692d402dc1',
  url: 'https://app.devin.ai/sessions/959dbaeaede348cea8eef5692d402dc1' }
'Created Devin session'
{ pending: 1, dispatched: 1, claimLost: 0, cancelled: 0, deferred: 0, failed: 0 }
attempt 1 state: 'session_created'

### outcome poll 0 (immediately after dispatch)
$ tsx scripts/structured-output-demo.ts --attempt 1
'Devin session turn is not complete; leaving outcome uncollected'
Decision: session_not_finished
structuredOutputRaw: null (nothing persisted)

### outcome poll 1 (~2 minutes later)
$ tsx scripts/structured-output-demo.ts --attempt 1
{ attempt_id: 1, devin_session_id: '959dbaeaede348cea8eef5692d402dc1',
  agent_outcome: 'no_action', pr_url: null }
'Recorded structured output from Devin session'
Decision: recorded
Raw structured_output:
{
  "schema_version": 1,
  "outcome": "no_action",
  "pr_url": null,
  "diagnosis": "Issue #1 in k-mats/superset is an intake-verification test
    issue ... It describes no defect or behavior in Superset, so there is no
    root cause to diagnose and no code change is warranted. The issue can
    simply be closed by the intake system/owner.",
  "tests_run": [],
  "risks": ["The issue remains open; closing it is left to the intake system
    or a human since no PR was opened."],
  "needs_human_reason": null
}
attempt 1: state 'session_created', outcome null, outcomeReason null,
prUrl null, agentOutcome 'no_action', agentPrUrl null, needsHumanReason null,
structuredOutputRaw = exact JSON above

### independent GET
$ curl -H "Authorization: Bearer ***" \
    https://api.devin.ai/v3/organizations/<org>/sessions/959dbaeaede348cea8eef5692d402dc1
{ "session_id": "959dbaeaede348cea8eef5692d402dc1",
  "status": "running", "status_detail": "waiting_for_user",
  "title": "Remediate k-mats/superset#1: [intake-test] Verify periodic GitHub intake discovery",
  "acus_consumed": 0.0,
  "structured_output": { ...as above... }, ... }
```

Full run logs: `issue10-evidence/{intake,dispatch,outcome-poll-0,
outcome-poll-1}.log` and `issue10-evidence/session-get.json` on the run
machine.
