ALTER TABLE `attempts` ADD `structured_output_raw` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `agent_outcome` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `agent_pr_url` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `agent_diagnosis` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `agent_tests_run` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `agent_risks` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `needs_human_reason` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `structured_output_accepted_at` integer;