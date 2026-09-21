# Issue #11 — Session and pull request lifecycle evidence

## Purpose

Exercise the tracking poller end-to-end with one real Devin session that
opens a pull request: observe the session snapshot being persisted on every
poll, the `running` transition, structured-output collection, independent
GitHub verification of the agent-reported PR, the transition into the active
`verifying` state (with `outcome` still NULL), and PR state/head SHA refresh
while verifying.

## Setup

- Target: `k-mats/superset`, label `devin-ready`. A dedicated test issue was
  created for this run: `k-mats/superset#8` — _docs: fix "cancelation" typo in
  db_engine_specs README_ (three occurrences at lines 1316/1320/1322, docs
  only). Issue `#1` (intake test issue) still carried the label and was also
  picked up by intake; see "Deviations" below.
- Fresh SQLite database (`DATABASE_PATH=./data/issue-11-evidence.db`).
- PR #52 branch (`devin/1789932399-issue-11-session-pr-tracking`) at `35067a9`.
- `DEVIN_API_KEY`, `DEVIN_ORG_ID`, `GITHUB_TOKEN`, `GITHUB_REPO_OWNER`,
  `GITHUB_REPO_NAME` were supplied via the environment at run time (not from
  `.env`). Values are not recorded here. `GITHUB_TOKEN` was a read-capable
  token for the public `k-mats/superset` repository.
- Tracking was driven manually with `pnpm demo:tracking` (one pass per
  invocation) instead of the in-process interval, so each observation is a
  discrete, logged step.

## Sequence

```bash
pnpm demo:intake            # tasks for superset#8 (attempt 1) and superset#1 (attempt 2)
pnpm demo:dispatch          # 2 sessions created
# attempt 2 (superset#1) session terminated via DELETE /sessions/{id}; attempt 2 -> completed/cancelled
pnpm demo:tracking          # poll 0: running/working -> markedRunning, snapshot persisted
pnpm demo:tracking          # poll 1 (~5 min later): structured output recorded, PR verified -> verifying
pnpm demo:tracking          # poll 2: PR state/head SHA refreshed while verifying
curl GET .../sessions/<id>  # independent read of the Devin session
gh api repos/k-mats/superset/pulls/9  # independent read of the PR
```

## Result

| Step        | Decision / counters                         | Attempt 1 after the step                                                                                                                                             |
| ----------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| intake      | 2 tasks created                             | `pending`                                                                                                                                                            |
| dispatch    | `dispatched: 2`                             | `session_created`, `devin_session_id = cca5dbd787f04d57820a5740e79b73f4`                                                                                             |
| tracking p0 | `markedRunning: 1`                          | `running`; snapshot `running` / `working`, `acus_consumed = 0`, `session_updated_at = 1789973881000`, `session_last_polled_at` set                                   |
| tracking p1 | `verifying: 1` (structured output recorded) | `verifying`; `agent_outcome = remediated`, `agent_pr_url = …/pull/9`; verified `pr_url`/`pr_number = 9`/`pr_state = open`/`pr_head_sha = e43eecf…`; `outcome = NULL` |
| tracking p2 | `prRefreshed: 1`                            | still `verifying`; `pr_last_checked_at` and `session_last_polled_at` advanced, PR fields unchanged (`open`, same head SHA)                                           |

Created session: `cca5dbd787f04d57820a5740e79b73f4`
(https://app.devin.ai/sessions/cca5dbd787f04d57820a5740e79b73f4).

Created pull request: https://github.com/k-mats/superset/pull/9 (title
`docs: fix "cancelation" typo in db_engine_specs README`, body contains
`Fixes #8`, diff = 3 replacements in `superset/db_engine_specs/README.md`).

Observed invariants:

- The four lifecycle concepts stayed separate: Devin `status`/`status_detail`
  (`running`/`waiting_for_user`), agent `agent_outcome` (`remediated`),
  independently verified `pr_state` (`open`) and orchestrator `state`/`outcome`
  (`verifying`/`NULL`).
- `remediated` + verified PR did **not** become `succeeded`; the attempt
  entered `verifying` and `outcome`/`outcome_reason`/`completed_at` remained
  NULL.
- PR verification checked existence, owner/repo (`k-mats/superset`) and the
  issue reference (`Fixes #8`) against the GitHub PR API before promoting
  `agent_pr_url` to `pr_url`.
- The independent session GET agreed with the persisted snapshot
  (`status: running`, `status_detail: waiting_for_user`, `acus_consumed: 0.0`,
  `updated_at: 1789973938` → stored as `1789973938000` ms) and listed the same
  PR in `pull_requests`.
- `acus_consumed` was reported as `0.0` by the API for the whole run, so the
  column was exercised but only with a zero value.

## Deviations

- Issue `#1` still carried `devin-ready`, so intake created a second task and
  dispatch created a second session (`bf171a31553c44e49580f4dce193429c`). An
  attempt to cancel attempt 2 before dispatch failed (script module
  resolution) and the failure was masked by `tee`. The session was terminated
  immediately via the Devin API (`DELETE /organizations/{org}/sessions/{id}`,
  HTTP 200, `acus_consumed: 0.0`) and attempt 2 was then completed as
  `cancelled` with an operator reason. It did not participate in tracking.

## Not verified

- `verifying` → `completed / succeeded` (the later independent verification
  stage is out of scope for #11).
- `closed`/`merged` PR refresh and tracking stop: PR #9 stayed `open` during
  the run; the retention semantics are covered by unit tests.
- `needs_human` → `completed / escalated`, `no_action` → `completed / no_action`,
  and the missing/mismatched/unverifiable-PR escalation paths were not hit in
  this run; they are covered by `tests/session-tracker.test.ts`.
- The in-process interval poller (`DEVIN_TRACKING_INTERVAL_MS`) was not run as
  a long-lived service; the same `runTrackingOnce` was invoked manually.

## Raw log (tokens redacted, tables abbreviated)

```text
### intake
$ tsx scripts/intake-demo.ts
issue_number: 8, attempt_id: 1, correlation_id: '7adca649-01d9-4583-a9d5-ee1486138e5e'
issue_number: 1, attempt_id: 2, correlation_id: '8ef6de2b-b996-4af2-826e-932a158fb455'
attempts 1,2 state: 'pending'

### dispatch
$ tsx scripts/dispatch-demo.ts
{ attempt_id: 1, devin_session_id: 'cca5dbd787f04d57820a5740e79b73f4',
  url: 'https://app.devin.ai/sessions/cca5dbd787f04d57820a5740e79b73f4' } Created Devin session
{ attempt_id: 2, devin_session_id: 'bf171a31553c44e49580f4dce193429c', ... } Created Devin session
{ pending: 2, dispatched: 2, claimLost: 0, cancelled: 0, deferred: 0, failed: 0 }

### operator: terminate attempt 2 session, cancel attempt 2
DELETE .../sessions/bf171a31553c44e49580f4dce193429c?archive=false -> HTTP 200
2 completed cancelled 'operator: issue #1 is the intake test issue; Devin session terminated manually'

### tracking poll 0 (~50 s after dispatch)
$ tsx scripts/tracking-demo.ts
{ attempt_id: 1, status: 'running', phase: 'in_progress' }
  Devin session turn is not complete; leaving output uncollected
{ trackable: 1, trackedPullRequests: 0, snapshots: 0, markedRunning: 1, outputCollected: 0,
  escalated: 0, completedNoAction: 0, verifying: 0, prRefreshed: 0, prLookupDeferred: 0, failed: 0 }
attempt 1: state 'running', devinSessionStatus 'running', devinSessionStatusDetail 'working',
  acusConsumed 0, sessionUpdatedAt 1789973881000, sessionLastPolledAt 1789973914818,
  prUrl null, prNumber null, prState null, prHeadSha null, outcome null

### tracking poll 1 (~5 min later)
$ tsx scripts/tracking-demo.ts
{ attempt_id: 1, status: 'running', phase: 'waiting_for_user',
  agent_outcome: 'remediated', pr_url: 'https://github.com/k-mats/superset/pull/9' }
  Recorded structured output from Devin session
{ trackable: 1, ..., verifying: 1, prRefreshed: 0, failed: 0 }
attempt 1: state 'verifying', outcome null, outcomeReason null, completedAt null,
  devinSessionStatus 'running', devinSessionStatusDetail 'waiting_for_user', acusConsumed 0,
  sessionUpdatedAt 1789973938000, sessionLastPolledAt 1789974233075,
  prUrl 'https://github.com/k-mats/superset/pull/9', prNumber 9, prState 'open',
  prHeadSha 'e43eecfc85d20192f8c83a098f252a3ae10de203', prLastCheckedAt 1789974233569,
  agentOutcome 'remediated', agentPrUrl 'https://github.com/k-mats/superset/pull/9'
structured_output:
{
  "schema_version": 1,
  "outcome": "remediated",
  "pr_url": "https://github.com/k-mats/superset/pull/9",
  "diagnosis": "superset/db_engine_specs/README.md misspelled \"cancellation\" as \"cancelation\"
    at lines 1316, 1320 and 1322 ... Replaced all three occurrences; no other files contained the typo.",
  "tests_run": [{ "command": "grep -rn \"cancelation\" superset/db_engine_specs/README.md",
                  "result": "passed", "notes": "No matches after the fix; git diff --stat shows 1 file changed, +3/-3." }],
  "risks": ["Docs-only change; no automated tests apply. CI on the PR was still running at session end."],
  "needs_human_reason": null
}

### tracking poll 2 (~20 s later)
$ tsx scripts/tracking-demo.ts
{ trackable: 1, ..., verifying: 0, prRefreshed: 1, failed: 0 }
attempt 1: state 'verifying', prState 'open', prHeadSha 'e43eecfc…' (unchanged),
  prLastCheckedAt 1789974256138, sessionLastPolledAt 1789974255665

### independent GET (Devin)
$ curl -H "Authorization: Bearer ***" .../sessions/cca5dbd787f04d57820a5740e79b73f4
{ "status": "running", "status_detail": "waiting_for_user", "acus_consumed": 0.0,
  "updated_at": 1789973938,
  "pull_requests": [{ "pr_url": "https://github.com/k-mats/superset/pull/9", "pr_state": "open" }],
  "structured_output": { ...as above... } }

### independent GET (GitHub)
$ gh api repos/k-mats/superset/pulls/9
{ "state": "open", "merged": false, "head": "e43eecfc85d20192f8c83a098f252a3ae10de203",
  "title": "docs: fix \"cancelation\" typo in db_engine_specs README",
  "body": "... - [x] Has associated issue: Fixes #8 ..." }
```

Full run logs: `issue11-evidence/{intake,dispatch,cancel-attempt-2,tracking-poll-0,
tracking-poll-1,tracking-poll-2}.log`, `session-get.json`, `pr-9.json`, `pr-9.diff`
on the run machine.
