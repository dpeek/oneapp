CREATE TABLE `deleted_task_attachments` (
	`account_id` text NOT NULL,
	`task_id` text NOT NULL,
	`id` text NOT NULL,
	`delete_after` integer NOT NULL,
	CONSTRAINT `deleted_task_attachments_pk` PRIMARY KEY(`account_id`, `task_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `deleted_task_attachments_due` ON `deleted_task_attachments` (`delete_after`);
--> statement-breakpoint
CREATE TRIGGER `task_screenshot_cleanup`
BEFORE DELETE ON `tasks`
FOR EACH ROW BEGIN
  -- Pending uploads may still reach R2 after the task is deleted. Wait for
  -- the upload reservation to expire before collecting those objects.
  INSERT INTO `deleted_task_attachments` (`account_id`, `task_id`, `id`, `delete_after`)
  SELECT account_id, task_id, id,
    CASE WHEN state = 'pending' THEN created_at + 3600000 ELSE 0 END
  FROM task_attachments WHERE account_id = OLD.account_id AND task_id = OLD.item_id;
END;
