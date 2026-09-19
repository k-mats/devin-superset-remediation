CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL
);
