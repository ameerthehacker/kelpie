ALTER TABLE `sessions` ADD `title_source` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `title_turn` integer;--> statement-breakpoint
UPDATE `sessions` SET `title_source` = 'message' WHERE `title` != '' AND `parent_id` IS NULL;