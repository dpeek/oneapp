CREATE TABLE `personal_vault_attachment_cleanup` (
	`id` text PRIMARY KEY,
	`delete_after` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `personal_vault_attachments` (
	`id` text PRIMARY KEY,
	`item_id` text NOT NULL,
	`name` text NOT NULL,
	`wrapped_key` text NOT NULL,
	`size` integer NOT NULL,
	`item_key` text NOT NULL,
	`revision_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ready_at` integer,
	`create_digest` text NOT NULL,
	CONSTRAINT `fk_personal_vault_attachments_item_id_personal_vault_logins_id_fk` FOREIGN KEY (`item_id`) REFERENCES `personal_vault_logins`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `personal_vault_attachment_create` ON `personal_vault_attachments` (`item_id`,`create_digest`);
--> statement-breakpoint
CREATE TRIGGER `personal_vault_attachment_delete`
AFTER DELETE ON `personal_vault_attachments`
FOR EACH ROW BEGIN
  INSERT INTO `personal_vault_attachment_cleanup` (`id`, `delete_after`)
  VALUES (
    OLD.id,
    CAST(unixepoch('subsec') * 1000 AS INTEGER) + CASE WHEN OLD.ready_at IS NULL THEN 300000 ELSE 0 END
  );
END;
