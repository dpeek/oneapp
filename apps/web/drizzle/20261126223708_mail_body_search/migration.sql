CREATE TABLE `mail_body_terms` (
	`mailbox_id` text NOT NULL,
	`term` text NOT NULL,
	`message_id` text NOT NULL,
	CONSTRAINT `mail_body_terms_pk` PRIMARY KEY(`mailbox_id`, `term`, `message_id`),
	CONSTRAINT `fk_mail_body_terms_mailbox_id_message_id_mail_body_text_mailbox_id_message_id_fk` FOREIGN KEY (`mailbox_id`,`message_id`) REFERENCES `mail_body_text`(`mailbox_id`,`message_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `mail_body_text` (
	`mailbox_id` text NOT NULL,
	`message_id` text NOT NULL,
	`body` text NOT NULL,
	`words` text NOT NULL,
	CONSTRAINT `mail_body_text_pk` PRIMARY KEY(`mailbox_id`, `message_id`),
	CONSTRAINT `fk_mail_body_text_mailbox_id_message_id_mail_index_messages_mailbox_id_id_fk` FOREIGN KEY (`mailbox_id`,`message_id`) REFERENCES `mail_index_messages`(`mailbox_id`,`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `mail_index_messages` ADD `body_indexed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `mail_body_terms_message` ON `mail_body_terms` (`mailbox_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `mail_index_body_pending` ON `mail_index_messages` (`mailbox_id`,`id`) WHERE deleted = 0 AND body_indexed = 0;