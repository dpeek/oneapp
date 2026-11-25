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
	CONSTRAINT `fk_task_attachments_account_id_task_id_tasks_account_id_item_id_fk` FOREIGN KEY (`account_id`,`task_id`) REFERENCES `tasks`(`account_id`,`item_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `task_attachments_cleanup` ON `task_attachments` (`state`,`created_at`);