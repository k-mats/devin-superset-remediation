# Issue #16 — Application tests + CI evidence

## Purpose

Show that the orchestration application itself is continuously verified by
GitHub Actions on every pull request and push to `main`, without any GitHub or
Devin credentials.

## Setup

- Workflow: `.github/workflows/ci.yml`
- Triggers: `pull_request`, `push` to `main`; `permissions: contents: read`;
  superseded runs for the same PR/branch are cancelled.
- Runtime pinned from the repository: Node 24.21.0 (`.node-version`),
  pnpm 12.4.2 (`packageManager`), `pnpm install --frozen-lockfile`,
  pnpm store cache.
- Four parallel jobs reuse the existing package scripts:

| Check                 | Commands                                                          |
| --------------------- | ----------------------------------------------------------------- |
| Format & lint         | `pnpm format:check`, `pnpm lint`                                  |
| Type check            | `pnpm type-check`                                                 |
| Tests                 | `pnpm test`                                                       |
| Build & startup smoke | `pnpm build`, `node dist/index.js`, `curl /health`, `curl /ready` |

The startup smoke runs the built artifact against a fresh SQLite database in a
temporary directory, bound to `127.0.0.1`, with intake, dispatch, tracking and
verification workers disabled (`*_INTERVAL_MS=0`, `VERIFICATION_ENABLED=false`).
It polls `/health` until ready (aborting if the process exits), requires 2xx
from both `/health` and `/ready`, prints the application log on failure and
always terminates the spawned process. `tests/startup.test.ts` remains as the
in-process startup test.

## Demonstrated run

- Pull request: https://github.com/k-mats/devin-superset-remediation/pull/57
- Commit: `ccc084c1492e34ee6c20b5a870132316a560dfca`
- Green run: https://github.com/k-mats/devin-superset-remediation/actions/runs/35622046994

## Result

| Check                 | Outcome                                                  |
| --------------------- | -------------------------------------------------------- |
| Format & lint         | passed                                                   |
| Type check            | passed                                                   |
| Tests                 | passed — `Test Files 22 passed (22)`, `Tests 311 passed` |
| Build & startup smoke | passed — `/health` `ok`, `/ready` `ready`/`connected`    |

Smoke step output from the run:

```
{"status":"ok","timestamp":"2026-09-21T15:54:27.142Z"}
{"status":"ready","database":"connected","timestamp":"2026-09-21T15:54:27.148Z"}
Startup smoke passed
```

The run used only the committed repository contents on a clean checkout: no
`.env`, no pre-existing database, no GitHub or Devin API calls.
