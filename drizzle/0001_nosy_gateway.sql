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