# Operations guide

Operational detail that was kept out of the [README](../README.md) evaluator
quick start: Docker behaviour, host prerequisites, verification spec format,
per-stage behaviour, and the manual single-pass scripts.

Runtime stack: TypeScript on Node.js 24 LTS (24.21.0), Fastify 5, SQLite with
Drizzle ORM and better-sqlite3, pnpm 12.4.2, Vitest 5, ESLint 10, Prettier.

## Docker

The whole solution is containerized: a multi-stage `Dockerfile` builds the
TypeScript application and produces a runtime image that also bundles `git`,
`uv`, Python 3.12, and the Superset native build dependencies
(`pkg-config`, `default-libmysqlclient-dev`, `libldap2-dev`, `libsasl2-dev`,
`libffi-dev`, `libssl-dev`, `gcc`, `g++`, `make`), so independent
verification (`src/verification/`, Issue #13) runs inside the container
unchanged — the Superset repo-setup adapter and an approved `pytest`
command were exercised end-to-end in a recorded in-container run
([evidence](evidence/issue-17-docker.md)). The container runs as the
non-root user `app` (uid 1001) and no secrets are baked into the image —
credentials are passed only via `.env` / environment variables at run time.

Prerequisites: Docker Engine 20.10+ (developed against Docker 29) and
Docker Compose v2+ (`docker compose`, developed against v5).

### Environment variables in compose

`.env` is loaded via `env_file`; the compose `environment:` block pins
`NODE_ENV=production`, `DATABASE_PATH=/app/data/orchestrator.db`,
`HOST=0.0.0.0`, `PORT=3000`, and
`VERIFICATION_WORKSPACE_ROOT=/app/data/verification` on top. With all
credentials unset the application still starts and serves health, readiness,
reporting, and the dashboard — only GitHub intake, Devin dispatch, and
session/PR tracking are skipped (each logs a warning).

| Group                      | Variables                                                                                                                                                                                        | Required?                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Minimal (works as-is)      | `PORT`, `HOST`, `NODE_ENV`, `DATABASE_PATH` (overridden in Docker), `LOG_LEVEL`                                                                                                                  | No — defaults in `.env.example` suffice |
| GitHub intake              | `GITHUB_TOKEN`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`, `GITHUB_INTAKE_LABEL`, `GITHUB_VERIFIED_LABEL`                                                                                          | Only for real orchestration             |
| Optional webhook fast path | `GITHUB_WEBHOOK_SECRET` (with `GITHUB_REPO_OWNER` / `GITHUB_REPO_NAME`) — see [GitHub webhook intake](#github-webhook-intake-issue-22)                                                           | No — polling remains the fallback       |
| Devin dispatch             | `DEVIN_API_KEY`, `DEVIN_ORG_ID`, `DEVIN_API_URL`, `DEVIN_MAX_ACU_PER_SESSION`                                                                                                                    | Only for real orchestration             |
| Optional: polling / tuning | `GITHUB_POLL_INTERVAL_MS`, `DEVIN_DISPATCH_INTERVAL_MS`, `DEVIN_TRACKING_INTERVAL_MS`, `DEVIN_RECONCILE_INTERVAL_MS`, `DEVIN_DISPATCH_GRACE_MS`, `DEVIN_SESSION_STALE_WARN_MS`, `VERIFICATION_*` | No — sensible defaults                  |

For local development outside Docker, `.env.example` sets
`NODE_ENV=development`, `PORT=3000`, `DATABASE_PATH=./database.db`,
`LOG_LEVEL=info`.

The default Compose configuration publishes only on loopback because the
operator routes can execute approved shell scripts; deployments that
intentionally expose webhook/operator traffic should use their own
network/reverse-proxy configuration.

### Persistence

The SQLite database lives on the named volume `orchestrator-data` mounted at
`/app/data` (which also holds the verification workspace under
`/app/data/verification`).

- `docker compose restart` — data kept
- `docker compose down && docker compose up -d` — data kept
- `docker compose down -v` — **deletes** the volume and all state

Verify persistence after the container is healthy:

```bash
docker compose exec app node -e "import('/app/dist/db/client.js').then(async ({runMigrations,closeDb})=>{runMigrations();const s=await import('/app/dist/db/task-state.js');const t=s.upsertTask({repoOwner:'k-mats',repoName:'superset',issueNumber:17,title:'Docker persistence check'});s.createAttempt(t.id);console.log(JSON.stringify(t));closeDb();})"
curl -s http://localhost:3000/api/report | grep -i docker
docker compose restart
curl -s http://localhost:3000/api/report | grep -i docker   # still present
```

### Single-command equivalent

Compose is the primary path; a plain `docker run` works too. Pass the same
overrides that `compose.yaml` pins (`.env.example` sets `NODE_ENV=development`
for local development, so it must be overridden explicitly here):

```bash
docker build -t devin-superset-remediation .
docker run --rm -p 127.0.0.1:3000:3000 --env-file .env \
  -e NODE_ENV=production -e HOST=0.0.0.0 \
  -e DATABASE_PATH=/app/data/orchestrator.db \
  -e VERIFICATION_WORKSPACE_ROOT=/app/data/verification \
  -v orchestrator-data:/app/data devin-superset-remediation
```

### Operator commands inside the container

The verification operator CLIs are compiled into the image under `dist/cli/`
and run with plain `node` — no `tsx` or dev dependencies required:

```bash
docker compose exec app node dist/cli/verification-propose.js --attempt <id> --command "<cmd>"
docker compose exec app node dist/cli/verification-approve.js --attempt <id> --spec-hash <sha256>
docker compose exec app node dist/cli/verification-show.js --attempt <id>
```

### Operator verification UI

The same review, proposal, approval, and explicit rerun workflow is available
at `/operator/attempts/<id>/verification`. The page is intentionally separate
from the reporting dashboard: verification scripts are visible only on this
operator surface, while raw command output remains excluded from reports.
Reruns are synchronous and warn before running checkout, repository setup, and
the approved shell script; they may take many minutes. A rerun returns `503
verification_disabled` when `VERIFICATION_ENABLED=false`, or `503
github_unavailable` when `GITHUB_TOKEN` is not configured. Review, propose, and
approve remain available in both cases.

Verification execution is serialized in-process per repository workspace:
tracker verification and browser reruns share the lock, and a waiter re-reads
attempt state after acquiring it. The remaining limitation is cross-process:
`demo:verification` and CLI runs in a separate process against a live service
are not covered by the in-process lock.
Mutating operator forms reject cross-site requests (Origin/Sec-Fetch-Site check);
there is still no authentication. Behind a proxy that rewrites Host, modern
browsers' Sec-Fetch-Site header keeps forms working; legacy clients without it
must present an Origin matching Host.

### Trust boundary of in-container verification

Independent verification runs checked-out repository / PR code **inside the
same `app` container, as the same non-root `app` user** as the orchestrator.
The child process environment is sanitized (no GitHub/Devin credentials), but
the container is not a security isolation boundary between the orchestrator
and the code under verification. In this prototype only use it with trusted
repositories and remediation inputs; see
[Known limitations of the verification runner](#known-limitations-of-the-verification-runner).

### Graceful shutdown

`docker compose stop` (or `down`) sends SIGTERM; the service closes the
HTTP server and database cleanly before exiting. `stop_grace_period: 15s`
gives in-flight polls time to finish. Note the demonstrated graceful
shutdown had **no long-running verification in flight**: an in-flight
verification (checkout / setup / command, with timeouts up to 5 / 30 / 15
minutes) may be forcibly killed when `stop_grace_period` expires.
Verification workspaces and results are persisted on the
`orchestrator-data` volume, but graceful cancellation and restart
reconciliation of an in-flight verification are not implemented yet
(follow-up).

See [evidence/issue-17-docker.md](evidence/issue-17-docker.md) for a
recorded clean-checkout run.

## Host prerequisites for verification

For independent verification of remediations (Issue #13) run on the host
(outside Docker):

- `git`
- `uv` (`pip install uv`)
- Python 3.12
- The `superset` repository setup adapter additionally builds some wheels
  from source and needs:
  `apt-get install pkg-config default-libmysqlclient-dev libldap2-dev libsasl2-dev libffi-dev libssl-dev gcc g++ make`

## Verification specs

Issues can propose a verification command in a
`## Verification` (or `#`/`###`) section containing a fenced code block tagged
`bash` (run via `bash -euo pipefail`) or `sh`/`shell`/untagged (run via
`sh -eu`):

    ## Verification

    ```bash
    source .venv/bin/activate && pytest tests/unit_tests/ -k my_test
    ```

The block's content is hashed (sha256) and stored per attempt as a
_candidate_; it is never approved automatically (`devin-ready` authorizes
remediation, not shell commands). Every candidate — issue section,
agent-reported tests, or operator proposal — stays `pending_approval` until an
operator runs `pnpm verification:approve --attempt <id> --spec-hash <sha256>`,
and only the approved spec ever executes
(inspect with `pnpm verification:show --attempt <id>`, propose a spec with
`pnpm verification:propose --attempt <id> --command "<cmd>"`).
The `pnpm verification:*` commands are thin wrappers around `src/cli/*`;
the compiled equivalents live in `dist/cli/` and can be run with `node`
inside the production container (see
[Operator commands inside the container](#operator-commands-inside-the-container)).
Removing or breaking the `## Verification` section clears an issue-derived
candidate; operator candidates are never cleared or overwritten by issue
edits.

### Known limitations of the verification runner

- **Not a security sandbox.** Independent verification executes repository /
  PR-head code locally inside the application process's own environment —
  under Docker that is the same `app` container and the same Unix user
  (`app`, uid 1001) as the orchestrator itself. The child process gets a
  sanitized environment (allow-listed variables only, no GitHub/Devin
  credentials), a timeout, and process-group cleanup, but it shares the
  container filesystem (including `/app/data` and the SQLite database) and
  network with the orchestrator. This is **not** a security isolation
  boundary; in this prototype it should only be used with trusted
  repositories and remediation inputs (the controlled Superset fork). A
  separate sandbox/container for verification is out of scope for Issue #17.
  See also [Trust boundary of in-container verification](#trust-boundary-of-in-container-verification).
- **Public repositories only.** The runner clones over unauthenticated HTTPS
  with `GIT_TERMINAL_PROMPT=0`; private repositories are out of scope and
  surface as a visible `error/checkout_failed` verification row, never as
  success.
- **No graceful cancellation of in-flight verification.** Under Docker the
  demonstrated graceful SIGTERM shutdown covered an idle service; an
  in-flight verification (checkout / setup / command, timeouts up to
  5 / 30 / 15 minutes) may be forcibly killed when `stop_grace_period`
  (15s) expires. Workspaces and recorded state persist on the volume, but
  cancellation and restart reconciliation of a mid-run verification are
  not implemented yet (follow-up).

## Stage details

### GitHub intake (Issue #7)

The service periodically polls the configured Superset fork for open issues
with the configured intake label. Eligible issues are ordinary (non-PR) issues
whose response state is `open` and that carry the label; each issue is persisted
as a task with its first pending attempt. Existing attempt history is never
retried implicitly, and GitHub failures leave task state unchanged.

Configure `GITHUB_TOKEN`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`, and
`GITHUB_INTAKE_LABEL` (default `devin-ready`). `GITHUB_POLL_INTERVAL_MS`
defaults to 60000 milliseconds; set it to `0` to disable polling. Run a single
intake pass and print the result and persisted rows with:

```bash
pnpm demo:intake
```

### GitHub webhook intake (Issue #22)

`POST /webhooks/github` is an optional low-latency fast path into the same
durable intake as polling. It is registered only when `GITHUB_WEBHOOK_SECRET`,
`GITHUB_REPO_OWNER`, and `GITHUB_REPO_NAME` are all set (`GITHUB_TOKEN` is not
required to receive webhooks). Otherwise startup logs one line and the route
returns 404; polling behaviour is unchanged.

Request handling, in order:

1. Content type must be `application/json` (GitHub's default). Anything else,
   including the `application/x-www-form-urlencoded` option, is rejected with 415. The route keeps the raw request bytes; JSON is parsed only after the
   signature is verified.
2. `X-Hub-Signature-256` must be `sha256=` followed by 64 hex characters and
   must match HMAC-SHA256(secret, raw body) under a constant-time comparison.
   Missing, malformed, or wrong signatures return 401 and change nothing.
3. `X-GitHub-Event` must be `issues`, the payload `repository` must match the
   configured owner/name (case-insensitive; the task is persisted under the
   configured spelling), and `action` must be `opened`, `reopened`, or
   `labeled`. Anything else is acknowledged with 200 `{ status: 'ignored' }`
   and creates no work.
4. The payload's `issue` is validated with the same schema polling uses and
   passed through the same `isEligibleIssue()` → `intakeIssue()` path, so
   replaying a delivery, or a webhook racing a poll, converges on one task and
   one attempt exactly as repeated polling does. Malformed JSON or an
   unexpected payload shape returns 400.

`X-GitHub-Delivery` is logged for traceability only; there is no delivery
table or webhook-specific dedup state. Dispatch still re-validates the issue
against GitHub before any Devin session is created.

To use it against a real fork: create a repository webhook for the `Issues`
event with content type `application/json`, the same secret, and a payload URL
reaching the service (a reverse proxy or tunnel is the operator's concern; it
is not needed for the Docker quick start or for the test suite, which signs
fixtures locally in `tests/github-webhook.test.ts`).

### Devin dispatch and duplicate protection (Issues #8, #9)

A dispatch poller moves each `pending` attempt through
`pending -> atomic claim -> dispatching -> revalidate eligibility ->
createSession -> session_created`. The claim is a single conditional
`UPDATE` that only succeeds while the attempt is still `pending`, so a
losing dispatcher skips the row instead of double-dispatching. A partial
unique index on `attempts.task_id` (covering `pending`, `dispatching`,
`session_created`, and `running`) enforces at most one active attempt per
task at the database level, and intake maps a losing insert to a skip.
Together these guarantee `DevinClient.createSession()` is invoked at most
once per task.

Between claim and dispatch the issue is refetched from GitHub and
revalidated: issues that became pull requests, closed, or lost the intake
label are completed with outcome `cancelled` and an `outcome_reason` of
`is_pull_request`, `issue_closed`, or `label_missing`. If the eligibility
check fails terminally (a GitHub 4xx other than 429 or a 403 rate
limit signalled via `X-RateLimit-Remaining: 0` or `Retry-After`), the attempt is
completed with outcome `failed` and reason `eligibility_check_failed:
<message>`. Transient revalidation failures (5xx, 429, 403 rate limits,
network/timeout, or
parse errors) instead release the claim back to `pending` and the attempt
is retried on the next poll — retry caps are owned by Issue #21. If Devin
rejects `createSession` with a 4xx (bad API key, wrong `DEVIN_ORG_ID`,
validation, rate limit), no session exists, so the claim is released back to
`pending` and retried on the next poll (`session_create_rejected`, counted as
`deferred`); fix the configuration and the attempt proceeds on its own. If
`createSession` fails uncertainly (5xx, timeout, network error), the attempt
is intentionally left in `dispatching` — a session may exist server-side, and
uncertain-dispatch reconciliation (Issue #20, below) owns recovery.

Migration `0002` reconciles legacy data before creating the partial index:
tasks with multiple active attempts keep the newest active row (preferring
one that already has a Devin session) and demote the rest to `completed`
with `outcome_reason` `migration_0002_duplicate_active_attempt`.

Dispatch requires `GITHUB_TOKEN`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`,
`DEVIN_API_KEY`, and `DEVIN_ORG_ID`. `DEVIN_DISPATCH_INTERVAL_MS` defaults
to 60000 milliseconds; set it to `0` to disable polling.
`DEVIN_MAX_ACU_PER_SESSION` (default `5`) caps the ACUs each dispatched
session may consume. Run a single dispatch pass against pending attempts
with:

```bash
pnpm demo:dispatch
```

### Uncertain dispatch reconciliation (Issue #20)

When `createSession` fails or times out, a session may exist server-side
without the orchestrator ever seeing its id; the attempt stays `dispatching`
with a null `devin_session_id` and is never redispatched. A reconciliation
poller periodically selects such attempts once their `dispatched_at` is older
than `DEVIN_DISPATCH_GRACE_MS` (default 300000 milliseconds; must exceed the
30 s Devin request timeout) and looks the session up on the provider instead
of recreating it.

For each candidate the reconciler calls `GET
/v3/organizations/{org_id}/sessions?tags=correlation:<uuid>&first=200` — the
correlation tag is a per-attempt UUID written into `buildSessionTags`, so it
identifies at most one session. Provider capability (verified live): matching
is exact and case-sensitive, multiple `tags=` params are ORed (the reconciler
therefore queries the single correlation tag and verifies the full expected
tag set client-side), pagination uses `first`/`after`/`end_cursor`, and the
endpoint requires a service user with `ViewOrgSessions`. `is_archived` is
never sent — archived sessions remain eligible for adoption. Decisions:
`session_adopted` (exactly one match carrying all expected tags →
`markSessionCreated`, after which the tracking poller takes over),
`already_adopted` (a concurrent adopter won; the guarded UPDATE is atomic),
`no_match`, `ambiguous_match`, `identity_mismatch` (matched session missing
expected tags), and `lookup_unavailable` (provider error). Every non-adopted
decision leaves the attempt `dispatching` for a later pass — reconciliation
never creates a session, releases the claim, or calls GitHub.

Reconciliation requires only `DEVIN_API_KEY` and `DEVIN_ORG_ID`.
`DEVIN_RECONCILE_INTERVAL_MS` defaults to 60000 milliseconds; set it to `0`
to disable. The poller runs once at startup and then on the interval.

If an attempt is stuck in `dispatching` without a session and reconciliation
keeps reporting `no_match` (an uncertain failure whose session was in fact
never created, or a row left behind by a version that did not release 4xx
rejections), the dashboard shows `DISPATCHING` indefinitely and intake skips
the issue (`existing_attempt`). Recovery is an explicit operator step (refused
while the attempt is younger than `DEVIN_DISPATCH_GRACE_MS`, since its
create-session request may still be in flight):

```bash
pnpm attempt:requeue --attempt <id>
# in Docker:
docker compose exec app node dist/cli/attempt-requeue.js --attempt <id>
```

This completes the stuck attempt as `failed` with `outcome_reason`
`operator_requeue_dispatch_failed` and creates a new `pending` attempt (fresh
correlation id) for the same task, which the dispatch poller picks up on its
next pass. It refuses attempts that are not `dispatching` or that already
carry a `devin_session_id` — those belong to reconciliation/tracking.

Because the pollers are stateless over SQLite, restart recovery otherwise
needs no explicit pass: `session_created`/`running`/`verifying` attempts and
completed attempts with tracked open pull requests are picked up by the
tracking poller on its next run.

### Structured output collection (Issue #10)

Dispatched sessions are created with `structured_output_required` and a JSON
Schema (`src/devin/structured-output.ts`) so Devin finishes with a
machine-readable `outcome` (`remediated`, `needs_human`, `no_action`), `pr_url`,
`diagnosis`, `tests_run`, `risks`, and `needs_human_reason`.
`collectStructuredOutput` (`src/outcome/collect-structured-output.ts`) classifies
the fetched session into a phase (`in_progress`, `waiting_for_user`,
`suspended`, `finished`, `error`) and returns a decision: `recorded` when a
valid output is accepted (idempotent via `structured_output_accepted_at`;
repeat calls return `already_recorded`), `session_not_finished` /
`awaiting_user_without_output` / `session_suspended_without_output` when there
is nothing to collect yet, `escalated_missing` / `escalated_invalid` when a
finished session's output is absent or malformed, and `escalated_session_error`
when the session itself errored. `no_session` and `already_completed` cover
attempts without a Devin session or already completed. Agent-reported fields
are stored separately from the orchestrator's `outcome`/`pr_url`. Collect the
output of a finished session once with:

```bash
pnpm demo:structured-output --attempt <id>          # or --correlation <uuid>
```

### Session and pull request lifecycle tracking (Issue #11)

The tracking poller records Devin session snapshots, collects structured agent
outcomes, verifies agent-reported pull requests against the task repository and
issue, and refreshes tracked pull request state and head SHA. Session
observations, agent outcomes, verified PR identity, and orchestrator outcomes
are persisted separately. The lifecycle can move through
`session_created -> running -> verifying -> completed`; `no_action` is an
orchestrator outcome for an agent that reports no remediation was needed.

Tracking requires `GITHUB_TOKEN`, `DEVIN_API_KEY`, and `DEVIN_ORG_ID`; repository
owner/name are read from each persisted task. `DEVIN_TRACKING_INTERVAL_MS`
defaults to 60000 milliseconds and set to `0` disables tracking. Stale-session
warnings use `DEVIN_SESSION_STALE_WARN_MS`, defaulting to 21600000 milliseconds;
set it to `0` to disable warnings. Run one pass with:

```bash
pnpm demo:tracking
pnpm demo:tracking -- --attempt <id>
```

See [evidence/issue-11-session-pr-lifecycle.md](evidence/issue-11-session-pr-lifecycle.md)
for live-run evidence.

One independent verification pass for a single `verifying` attempt (Issue #13)
can be triggered with:

```bash
pnpm demo:verification --attempt <id>          # append [--rerun] to re-execute even after a recorded result
```

`GITHUB_VERIFIED_LABEL` (default `devin-verified`) tracks the current PR head's
verification state: the tracker adds the label to the remediation PR when the
attempt is `completed`/`succeeded` and the current head has a passed independent
verification, and removes it again if the PR later advances to a head that has
not been verified. Both operations are idempotent and retried on each tracking
poll until they succeed; they require the token to have issues write permission
on the fork. Set `GITHUB_VERIFIED_LABEL` to an empty value to disable
labelling.

### Observability / reporting (Issue #15)

The service exposes `GET /api/report` for a JSON report and `GET /dashboard`
for a lightweight server-rendered HTML dashboard. Both report all persisted
work in the configured `DATABASE_PATH` and include the runtime context
(database path, environment, and configured intake repository). The report
summary and dashboard cards count **tasks**. Throughput measures count
discovered, terminal, and verified **tasks**, while the attempts-created
measure counts **attempts**; each is reported over 24h / 7d / 30d / Total
windows. Tasks discovered covers every persisted task, including tasks without
an attempt. The observed-ACU measure sums the latest persisted provider
snapshot (`acus_consumed`, unit `acus`) for attempts that reached a terminal
state in the window — a lower bound, attributed by terminal time, not billing
data; attempts without a Devin session or terminal timestamp are not eligible.
The summary describes the current task state;
throughput and cycle time describe historical events and never decrease
retroactively when retries change the current attempt. Success is defined
strictly as the normalized `VERIFIED` state; a PR URL or open PR is not
success.
Terminal time comes only from persisted immutable timestamps (`completed_at` on
the attempt or the decisive verification row). Derived terminal states without
one are counted in the summary cards but excluded from terminal throughput and
cycle time, and surfaced via `terminalWithoutTimestamp`. Cycle time uses all
historical terminal attempts.

Demo and test data use separate databases: `pnpm demo:restart` writes to
`./data/demo-state-restart.db` by default and can be overridden with
`DEMO_DATABASE_PATH`; tests use `./test-database.db`.

Health endpoints: `GET /health` is a process liveness check and `GET /ready`
is an application readiness check with database connectivity.

These endpoints are UNAUTHENTICATED and are intended only for local or trusted
internal environments. Responses never contain secrets, verification scripts,
raw structured output, or agent diagnoses.

## Manual single-pass scripts

Each of these runs exactly one pass of the same poller code the running
service uses; they exist for exercising or debugging a single step, not as an
alternative workflow.

| Command                                                         | What it does                                                                           | Credentials needed                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------- |
| `pnpm demo:intake`                                              | One intake pass: poll issues, persist tasks/pending attempts, print persisted rows     | GitHub (`GITHUB_TOKEN`, repo owner/name) |
| `pnpm demo:dispatch`                                            | One dispatch pass over `pending` attempts (claim → revalidate → `createSession`)       | GitHub + Devin                           |
| `pnpm demo:structured-output --attempt <id>`                    | Collect the structured output of a finished session once (or `--correlation <uuid>`)   | Devin                                    |
| `pnpm demo:tracking [-- --attempt <id>]`                        | One tracking pass: session snapshot, outcome collection, PR verification/refresh       | GitHub + Devin                           |
| `pnpm demo:verification --attempt <id> [--rerun]`               | One independent verification pass for a single `verifying` attempt                     | GitHub (checks); repo must be public     |
| `pnpm demo:adopt-session`                                       | Attach an existing Devin session to a pending attempt (evidence without re-dispatch)   | Devin                                    |
| `pnpm demo:restart`                                             | Persistent-state restart demo in `./data/demo-state-restart.db` (`DEMO_DATABASE_PATH`) | None                                     |
| `pnpm demo:dashboard-fixtures`                                  | Seed one task per dashboard state/reason into `DATABASE_PATH` (see below)              | None                                     |
| `pnpm verification:show --attempt <id>`                         | Print normalized state, raw provider facts, candidate/approved spec, verification rows | None                                     |
| `pnpm verification:propose --attempt <id> --command "<cmd>"`    | Propose an operator verification spec (candidate only)                                 | None                                     |
| `pnpm attempt:requeue --attempt <id>`                           | Fail a `dispatching` attempt that never got a Devin session and queue a new attempt    | None                                     |
| `pnpm verification:approve --attempt <id> --spec-hash <sha256>` | Approve a pending verification spec by sha256                                          | None                                     |
| `pnpm smoke:devin`                                              | Minimal Devin session create + poll, sanitized JSON summary                            | Devin (`DEVIN_API_KEY`, `DEVIN_ORG_ID`)  |

### Dashboard fixtures (no credentials)

`pnpm demo:dashboard-fixtures` walks the real attempt state machine to seed 14
tasks covering every normalized state and reason shown on `/dashboard`
(`spec_pending_approval`, `approved_spec_awaiting_run`, `verified_head_superseded`,
…). Point it at a throwaway database and start the server with the pollers
disabled so nothing tries to reach GitHub or Devin:

```bash
DATABASE_PATH=./data/dashboard-fixtures.db pnpm demo:dashboard-fixtures
DATABASE_PATH=./data/dashboard-fixtures.db \
  GITHUB_POLL_INTERVAL_MS=0 DEVIN_DISPATCH_INTERVAL_MS=0 \
  DEVIN_TRACKING_INTERVAL_MS=0 DEVIN_RECONCILE_INTERVAL_MS=0 pnpm dev
# open http://localhost:3000/dashboard
```

Because every poller is disabled in this mode, the dashboard is truthful about
it: states that would normally show "Wait" show "Action needed" with a note that
the required worker is not running. The State map above the Tasks table shows
the seeded tasks spread over the whole lifecycle; click "map" next to any State
to highlight that task's box. The Verification pages of the seeded attempts work
(approve the candidate on issue #105 and its reason changes to
`approved_spec_awaiting_run`); explicit reruns
are unavailable because `VERIFICATION_ENABLED` execution needs a `GITHUB_TOKEN`.
Re-running the script against the same database fails with
`ActiveAttemptExistsError` — delete the file first.

## Devin API smoke test (Issue #5)

A reusable Devin v3 Organization API client lives in `src/devin/client.ts`. To
verify API connectivity end-to-end, run the smoke-test script:

```bash
DEVIN_API_KEY=... DEVIN_ORG_ID=... pnpm smoke:devin
```

It creates a minimal session, polls until it reaches a terminal status, and
prints a sanitized JSON summary (optionally persisted via `SMOKE_OUTPUT_PATH`).
See [evidence/issue-5-devin-smoke.md](evidence/issue-5-devin-smoke.md)
for details and recorded evidence.

## Development commands

Host development requires Node.js 24.21.0 and pnpm 12.4.2; `pnpm install`
installs dependencies.

### Verification

- `pnpm check` — run comprehensive code quality checks (format, lint, type-check, test, build)

### Application execution

- `pnpm dev` — start development server with hot reload
- `pnpm build` — build TypeScript to JavaScript
- `pnpm start` — start production server (requires build first)

### Tests

- `pnpm test` — run all tests
- `pnpm test:coverage` — run tests with coverage report

### Linting

- `pnpm lint` — run ESLint
- `pnpm lint:fix` — run ESLint with auto-fix
- `pnpm format` — format code with Prettier
- `pnpm format:check` — check code formatting

### Type checking

- `pnpm type-check` — run TypeScript type checking

### Database

- `pnpm db:generate` — generate Drizzle migrations from schema
- `pnpm db:migrate` — apply migrations to the database
- `pnpm demo:restart` — demonstrate persistent state across process restart
  in `./data/demo-state-restart.db` (override with `DEMO_DATABASE_PATH`); the
  demo database is reset on each run
