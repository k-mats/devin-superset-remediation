# Issue #6 — Persistent task state evidence

## Schema

`pnpm db:generate` emitted `drizzle/0001_brave_red_hulk.sql` and the matching
`drizzle/meta/0001_snapshot.json`. The migration contains the replacement
schema, foreign key, unique indexes, all five CHECK constraints, and drops the
placeholder `sessions` table:

````sql
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
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_identity_unique` ON `tasks` (`repo_owner`,`repo_name`,`issue_number`);--> statement-breakpoint
DROP TABLE `sessions`;
```

## Persistence test

`pnpm exec vitest run tests/task-state.test.ts`:

````

RUN v5.0.1 /home/ubuntu/repos/devin-superset-remediation

Test Files 1 passed (1)
Tests 7 passed (7)
Start at 12:10:39
Duration 558ms (import 69%, tests 16%, transform 13%, setup 1%, worker 1%)

```

## Restart demo

`DATABASE_PATH=./data/demo-issue-6.db pnpm demo:restart` ran the write and read
subcommands in separate processes. The recovered state includes a completed
first attempt and a stale dispatching second attempt:

```

$ tsx scripts/state-restart-demo.ts
{
"pid": 9817,
"task": {
"id": 1,
"repoOwner": "k-mats",
"repoName": "superset-fork",
"issueNumber": 101,
"title": "Persistent task state demo",
"createdAt": 1789906238477,
"updatedAt": 1789906238477
},
"attempts": [
{
"id": 1,
"taskId": 1,
"attemptNumber": 1,
"correlationId": "140d7cb9-515d-4005-9577-fcf927f6cbc5",
"state": "completed",
"outcome": "succeeded",
"devinSessionId": "demo-session-140d7cb9-515d-4005-9577-fcf927f6cbc5",
"devinSessionUrl": "https://app.devin.ai/sessions/demo-session-140d7cb9-515d-4005-9577-fcf927f6cbc5?correlation_id=140d7cb9-515d-4005-9577-fcf927f6cbc5",
"prUrl": "https://github.com/k-mats/superset-fork/pull/101",
"createdAt": 1789906238480,
"updatedAt": 1789906238486,
"dispatchedAt": 1789906238482,
"sessionCreatedAt": 1789906238483,
"completedAt": 1789906238486
},
{
"id": 2,
"taskId": 1,
"attemptNumber": 2,
"correlationId": "d4af002e-c839-4a4c-b38c-6948374d07fc",
"state": "dispatching",
"outcome": null,
"devinSessionId": null,
"devinSessionUrl": null,
"prUrl": null,
"createdAt": 1789906238488,
"updatedAt": 1789906238489,
"dispatchedAt": 1789906238489,
"sessionCreatedAt": null,
"completedAt": null
}
]
}
{
"pid": 9871,
"task": {
"id": 1,
"repoOwner": "k-mats",
"repoName": "superset-fork",
"issueNumber": 101,
"title": "Persistent task state demo",
"createdAt": 1789906238477,
"updatedAt": 1789906238477
},
"attempts": [
{
"id": 1,
"taskId": 1,
"attemptNumber": 1,
"correlationId": "140d7cb9-515d-4005-9577-fcf927f6cbc5",
"state": "completed",
"outcome": "succeeded",
"devinSessionId": "demo-session-140d7cb9-515d-4005-9577-fcf927f6cbc5",
"devinSessionUrl": "https://app.devin.ai/sessions/demo-session-140d7cb9-515d-4005-9577-fcf927f6cbc5?correlation_id=140d7cb9-515d-4005-9577-fcf927f6cbc5",
"prUrl": "https://github.com/k-mats/superset-fork/pull/101",
"createdAt": 1789906238480,
"updatedAt": 1789906238486,
"dispatchedAt": 1789906238482,
"sessionCreatedAt": 1789906238483,
"completedAt": 1789906238486
},
{
"id": 2,
"taskId": 1,
"attemptNumber": 2,
"correlationId": "d4af002e-c839-4a4c-b38c-6948374d07fc",
"state": "dispatching",
"outcome": null,
"devinSessionId": null,
"devinSessionUrl": null,
"prUrl": null,
"createdAt": 1789906238488,
"updatedAt": 1789906238489,
"dispatchedAt": 1789906238489,
"sessionCreatedAt": null,
"completedAt": null
}
],
"stale": [
{
"id": 2,
"taskId": 1,
"attemptNumber": 2,
"correlationId": "d4af002e-c839-4a4c-b38c-6948374d07fc",
"state": "dispatching",
"outcome": null,
"devinSessionId": null,
"devinSessionUrl": null,
"prUrl": null,
"createdAt": 1789906238488,
"updatedAt": 1789906238489,
"dispatchedAt": 1789906238489,
"sessionCreatedAt": null,
"completedAt": null
}
]
}
OK: state recovered across process restart

```

```
