CREATE TABLE `__new_tasks` (
	`account_id` text NOT NULL,
	`item_id` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'not-started' NOT NULL,
	`priority` text,
	`due_on` text,
	CONSTRAINT `tasks_pk` PRIMARY KEY(`account_id`, `item_id`),
	CONSTRAINT `fk_tasks_account_id_item_id_items_account_id_id_fk` FOREIGN KEY (`account_id`,`item_id`) REFERENCES `items`(`account_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT "tasks_status" CHECK("status" in ('not-started', 'in-progress', 'in-review', 'completed', 'canceled'))
);
--> statement-breakpoint
INSERT INTO `__new_tasks` (`account_id`, `item_id`, `description`, `status`, `priority`, `due_on`)
SELECT `account_id`, `item_id`, `description`, coalesce(`status`, 'not-started'), `priority`, `due_on`
FROM `tasks`;
--> statement-breakpoint
-- Copy attachments before replacing their parent table to preserve them
-- with foreign keys enabled.
CREATE TABLE `__task_attachment_backup` AS
SELECT `account_id`, `task_id`, `id`, `name`, `media_type`, `size`, `created_at`, `state`
FROM `task_attachments`;
--> statement-breakpoint
DROP TABLE `task_attachments`;
--> statement-breakpoint
DROP TABLE `tasks`;
--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;
--> statement-breakpoint
CREATE TABLE `task_attachments` (
	`account_id` text NOT NULL,
	`task_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`state` text NOT NULL,
	CONSTRAINT `task_attachments_pk` PRIMARY KEY(`account_id`, `task_id`, `id`),
	CONSTRAINT `fk_task_attachments_account_id_task_id_tasks_account_id_item_id_fk` FOREIGN KEY (`account_id`, `task_id`) REFERENCES `tasks`(`account_id`, `item_id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `task_attachments` (`account_id`, `task_id`, `id`, `name`, `media_type`, `size`, `created_at`, `state`)
SELECT `account_id`, `task_id`, `id`, `name`, `media_type`, `size`, `created_at`, `state`
FROM `__task_attachment_backup`;
--> statement-breakpoint
DROP TABLE `__task_attachment_backup`;
--> statement-breakpoint
CREATE INDEX `task_attachments_cleanup` ON `task_attachments` (`state`, `created_at`);
