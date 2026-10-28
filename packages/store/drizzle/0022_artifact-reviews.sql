CREATE TABLE `artifact_reviews` (
	`round_up_id` text NOT NULL,
	`key` text NOT NULL,
	`accepted_at` integer NOT NULL,
	PRIMARY KEY(`round_up_id`, `key`),
	FOREIGN KEY (`round_up_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
