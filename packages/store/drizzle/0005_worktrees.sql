CREATE TABLE `worktrees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`round_up_id` text NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`repo_root` text NOT NULL,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`parent_branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`base_commit` text NOT NULL,
	`deliver` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`round_up_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_session_id_unique` ON `worktrees` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_path_unique` ON `worktrees` (`path`);--> statement-breakpoint
CREATE INDEX `worktrees_round_up_idx` ON `worktrees` (`round_up_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `kind` text DEFAULT 'worker' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `base_branch` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `base_commit` text;