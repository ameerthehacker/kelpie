CREATE TABLE `permission_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`round_up_id` text NOT NULL,
	`rule` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`round_up_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `permission_rules_round_up_rule` ON `permission_rules` (`round_up_id`,`rule`);