CREATE TABLE `personal_vault_deleted_items` (
	`id` text PRIMARY KEY,
	`vault_id` text NOT NULL,
	CONSTRAINT `fk_personal_vault_deleted_items_vault_id_personal_vaults_id_fk` FOREIGN KEY (`vault_id`) REFERENCES `personal_vaults`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `personal_vault_folders` (
	`id` text PRIMARY KEY,
	`vault_id` text NOT NULL,
	`name` text NOT NULL,
	`revision_at` integer NOT NULL,
	`create_digest` text,
	CONSTRAINT `fk_personal_vault_folders_vault_id_personal_vaults_id_fk` FOREIGN KEY (`vault_id`) REFERENCES `personal_vaults`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `personal_vault_logins` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `personal_vault_logins` ADD `folder_id` text REFERENCES personal_vault_folders(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `personal_vault_folder_create` ON `personal_vault_folders` (`vault_id`,`create_digest`);