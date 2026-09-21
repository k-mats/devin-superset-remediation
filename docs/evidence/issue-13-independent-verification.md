# Issue #13 — Independent verification evidence

## Purpose

Show that the orchestrator does **not** equate "Devin created a PR" with a
successful remediation: the attempt for the real remediation
`k-mats/superset#13` / PR #14 only reached `completed / succeeded` after an
operator-approved verification command was executed by the orchestrator against
the exact current PR head, and every intermediate state (missing checks,
pending approval, a failed run) was persisted and remains visible.

## Subject

- Original issue: https://github.com/k-mats/superset/issues/13
  (`fix(mcp): query_dataset returns UnexpectedError for reversed time_range`)
- Remediation PR: https://github.com/k-mats/superset/pull/14 (state `open`)
- Devin session (adopted, no new paid session):
  `5957ce490e56465b930e0349ace6db68`
- Verified PR head SHA: `f22d3d3f55b19803542416f4150a62cbc7607fc0`
  (refreshed from the GitHub API immediately before each verification run)

## Setup

- Fresh SQLite database (`DATABASE_PATH=./data/evidence-issue-13.db`).
- Branch `devin/1789980536-issue-13-independent-verification` (PR #53).
- `VERIFICATION_ENABLED=true`, `VERIFICATION_WORKSPACE_ROOT=./data/verification`.
- Credentials supplied via environment (`DEVIN_API_KEY`, `DEVIN_ORG_ID`,
  `GITHUB_TOKEN`, read-only); values are not recorded here and are not passed to
  the verification command (`baseEnv()` whitelists `PATH HOME LANG LC_ALL TERM
TMPDIR` and adds `CI=1 GIT_TERMINAL_PROMPT=0`; the Superset adapter adds
  `PATH`/`VIRTUAL_ENV`/`PYTHONDONTWRITEBYTECODE`).
- Host prerequisites for the Superset adapter: `uv`, Python 3.12, and native
  build deps for `mysqlclient` / `python-ldap`.
- `k-mats/superset#13` has **no** `## Verification` section, so the command was
  proposed and approved through the operator CLI.

## Sequence

```bash
pnpm demo:intake                                            # task 1 + attempt 1 (pending)
pnpm demo:adopt-session --attempt 1 --session 5957ce49…     # attach existing Devin session
pnpm demo:tracking                                          # snapshot, structured output, PR verified, verifying
pnpm verification:show --attempt 1                          # candidate from agent_tests_run, pending_approval
pnpm verification:propose --attempt 1 --command \
  "pytest tests/unit_tests/mcp_service/dataset/tool/test_query_dataset.py::test_query_dataset_reversed_time_range -q"
pnpm verification:approve --attempt 1 --spec-hash 67ebd294… # stale (agent) hash -> refused, exit 1
pnpm verification:approve --attempt 1 --spec-hash 590eadd1… # exact candidate hash -> approved
pnpm demo:verification --attempt 1                          # run 1: failed (exit 127, see below)
pnpm demo:verification --attempt 1 --rerun                  # run 2: passed -> completed / succeeded
```

## Approval boundary

| Item                                | Value                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| Agent-derived candidate (never run) | sha256 `67ebd2946795cff708639d522b580773507e753605d33066f3407b4aabdb481d`, source `agent_tests_run` |
| Operator candidate                  | sha256 `590eadd10bdffac99af35dcba67a28c4330b33bca2fda534b812b58711dc13df`, source `operator`        |
| Approved spec                       | shell `sh`, sha256 `590eadd1…`, `approved_by=operator`, `approved_at=1789981839374`                 |

Approved script (executed verbatim as `sh -eu -c <script>` in the checkout):

```sh
pytest tests/unit_tests/mcp_service/dataset/tool/test_query_dataset.py::test_query_dataset_reversed_time_range -q
```

The agent-derived candidate concatenates Devin's three `agent_tests_run`
commands and contains a non-executable placeholder (`<same files>`); it was
surfaced only as a candidate and was never executed. Approving it by its hash
after the operator proposal was refused because it no longer matched the
current candidate.

## Verification history (`verifications` table, attempt 1)

All rows are for head `f22d3d3f55b19803542416f4150a62cbc7607fc0`.

| id  | kind            | status       | reason                               | exit | evidence                                                                             |
| --- | --------------- | ------------ | ------------------------------------ | ---- | ------------------------------------------------------------------------------------ |
| 1   | `github_checks` | `unverified` | `no_checks`                          | –    | `check_runs=0 (); statuses=0 ()` — https://github.com/k-mats/superset/pull/14/checks |
| 2   | `command`       | `unverified` | `verification_spec_pending_approval` | –    | `candidate_sha256=67ebd294… source=agent_tests_run`                                  |
| 3   | `command`       | `failed`     | –                                    | 127  | `sh: 1: pytest: not found` (see note)                                                |
| 4   | `command`       | `passed`     | –                                    | 0    | `1 passed in 1.69s` (`setup_ms=171`, 14.1 s wall incl. checkout)                     |

Rows 3 and 4 carry the exact `spec_script` / `spec_sha256 = 590eadd1…`.

Note on row 3: the first execution failed because the adapter built the venv
`PATH` entry from a relative `VERIFICATION_WORKSPACE_ROOT`, which does not
resolve from the child process cwd. The fix (`path.resolve` on the workspace
root) is part of PR #53. The failed row was deliberately left in place: it is
the required visible failure history, and `--rerun` re-executed the identical
approved spec against the identical head rather than editing or deleting it.

## Final attempt state

```json
{
  "state": "completed",
  "outcome": "succeeded",
  "outcome_reason": "independent_verification_passed: f22d3d3f55b19803542416f4150a62cbc7607fc0",
  "pr_url": "https://github.com/k-mats/superset/pull/14",
  "pr_head_sha": "f22d3d3f55b19803542416f4150a62cbc7607fc0",
  "pr_state": "open"
}
```

The attempt stayed in `verifying` after rows 1–3; it moved to
`completed / succeeded` only when row 4 (`command`, `passed`, current head)
was recorded. The GitHub Checks row remained `unverified` throughout and did
not contribute to the outcome.

## Agent-reported vs independent evidence

`attempts.agent_tests_run` (Devin's own report, verbatim) is retained
separately and was never treated as verification:

```json
[
  {
    "command": "pytest tests/unit_tests/mcp_service/dataset/tool/test_query_dataset.py -q",
    "result": "passed"
  },
  { "command": "ruff check … && ruff format --check <same files>", "result": "passed" },
  { "command": "pre-commit run mypy --files …", "result": "passed" }
]
```

Independent evidence is the `verifications` rows above, produced by the
orchestrator-managed runner in an isolated clone at the refreshed head SHA.

## Acceptance criteria mapping

| Criterion                                    | Evidence                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Verification against the current PR head     | every row keyed to `f22d3d3f…`; head refreshed before each run                                                                              |
| Missing checks are `unverified`, not success | row 1                                                                                                                                       |
| Devin-reported tests kept separate           | `agent_tests_run` vs `verifications`                                                                                                        |
| Failures remain visible                      | row 3 retained alongside row 4                                                                                                              |
| Original problem shown fixed                 | row 4: focused regression test for reversed `time_range` passes; the same test fails on the base commit without the fix (feasibility check) |
| Only approved commands execute               | rows 2/3/4; stale-hash approval refused                                                                                                     |

Raw logs for each step were kept locally under `data/logs/issue13-*.log` and
the final DB dump as `data/logs/issue13-10-final-db-state.json` (not
committed).
