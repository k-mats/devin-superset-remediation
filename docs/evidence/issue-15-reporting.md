# Issue #15 — Reporting view real-run evidence

## Purpose

Show that a real remediation (not a test seed) appears in `GET /api/report` and
`GET /dashboard` while it is in progress and ends in the correct normalized
state derived from Issue #14's `projectTaskState`.

## Subject

- GitHub issue: https://github.com/k-mats/superset/issues/13
- Devin session (adopted, same as Issue #13 evidence; no new session was
  dispatched): https://app.devin.ai/sessions/5957ce490e56465b930e0349ace6db68
- Remediation PR: https://github.com/k-mats/superset/pull/14 (open, head
  `f22d3d3f55b19803542416f4150a62cbc7607fc0`)
- Orchestrator branch: `devin/1789999883-issue-15-reporting` (PR #56)

## Setup

- Fresh SQLite database `DATABASE_PATH=./data/evidence-issue-15.db` (the
  dashboard header shows this path as the data source).
- `pnpm dev` running with intake + tracking pollers enabled,
  `DEVIN_DISPATCH_INTERVAL_MS=0` (no new Devin session), `VERIFICATION_ENABLED=true`,
  `GITHUB_REPO_OWNER=k-mats`, `GITHUB_REPO_NAME=superset`.
- Credentials supplied via environment; they are not recorded here and do not
  appear in any report response.

## Sequence

```bash
pnpm demo:intake                                             # task 1 / attempt 1 (pending)
pnpm dev &                                                   # server: /dashboard, /api/report, pollers
pnpm demo:adopt-session --attempt 1 --session 5957ce49…      # attach existing session
# tracking poll: PR #14 verified, github_checks unverified (no_checks), command spec pending
pnpm verification:propose --attempt 1 --command \
  "pytest tests/unit_tests/mcp_service/dataset/tool/test_query_dataset.py::test_query_dataset_reversed_time_range -q"
pnpm verification:approve --attempt 1 --spec-hash 590eadd1…
# next tracking poll: command verification passed -> completed / succeeded
```

## Report snapshots (`GET /api/report`, request-time)

| Snapshot (`generatedAt`)   | task `state` | `reason`                      | bucket       | attempt state | `byBucket`                  |
| -------------------------- | ------------ | ----------------------------- | ------------ | ------------- | --------------------------- |
| `2026-09-21T14:59:15.933Z` | `QUEUED`     | `attempt_pending`             | `active`     | `pending`     | `active: 1`                 |
| `2026-09-21T15:00:19.879Z` | `VERIFYING`  | `spec_pending_approval`       | `active`     | `verifying`   | `active: 1`                 |
| `2026-09-21T15:02:51.037Z` | `VERIFIED`   | `command_verification_passed` | `successful` | `completed`   | `successful: 1`, others `0` |

Final snapshot excerpt:

```json
{
  "context": {
    "databasePath": "/home/ubuntu/repos/devin-superset-remediation/data/evidence-issue-15.db",
    "nodeEnv": "development",
    "repository": "k-mats/superset"
  },
  "summary": {
    "totalTasks": 1,
    "byBucket": {
      "active": 0,
      "successful": 1,
      "needs_human": 0,
      "failed": 0,
      "no_action": 0,
      "cancelled": 0
    },
    "terminalWithoutTimestamp": 0
  },
  "throughput": {
    "tasksDiscovered": { "last24h": 1, "last7d": 1 },
    "tasksReachedTerminal": { "last24h": 1, "last7d": 1 },
    "tasksVerified": { "last24h": 1, "last7d": 1 },
    "attemptsCreated": { "last24h": 1, "last7d": 1 }
  },
  "cycleTime": { "medianMsIntakeToTerminal": 194561, "sampleSize": 1 },
  "tasks": [
    {
      "issueNumber": 13,
      "issueUrl": "https://github.com/k-mats/superset/issues/13",
      "state": "VERIFIED",
      "reason": "command_verification_passed",
      "bucket": "successful",
      "attemptCount": 1,
      "currentAttempt": {
        "attemptNumber": 1,
        "state": "completed",
        "outcome": "succeeded",
        "outcomeReason": "independent_verification_passed: f22d3d3f55b19803542416f4150a62cbc7607fc0",
        "devinSessionUrl": "https://app.devin.ai/sessions/5957ce490e56465b930e0349ace6db68",
        "prUrl": "https://github.com/k-mats/superset/pull/14",
        "prState": "open",
        "createdAt": 1790002722022,
        "completedAt": 1790002916580,
        "projection": {
          "raw": {
            "githubChecks": { "status": "unverified", "reason": "no_checks" },
            "command": {
              "status": "passed",
              "specSha256": "590eadd10bdffac99af35dcba67a28c4330b33bca2fda534b812b58711dc13df"
            }
          }
        }
      }
    }
  ]
}
```

The `VERIFYING` snapshot was taken while the PR already existed and had been
verified by the tracker; the task was still counted as `active`, not
`successful` — success requires `VERIFIED`.

## Dashboard (`GET /dashboard`) after verification

![dashboard showing task #13 VERIFIED](https://app.devin.ai/attachments/3bbcdd0e-5bac-4715-b9ba-031c4f202c62/ss_760d8852.png)

The row shows issue link + title, `VERIFIED / command_verification_passed`,
outcome reason with the verified head SHA, attempt `1 / 1`, Devin session link,
`PR #14 (open)`, and last-updated timestamp; the header shows the resolved
database path, `NODE_ENV`, and repository.

## Acceptance criteria mapping

| Criterion                                          | Evidence                                                        |
| -------------------------------------------------- | --------------------------------------------------------------- |
| Real remediation visible mid-lifecycle             | `QUEUED` and `VERIFYING` snapshots above                        |
| Final state is the normalized state from Issue #14 | `VERIFIED` / `command_verification_passed`, bucket `successful` |
| PR existence alone is not success                  | `VERIFYING` snapshot (PR #14 open) counted as `active`          |
| Report reflects the configured DB only             | `context.databasePath` = `data/evidence-issue-15.db`            |
| No secrets in responses                            | report contains only issue/session/PR URLs, states, timestamps  |

Raw snapshots and server log kept locally under `data/evidence15/` and
`data/logs/issue15-server.log` (gitignored).
