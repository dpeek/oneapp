CREATE TABLE `mail_import_runs` (
	`mailbox_id` text NOT NULL,
	`id` text NOT NULL,
	`configuration` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	CONSTRAINT `mail_import_runs_pk` PRIMARY KEY(`mailbox_id`, `id`),
	CONSTRAINT `fk_mail_import_runs_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`)
);
