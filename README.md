# devin-superset-remediation

Event-driven orchestration service that uses the Devin API to remediate
selected issues in a fork of Apache Superset.

An issue labelled `devin-ready` in the configured Superset fork is picked up
by periodic polling, handed to a Devin session with a structured-output
contract, tracked through the session and the resulting pull request, and
finally verified by an operator-approved command that the orchestrator runs
itself. Every step is persisted in SQLite so state survives restarts, and the
result is visible at `/api/report` and `/dashboard`.

**No public webhook endpoint or tunnel is required at any point** — GitHub
intake is polling-based. An optional signed webhook fast path
(`POST /webhooks/github`, Issue #22) can be enabled with
`GITHUB_WEBHOOK_SECRET` to lower intake latency; polling stays on as the
reconciliation fallback either way.

## Table of contents

- [Evaluator quick start](#evaluator-quick-start)
- [What the system does](#what-the-system-does)
- [Two ways to exercise the system](#two-ways-to-exercise-the-system)
  - [Path A — no-credential evaluation](#path-a--no-credential-evaluation)
  - [Path B — real GitHub + Devin remediation](#path-b--real-github--devin-remediation)
- [Credentials and configuration](#credentials-and-configuration)
- [How work is triggered](#how-work-is-triggered)
- [How to inspect results](#how-to-inspect-results)
- [What counts as success](#what-counts-as-success)
- [Real vs. demo / manual / evidence flows](#real-vs-demo--manual--evidence-flows)
- [Known limitations and trust boundaries](#known-limitations-and-trust-boundaries)
- [Further documentation](#further-documentation)
- [Local development](#local-development)

## Evaluator quick start

Prerequisites: Docker Engine 20.10+ and Docker Compose v2+ (developed
against Docker 29 / Compose v5). Nothing else — no Node.js, no credentials.

```bash
git clone https://github.com/k-mats/devin-superset-remediation.git
cd devin-superset-remediation
cp .env.example .env
docker compose up --build
```

`docker compose up` stays attached and streams the service log (Ctrl-C stops
the service); keep it running. In a second terminal in the same directory,
wait until `docker compose ps` shows the `app` service as `healthy`
(roughly 1–2 minutes on first build, ~10 s afterwards), then:

```bash
docker compose ps                      # STATUS ... (healthy)
curl http://localhost:3000/health      # {"status":"ok",...}
curl http://localhost:3000/ready       # {"status":"ready","database":"connected",...}
curl http://localhost:3000/api/report  # JSON observability report (empty database on a fresh start)
```

Then open <http://localhost:3000/dashboard> in a browser for the HTML
dashboard.

That is the complete no-credential path: the service starts, migrates its
SQLite database on the named volume `orchestrator-data`, serves health,
readiness, the report, and the dashboard, and logs one warning per skipped
poller (GitHub intake, Devin dispatch, session/PR tracking) because no
credentials are configured. To go further, continue with
[Path B](#path-b--real-github--devin-remediation).

Stop with `docker compose down` (data kept) or `docker compose down -v`
(deletes the volume and all state). A recorded clean-checkout run of exactly
these steps is in
[docs/evidence/issue-18-readme-walkthrough.md](docs/evidence/issue-18-readme-walkthrough.md).

## What the system does

```
GitHub issue labelled `devin-ready`  (polled; optional signed webhook)
        │  intake                     → task + pending attempt persisted
        ▼
Devin session                          dispatch (at most once per task)
        │  structured output           → outcome, pr_url, tests_run, …
        ▼
Pull request                           tracked: session status, PR state, head SHA
        │  operator approves a verification command (never automatic)
        ▼
Independent verification               clean checkout of the PR head, command run by the orchestrator
        │
        ▼
/api/report and /dashboard             normalized task state; only VERIFIED counts as success
```

Components (all in one Fastify process, `src/`):

| Stage                    | Module                                           | What it guarantees                                                                                                                           |
| ------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Intake                   | `src/intake/github-intake.ts`                    | Polls the configured repo for open issues with the intake label; one task per issue, first attempt `pending`; GitHub failures change nothing |
| Dispatch                 | `src/dispatch/devin-dispatcher.ts`               | Atomic claim + DB-level unique active attempt ⇒ `createSession` called at most once per task; issue eligibility revalidated before dispatch  |
| Structured output        | `src/devin/structured-output.ts`, `src/outcome/` | Devin must finish with a JSON outcome (`remediated`, `needs_human`, `no_action`); missing/invalid output is escalated, never guessed         |
| Tracking                 | `src/tracking/session-tracker.ts`                | Records session snapshots, verifies the agent-reported PR belongs to the task repo/issue, refreshes PR state and head SHA                    |
| Normalized task state    | `src/tracking/normalized-task-state.ts`          | Derives one of `QUEUED … VERIFIED / FAILED / CANCELLED` on demand from persisted facts; no second source of truth                            |
| Independent verification | `src/verification/`                              | Candidate specs (issue section, agent `tests_run`, operator proposal) are never executed until an operator approves a specific sha256        |
| Reporting                | `src/reporting/`, `src/routes/report.ts`         | `/api/report` and `/dashboard` derived from the projection; success = `VERIFIED` only                                                        |
| Persistence              | `src/db/` (SQLite, Drizzle ORM)                  | Tasks, attempts, session observations, verification rows; migrations run at startup                                                          |

The full design — persistence model, state machine, verification approval
boundary, constraints — is in [architecture.md](architecture.md). Product
scope is in [product.md](product.md).

## Two ways to exercise the system

### Path A — no-credential evaluation

Everything in the [Evaluator quick start](#evaluator-quick-start) works with
the unmodified `.env.example`:

1. `git clone …` → `cp .env.example .env` → `docker compose up --build`
2. `GET /health`, `GET /ready`
3. `GET /api/report`, `GET /dashboard` (empty summary, runtime context shows
   the database path and that no intake repository is configured)
4. Read [architecture.md](architecture.md) and
   [Known limitations and trust boundaries](#known-limitations-and-trust-boundaries)

Optional in this path, to see persistence with non-empty data: the
[persistence check](docs/operations.md#persistence) in the operations guide
inserts a task through the compiled application code and shows it surviving
`docker compose restart`. This is a manual evidence step, not part of the real
workflow.

What Path A does **not** show: talking to GitHub, creating Devin sessions,
tracking a PR, or running a verification. Those need Path B.

### Path B — real GitHub + Devin remediation

1. **Configure credentials** in `.env` (see
   [Credentials and configuration](#credentials-and-configuration)):
   `GITHUB_TOKEN`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`, `DEVIN_API_KEY`,
   `DEVIN_ORG_ID`. Restart: `docker compose up --build -d` (or
   `docker compose restart` if the image is already built).
2. **Create or label an issue** in the configured Superset fork with the
   intake label (`GITHUB_INTAKE_LABEL`, default `devin-ready`). Optionally
   add a `## Verification` section with a fenced `bash` block containing the
   command that should prove the fix (it becomes a _candidate_ only).
3. **Polling detects it** within `GITHUB_POLL_INTERVAL_MS` (default 60 s):
   a task and a `pending` attempt are persisted.
4. **Devin dispatch** within `DEVIN_DISPATCH_INTERVAL_MS` (default 60 s):
   the issue is revalidated (still open, still labelled, not a PR), a session
   is created once, the attempt moves to `session_created`.
5. **Session / PR tracking** within `DEVIN_TRACKING_INTERVAL_MS` (default
   60 s): session snapshots and the structured outcome are recorded, the
   agent-reported PR is checked against the task repository and issue, and
   the attempt moves `running → verifying`.
6. **Verification approval** (operator, manual by design): inspect the
   candidate spec and approve its sha256 — see
   [How to inspect results](#how-to-inspect-results), or use the browser UI at
   `/operator/attempts/<id>/verification`. The next tracking pass
   clones the PR head into the verification workspace, runs the repository
   setup adapter, executes only the approved command, and records the result.
7. **Confirm the result** at `/dashboard` / `/api/report`: the task reaches
   `VERIFIED` (success), `VERIFICATION_FAILED`, `NEEDS_HUMAN`, `NO_ACTION`,
   `FAILED`, or `CANCELLED`.

No public webhook endpoint or tunnel is needed for any of these steps; the
container only makes outbound HTTPS calls to GitHub and the Devin API. The
webhook route is opt-in (see the table below) and is fully tested with
locally signed fixtures.

This path was **not** re-run for the README walkthrough. Recorded real runs
of each stage are linked under
[Real vs. demo / manual / evidence flows](#real-vs-demo--manual--evidence-flows).

## Credentials and configuration

`.env` is loaded via `env_file` in `compose.yaml`; the compose
`environment:` block additionally pins `NODE_ENV=production`,
`DATABASE_PATH=/app/data/orchestrator.db`, `HOST=0.0.0.0`, `PORT=3000` and
`VERIFICATION_WORKSPACE_ROOT=/app/data/verification`. `.env.example` is
grouped the same way as this table and is safe to use unchanged.

| Group            | Variables                                                                                                                                                                                                                                                                                                                                    | Required for                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Minimal          | `PORT`, `HOST`, `NODE_ENV`, `DATABASE_PATH`, `LOG_LEVEL`                                                                                                                                                                                                                                                                                     | Nothing — defaults in `.env.example` suffice for Path A                                                                        |
| GitHub intake    | `GITHUB_TOKEN`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`, `GITHUB_INTAKE_LABEL` (default `devin-ready`)                                                                                                                                                                                                                                       | Path B: intake, dispatch revalidation, PR tracking, GitHub check evaluation. Token needs read access to issues/PRs of the fork |
| Devin dispatch   | `DEVIN_API_KEY`, `DEVIN_ORG_ID`, `DEVIN_API_URL` (default `https://api.devin.ai/v3`), `DEVIN_MAX_ACU_PER_SESSION` (5)                                                                                                                                                                                                                        | Path B: dispatch and session tracking                                                                                          |
| Optional tuning  | `GITHUB_POLL_INTERVAL_MS`, `DEVIN_DISPATCH_INTERVAL_MS`, `DEVIN_TRACKING_INTERVAL_MS`, `DEVIN_RECONCILE_INTERVAL_MS` (60000 each; `0` disables), `DEVIN_DISPATCH_GRACE_MS` (must exceed the 30 s Devin request timeout), `DEVIN_SESSION_STALE_WARN_MS`, `VERIFICATION_ENABLED`, `VERIFICATION_*_TIMEOUT_MS`, `VERIFICATION_MAX_OUTPUT_BYTES` | Nothing — sensible defaults                                                                                                    |
| Optional webhook | `GITHUB_WEBHOOK_SECRET` (plus `GITHUB_REPO_OWNER` / `GITHUB_REPO_NAME`; no token needed)                                                                                                                                                                                                                                                     | Signed `POST /webhooks/github` fast path (Issue #22). Unset or blank → route not registered (404); polling is unaffected       |

With the GitHub or Devin group missing, the corresponding poller is skipped
and a warning is logged at startup; the HTTP endpoints keep working.
Secrets are never baked into the image and never appear in `/api/report`,
`/dashboard`, or logs.

## How work is triggered

| Trigger                            | Kind              | Needs credentials   | How                                                                                                                                   |
| ---------------------------------- | ----------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Label an issue `devin-ready`       | **Real workflow** | GitHub + Devin      | Periodic polling inside the running service; optionally a signed GitHub webhook (`GITHUB_WEBHOOK_SECRET`) as a low-latency fast path  |
| Approve a verification spec        | **Real workflow** | GitHub + Devin      | `docker compose exec app node dist/cli/verification-approve.js --attempt <id> --spec-hash <sha256>` (operator step, by design manual) |
| Run one poller pass by hand        | Manual exercise   | GitHub and/or Devin | `pnpm demo:intake`, `pnpm demo:dispatch`, `pnpm demo:tracking`, `pnpm demo:verification --attempt <id>` (host, Node.js)               |
| Attach an existing Devin session   | Manual exercise   | Devin               | `pnpm demo:adopt-session` — used to record evidence without re-dispatching                                                            |
| Insert a task without any provider | Manual evidence   | None                | `node -e` snippet in the [persistence check](docs/operations.md#persistence); exercises persistence/reporting only                    |
| Devin API connectivity             | Smoke test        | Devin               | `pnpm smoke:devin`                                                                                                                    |

The `demo:*` scripts run exactly one pass of the same code the pollers run;
they are for exercising or debugging a single step, not an alternative
workflow. Details and options are in
[docs/operations.md](docs/operations.md#manual-single-pass-scripts).

## How to inspect results

| What                                                 | Where                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Everything at a glance                               | <http://localhost:3000/dashboard> — summary cards per normalized state, throughput, cycle time, per-task rows, and the remediation evidence ledger                       |
| Machine-readable report                              | `GET /api/report` — same data as JSON, plus runtime context and a per-task remediation evidence ledger                                                                   |
| Liveness / readiness                                 | `GET /health`, `GET /ready` (readiness includes database connectivity)                                                                                                   |
| Task state, session, PR for one attempt              | `docker compose exec app node dist/cli/verification-show.js --attempt <id>` — prints normalized state, raw provider facts, candidate/approved spec, verification history |
| Devin session                                        | `devin_session_id` / session URL in `/api/report` and `verification-show`; open it in the Devin app                                                                      |
| Pull request                                         | `pr_url`, `pr_state`, tracked head SHA in `/api/report`, the dashboard row, and `verification-show`                                                                      |
| Verification spec and results                        | `verification-show` (candidate vs approved sha256, status, each `command` / `github_checks` verification row for the current head)                                       |
| Propose / approve a verification command             | `verification-propose.js --attempt <id> --command "<cmd>"`, then `verification-approve.js --attempt <id> --spec-hash <sha256>`                                           |
| Review/propose/approve/rerun verification in browser | `/operator/attempts/<id>/verification`                                                                                                                                   |
| Raw database                                         | SQLite file on the `orchestrator-data` volume (`/app/data/orchestrator.db`); tables `tasks`, `attempts`, `verifications`                                                 |
| Logs                                                 | `docker compose logs -f app` — structured JSON, one projection line per tracking pass                                                                                    |

Attempt ids are the numeric `attempt.id` shown in `/api/report`. The
`docker compose exec …` commands must be run from the repository directory
while the service is up. The
`pnpm verification:*` commands are the same CLIs run from a host checkout.
The report endpoints are **unauthenticated** and intended for local or
trusted internal use only; they never contain secrets, verification scripts,
raw structured output, or agent diagnoses.

## What counts as success

- A task is successful only when its normalized state is **`VERIFIED`**: the
  current PR head has a recorded, passing, operator-approved independent
  verification. An open PR, a `remediated` structured output, or agent-reported
  passing tests are **not** success on their own.
- `VERIFIED` is a property of the tracked PR head; if the head moves, the
  projection drops back to `PR_OPEN` until the new head is verified.
- `NEEDS_HUMAN`, `NO_ACTION`, `VERIFICATION_FAILED`, `FAILED`, and `CANCELLED`
  are terminal, visible outcomes — never silently retried.
- Dashboard cards and report summary count **tasks**; throughput counts
  historical events and never decreases when a retry changes the current
  attempt.

The precise state definitions are in
[architecture.md — Normalized task state](architecture.md#normalized-task-state).

## Real vs. demo / manual / evidence flows

| Flow                                                       | What it is                                                                                            | Evidence                                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application startup / local evaluation (Path A)            | Container build, migrations, health/ready/report/dashboard, persistence across restart, graceful stop | [issue-17-docker.md](docs/evidence/issue-17-docker.md), [issue-18-readme-walkthrough.md](docs/evidence/issue-18-readme-walkthrough.md), [issue-6-persistent-state.md](docs/evidence/issue-6-persistent-state.md)                         |
| Real GitHub + Devin remediation (Path B)                   | Live intake, dispatch, structured output, session/PR tracking against the Superset fork and Devin API | [issue-8-9-real-dispatch.md](docs/evidence/issue-8-9-real-dispatch.md), [issue-10-structured-output.md](docs/evidence/issue-10-structured-output.md), [issue-11-session-pr-lifecycle.md](docs/evidence/issue-11-session-pr-lifecycle.md) |
| Independent verification (real PR head, operator approval) | Clean checkout + approved command run by the orchestrator, including once inside the Docker container | [issue-13-independent-verification.md](docs/evidence/issue-13-independent-verification.md), [issue-17-docker.md](docs/evidence/issue-17-docker.md)                                                                                       |
| Normalized state and reporting                             | Projection and report/dashboard over recorded data                                                    | [issue-14-task-states.md](docs/evidence/issue-14-task-states.md), [issue-15-reporting.md](docs/evidence/issue-15-reporting.md)                                                                                                           |
| Devin API smoke test                                       | Minimal session create + poll, no repository involved                                                 | [issue-5-devin-smoke.md](docs/evidence/issue-5-devin-smoke.md)                                                                                                                                                                           |
| CI                                                         | GitHub Actions: format, lint, type-check, tests, build, startup smoke                                 | [issue-16-ci.md](docs/evidence/issue-16-ci.md)                                                                                                                                                                                           |

Claims in this README are limited to what those recordings show. In
particular, the Docker walkthrough for this README was run without
credentials; the real-run stages were recorded separately as linked above.

## Known limitations and trust boundaries

- **Verification is not a security sandbox.** The approved command runs
  inside the same `app` container, as the same non-root user (`app`,
  uid 1001), with a sanitized environment (allow-listed variables, no
  GitHub/Devin credentials), a timeout, and process-group cleanup — but it
  shares the container filesystem (including `/app/data` and the SQLite
  database) and network with the orchestrator. Use only with trusted
  repositories and remediation inputs (the controlled Superset fork).
- **Nothing runs without an operator approval.** Issue `## Verification`
  sections, agent-reported `tests_run`, and operator proposals are all
  _candidates_; only a spec whose sha256 an operator approved is executed.
  `devin-ready` authorizes remediation, not shell commands.
- **Public repositories only** for verification checkouts (unauthenticated
  HTTPS, `GIT_TERMINAL_PROMPT=0`); private repositories surface as
  `error/checkout_failed`, never as success.
- **In-flight verification is not cancelled gracefully.** `docker compose
stop` gives 15 s; a running checkout/setup/command (timeouts up to
  5 / 30 / 15 min) may be killed. Recorded state and workspaces persist on
  the volume; a mid-run verification is not reconciled across restarts.
- **Browser reruns can overlap tracker verification.** The explicit browser
  rerun is synchronous and may race a tracking poll on the same attempt and
  workspace; completion is transaction-guarded, but checkout/setup work can
  collide.
- **Polling by default.** Without the optional webhook, intake latency is
  bounded by `GITHUB_POLL_INTERVAL_MS`; dispatch and tracking latency by the
  other interval settings (60 s each by default). The webhook only
  accelerates intake; it does not change dispatch or tracking cadence.
- **Recovery gaps are tracked, not hidden.** If `createSession` fails or
  times out, the attempt stays `dispatching` and the Issue #20 reconciliation
  poller adopts the matching Devin session by its correlation tag instead of
  creating a second one; transient revalidation failures release the claim
  for the next poll and retry caps are Issue #21.
- **Unauthenticated report endpoints** — local / trusted network only.
- **Single process, SQLite.** Designed for one orchestrator instance;
  duplicate-dispatch protection is enforced at the database level, not
  across databases.

## Further documentation

- [docs/operations.md](docs/operations.md) — operational detail: Docker
  persistence and single-command run, graceful shutdown, operator CLIs,
  verification spec format, per-stage behaviour (intake, dispatch and
  duplicate protection, structured output, tracking), single-pass demo
  scripts, smoke test.
- [architecture.md](architecture.md) — design, persistence model, state
  machine, verification approval boundary, constraints.
- [product.md](product.md) — product scope.
- [docs/evidence/](docs/evidence/) — per-issue recorded evidence.
- [REVIEW.md](REVIEW.md), [AGENTS.md](AGENTS.md) — review notes and
  contributor conventions.

## Local development

Prerequisites: Node.js 24.21.0, pnpm 12.4.2. For running independent
verification on the host (outside Docker) additionally `git`, `uv`, Python
3.12 and the Superset native build packages listed in
[docs/operations.md](docs/operations.md#host-prerequisites-for-verification).

```bash
pnpm install
cp .env.example .env
pnpm dev          # http://localhost:3000/health, /ready, /api/report, /dashboard
pnpm check        # format:check, lint, type-check, test, build
```

Other commands: `pnpm build` / `pnpm start`, `pnpm test`,
`pnpm test:coverage`, `pnpm lint`, `pnpm format`, `pnpm type-check`,
`pnpm db:generate` / `pnpm db:migrate`, `pnpm demo:restart` (state-restart
demo in a separate database). Tests use `./test-database.db`; the restart
demo uses `./data/demo-state-restart.db` (`DEMO_DATABASE_PATH`).

Conventions: strict TypeScript, Drizzle ORM for all database access,
idempotent event processing, tests for every external side effect, and
evidence preserved under `docs/evidence/` for every issue.
