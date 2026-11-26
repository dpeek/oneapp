CREATE TABLE `mail_conversations` (
	`mailbox_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`account_id` text NOT NULL,
	`item_id` text NOT NULL,
	CONSTRAINT `mail_conversations_pk` PRIMARY KEY(`mailbox_id`, `thread_id`),
	CONSTRAINT `fk_mail_conversations_account_id_item_id_items_account_id_id_fk` FOREIGN KEY (`account_id`,`item_id`) REFERENCES `items`(`account_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_mail_conversations_mailbox_id_account_id_mailboxes_id_owner_account_id_fk` FOREIGN KEY (`mailbox_id`,`account_id`) REFERENCES `mailboxes`(`id`,`owner_account_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_conversations_item` ON `mail_conversations` (`account_id`,`item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_id_owner` ON `mailboxes` (`id`,`owner_account_id`);--> statement-breakpoint
CREATE TABLE `mail_conversation_backfill` (
	`mailbox_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`account_id` text NOT NULL,
	`item_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
-- Group mail by its existing, mailbox-scoped thread identity. Keep recoverable
-- trash, but skip the empty tombstones left by permanent deletion.
INSERT INTO `mail_conversation_backfill`
WITH conversations AS (
	SELECT mailbox_id, thread_id, min(timestamp) AS created_at, max(timestamp) AS updated_at
	FROM mail_index_messages
	WHERE deleted = 0 OR deleted_at IS NOT NULL
	GROUP BY mailbox_id, thread_id
)
SELECT c.mailbox_id, c.thread_id, b.owner_account_id,
	lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) ||
		'-' || substr('89ab', (random() & 3) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
	coalesce((
		SELECT trim(m.subject) FROM mail_index_messages m
		WHERE m.mailbox_id = c.mailbox_id AND m.thread_id = c.thread_id
			AND (m.deleted = 0 OR m.deleted_at IS NOT NULL) AND trim(m.subject) <> ''
		ORDER BY m.timestamp, m.id LIMIT 1
	), '(No subject)'), c.created_at, c.updated_at
FROM conversations c JOIN mailboxes b ON b.id = c.mailbox_id;--> statement-breakpoint
INSERT INTO `items` (account_id, id, kind, title, revision, created_at, updated_at)
SELECT account_id, item_id, 'mail-conversation', title, item_id, created_at, updated_at
FROM `mail_conversation_backfill`;--> statement-breakpoint
INSERT INTO `mail_conversations` (mailbox_id, thread_id, account_id, item_id)
SELECT mailbox_id, thread_id, account_id, item_id FROM `mail_conversation_backfill`;--> statement-breakpoint
DROP TABLE `mail_conversation_backfill`;
