CREATE TABLE `personal_vault_logins_next` (
	`id` text PRIMARY KEY,
	`vault_id` text NOT NULL,
	`name` text NOT NULL,
	`wrapped_key` text NOT NULL,
	`details` text NOT NULL,
	`create_digest` text,
	`created_at` integer NOT NULL,
	`revision_at` integer NOT NULL,
	CONSTRAINT `fk_personal_vault_logins_vault_id_personal_vaults_id_fk` FOREIGN KEY (`vault_id`) REFERENCES `personal_vaults`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `personal_vault_logins_next` (`id`, `vault_id`, `name`, `wrapped_key`, `details`, `created_at`, `revision_at`)
SELECT `id`, `vault_id`, `name`, `wrapped_key`, json_object('credentials', json_object(
	'username', `username`, 'password', `password`, 'uris', json_array(json_object('uri', `uri`, 'match', NULL))
)), `created_at`, `revision_at`
FROM `personal_vault_logins`;
--> statement-breakpoint
DROP TABLE `personal_vault_logins`;
--> statement-breakpoint
ALTER TABLE `personal_vault_logins_next` RENAME TO `personal_vault_logins`;
--> statement-breakpoint
CREATE INDEX `personal_vault_logins_vault` ON `personal_vault_logins` (`vault_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `personal_vault_logins_create` ON `personal_vault_logins` (`vault_id`, `create_digest`);
