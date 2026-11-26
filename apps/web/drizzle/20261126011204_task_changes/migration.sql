CREATE TABLE `task_changes` (
	`account_id` text PRIMARY KEY,
	`version` integer NOT NULL,
	CONSTRAINT `fk_task_changes_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE
);
