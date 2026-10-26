ALTER TABLE `review_comments` ADD `author_harness` text;--> statement-breakpoint
-- Agents still here: their harness, for replies written before it was kept.
UPDATE `review_comments` SET `author_harness` = (SELECT `harness` FROM `sessions` WHERE `sessions`.`id` = `review_comments`.`author_session_id`) WHERE `author` = 'agent';
