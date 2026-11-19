CREATE TABLE `mail_sender_rules` (
	`address` text PRIMARY KEY,
	`priority` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `mail_index_messages` ADD `list_mail` integer;