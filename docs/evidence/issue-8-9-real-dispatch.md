# Issues #8 / #9 — Real dispatch evidence

## Purpose

Exercise the real dispatch path (`runDispatchOnce` with the production
`DevinClient` and `GitHubClient`) once against the Superset fork, and show that
repeated intake/dispatch runs do not create a second Devin session.

## Setup

- Target: `k-mats/superset`, label `devin-ready`; exactly one eligible open
  issue at run time (`#1 [intake-test] Verify periodic GitHub intake discovery`).
- Fresh SQLite database (`DATABASE_PATH=./data/dispatch-evidence.db`).
- Branch `devin/1789918155-issue-8-9-dispatch-dedup` at `79f607d`.
- Credentials supplied via environment (`DEVIN_API_KEY`, `DEVIN_ORG_ID`,
  `GITHUB_TOKEN`); values are not recorded here.

## Sequence

```bash
pnpm demo:intake     # creates task + pending attempt
pnpm demo:dispatch   # run 1: claims, revalidates GitHub, creates session
pnpm demo:dispatch   # run 2: nothing pending -> no Devin call
pnpm demo:intake     # run 2: issue already tracked -> skipped
```

## Result

| Step           | Outcome                                       |
| -------------- | --------------------------------------------- |
| intake run 1   | 1 task created, attempt 1 `pending`           |
| dispatch run 1 | `dispatched: 1`, attempt -> `session_created` |
| dispatch run 2 | `dispatched: 0`, no `createSession()` call    |
| intake run 2   | `skipped: 1`, no new attempt                  |

Created session: `08366afe92f34d2885233f2340935399`
(https://app.devin.ai/sessions/08366afe92f34d2885233f2340935399).

`GET /organizations/{org}/sessions/{id}` afterwards returned
`status: "running"`, title
`Remediate k-mats/superset#1: [intake-test] Verify periodic GitHub intake discovery`,
tags `devin-superset-remediation`, `task:1`, `attempt:1`,
`correlation:e0565681-...`, `issue:k-mats/superset#1`.

Note: the Get Session response does not include `max_acu_limit` (the
documented response exposes `acus_consumed` instead; it was `0.0` right after
creation), so the configured limit of 5 cannot be confirmed from the GET
response. The request body did include `max_acu_limit: 5`.

## Raw log (tokens redacted)

```text
### intake
$ tsx scripts/intake-demo.ts
◇ injected env (6) from .env
{
  issue_number: 1,
  title: '[intake-test] Verify periodic GitHub intake discovery',
  html_url: 'https://github.com/k-mats/superset/issues/1',
  attempt_id: 1,
  correlation_id: 'e0565681-2b95-4ede-befa-8e8dcee002a3'
} Created GitHub intake task
{
  repoOwner: 'k-mats',
  repoName: 'superset',
  label: 'devin-ready',
  fetched: 1,
  created: 1,
  skipped: 0,
  ineligible: 0
} GitHub intake completed
Intake result:
┌────────────┬────────┐
│ (index)    │ Values │
├────────────┼────────┤
│ fetched    │ 1      │
│ created    │ 1      │
│ skipped    │ 0      │
│ ineligible │ 0      │
└────────────┴────────┘
Tasks:
┌─────────┬────┬───────────┬────────────┬─────────────┬─────────────────────────────────────────────────────────┬───────────────┬───────────────┐
│ (index) │ id │ repoOwner │ repoName   │ issueNumber │ title                                                   │ createdAt     │ updatedAt     │
├─────────┼────┼───────────┼────────────┼─────────────┼─────────────────────────────────────────────────────────┼───────────────┼───────────────┤
│ 0       │ 1  │ 'k-mats'  │ 'superset' │ 1           │ '[intake-test] Verify periodic GitHub intake discovery' │ 1789921312330 │ 1789921312330 │
└─────────┴────┴───────────┴────────────┴─────────────┴─────────────────────────────────────────────────────────┴───────────────┴───────────────┘
Attempts:
┌─────────┬────┬────────┬───────────────┬────────────────────────────────────────┬───────────┬─────────┬───────────────┬────────────────┬─────────────────┬───────┬───────────────┬───────────────┬──────────────┬──────────────────┬─────────────┐
│ (index) │ id │ taskId │ attemptNumber │ correlationId                          │ state     │ outcome │ outcomeReason │ devinSessionId │ devinSessionUrl │ prUrl │ createdAt     │ updatedAt     │ dispatchedAt │ sessionCreatedAt │ completedAt │
├─────────┼────┼────────┼───────────────┼────────────────────────────────────────┼───────────┼─────────┼───────────────┼────────────────┼─────────────────┼───────┼───────────────┼───────────────┼──────────────┼──────────────────┼─────────────┤
│ 0       │ 1  │ 1      │ 1             │ 'e0565681-2b95-4ede-befa-8e8dcee002a3' │ 'pending' │ null    │ null          │ null           │ null            │ null  │ 1789921312332 │ 1789921312332 │ null         │ null             │ null        │
└─────────┴────┴────────┴───────────────┴────────────────────────────────────────┴───────────┴─────────┴───────────────┴────────────────┴─────────────────┴───────┴───────────────┴───────────────┴──────────────┴──────────────────┴─────────────┘

### dispatch run 1
$ tsx scripts/dispatch-demo.ts
◇ injected env (6) from .env
{
  attempt_id: 1,
  correlation_id: 'e0565681-2b95-4ede-befa-8e8dcee002a3',
  devin_session_id: '08366afe92f34d2885233f2340935399',
  url: 'https://app.devin.ai/sessions/08366afe92f34d2885233f2340935399'
} Created Devin session
{
  pending: 1,
  dispatched: 1,
  claimLost: 0,
  cancelled: 0,
  deferred: 0,
  failed: 0
} Devin dispatch completed
Dispatch result:
┌────────────┬────────┐
│ (index)    │ Values │
├────────────┼────────┤
│ pending    │ 1      │
│ dispatched │ 1      │
│ claimLost  │ 0      │
│ cancelled  │ 0      │
│ deferred   │ 0      │
│ failed     │ 0      │
└────────────┴────────┘
Attempts:
┌─────────┬────┬────────┬───────────────┬────────────────────────────────────────┬───────────────────┬─────────┬───────────────┬────────────────────────────────────┬──────────────────────────────────────────────────────────────────┬───────┬───────────────┬───────────────┬───────────────┬──────────────────┬─────────────┐
│ (index) │ id │ taskId │ attemptNumber │ correlationId                          │ state             │ outcome │ outcomeReason │ devinSessionId                     │ devinSessionUrl                                                  │ prUrl │ createdAt     │ updatedAt     │ dispatchedAt  │ sessionCreatedAt │ completedAt │
├─────────┼────┼────────┼───────────────┼────────────────────────────────────────┼───────────────────┼─────────┼───────────────┼────────────────────────────────────┼──────────────────────────────────────────────────────────────────┼───────┼───────────────┼───────────────┼───────────────┼──────────────────┼─────────────┤
│ 0       │ 1  │ 1      │ 1             │ 'e0565681-2b95-4ede-befa-8e8dcee002a3' │ 'session_created' │ null    │ null          │ '08366afe92f34d2885233f2340935399' │ 'https://app.devin.ai/sessions/08366afe92f34d2885233f2340935399' │ null  │ 1789921312332 │ 1789921313825 │ 1789921313046 │ 1789921313825    │ null        │
└─────────┴────┴────────┴───────────────┴────────────────────────────────────────┴───────────────────┴─────────┴───────────────┴────────────────────────────────────┴──────────────────────────────────────────────────────────────────┴───────┴───────────────┴───────────────┴───────────────┴──────────────────┴─────────────┘

### dispatch run 2 (expect no new session)
$ tsx scripts/dispatch-demo.ts
◇ injected env (6) from .env
{
  pending: 0,
  dispatched: 0,
  claimLost: 0,
  cancelled: 0,
  deferred: 0,
  failed: 0
} Devin dispatch completed
Dispatch result:
┌────────────┬────────┐
│ (index)    │ Values │
├────────────┼────────┤
│ pending    │ 0      │
│ dispatched │ 0      │
│ claimLost  │ 0      │
│ cancelled  │ 0      │
│ deferred   │ 0      │
│ failed     │ 0      │
└────────────┴────────┘
Attempts:
┌─────────┬────┬────────┬───────────────┬────────────────────────────────────────┬───────────────────┬─────────┬───────────────┬────────────────────────────────────┬──────────────────────────────────────────────────────────────────┬───────┬───────────────┬───────────────┬───────────────┬──────────────────┬─────────────┐
│ (index) │ id │ taskId │ attemptNumber │ correlationId                          │ state             │ outcome │ outcomeReason │ devinSessionId                     │ devinSessionUrl                                                  │ prUrl │ createdAt     │ updatedAt     │ dispatchedAt  │ sessionCreatedAt │ completedAt │
├─────────┼────┼────────┼───────────────┼────────────────────────────────────────┼───────────────────┼─────────┼───────────────┼────────────────────────────────────┼──────────────────────────────────────────────────────────────────┼───────┼───────────────┼───────────────┼───────────────┼──────────────────┼─────────────┤
│ 0       │ 1  │ 1      │ 1             │ 'e0565681-2b95-4ede-befa-8e8dcee002a3' │ 'session_created' │ null    │ null          │ '08366afe92f34d2885233f2340935399' │ 'https://app.devin.ai/sessions/08366afe92f34d2885233f2340935399' │ null  │ 1789921312332 │ 1789921313825 │ 1789921313046 │ 1789921313825    │ null        │
└─────────┴────┴────────┴───────────────┴────────────────────────────────────────┴───────────────────┴─────────┴───────────────┴────────────────────────────────────┴──────────────────────────────────────────────────────────────────┴───────┴───────────────┴───────────────┴───────────────┴──────────────────┴─────────────┘

### intake run 2 (expect duplicate skip)
$ tsx scripts/intake-demo.ts
◇ injected env (6) from .env
{
  issue_number: 1,
  title: '[intake-test] Verify periodic GitHub intake discovery',
  html_url: 'https://github.com/k-mats/superset/issues/1',
  reason: 'existing_attempt'
} Skipped GitHub issue with existing attempt history
{
  repoOwner: 'k-mats',
  repoName: 'superset',
  label: 'devin-ready',
  fetched: 1,
  created: 0,
  skipped: 1,
  ineligible: 0
} GitHub intake completed
Intake result:
┌────────────┬────────┐
│ (index)    │ Values │
├────────────┼────────┤
│ fetched    │ 1      │
│ created    │ 0      │
│ skipped    │ 1      │
│ ineligible │ 0      │
└────────────┴────────┘
Tasks:
┌─────────┬────┬───────────┬────────────┬─────────────┬─────────────────────────────────────────────────────────┬───────────────┬───────────────┐
│ (index) │ id │ repoOwner │ repoName   │ issueNumber │ title                                                   │ createdAt     │ updatedAt     │
├─────────┼────┼───────────┼────────────┼─────────────┼─────────────────────────────────────────────────────────┼───────────────┼───────────────┤
│ 0       │ 1  │ 'k-mats'  │ 'superset' │ 1           │ '[intake-test] Verify periodic GitHub intake discovery' │ 1789921312330 │ 1789921312330 │
└─────────┴────┴───────────┴────────────┴─────────────┴─────────────────────────────────────────────────────────┴───────────────┴───────────────┘
Attempts:
┌─────────┬────┬────────┬───────────────┬────────────────────────────────────────┬───────────────────┬─────────┬───────────────┬────────────────────────────────────┬──────────────────────────────────────────────────────────────────┬───────┬───────────────┬───────────────┬───────────────┬──────────────────┬─────────────┐
│ (index) │ id │ taskId │ attemptNumber │ correlationId                          │ state             │ outcome │ outcomeReason │ devinSessionId                     │ devinSessionUrl                                                  │ prUrl │ createdAt     │ updatedAt     │ dispatchedAt  │ sessionCreatedAt │ completedAt │
├─────────┼────┼────────┼───────────────┼────────────────────────────────────────┼───────────────────┼─────────┼───────────────┼────────────────────────────────────┼──────────────────────────────────────────────────────────────────┼───────┼───────────────┼───────────────┼───────────────┼──────────────────┼─────────────┤
│ 0       │ 1  │ 1      │ 1             │ 'e0565681-2b95-4ede-befa-8e8dcee002a3' │ 'session_created' │ null    │ null          │ '08366afe92f34d2885233f2340935399' │ 'https://app.devin.ai/sessions/08366afe92f34d2885233f2340935399' │ null  │ 1789921312332 │ 1789921313825 │ 1789921313046 │ 1789921313825    │ null        │
└─────────┴────┴────────┴───────────────┴────────────────────────────────────────┴───────────────────┴─────────┴───────────────┴────────────────────────────────────┴──────────────────────────────────────────────────────────────────┴───────┴───────────────┴───────────────┴───────────────┴──────────────────┴─────────────┘
```
