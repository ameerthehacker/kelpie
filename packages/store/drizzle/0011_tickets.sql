CREATE TABLE `tickets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`round_up_id` text NOT NULL,
	`ref` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`key` text,
	`title` text,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`round_up_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_round_up_ref` ON `tickets` (`round_up_id`,`ref`);