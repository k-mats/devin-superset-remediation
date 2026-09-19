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

## Evidence

| Field           | Value |
| --------------- | ----- |
| Session ID      | TBD   |
| Session URL     | TBD   |
| status          | TBD   |
| status_detail   | TBD   |
| origin          | TBD   |
| service_user_id | TBD   |
| ACU consumed    | TBD   |
| created_at      | TBD   |

## Sanitized response example

```json
TBD — paste the sanitized JSON summary printed by the script here
```

Note: no API tokens or raw responses are recorded here — only the sanitized
fields listed above.
