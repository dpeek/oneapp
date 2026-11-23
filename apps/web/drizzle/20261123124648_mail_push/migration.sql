CREATE TABLE `mail_push_outbox` (
	`mailbox_id` text NOT NULL,
	`message_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease` text,
	`completed_at` integer,
	CONSTRAINT `mail_push_outbox_pk` PRIMARY KEY(`mailbox_id`, `message_id`, `subscription_id`),
	CONSTRAINT `fk_mail_push_outbox_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`),
	CONSTRAINT `fk_mail_push_outbox_subscription_id_push_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `push_subscriptions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`session_id` text NOT NULL,
	`security_revision` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_push_subscriptions_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_push_subscriptions_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`)
);
--> statement-breakpoint
CREATE INDEX `mail_push_pending` ON `mail_push_outbox` (`completed_at`,`next_attempt_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscription_endpoint` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscription_session` ON `push_subscriptions` (`session_id`);