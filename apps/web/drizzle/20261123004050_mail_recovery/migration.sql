ALTER TABLE `mail_index_messages` ADD `deleted_at` integer;--> statement-breakpoint
CREATE INDEX `mail_index_deleted_date` ON `mail_index_messages` (`deleted`,`deleted_at`);