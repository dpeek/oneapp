CREATE TABLE `personal_vault_imports` (
	`id` text PRIMARY KEY,
	`vault_id` text NOT NULL,
	`digest` text NOT NULL,
	CONSTRAINT `fk_personal_vault_imports_vault_id_personal_vaults_id_fk` FOREIGN KEY (`vault_id`) REFERENCES `personal_vaults`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `personal_vault_import_digest` ON `personal_vault_imports` (`vault_id`,`digest`);