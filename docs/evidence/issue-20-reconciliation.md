# Issue #20 evidence — restart reconciliation and uncertain-dispatch recovery

## Provider API probe (live, verified against the v3 Organization API)

Endpoint: `GET https://api.devin.ai/v3/organizations/{org_id}/sessions`
(`SessionsQueryParams` in `https://docs.devin.ai/v3-openapi.yaml`; requires a
service user with `ViewOrgSessions`). Probed with the repo-scoped
`DEVIN_API_KEY` against `org-0186004a314f4041bbc5f8f1bc8e401d`.

Observed behaviour:

- Credentials authorised: `200`, 35 sessions total in the org, 10 tagged
  `devin-superset-remediation`, all with the full 5-tag set from
  `buildSessionTags` intact (`tags` survive creation; `origin: api`).
- `tags=correlation:<uuid>` → exactly **1** item (`total: 1`).
- Matching is **exact and case-sensitive**: `tags=correlation:` → 0; partial
  uuid → 0; upper-cased tag → 0; comma-joined `a,b` → 0 (one literal tag).
- Multiple `tags=` params are **OR**, not AND:
  `tags=devin-superset-remediation&tags=<corr>` → 10;
  `tags=<corr>&tags=nonexistent` → 1. The reconciler therefore queries the
  single correlation tag and verifies the full expected tag set client-side.
- Pagination: `first` ≤ 200 (default 100), cursor `end_cursor`/`after`,
  `has_next_page`; `total` is present.
- `is_archived` exists but is never sent: an archived-but-existing session
  must still be adopted, not recreated (test covers an archived match).
- `/v3/enterprise/organizations` → 403 for this key (enterprise scope not
  granted; irrelevant to the lookup).
- Not verified (would require creating a paid session): whether a freshly
  created session is immediately visible in the list. Reconciliation
  tolerates 0 matches by re-checking on subsequent passes.

## `pnpm check` summary

Run on the implementation branch (format:check, lint, type-check, test,
build): all green — see the PR CI run for the recorded output. Test coverage
added:

- `tests/reconcile-uncertain-dispatch.test.ts` — grace-period gating, no
  match, archived-session adoption + tracker handoff, ambiguous match,
  identity mismatch, lookup failure (DevinApiError 503 and network error),
  idempotent repeat passes, and concurrent-adoption `already_adopted`;
  every case asserts `createSession` is never called.
- `tests/restart-recovery.test.ts` — close/reopen of the file-backed SQLite
  database: `session_created`/`running` attempts resume tracking without
  `createSession`, a `verifying` attempt refreshes its PR even when
  `getSession` rejects, and a completed attempt's row and `verifications`
  history are unchanged after restart.
- `tests/devin-client.test.ts` — `listSessions` URL uses repeated `tags=`
  params, omits `is_archived`, and parses the paginated schema.
