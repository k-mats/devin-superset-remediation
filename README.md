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
(database path, environment, and configured repository). The report summary
and dashboard cards count **tasks**, while the attempts-created throughput
measure counts **attempts**. Success is defined strictly as the normalized
`VERIFIED` state; a PR URL or open PR is not success.
For tasks whose terminal state is derived while the attempt is still verifying
(for example, a closed PR becoming `NEEDS_HUMAN`), terminal time is when the
decisive evidence was recorded.

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
