CREATE TABLE `mail_send_requests` (
	`mailbox_id` text NOT NULL,
	`request_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`outcome` text,
	CONSTRAINT `mail_send_requests_pk` PRIMARY KEY(`mailbox_id`, `request_id`),
	CONSTRAINT `fk_mail_send_requests_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`)
);
