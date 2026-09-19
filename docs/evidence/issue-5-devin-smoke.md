# Issue #5 — Devin API smoke test evidence

## Purpose

Verify that the orchestration service can authenticate against the Devin v3
Organization API and create + poll a session end-to-end, as required by GitHub
Issue #5 ("Devin API smoke test").

## Endpoints used

- `POST {baseUrl}/organizations/{org_id}/sessions` — create a session
- `GET {baseUrl}/organizations/{org_id}/sessions/{devin_id}` — poll session status

Base URL defaults to `https://api.devin.ai/v3` (`DEVIN_API_URL`). Auth is via
`Authorization: Bearer $DEVIN_API_KEY`.

## Request shape (sanitized)

```json
{
  "prompt": "This is an automated API smoke test. Reply with exactly the word \"pong\" and then finish the session immediately. Do not run any commands, do not open any repositories, and do not create files or pull requests.",
  "title": "Issue #5 Devin API smoke test",
  "tags": ["take-home", "issue-5", "smoke-test"],
  "max_acu_limit": 1,
  "resumable": false
}
```

## How to run

```bash
DEVIN_API_KEY=... DEVIN_ORG_ID=... pnpm smoke:devin
# optionally persist the sanitized summary:
SMOKE_OUTPUT_PATH=docs/evidence/issue-5-devin-smoke.json \
  DEVIN_API_KEY=... DEVIN_ORG_ID=... pnpm smoke:devin
```

The script exits non-zero unless the session both has `origin: "api"` and
completed its turn (`status: "exit"` or `status_detail` of `waiting_for_user` /
`finished`). Polling is bounded by `SMOKE_POLL_TIMEOUT_MS` (default 5 min) and
each HTTP request by a 30 s timeout — a timeout, `error`, or `suspended`
session fails the smoke test rather than passing.

## Evidence

Run on 2026-09-19 (UTC) with `pnpm smoke:devin` against `https://api.devin.ai/v3`.

| Field           | Value                                                                |
| --------------- | -------------------------------------------------------------------- |
| Session ID      | `150963c3a1564467b7e940850a07be0b`                                   |
| Session URL     | https://app.devin.ai/sessions/150963c3a1564467b7e940850a07be0b       |
| status          | `running`                                                            |
| status_detail   | `waiting_for_user` (Devin replied `pong` and finished its turn)      |
| origin          | `api`                                                                |
| service_user_id | `service-user-93e76146898e431aaae18389201489e0`                      |
| ACU consumed    | `0` (`acus_consumed` as reported by Get Session ~16s after creation) |
| created_at      | `1789830046` (2026-09-19T14:47:26Z)                                  |
| tags            | `take-home`, `issue-5`, `smoke-test`                                 |

The session's message list (`GET .../sessions/{devin_id}/messages`) shows the
prompt sent by the service account with `origin: "api"` followed by Devin's
single reply `pong`, confirming the lifecycle end-to-end.

## Sanitized response example

Summary printed by the script (`SMOKE_OUTPUT_PATH` JSON):

```json
{
  "session_id": "150963c3a1564467b7e940850a07be0b",
  "url": "https://app.devin.ai/sessions/150963c3a1564467b7e940850a07be0b",
  "status": "running",
  "status_detail": "waiting_for_user",
  "origin": "api",
  "service_user_id": "service-user-93e76146898e431aaae18389201489e0",
  "tags": ["take-home", "issue-5", "smoke-test"],
  "acus_consumed": 0,
  "created_at": 1789830046,
  "updated_at": 1789830062,
  "title": "Issue #5 Devin API smoke test",
  "originIsApi": true,
  "timedOut": false,
  "completed": true
}
```

## Observations for the main workflow

- `POST .../sessions` returns the full `SessionResponse` (including `session_id` and `url`) synchronously, so the session ID can be persisted before any polling.
- `status` stays `running` while Devin waits for input; `status_detail` (`working` → `waiting_for_user`) is the signal that a turn has completed. Terminal `status` values are `exit` / `error` / `suspended`.
- `acus_consumed` lags real usage; poll again later (or use the consumption endpoint) for final billing figures.

Note: no API tokens or raw responses are recorded here — only the sanitized
fields listed above.
