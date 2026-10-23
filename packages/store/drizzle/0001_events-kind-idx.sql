DROP INDEX `events_kind`;--> statement-breakpoint
CREATE INDEX `events_kind_idx` ON `events` (`session_id`,`kind`,`idx`);