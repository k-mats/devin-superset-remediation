# Issue #17 — Dockerize the whole solution evidence

Evidence bullets from the issue:

- **Dockerfile**: `Dockerfile` (multi-stage, `node:24.21.0-bookworm-slim` build
  and runtime stages; runtime bundles `git`, `uv` 0.9.26, a uv-managed Python
  3.12, and the Superset native build deps; non-root `app` uid 1001)
- **Compose file**: `compose.yaml` (service `app`, port 3000, `env_file: .env`,
  named volume `orchestrator-data:/app/data`, `curl`-based healthcheck,
  `restart: unless-stopped`, `stop_grace_period: 15s`)
- **Clean-start command**: `cp .env.example .env && docker compose up --build`

## Purpose

Show that a clean checkout of the repository runs the full orchestration
service with a single `docker compose up --build`, that persisted SQLite state
survives container restart and recreation, that shutdown is graceful
(SIGTERM → exit 0), that no secrets are baked into the image, and that the
real independent-verification path (Issue #13) — clone, `uv` venv setup, and
an approved `pytest` command — runs end-to-end inside the production image.

## Setup

- Host: Docker Engine 29.7.2, Docker Compose v5.4.0
- Fresh clone in `~/docker-clean-check` from the pushed branch
  `devin/1790007295-issue-17-docker`; `cp .env.example .env` (all credentials
  empty — no GitHub/Devin calls are made)
- `.dockerignore` keeps the build context to **3.54 kB** transferred
  (`docker buildx build --progress=plain`: `transferring context: 3.54kB`)

## Demonstrated run

### Build and startup

```bash
docker compose up --build -d
# => Image docker-clean-check-app Built
# => Container docker-clean-check-app-1 Started

docker compose ps
# docker-clean-check-app-1   Up 17 seconds (healthy)   0.0.0.0:3000->3000/tcp

docker images docker-clean-check-app --format '{{.ID}} {{.Size}}'
# 348d746cd945 1.22GB
```

### Endpoints

```bash
curl -i http://localhost:3000/health
# HTTP/1.1 200 OK
# {"status":"ok","timestamp":"2026-09-21T16:19:23.707Z"}

curl -i http://localhost:3000/ready
# HTTP/1.1 200 OK
# {"status":"ready","database":"connected","timestamp":"2026-09-21T16:19:23.713Z"}

curl -i http://localhost:3000/api/report
# HTTP/1.1 200 OK
# {"generatedAt":...,"context":{"databasePath":"/app/data/orchestrator.db",...},
#  "summary":{"totalTasks":0,...},"tasks":[],...}

curl -i http://localhost:3000/dashboard
# HTTP/1.1 200 OK  (content-type: text/html, <!doctype html> ...)
```

### Persistence (seed task → restart → down/up)

Seed one task + pending attempt via the compiled code inside the container:

```bash
docker compose exec app node -e "import('/app/dist/db/client.js').then(async ({runMigrations,closeDb})=>{runMigrations();const s=await import('/app/dist/db/task-state.js');const t=s.upsertTask({repoOwner:'k-mats',repoName:'superset',issueNumber:17,title:'Docker persistence check'});s.createAttempt(t.id);console.log(JSON.stringify(t));closeDb();})"
# {"id":1,"repoOwner":"k-mats","repoName":"superset","issueNumber":17,
#  "title":"Docker persistence check","createdAt":1790007574412,...}
```

No sqlite locking issue: the one-shot insert alongside the running server
succeeded on the first try (better-sqlite3 synchronous access; single short
write).

```bash
curl -s localhost:3000/api/report   # summary.totalTasks = 1, task QUEUED "Docker persistence check"
docker compose restart
curl -s localhost:3000/api/report   # totalTasks = 1 — data kept
docker compose down && docker compose up -d   # container recreated
docker compose ps                    # Up 15 seconds (healthy)
curl -s localhost:3000/api/report   # totalTasks = 1 — data kept on the named volume
```

### Graceful shutdown

```bash
docker compose stop
docker compose logs app
# {"level":30,...,"signal":"SIGTERM","msg":"Shutting down"}
docker inspect docker-clean-check-app-1 --format '{{.State.ExitCode}}'
# 0
```

Scope note: this graceful shutdown was demonstrated with **no long-running
verification in flight** (idle service). An in-flight verification —
checkout / setup / command, with timeouts up to 5 / 30 / 15 minutes — may
be forcibly killed when `stop_grace_period` (15s) expires. Verification
workspaces and recorded state persist on the `orchestrator-data` volume,
but graceful cancellation and restart reconciliation of an in-flight
verification are not implemented yet (follow-up).

### In-container verification toolchain

```bash
docker compose exec app sh -c 'git --version; uv --version; uv python find 3.12; python3 --version; whoami; id; touch /app/data/.w && echo writable && rm /app/data/.w'
# git version 2.39.5
# uv 0.9.26
# /opt/uv/python/cpython-3.12.12-linux-x86_64-gnu/bin/python3.12
# Python 3.11.2
# app
# uid=1001(app) gid=1001(app) groups=1001(app)
# writable
```

(`python3` on PATH is Debian's 3.11 system Python; the uv-managed 3.12 used by
the superset repo-setup adapter resolves via `uv python find` / `uv venv
--python 3.12`.)

The toolchain above is not only present but was exercised end-to-end by a
real remediation verification — see "End-to-end independent verification
inside the container" below.

### No secrets in the image

```bash
docker history --no-trunc docker-clean-check-app | grep -iE 'token|key|secret'
# matches only base-image layer commands (public GPG keys used to verify the
# node/yarn tarballs) — no credentials

docker image inspect docker-clean-check-app --format '{{json .Config.Env}}'
# ["PATH=...","NODE_VERSION=24.21.0","YARN_VERSION=1.22.22",
#  "UV_PYTHON_INSTALL_DIR=/opt/uv/python","UV_CACHE_DIR=/home/app/.cache/uv",
#  "NODE_ENV=production","DATABASE_PATH=/app/data/orchestrator.db"]

docker compose exec app env | grep -E '^(GITHUB|DEVIN)'
# GITHUB_TOKEN=  GITHUB_REPO_OWNER=  GITHUB_REPO_NAME=  GITHUB_WEBHOOK_SECRET=
# DEVIN_API_KEY=  DEVIN_ORG_ID=  ... (all empty — values come from .env at run
# time, not the image)

docker compose exec app ls -la /app
# data/  dist/  drizzle/  node_modules/  package.json — no .env file present

git ls-files | grep -E '^\.env$'
# (no output — .env is never tracked; .dockerignore also excludes .env/.env.*
#  from the build context while keeping .env.example)
```

### Operator CLIs inside the container

Recorded on a fresh clone of the pushed branch with a rebuilt image
(`docker compose up --build -d`), after seeding task+attempt id 1 with the
README seed command:

```bash
docker compose exec app ls dist/cli
# verification-approve.js  verification-propose.js  verification-show.js  (+ .map)

docker compose exec app node dist/cli/verification-propose.js --attempt 1 --command "echo ok"
# Candidate sha256: 97b9f51fe854c6a83b766f5a6c4f577933ab4c3696ab685e574078893ab47251
# Candidate source: operator
# Script:
# echo ok
# Approve with: verification-approve --attempt 1 --spec-hash 97b9f51f...

docker compose exec app node dist/cli/verification-approve.js --attempt 1 --spec-hash 0000...0000
# Refusing to approve: 0000...0000 does not match the current candidate.
# (exit code 1)

docker compose exec app node dist/cli/verification-approve.js --attempt 1 --spec-hash 97b9f51f...ab47251
# New approved sha256:      97b9f51fe854c6a83b766f5a6c4f577933ab4c3696ab685e574078893ab47251
# Approved by:              operator
# (exit code 0)

docker compose exec app node dist/cli/verification-show.js --attempt 1
# ... Approved table: sha256 97b9f51f..., approved_by 'operator', script 'echo ok'
# Approval status: approved

docker compose exec app node dist/cli/verification-approve.js
# Usage: verification-approve --attempt <id> --spec-hash <sha256>
# (exit code 1)
```

No `tsx`, dev dependencies, or `.env` are required inside the container
(`dotenv` reports `injected env (0) from .env`).

### End-to-end independent verification inside the container (Issue #13 remediation)

Recorded on a fresh clone of image commit
`a04bed7afd79f8c1a49a79d2fcec1daabbabad13` (`docker compose up --build -d`,
empty `orchestrator-data` volume). Subject: `k-mats/superset` issue #13
(`fix(mcp): query_dataset returns UnexpectedError for reversed time_range`),
PR #14, head SHA `f22d3d3f55b19803542416f4150a62cbc7607fc0`, adopted Devin
session `5957ce490e56465b930e0349ace6db68` (no new Devin session created).
The verification workspace lives on the `orchestrator-data` volume under
`/app/data/verification/k-mats__superset`.

Two driver scripts were used: `evidence-seed.mjs` (mirrors
`scripts/adopt-session-demo.ts` + intake/tracking writes over compiled
`dist/` modules: seeds task+attempt, marks dispatching/session_created,
records PR #14, marks `verifying`) and `evidence-verify.mjs` (mirrors
`scripts/verification-demo.ts`: refreshes PR state then calls
`verifyRemediationOnce`, the same function the service poll uses). Both were
copied into the volume with `docker compose cp` and run unmodified. The
GitHub token was fetched with `gh auth token` on the host and passed
per-command via `docker compose exec -e GITHUB_TOKEN=...` — never written to
`.env`, the image, or the volume scripts.

```bash
# Seed → attempt 1 in state verifying
docker compose exec -e GITHUB_TOKEN="$T" app node /app/data/evidence-seed.mjs
# {"task_id":1,"attempt_id":1,"state":"verifying",
#  "pr_url":"https://github.com/k-mats/superset/pull/14",
#  "pr_head_sha":"f22d3d3f55b19803542416f4150a62cbc7607fc0"}

# Operator flow via the compiled CLIs
docker compose exec app node dist/cli/verification-propose.js --attempt 1 \
  --command "pytest tests/unit_tests/mcp_service/dataset/tool/test_query_dataset.py::test_query_dataset_reversed_time_range -q"
# Candidate sha256: 590eadd10bdffac99af35dcba67a28c4330b33bca2fda534b812b58711dc13df
# Candidate source: operator

docker compose exec app node dist/cli/verification-approve.js --attempt 1 \
  --spec-hash 590eadd10bdffac99af35dcba67a28c4330b33bca2fda534b812b58711dc13df
# New approved sha256:      590eadd10bdffac99af35dcba67a28c4330b33bca2fda534b812b58711dc13df
# Approved by:              operator

# The real verification pass: clone → uv venv (Python 3.12) → uv pip install
# -r requirements/development.txt → approved pytest command
docker compose exec -e GITHUB_TOKEN="$T" app node /app/data/evidence-verify.mjs --attempt 1
# Decision: verification_passed (64182 ms wall)
# adapter=superset setup_ms=40467
# exit_code=0
# .                                                                        [100%]
# 1 passed in 1.27s
```

Verifications table after the run:

| id  | kind            | status       | reason      | exit_code | head_sha   | spec_sha256 |
| --- | --------------- | ------------ | ----------- | --------- | ---------- | ----------- |
| 1   | `github_checks` | `unverified` | `no_checks` | —         | `f22d3d3f` | —           |
| 2   | `command`       | `passed`     | —           | 0         | `f22d3d3f` | `590eadd1`  |

Post-run state:

```bash
docker compose exec app node dist/cli/verification-show.js --attempt 1
# Normalized task state: 'VERIFIED' / 'command_verification_passed'
# Approval status: approved

curl -s localhost:3000/api/report
# summary.byState.VERIFIED = 1; task k-mats/superset#13 state "VERIFIED",
# currentAttempt state "completed", outcome "succeeded",
# outcomeReason "independent_verification_passed: f22d3d3f55b19803542416f4150a62cbc7607fc0"

docker compose exec app sh -c '/app/data/verification/*/.venv/bin/python --version; uv python find 3.12'
# Python 3.12.12
# /opt/uv/python/cpython-3.12.12-linux-x86_64-gnu/bin/python3.12
```

The `/dashboard` and `/api/report` surfaces show the completed attempt
(`VERIFIED` / `succeeded`).

## Result

| Check                                            | Outcome                                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Clean-checkout `docker compose up --build`       | passed — container `healthy`, no credentials required                                                             |
| `/health`, `/ready`, `/api/report`, `/dashboard` | all HTTP 200                                                                                                      |
| Seed task persisted                              | `totalTasks: 1`, `QUEUED` "Docker persistence check"                                                              |
| `docker compose restart`                         | task still present                                                                                                |
| `docker compose down && up -d`                   | task still present (named volume `orchestrator-data`)                                                             |
| Graceful shutdown                                | SIGTERM log `Shutting down`, exit code 0                                                                          |
| Verification toolchain in image                  | git 2.39.5, uv 0.9.26, uv-managed Python 3.12.12, native deps                                                     |
| Operator CLIs run in-container (`dist/cli/`)     | propose/approve/show exit 0; wrong hash and no-args exit 1                                                        |
| In-container end-to-end verification             | passed — clone + uv setup (40.5s) + approved pytest, exit 0, `1 passed in 1.27s`; attempt `completed`/`succeeded` |
| Secrets                                          | none in image layers/config; env values empty by default; `.env` untracked and excluded from build context        |
| Build context                                    | 3.54 kB transferred (`.dockerignore`)                                                                             |

Cleanup: `docker compose down -v` removes the volume and all seeded state.
