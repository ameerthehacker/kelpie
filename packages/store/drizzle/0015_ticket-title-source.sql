ALTER TABLE `tickets` ADD `title_source` text;--> statement-breakpoint
UPDATE `tickets` SET `title_source` = 'orchestrator' WHERE `title` IS NOT NULL;