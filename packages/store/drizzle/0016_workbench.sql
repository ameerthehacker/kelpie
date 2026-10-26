CREATE TABLE `workbench_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`round_up_id` text NOT NULL,
	`title` text NOT NULL,
	`stage` text NOT NULL,
	`callout` text,
	`tickets` text DEFAULT '[]' NOT NULL,
	`archived_at` integer,
	`done_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`round_up_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workbench_cards_round_up_idx` ON `workbench_cards` (`round_up_id`);--> statement-breakpoint
CREATE TABLE `workbench_entries` (
	`session_id` text PRIMARY KEY NOT NULL,
	`round_up_id` text NOT NULL,
	`focus` text,
	`claims` text DEFAULT '[]' NOT NULL,
	`blocker` text,
	`progress` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`round_up_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workbench_entries_round_up_idx` ON `workbench_entries` (`round_up_id`);--> statement-breakpoint
CREATE TABLE `workbench_items` (
	`card_id` text NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`ref` text,
	`url` text,
	`status` text NOT NULL,
	`agent_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`card_id`, `key`),
	FOREIGN KEY (`card_id`) REFERENCES `workbench_cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workbench_items_agent_idx` ON `workbench_items` (`agent_id`);--> statement-breakpoint
CREATE TABLE `workbench_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`round_up_id` text NOT NULL,
	`card_id` text,
	`from_id` text,
	`from_title` text NOT NULL,
	`to_id` text,
	`to_title` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`round_up_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `workbench_cards`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`from_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`to_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workbench_notes_round_up_idx` ON `workbench_notes` (`round_up_id`,`id`);--> statement-breakpoint
CREATE INDEX `workbench_notes_to_idx` ON `workbench_notes` (`to_id`,`delivered_at`);