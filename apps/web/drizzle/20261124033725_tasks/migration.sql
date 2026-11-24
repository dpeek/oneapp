CREATE TABLE `item_tags` (
	`account_id` text NOT NULL,
	`item_id` text NOT NULL,
	`tag_id` text NOT NULL,
	CONSTRAINT `item_tags_pk` PRIMARY KEY(`account_id`, `item_id`, `tag_id`),
	CONSTRAINT `fk_item_tags_account_id_item_id_items_account_id_id_fk` FOREIGN KEY (`account_id`,`item_id`) REFERENCES `items`(`account_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_item_tags_account_id_tag_id_tags_account_id_id_fk` FOREIGN KEY (`account_id`,`tag_id`) REFERENCES `tags`(`account_id`,`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `items` (
	`account_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`revision` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `items_pk` PRIMARY KEY(`account_id`, `id`),
	CONSTRAINT `fk_items_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`account_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	CONSTRAINT `tags_pk` PRIMARY KEY(`account_id`, `id`),
	CONSTRAINT `fk_tags_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`account_id` text NOT NULL,
	`item_id` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'not-started',
	`priority` text,
	`due_on` text,
	CONSTRAINT `tasks_pk` PRIMARY KEY(`account_id`, `item_id`),
	CONSTRAINT `fk_tasks_account_id_item_id_items_account_id_id_fk` FOREIGN KEY (`account_id`,`item_id`) REFERENCES `items`(`account_id`,`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `item_tags_by_tag` ON `item_tags` (`account_id`,`tag_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `items_kind_updated` ON `items` (`account_id`,`kind`,`updated_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name` ON `tags` (`account_id`,`name_key`);