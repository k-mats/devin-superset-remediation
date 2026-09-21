PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`attempt_number` integer NOT NULL,
	`correlation_id` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`outcome` text,
	`outcome_reason` text,
	`devin_session_id` text,
	`devin_session_url` text,
	`devin_session_status` text,
	`devin_session_status_detail` text,
	`acus_consumed` real,
	`session_updated_at` integer,
	`session_last_polled_at` integer,
	`pr_url` text,
	`pr_number` integer,
	`pr_state` text,
	`pr_head_sha` text,
	`pr_last_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`dispatched_at` integer,
	`session_created_at` integer,
	`completed_at` integer,
	`structured_output_raw` text,
	`agent_outcome` text,
	`agent_pr_url` text,
	`agent_diagnosis` text,
	`agent_tests_run` text,
	`agent_risks` text,
	`needs_human_reason` text,
	`structured_output_accepted_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "attempts_attempt_number_check" CHECK("__new_attempts"."attempt_number" > 0),
	CONSTRAINT "attempts_state_check" CHECK("__new_attempts"."state" IN ('pending', 'dispatching', 'session_created', 'running', 'verifying', 'completed')),
	CONSTRAINT "attempts_outcome_check" CHECK("__new_attempts"."outcome" IS NULL OR "__new_attempts"."outcome" IN ('succeeded', 'failed', 'cancelled', 'escalated', 'no_action')),
	CONSTRAINT "attempts_completed_outcome_check" CHECK(("__new_attempts"."state" = 'completed') = ("__new_attempts"."outcome" IS NOT NULL)),
	CONSTRAINT "attempts_session_id_check" CHECK("__new_attempts"."state" NOT IN ('session_created', 'running', 'verifying') OR "__new_attempts"."devin_session_id" IS NOT NULL),
	CONSTRAINT "attempts_agent_outcome_check" CHECK("__new_attempts"."agent_outcome" IS NULL OR "__new_attempts"."agent_outcome" IN ('remediated', 'needs_human', 'no_action')),
	CONSTRAINT "attempts_succeeded_session_check" CHECK("__new_attempts"."outcome" IS NULL OR "__new_attempts"."outcome" <> 'succeeded' OR "__new_attempts"."devin_session_id" IS NOT NULL),
	CONSTRAINT "attempts_pr_fields_check" CHECK("__new_attempts"."pr_number" IS NULL OR "__new_attempts"."pr_url" IS NOT NULL),
	CONSTRAINT "attempts_pr_state_check" CHECK("__new_attempts"."pr_state" IS NULL OR "__new_attempts"."pr_state" IN ('open', 'closed', 'merged'))
);
--> statement-breakpoint
INSERT INTO `__new_attempts`("id", "task_id", "attempt_number", "correlation_id", "state", "outcome", "outcome_reason", "devin_session_id", "devin_session_url", "pr_url", "pr_number", "created_at", "updated_at", "dispatched_at", "session_created_at", "completed_at", "structured_output_raw", "agent_outcome", "agent_pr_url", "agent_diagnosis", "agent_tests_run", "agent_risks", "needs_human_reason", "structured_output_accepted_at") SELECT "id", "task_id", "attempt_number", "correlation_id", "state", "outcome", "outcome_reason", "devin_session_id", "devin_session_url", "pr_url", CASE WHEN rtrim(pr_url, '/') GLOB 'https://github.com/*/*/pull/[0-9]*' AND (pr_url = rtrim(pr_url, '/') OR length(pr_url) = length(rtrim(pr_url, '/')) + 1) AND length(substr(rtrim(pr_url, '/'), instr(rtrim(pr_url, '/'), '/pull/') + 6)) > 0 AND substr(rtrim(pr_url, '/'), instr(rtrim(pr_url, '/'), '/pull/') + 6) NOT GLOB '*[^0-9]*' AND rtrim(pr_url, '/') NOT LIKE 'https://github.com//%' AND rtrim(pr_url, '/') NOT LIKE 'https://github.com/%//pull/%' AND rtrim(pr_url, '/') NOT LIKE 'https://github.com/%/%/%/pull/%' THEN CAST(substr(rtrim(pr_url, '/'), instr(rtrim(pr_url, '/'), '/pull/') + 6) AS INTEGER) ELSE NULL END, "created_at", "updated_at", "dispatched_at", "session_created_at", "completed_at", "structured_output_raw", "agent_outcome", "agent_pr_url", "agent_diagnosis", "agent_tests_run", "agent_risks", "needs_human_reason", "structured_output_accepted_at" FROM `attempts`;--> statement-breakpoint
DROP TABLE `attempts`;--> statement-breakpoint
ALTER TABLE `__new_attempts` RENAME TO `attempts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_correlation_id_unique` ON `attempts` (`correlation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_devin_session_id_unique` ON `attempts` (`devin_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_task_attempt_unique` ON `attempts` (`task_id`,`attempt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_task_active_unique` ON `attempts` (`task_id`) WHERE "attempts"."state" IN ('pending', 'dispatching', 'session_created', 'running', 'verifying');