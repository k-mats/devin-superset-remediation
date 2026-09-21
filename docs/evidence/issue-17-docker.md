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
(SIGTERM → exit 0), and that no secrets are baked into the image.

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

## Result

| Check                                            | Outcome                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Clean-checkout `docker compose up --build`       | passed — container `healthy`, no credentials required                                                      |
| `/health`, `/ready`, `/api/report`, `/dashboard` | all HTTP 200                                                                                               |
| Seed task persisted                              | `totalTasks: 1`, `QUEUED` "Docker persistence check"                                                       |
| `docker compose restart`                         | task still present                                                                                         |
| `docker compose down && up -d`                   | task still present (named volume `orchestrator-data`)                                                      |
| Graceful shutdown                                | SIGTERM log `Shutting down`, exit code 0                                                                   |
| Verification toolchain in image                  | git 2.39.5, uv 0.9.26, uv-managed Python 3.12.12, native deps                                              |
| Secrets                                          | none in image layers/config; env values empty by default; `.env` untracked and excluded from build context |
| Build context                                    | 3.54 kB transferred (`.dockerignore`)                                                                      |

Cleanup: `docker compose down -v` removes the volume and all seeded state.
