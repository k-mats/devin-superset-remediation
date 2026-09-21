# devin-superset-remediation

Event-driven orchestration service for Devin API to remediate selected issues in a fork of Apache Superset.

## Overview

This project implements an automated system that:

- Detects selected issues in a fork of Apache Superset
- Invokes the Devin API to perform remediation
- Tracks Devin sessions and resulting pull requests
- Verifies and reports remediation results
- Preserves idempotency, failure handling, and evidence suitable for evaluation

## Technology Stack

- **Language**: TypeScript 6.0.3
- **Runtime**: Node.js 24 LTS (24.21.0)
- **Framework**: Fastify 5
- **Database**: SQLite with Drizzle ORM and better-sqlite3
- **Package Manager**: pnpm 12.4.2
- **Testing**: Vitest 5
- **Linting**: ESLint 10 with typescript-eslint
- **Formatting**: Prettier

## Running with Docker (Issue #17)

The whole solution is containerized: a multi-stage `Dockerfile` builds the
TypeScript application and produces a runtime image that also bundles `git`,
`uv`, Python 3.12, and the Superset native build dependencies
(`pkg-config`, `default-libmysqlclient-dev`, `libldap2-dev`, `libsasl2-dev`,
`libffi-dev`, `libssl-dev`, `gcc`, `g++`, `make`), so independent
verification (`src/verification/`, Issue #13) runs inside the container
unchanged. The container runs as the non-root user `app` (uid 1001) and no
secrets are baked into the image — credentials are passed only via `.env` /
environment variables at run time.

### Prerequisites

- Docker Engine 20.10+ (developed against Docker 29)
- Docker Compose v2+ (`docker compose`, developed against v5)

### Clean checkout → running service

```bash
git clone https://github.com/k-mats/devin-superset-remediation.git
cd devin-superset-remediation
cp .env.example .env
docker compose up --build
```

Then, in another terminal:

```bash
curl http://localhost:3000/health      # {"status":"ok",...}
curl http://localhost:3000/ready       # {"status":"ready","database":"connected",...}
curl http://localhost:3000/api/report  # JSON observability report
```

and open `http://localhost:3000/dashboard` for the HTML dashboard.

### Environment variables

`.env` is loaded via `env_file`; the compose `environment:` block pins
`NODE_ENV=production`, `DATABASE_PATH=/app/data/orchestrator.db`, `HOST=0.0.0.0`, `PORT=3000`, and
`VERIFICATION_WORKSPACE_ROOT=/app/data/verification` on top. With all
credentials unset the application still starts and serves health, readiness,
reporting, and the dashboard — only GitHub intake, Devin dispatch, and
session/PR tracking are skipped (each logs a warning).

| Group                      | Variables                                                                                                                              | Required?                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Minimal (works as-is)      | `PORT`, `HOST`, `NODE_ENV`, `DATABASE_PATH` (overridden in Docker), `LOG_LEVEL`                                                        | No — defaults in `.env.example` suffice |
| GitHub intake              | `GITHUB_TOKEN`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_INTAKE_LABEL`                                | Only for real orchestration             |
| Devin dispatch             | `DEVIN_API_KEY`, `DEVIN_ORG_ID`, `DEVIN_API_URL`, `DEVIN_MAX_ACU_PER_SESSION`                                                          | Only for real orchestration             |
| Optional: polling / tuning | `GITHUB_POLL_INTERVAL_MS`, `DEVIN_DISPATCH_INTERVAL_MS`, `DEVIN_TRACKING_INTERVAL_MS`, `DEVIN_SESSION_STALE_WARN_MS`, `VERIFICATION_*` | No — sensible defaults                  |

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

Compose is the primary path; a plain `docker run` works too:

```bash
docker build -t devin-superset-remediation .
docker run --rm -p 3000:3000 --env-file .env \
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

See [docs/evidence/issue-17-docker.md](docs/evidence/issue-17-docker.md) for a
recorded clean-checkout run.

## Development

### Prerequisites

- Node.js 24.21.0
- pnpm 12.4.2
- For independent verification of remediations (Issue #13): `git`, `uv`
  (`pip install uv`), and Python 3.12. The `superset` repository setup adapter
  additionally builds some wheels from source and needs:
  `apt-get install pkg-config default-libmysqlclient-dev libldap2-dev libsasl2-dev libffi-dev libssl-dev gcc g++ make`

### Verification specs

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
"Operator commands inside the container").
Removing or breaking the `## Verification` section clears an issue-derived
candidate; operator candidates are never cleared or overwritten by issue
edits.

#### Known limitations of the verification runner

- **Not a security sandbox.** The approved command runs PR-head code in an
  isolated checkout with a scrubbed environment (no application secrets), a
  timeout, and process-group cleanup, but it still has host filesystem and
  network access. This is accepted only because verification targets a
  trusted public fork; before pointing the runner at untrusted repositories
  or PR code, run it inside a container/sandbox with restricted filesystem,
  credentials, and network.
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

### Installation

```bash
pnpm install
```

### Commands

#### Verification

- `pnpm check` - Run comprehensive code quality checks (format, lint, type-check, test, build)

#### Application Execution

- `pnpm dev` - Start development server with hot reload
- `pnpm build` - Build TypeScript to JavaScript
- `pnpm start` - Start production server (requires build first)

#### Tests

- `pnpm test` - Run all tests
- `pnpm test:coverage` - Run tests with coverage report

#### Linting

- `pnpm lint` - Run ESLint
- `pnpm lint:fix` - Run ESLint with auto-fix
- `pnpm format` - Format code with Prettier
- `pnpm format:check` - Check code formatting

#### Type Checking

- `pnpm type-check` - Run TypeScript type checking

#### Database

- `pnpm db:generate` - Generate Drizzle migrations from schema
- `pnpm db:migrate` - Apply migrations to the database
- `pnpm demo:restart` - Demonstrate persistent state across process restart in `./data/demo-state-restart.db` (override with `DEMO_DATABASE_PATH`); the demo database is reset on each run

### Environment Variables

Create a `.env` file based on `.env.example`:

```env
NODE_ENV=development
PORT=3000
DATABASE_PATH=./database.db
LOG_LEVEL=info
```

## Observability / reporting (Issue #15)

The service exposes `GET /api/report` for a JSON report and `GET /dashboard`
for a lightweight server-rendered HTML dashboard. Both report all persisted
work in the configured `DATABASE_PATH` and include the runtime context
(database path, environment, and configured intake repository). The report
summary and dashboard cards count **tasks**. Throughput measures count
discovered, terminal, and verified **tasks**, while the attempts-created
measure counts **attempts**. The summary describes the current task state;
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

These endpoints are UNAUTHENTICATED and are intended only for local or trusted
internal environments. Responses never contain secrets, verification scripts,
raw structured output, or agent diagnoses.

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
is retried on the next poll — retry caps are owned by Issue #21. If
`createSession` fails or times out, the attempt is intentionally left in
`dispatching` — a session may exist server-side, and Issue #20
reconciliation owns recovery.

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

See [docs/evidence/issue-11-session-pr-lifecycle.md](docs/evidence/issue-11-session-pr-lifecycle.md)
for live-run evidence.

One independent verification pass for a single `verifying` attempt (Issue #13)
can be triggered with:

```bash
pnpm demo:verification --attempt <id>          # append [--rerun] to re-execute even after a recorded result
```

### Devin API smoke test (Issue #5)

A reusable Devin v3 Organization API client lives in `src/devin/client.ts`. To
verify API connectivity end-to-end, run the smoke-test script:

```bash
DEVIN_API_KEY=... DEVIN_ORG_ID=... pnpm smoke:devin
```

It creates a minimal session, polls until it reaches a terminal status, and
prints a sanitized JSON summary (optionally persisted via `SMOKE_OUTPUT_PATH`).
See [docs/evidence/issue-5-devin-smoke.md](docs/evidence/issue-5-devin-smoke.md)
for details and recorded evidence.

### Health Endpoints

- `GET /health` - Process liveness check
- `GET /ready` - Application readiness check with database connectivity

## Architecture

The system follows an event-driven architecture:

```
GitHub issue/event
    ↓
orchestrator
    ↓
Devin API
    ↓
pull request
    ↓
verification/reporting
```

See [architecture.md](architecture.md) for detailed architectural information.

## Development Conventions

- Strict TypeScript mode with no implicit any
- Type-safe database operations with Drizzle ORM
- Comprehensive testing for external side effects
- Idempotent event processing
- Evidence preservation for evaluation
