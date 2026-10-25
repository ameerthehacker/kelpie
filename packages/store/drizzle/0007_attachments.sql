CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`round_up_id` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`round_up_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_round_up_idx` ON `attachments` (`round_up_id`);