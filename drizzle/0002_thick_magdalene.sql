ALTER TABLE `attempts` ADD `outcome_reason` text;--> statement-breakpoint
UPDATE `attempts`
SET `state` = 'completed',
    `outcome` = 'cancelled',
    `outcome_reason` = 'migration_0002_duplicate_active_attempt',
    `completed_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `state` IN ('pending', 'dispatching', 'session_created', 'running')
  AND `id` <> (
    SELECT `b`.`id` FROM `attempts` AS `b`
    WHERE `b`.`task_id` = `attempts`.`task_id`
      AND `b`.`state` IN ('pending', 'dispatching', 'session_created', 'running')
    ORDER BY (`b`.`devin_session_id` IS NOT NULL) DESC, `b`.`id` DESC
    LIMIT 1
  );--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_task_active_unique` ON `attempts` (`task_id`) WHERE "attempts"."state" IN ('pending', 'dispatching', 'session_created', 'running');