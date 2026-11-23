CREATE TABLE `mail_domain_routes` (
	`domain` text PRIMARY KEY,
	`mailbox_id` text NOT NULL,
	CONSTRAINT `fk_mail_domain_routes_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`)
);
--> statement-breakpoint
CREATE TABLE `mailbox_addresses` (
	`address` text PRIMARY KEY,
	`mailbox_id` text NOT NULL,
	`can_receive` integer DEFAULT 0 NOT NULL,
	`can_send` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_mailbox_addresses_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`)
);
--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` text PRIMARY KEY,
	`owner_account_id` text NOT NULL,
	`name` text NOT NULL,
	CONSTRAINT `fk_mailboxes_owner_account_id_accounts_id_fk` FOREIGN KEY (`owner_account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
-- Preserve the existing owner's mailbox without deriving identity from login email.
INSERT INTO mailboxes (id, owner_account_id, name) SELECT 'personal', id, 'Personal' FROM accounts WHERE id = 'owner';
--> statement-breakpoint
CREATE TABLE `__new_mail_import_completions` (
	`mailbox_id` text DEFAULT 'personal' NOT NULL,
	`id` text NOT NULL,
	`policy` text NOT NULL,
	`decisions` text NOT NULL,
	`completed_at` integer,
	CONSTRAINT `mail_import_completions_pk` PRIMARY KEY(`mailbox_id`, `id`),
	CONSTRAINT `fk_mail_import_completions_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_mail_import_completions`(`id`, `policy`, `decisions`, `completed_at`) SELECT `id`, `policy`, `decisions`, `completed_at` FROM `mail_import_completions`;--> statement-breakpoint
DROP TABLE `mail_import_completions`;--> statement-breakpoint
ALTER TABLE `__new_mail_import_completions` RENAME TO `mail_import_completions`;--> statement-breakpoint
CREATE TABLE `__new_mail_imports` (
	`mailbox_id` text DEFAULT 'personal' NOT NULL,
	`source_id` text NOT NULL,
	`message_id` text NOT NULL,
	`sha256` text NOT NULL,
	`metadata` text NOT NULL,
	`completed_at` integer,
	CONSTRAINT `mail_imports_pk` PRIMARY KEY(`mailbox_id`, `source_id`),
	CONSTRAINT `fk_mail_imports_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_mail_imports`(`source_id`, `message_id`, `sha256`, `metadata`, `completed_at`) SELECT `source_id`, `message_id`, `sha256`, `metadata`, `completed_at` FROM `mail_imports`;--> statement-breakpoint
DROP TABLE `mail_imports`;--> statement-breakpoint
ALTER TABLE `__new_mail_imports` RENAME TO `mail_imports`;--> statement-breakpoint
CREATE TABLE `__new_mail_index_keys` (
	`mailbox_id` text DEFAULT 'personal' NOT NULL,
	`identity` text NOT NULL,
	`thread_id` text NOT NULL,
	CONSTRAINT `mail_index_keys_pk` PRIMARY KEY(`mailbox_id`, `identity`),
	CONSTRAINT `fk_mail_index_keys_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_mail_index_keys`(`identity`, `thread_id`) SELECT `identity`, `thread_id` FROM `mail_index_keys`;--> statement-breakpoint
DROP TABLE `mail_index_keys`;--> statement-breakpoint
ALTER TABLE `__new_mail_index_keys` RENAME TO `mail_index_keys`;--> statement-breakpoint
CREATE TABLE `__new_mail_index_messages` (
	`mailbox_id` text DEFAULT 'personal' NOT NULL,
	`id` text NOT NULL,
	`envelope_recipient` text,
	`thread_id` text NOT NULL,
	`folder` text NOT NULL,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`subject` text NOT NULL,
	`timestamp` integer NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`deleted_at` integer,
	`unread` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`people` text,
	`list_mail` integer,
	`body_preview` text,
	CONSTRAINT `mail_index_messages_pk` PRIMARY KEY(`mailbox_id`, `id`),
	CONSTRAINT `fk_mail_index_messages_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_mail_index_messages`(`id`, `thread_id`, `folder`, `sender`, `recipient`, `subject`, `timestamp`, `deleted`, `deleted_at`, `unread`, `archived`, `people`, `list_mail`, `body_preview`) SELECT `id`, `thread_id`, `folder`, `sender`, `recipient`, `subject`, `timestamp`, `deleted`, `deleted_at`, `unread`, `archived`, `people`, `list_mail`, `body_preview` FROM `mail_index_messages`;--> statement-breakpoint
DROP TABLE `mail_index_messages`;--> statement-breakpoint
ALTER TABLE `__new_mail_index_messages` RENAME TO `mail_index_messages`;--> statement-breakpoint
CREATE TABLE `__new_mail_index_scans` (
	`mailbox_id` text DEFAULT 'personal' NOT NULL,
	`folder` text NOT NULL,
	`cursor` text,
	`scanned_at` integer NOT NULL,
	`ready` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `mail_index_scans_pk` PRIMARY KEY(`mailbox_id`, `folder`),
	CONSTRAINT `fk_mail_index_scans_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_mail_index_scans`(`folder`, `cursor`, `scanned_at`, `ready`) SELECT `folder`, `cursor`, `scanned_at`, `ready` FROM `mail_index_scans`;--> statement-breakpoint
DROP TABLE `mail_index_scans`;--> statement-breakpoint
ALTER TABLE `__new_mail_index_scans` RENAME TO `mail_index_scans`;--> statement-breakpoint
CREATE TABLE `__new_mail_sender_avatars` (
	`mailbox_id` text DEFAULT 'personal' NOT NULL,
	`address` text NOT NULL,
	`kind` text NOT NULL,
	CONSTRAINT `mail_sender_avatars_pk` PRIMARY KEY(`mailbox_id`, `address`),
	CONSTRAINT `fk_mail_sender_avatars_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_mail_sender_avatars`(`address`, `kind`) SELECT `address`, `kind` FROM `mail_sender_avatars`;--> statement-breakpoint
DROP TABLE `mail_sender_avatars`;--> statement-breakpoint
ALTER TABLE `__new_mail_sender_avatars` RENAME TO `mail_sender_avatars`;--> statement-breakpoint
CREATE TABLE `__new_mail_sender_rules` (
	`mailbox_id` text DEFAULT 'personal' NOT NULL,
	`address` text NOT NULL,
	`priority` text NOT NULL,
	CONSTRAINT `mail_sender_rules_pk` PRIMARY KEY(`mailbox_id`, `address`),
	CONSTRAINT `fk_mail_sender_rules_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_mail_sender_rules`(`address`, `priority`) SELECT `address`, `priority` FROM `mail_sender_rules`;--> statement-breakpoint
DROP TABLE `mail_sender_rules`;--> statement-breakpoint
ALTER TABLE `__new_mail_sender_rules` RENAME TO `mail_sender_rules`;--> statement-breakpoint
CREATE UNIQUE INDEX `mail_imports_message` ON `mail_imports` (`mailbox_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `mail_index_keys_thread` ON `mail_index_keys` (`mailbox_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `mail_index_deleted_date` ON `mail_index_messages` (`mailbox_id`,`deleted`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `mail_index_folder_date` ON `mail_index_messages` (`mailbox_id`,`folder`,`deleted`,`timestamp`,`id`);--> statement-breakpoint
CREATE INDEX `mail_index_thread_folder_date` ON `mail_index_messages` (`mailbox_id`,`thread_id`,`folder`,`deleted`,`timestamp`,`id`);--> statement-breakpoint
CREATE INDEX `mail_index_unread` ON `mail_index_messages` (`mailbox_id`,`thread_id`) WHERE folder = 'inbox' AND deleted = 0 AND unread = 1;--> statement-breakpoint
CREATE INDEX `mail_index_inbox_archive_date` ON `mail_index_messages` (`mailbox_id`,`archived`,`timestamp`,`id`) WHERE folder = 'inbox' AND deleted = 0;--> statement-breakpoint
CREATE INDEX `mail_index_all_date` ON `mail_index_messages` (`mailbox_id`,`timestamp`,`id`) WHERE deleted = 0;--> statement-breakpoint
CREATE INDEX `mail_index_all_thread_date` ON `mail_index_messages` (`mailbox_id`,`thread_id`,`timestamp`,`id`) WHERE deleted = 0;--> statement-breakpoint
CREATE INDEX `mailbox_addresses_mailbox` ON `mailbox_addresses` (`mailbox_id`);