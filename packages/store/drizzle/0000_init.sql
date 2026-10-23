CREATE TABLE `events` (
	`session_id` text NOT NULL,
	`idx` integer NOT NULL,
	`kind` text NOT NULL,
	`event` text NOT NULL,
	PRIMARY KEY(`session_id`, `idx`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_kind` ON `events` (`session_id`,`kind`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`cwd` text NOT NULL,
	`harness` text DEFAULT 'claude-code' NOT NULL,
	`model` text,
	`harness_session_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
