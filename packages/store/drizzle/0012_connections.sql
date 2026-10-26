CREATE TABLE `connections` (
	`provider` text PRIMARY KEY NOT NULL,
	`method` text NOT NULL,
	`secret` text NOT NULL,
	`account` text,
	`scopes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
