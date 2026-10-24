CREATE TABLE `outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`text` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`session_id`,`delivered_at`,`id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `parent_id` text REFERENCES sessions(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `sessions` ADD `role` text DEFAULT 'orchestrator' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `writes` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `resume_pending` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `notified_idx` integer DEFAULT -1 NOT NULL;