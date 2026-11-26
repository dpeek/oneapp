CREATE TABLE `task_runs` (
	`account_id` text NOT NULL,
	`task_id` text NOT NULL,
	`id` text NOT NULL,
	`claim_revision` text NOT NULL,
	`phase` text NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer,
	`finished_at` integer,
	`outcome` text,
	`summary` text,
	`reason` text,
	`deployment_url` text,
	CONSTRAINT `task_runs_pk` PRIMARY KEY(`account_id`, `task_id`),
	CONSTRAINT `fk_task_runs_account_id_task_id_tasks_account_id_item_id_fk` FOREIGN KEY (`account_id`,`task_id`) REFERENCES `tasks`(`account_id`,`item_id`) ON DELETE CASCADE
);
