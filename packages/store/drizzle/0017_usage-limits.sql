CREATE TABLE `usage_limits` (
	`session_id` text PRIMARY KEY NOT NULL,
	`harness` text NOT NULL,
	`message` text NOT NULL,
	`resets_at` integer,
	`retry_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`auto` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
