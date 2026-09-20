# Issue #6 — Persistent task state evidence

## Schema

`pnpm db:generate` emitted `drizzle/0001_nosy_gateway.sql` and the matching
`drizzle/meta/0001_snapshot.json`. The migration contains the replacement
schema, foreign key, unique indexes, all seven CHECK constraints, and drops the
placeholder `sessions` table:

```sql
CREATE TABLE `attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`attempt_number` integer NOT NULL,
	`correlation_id` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`outcome` text,
	`devin_session_id` text,
	`devin_session_url` text,
	`pr_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`dispatched_at` integer,
	`session_created_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "attempts_attempt_number_check" CHECK("attempts"."attempt_number" > 0),
	CONSTRAINT "attempts_state_check" CHECK("attempts"."state" IN ('pending', 'dispatching', 'session_created', 'running', 'completed')),
	CONSTRAINT "attempts_outcome_check" CHECK("attempts"."outcome" IS NULL OR "attempts"."outcome" IN ('succeeded', 'failed', 'cancelled', 'escalated')),
	CONSTRAINT "attempts_completed_outcome_check" CHECK(("attempts"."state" = 'completed') = ("attempts"."outcome" IS NOT NULL)),
	CONSTRAINT "attempts_session_id_check" CHECK("attempts"."state" NOT IN ('session_created', 'running') OR "attempts"."devin_session_id" IS NOT NULL),
	CONSTRAINT "attempts_succeeded_session_check" CHECK("attempts"."outcome" IS NULL OR "attempts"."outcome" <> 'succeeded' OR "attempts"."devin_session_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_correlation_id_unique` ON `attempts` (`correlation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_devin_session_id_unique` ON `attempts` (`devin_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_task_attempt_unique` ON `attempts` (`task_id`,`attempt_number`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_owner` text NOT NULL,
	`repo_name` text NOT NULL,
	`issue_number` integer NOT NULL,
	`title` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "tasks_issue_number_check" CHECK("tasks"."issue_number" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_identity_unique` ON `tasks` (`repo_owner`,`repo_name`,`issue_number`);--> statement-breakpoint
DROP TABLE `sessions`;
```

## Persistence test

`pnpm test tests/task-state.test.ts`:

```text

 RUN  v5.0.1 /home/ubuntu/repos/devin-superset-remediation


 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  13:26:49
   Duration  543ms (import 66%, tests 18%, transform 15%, worker 1%, setup 1%)
```

## Restart demo

`DATABASE_PATH=./data/demo-issue-6.db pnpm demo:restart` ran the write and read
subcommands in separate processes. The recovered state includes a completed
first attempt and a stale dispatching second attempt. The output also shows the
resolved database path:

```
{
  "pid": 5349,
  "database": "/home/ubuntu/repos/devin-superset-remediation/data/demo-issue-6.db",
  "task": {
    "id": 1,
    "repoOwner": "k-mats",
    "repoName": "superset-fork",
    "issueNumber": 101,
    "title": "Persistent task state demo",
    "createdAt": 1789910808604,
    "updatedAt": 1789910808604
  },
  "attempts": [
    {
      "id": 1,
      "taskId": 1,
      "attemptNumber": 1,
      "correlationId": "3f537e47-3cef-415f-934b-f97085d1abc7",
      "state": "completed",
      "outcome": "succeeded",
      "devinSessionId": "demo-session-3f537e47-3cef-415f-934b-f97085d1abc7",
      "devinSessionUrl": "https://app.devin.ai/sessions/demo-session-3f537e47-3cef-415f-934b-f97085d1abc7?correlation_id=3f537e47-3cef-415f-934b-f97085d1abc7",
      "prUrl": "https://github.com/k-mats/superset-fork/pull/101",
      "createdAt": 1789910808607,
      "updatedAt": 1789910808616,
      "dispatchedAt": 1789910808609,
      "sessionCreatedAt": 1789910808611,
      "completedAt": 1789910808616
    },
    {
      "id": 2,
      "taskId": 1,
      "attemptNumber": 2,
      "correlationId": "7cfc127c-0eec-4abe-986e-6acc63b83251",
      "state": "dispatching",
      "outcome": null,
      "devinSessionId": null,
      "devinSessionUrl": null,
      "prUrl": null,
      "createdAt": 1789910808617,
      "updatedAt": 1789910808619,
      "dispatchedAt": 1789910808618,
      "sessionCreatedAt": null,
      "completedAt": null
    }
  ]
}
{
  "pid": 5401,
  "database": "/home/ubuntu/repos/devin-superset-remediation/data/demo-issue-6.db",
  "task": {
    "id": 1,
    "repoOwner": "k-mats",
    "repoName": "superset-fork",
    "issueNumber": 101,
    "title": "Persistent task state demo",
    "createdAt": 1789910808604,
    "updatedAt": 1789910808604
  },
  "attempts": [
    {
      "id": 1,
      "taskId": 1,
      "attemptNumber": 1,
      "correlationId": "3f537e47-3cef-415f-934b-f97085d1abc7",
      "state": "completed",
      "outcome": "succeeded",
      "devinSessionId": "demo-session-3f537e47-3cef-415f-934b-f97085d1abc7",
      "devinSessionUrl": "https://app.devin.ai/sessions/demo-session-3f537e47-3cef-415f-934b-f97085d1abc7?correlation_id=3f537e47-3cef-415f-934b-f97085d1abc7",
      "prUrl": "https://github.com/k-mats/superset-fork/pull/101",
      "createdAt": 1789910808607,
      "updatedAt": 1789910808616,
      "dispatchedAt": 1789910808609,
      "sessionCreatedAt": 1789910808611,
      "completedAt": 1789910808616
    },
    {
      "id": 2,
      "taskId": 1,
      "attemptNumber": 2,
      "correlationId": "7cfc127c-0eec-4abe-986e-6acc63b83251",
      "state": "dispatching",
      "outcome": null,
      "devinSessionId": null,
      "devinSessionUrl": null,
      "prUrl": null,
      "createdAt": 1789910808617,
      "updatedAt": 1789910808619,
      "dispatchedAt": 1789910808618,
      "sessionCreatedAt": null,
      "completedAt": null
    }
  ],
  "stale": [
    {
      "id": 2,
      "taskId": 1,
      "attemptNumber": 2,
      "correlationId": "7cfc127c-0eec-4abe-986e-6acc63b83251",
      "state": "dispatching",
      "outcome": null,
      "devinSessionId": null,
      "devinSessionUrl": null,
      "prUrl": null,
      "createdAt": 1789910808617,
      "updatedAt": 1789910808619,
      "dispatchedAt": 1789910808618,
      "sessionCreatedAt": null,
      "completedAt": null
    }
  ]
}
OK: state recovered across process restart
```
