# Issue #22 — Signed GitHub webhook fast path evidence

## Purpose

Show that `POST /webhooks/github` accepts only correctly signed GitHub `issues`
deliveries for the configured repository, feeds them through the **same**
`isEligibleIssue()` → `intakeIssue()` path as polling, and therefore cannot
create duplicate tasks or attempts when a delivery is replayed or when the
webhook and the poller both observe the same issue. No schema migration, no
delivery table, and no webhook-specific dedup state were added.

## Evidence classes

- **Deterministic tests** — `tests/github-webhook.test.ts` (47 tests) signs
  fixtures locally with a known secret and drives the route with
  `fastify.inject`; `tests/startup.test.ts` covers registration behaviour;
  `tests/config.test.ts` covers the blank-secret rule. No GitHub or Devin
  credentials, tunnel, or network access are required.
- **Local live run** — the real server process started with a webhook secret
  and exercised with `curl` + `openssl dgst -hmac` (below). No real GitHub
  delivery was received; a public endpoint is out of scope for this issue.

## Endpoint

- Route: `POST /webhooks/github` — `src/routes/github-webhook.ts`
- Handler / rules: `src/intake/github-webhook.ts`
- Registration: `src/index.ts` — registered only when `GITHUB_WEBHOOK_SECRET`,
  `GITHUB_REPO_OWNER`, and `GITHUB_REPO_NAME` are all set. A blank
  `GITHUB_WEBHOOK_SECRET=` is treated as unset (`envValue()` in
  `src/config.ts`). Without the secret the server logs
  `GitHub webhook intake disabled (GITHUB_WEBHOOK_SECRET not set)` and the
  route is a 404; polling is unaffected.

Response codes:

| Situation                                                                  | Code                                   |
| -------------------------------------------------------------------------- | -------------------------------------- |
| Content type other than `application/json`                                 | 415 (Fastify, parser scoped to plugin) |
| Missing / malformed / wrong `X-Hub-Signature-256`                          | 401 `{ error: 'Invalid signature' }`   |
| Signed but malformed JSON or non-`issues` payload shape                    | 400 `{ error }`                        |
| Non-`issues` event, other repository, unsupported action, ineligible issue | 200 `{ status: 'ignored', reason }`    |
| Eligible issue                                                             | 200 `{ status: 'accepted', decision }` |

## Signature implementation

`verifyGitHubSignature(rawBody, header, secret)` in
`src/intake/github-webhook.ts`:

1. Header must start with `sha256=` and the remainder must be exactly 64 hex
   characters; anything else is rejected before any HMAC is computed.
2. The expected digest is `HMAC-SHA256(secret, rawBody)` over the **Buffer
   Fastify handed to the route** — the plugin replaces the JSON parser with
   `addContentTypeParser('application/json', { parseAs: 'buffer' })` inside
   its own encapsulation context, so no JSON transformation happens first.
3. Comparison uses `crypto.timingSafeEqual` on the hex-decoded provided digest
   and the computed digest (equal length guaranteed by step 1).
4. `JSON.parse` and zod validation run only after step 3 succeeds.

The raw-bytes property is asserted directly by
`verifies the signature over the exact raw bytes, not re-serialized JSON`: the
same JSON value with different whitespace/key order is rejected when signed
over its canonical re-serialization and accepted when signed over the exact
bytes sent. `does not leak the buffer parser to sibling routes` proves a
sibling `POST /echo` still receives parsed JSON.

Logs contain `delivery_id`, `event`, `action`, `issue_number`, and a
`signature_present` boolean — never the secret or the signature value.

## Signed fixture test

`tests/github-webhook.test.ts › valid signed intake`:

- `accepts a correctly signed issues webhook and persists one task and one
pending attempt` — asserts exactly one row in `tasks` and one `pending` row
  in `attempts`, with `repoOwner`/`repoName` from configuration.
- `opened`, `reopened`, `labeled` each accepted for an eligible issue.

Signature failures (`signature failures`): missing, malformed (`sha256=not-hex`),
wrong secret, wrong digest, and a payload modified after signing all return
401 and `tasks`/`attempts` stay empty. Unit tests on `verifyGitHubSignature`
additionally cover empty header, `sha1=` prefix, no prefix, 63/65-char
digests, non-hex characters, upper-case hex (accepted).

Eligibility / scope (`eligibility and scope`): unexpected repository,
case-insensitive repository match persisting the configured identity,
`issue_comment` event, missing event header, `edited`/`closed`/`unlabeled`/
`assigned`/`deleted` actions, `labeled` with a non-intake label, `opened`
without the label, pull requests and closed issues carrying the label — all
`ignored` with no state change; a `labeled` event for a _different_ label on an
issue that already carries `devin-ready` is accepted (the payload `label`
field is deliberately not special-cased).

## Replay test

`replaying the same signed fixture creates no additional task or attempt` —
the identical signed body is posted five times with distinct
`X-GitHub-Delivery` ids. First response `decision: 'created'`, the remaining
four `decision: 'skipped_existing_attempt'`; one task, one attempt.

## Webhook → polling convergence test

`webhook followed by polling creates no duplicate work` — webhook creates the
task; a subsequent `runIntakeOnce()` returning the same issue reports
`{ created: 0, skipped: 1 }`; one task, one attempt.

## Polling → webhook convergence test

`polling followed by webhook creates no duplicate work` — `runIntakeOnce()`
creates the task; the subsequent signed webhook returns
`decision: 'skipped_existing_attempt'`; one task, one attempt.

Race: `a webhook losing an intake race to polling reports the conflict without
duplicate attempts` — `createAttempt` is made to throw
`ActiveAttemptExistsError` inside the webhook transaction (the DB-level
partial unique index firing after polling committed first); the webhook
responds 200 `decision: 'skipped_active_attempt_conflict'`, its transaction
rolls back, and the store ends with one attempt.
`interleaved webhook and polling for several issues converge on one attempt
each` interleaves `Promise.all` of a poll pass and three webhook posts over
three issues and asserts three tasks / three attempts.

## Startup behaviour

`tests/startup.test.ts`:

- blank secret → `/webhooks/github` is 404;
- secret without `GITHUB_REPO_OWNER`/`GITHUB_REPO_NAME` → 404, warning logged;
- secret + repository, **no** `GITHUB_TOKEN` → route registered (401 for an
  unsigned post), `/api/report` still 200, no outbound `fetch`.

## Local live run

Server started from the working tree with
`GITHUB_WEBHOOK_SECRET=evidence-secret GITHUB_REPO_OWNER=k-mats
GITHUB_REPO_NAME=superset GITHUB_POLL_INTERVAL_MS=0 DEVIN_DISPATCH_INTERVAL_MS=0
DEVIN_TRACKING_INTERVAL_MS=0 DATABASE_PATH=./data/evidence-issue-22.db PORT=3123`
(fresh database, no GitHub/Devin credentials). Signature computed with
`openssl dgst -sha256 -hmac evidence-secret` over the exact body string.

```text
--- missing signature
{"error":"Invalid signature"} [401]
--- wrong secret
{"error":"Invalid signature"} [401]
--- form content type
{"statusCode":415,"code":"FST_ERR_CTP_INVALID_MEDIA_TYPE","error":"Unsupported Media Type","message":"Unsupported Media Type"} [415]
--- valid (1st)
{"status":"accepted","decision":"created","issueNumber":13} [200]
--- replay (2nd)
{"status":"accepted","decision":"skipped_existing_attempt","issueNumber":13} [200]
--- other event
{"status":"ignored","reason":"unsupported_event"} [200]
--- /api/report
"summary":{"totalTasks":1,"byBucket":{"active":1,...},"byState":{"QUEUED":1,...
```

Server log excerpt (pid/hostname/time removed):

```text
{"level":30,"path":"/webhooks/github","msg":"GitHub webhook intake enabled"}
{"level":40,"delivery_id":"d1","event":"issues","signature_present":false,"msg":"Rejected GitHub webhook with missing or invalid signature"}
{"level":40,"delivery_id":"d2","event":"issues","signature_present":true,"msg":"Rejected GitHub webhook with missing or invalid signature"}
{"level":30,"delivery_id":"d3","event":"issues","action":"labeled","issue_number":13,"title":"Evidence issue","html_url":"https://github.com/k-mats/superset/issues/13","attempt_id":1,"correlation_id":"a6e78654-…","msg":"Created GitHub intake task from webhook"}
{"level":30,"delivery_id":"d4","event":"issues","action":"labeled","issue_number":13,"html_url":"https://github.com/k-mats/superset/issues/13","reason":"existing_attempt","msg":"Skipped GitHub webhook issue with existing attempt history"}
```

## CI run

`pnpm check` (format:check, lint, type-check, test, build) passed locally on
the PR branch: 24 test files, 388 tests. The GitHub Actions run for the PR is
linked from the pull request.

## Not done / out of scope (per issue non-goals)

- No real GitHub delivery through a public URL was received.
- No webhook delivery history, retry queue, or `X-GitHub-Delivery` dedup.
- Dispatch semantics unchanged; dispatch still re-validates the issue against
  GitHub before creating a Devin session.
