# devin-superset-remediation

Event-driven orchestration service that uses the Devin API to remediate
selected issues in a fork of Apache Superset.

Label an issue `devin-ready` in the configured Superset fork and the service
picks it up by polling, hands it to a Devin session with a structured-output
contract, tracks the session and the resulting pull request, and finally
verifies the fix with an operator-approved command that the orchestrator runs
itself on a clean checkout of the PR head. Every step is persisted in SQLite
and visible at `/dashboard` and `/api/report`. No public webhook endpoint or
tunnel is required; all traffic is outbound HTTPS to GitHub and Devin.

```
GitHub issue labelled `devin-ready`      intake (polled every 60 s)
        ▼
Devin session                            dispatch — at most once per task
        ▼
Pull request                             tracked: session status, structured outcome, PR head
        ▼
Independent verification                 operator approves a command, orchestrator runs it
        ▼
/dashboard, /api/report                  only VERIFIED counts as success
```

## Quick start

### 1. Prerequisites

- Docker Engine 20.10+ with Docker Compose v2+ (nothing else is needed on the host).
- A GitHub personal access token with **read/write access to Issues and
  read access to Pull Requests, Checks, and Commit statuses** on the Superset
  fork (write on Issues is used only to apply the `devin-verified` label).
- A Devin **v3 Organization API** key and your organization id
  (`DEVIN_API_KEY`, `DEVIN_ORG_ID`). The Devin organization must have access
  to the Superset fork so sessions can open pull requests against it.

### 2. Configure

```bash
git clone https://github.com/k-mats/devin-superset-remediation.git
cd devin-superset-remediation
cp .env.example .env
```

Edit `.env` and fill in the five required values; everything else can stay
at its default:

```dotenv
GITHUB_TOKEN=ghp_...
GITHUB_REPO_OWNER=<owner of the Superset fork>
GITHUB_REPO_NAME=<name of the Superset fork>
DEVIN_API_KEY=...
DEVIN_ORG_ID=...
```

### 3. Run

```bash
docker compose up --build
```

The first build takes a few minutes; afterwards it starts in about 10 s. In a
second terminal:

```bash
docker compose ps                     # STATUS ... (healthy)
curl http://localhost:3000/ready      # {"status":"ready","database":"connected",...}
```

Then open <http://localhost:3000/dashboard>. If the startup log contains a
`... skipped because configuration is incomplete` warning, a required
variable is missing from `.env`.

Stop with `docker compose down` (state kept on the `orchestrator-data`
volume) or `docker compose down -v` (delete all state).

### 4. Remediate an issue

1. Open an issue in the Superset fork and add the `devin-ready` label.
   Optionally include a `## Verification` section with a fenced `bash` block
   containing the command that proves the fix; it becomes a _candidate_ only.
2. Within ~1 minute the task appears on the dashboard as `QUEUED`, then
   `RUNNING` once the Devin session is created. Follow the session through
   the link on the dashboard.
3. When Devin finishes and opens a PR, the task moves to `PR_OPEN` /
   `VERIFYING`.
4. **Approve the verification** (always manual): click the **Verification**
   link on the task's dashboard row (it opens
   `/operator/attempts/<attempt id>/verification`), review the candidate
   command, and approve it — or propose your own first. The equivalent CLI is
   `docker compose exec app node dist/cli/verification-approve.js --attempt <id> --spec-hash <sha256>`.
5. On the next tracking pass the orchestrator clones the PR head, sets up the
   Superset repository, runs the approved command, and records the result.
   The task ends as `VERIFIED` (success; the PR gets the `devin-verified`
   label) or `VERIFICATION_FAILED`. Other terminal states are `NEEDS_HUMAN`,
   `NO_ACTION`, `FAILED`, and `CANCELLED`.

Superset setup inside the verification step can take a long time (up to the
30 min `VERIFICATION_SETUP_TIMEOUT_MS` default). Watch progress with
`docker compose logs -f app`.

## Configuration reference

All variables are documented in [.env.example](.env.example). Summary:

| Group                       | Variables                                                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required                    | `GITHUB_TOKEN`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`, `DEVIN_API_KEY`, `DEVIN_ORG_ID`                                                                                                                  |
| Labels                      | `GITHUB_INTAKE_LABEL` (`devin-ready`), `GITHUB_VERIFIED_LABEL` (`devin-verified`; empty disables)                                                                                                         |
| Devin                       | `DEVIN_API_URL` (`https://api.devin.ai/v3`), `DEVIN_MAX_ACU_PER_SESSION` (`5`)                                                                                                                            |
| Polling intervals           | `GITHUB_POLL_INTERVAL_MS`, `DEVIN_DISPATCH_INTERVAL_MS`, `DEVIN_TRACKING_INTERVAL_MS`, `DEVIN_RECONCILE_INTERVAL_MS` (60000 each; `0` disables), `DEVIN_DISPATCH_GRACE_MS`, `DEVIN_SESSION_STALE_WARN_MS` |
| Verification                | `VERIFICATION_ENABLED` (`true`), `VERIFICATION_WORKSPACE_ROOT`, `VERIFICATION_COMMAND_TIMEOUT_MS`, `VERIFICATION_SETUP_TIMEOUT_MS`, `VERIFICATION_CHECKOUT_TIMEOUT_MS`, `VERIFICATION_MAX_OUTPUT_BYTES`   |
| Optional webhook            | `GITHUB_WEBHOOK_SECRET` — enables signed `POST /webhooks/github` as a low-latency intake path; polling stays on as the fallback                                                                           |
| Server (compose pins these) | `PORT`, `HOST`, `NODE_ENV`, `DATABASE_PATH`, `LOG_LEVEL`                                                                                                                                                  |

Secrets are never written to the image, `/api/report`, `/dashboard`, or logs.

## Inspecting results

| What                                      | Where                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| Everything at a glance                    | <http://localhost:3000/dashboard> — per-state cards, throughput, per-task table with evidence |
| Machine-readable report                   | `GET /api/report`                                                                             |
| Liveness / readiness                      | `GET /health`, `GET /ready`                                                                   |
| One attempt in detail                     | `docker compose exec app node dist/cli/verification-show.js --attempt <id>`                   |
| Review / propose / approve / rerun a spec | `/operator/attempts/<id>/verification`                                                        |
| Requeue a stuck dispatch                  | `docker compose exec app node dist/cli/attempt-requeue.js --attempt <id>`                     |
| Logs                                      | `docker compose logs -f app`                                                                  |

The HTTP endpoints are unauthenticated and intended for local or trusted
internal use only.

## What counts as success

A task is successful only when its normalized state is **`VERIFIED`**: the
current PR head has a recorded, passing, operator-approved independent
verification. An open PR, a `remediated` structured output, or agent-reported
passing tests are not success on their own. If the PR head moves, the task
drops back to `PR_OPEN` until the new head is verified. State definitions are
in [architecture.md](architecture.md#normalized-task-state).

## Known limitations and trust boundaries

- **Verification is not a security sandbox.** The approved command runs in
  the `app` container as a non-root user with a sanitized environment and a
  timeout, but shares the container filesystem and network with the
  orchestrator. Use only with trusted repositories and inputs.
- **Nothing runs without operator approval.** Issue `## Verification`
  sections, agent-reported `tests_run`, and operator proposals are all
  candidates; only a spec whose sha256 an operator approved is executed.
- **Public repositories only** for verification checkouts (unauthenticated
  HTTPS).
- **In-flight verification is not cancelled gracefully** on `docker compose
stop`; a mid-run verification is not reconciled across restarts.
- **Single process, SQLite.** Designed for one orchestrator instance.
- **Observed ACU may be unreliable.** In runs so far, `acus_consumed`
  returned by the Devin API has appeared to be `0.0` even for sessions that
  did real work, so the "ACU observed" values and the ACU throughput figure
  on the dashboard may understate real consumption. The cause (API
  behaviour vs. this service's session polling) has not been investigated.

## Further documentation

- [docs/operations.md](docs/operations.md) — operations guide: Docker
  details, operator CLIs, verification spec format, per-stage behaviour,
  single-pass `pnpm demo:*` scripts, smoke test.
- [architecture.md](architecture.md) — design, persistence model, state
  machine, verification approval boundary.
- [product.md](product.md) — product scope.
- [docs/evidence/](docs/evidence/) — recorded evidence of real runs per issue.
- [REVIEW.md](REVIEW.md), [AGENTS.md](AGENTS.md) — review notes and
  contributor conventions.

## Local development

Prerequisites: Node.js 24.21.0 and pnpm 12.4.2. Running verification on the
host (outside Docker) additionally needs `git`, `uv`, Python 3.12 and the
Superset native build packages listed in
[docs/operations.md](docs/operations.md#host-prerequisites-for-verification).

```bash
pnpm install
cp .env.example .env   # fill in the required values as above
pnpm dev               # http://localhost:3000/dashboard
pnpm check             # format:check, lint, type-check, test, build
```

Other commands: `pnpm build` / `pnpm start`, `pnpm test`, `pnpm lint`,
`pnpm format`, `pnpm type-check`, `pnpm db:generate` / `pnpm db:migrate`.
