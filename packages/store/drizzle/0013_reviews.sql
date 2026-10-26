CREATE TABLE `deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`round_up_id` text NOT NULL,
	`session_id` text,
	`title` text NOT NULL,
	`harness` text NOT NULL,
	`branch` text NOT NULL,
	`fork_commit` text NOT NULL,
	`tip_commit` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`round_up_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `deliveries_round_up_idx` ON `deliveries` (`round_up_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `deliveries_tip` ON `deliveries` (`round_up_id`,`tip_commit`);--> statement-breakpoint
CREATE TABLE `review_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`round_up_id` text NOT NULL,
	`review_id` text,
	`author` text NOT NULL,
	`author_session_id` text,
	`author_title` text,
	`body` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `review_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`round_up_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `review_comments_thread_idx` ON `review_comments` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `review_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`round_up_id` text NOT NULL,
	`view` text NOT NULL,
	`view_session_id` text,
	`agent_id` text,
	`agent_title` text,
	`path` text NOT NULL,
	`side` text NOT NULL,
	`line` integer NOT NULL,
	`commit_sha` text NOT NULL,
	`base_sha` text NOT NULL,
	`line_text` text NOT NULL,
	`diff_hunk` text NOT NULL,
	`status` text NOT NULL,
	`assigned_to` text,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`round_up_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`view_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`agent_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assigned_to`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `review_threads_round_up_idx` ON `review_threads` (`round_up_id`,`status`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`round_up_id` text NOT NULL,
	`state` text NOT NULL,
	`verdict` text,
	`body` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`submitted_at` integer,
	FOREIGN KEY (`round_up_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_one_pending` ON `reviews` (`round_up_id`) WHERE state = 'pending';