CREATE TABLE `bitwarden_authorizations` (
	`id` text PRIMARY KEY,
	`vault_id` text NOT NULL,
	`browser_session_id` text NOT NULL,
	`security_revision` text NOT NULL,
	`consent_digest` text UNIQUE,
	`code_digest` text UNIQUE,
	`state` text NOT NULL,
	`challenge` text NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_bitwarden_authorizations_vault_id_personal_vaults_id_fk` FOREIGN KEY (`vault_id`) REFERENCES `personal_vaults`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `bitwarden_device_sessions` (
	`id` text PRIMARY KEY,
	`vault_id` text NOT NULL,
	`device_id` text NOT NULL,
	`security_revision` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`generation` integer NOT NULL,
	`issued_at` integer NOT NULL,
	`access_digest` text NOT NULL UNIQUE,
	`refresh_digest` text NOT NULL UNIQUE,
	`previous_access_digest` text UNIQUE,
	`previous_refresh_digest` text UNIQUE,
	`retry_until` integer,
	CONSTRAINT `fk_bitwarden_device_sessions_vault_id_personal_vaults_id_fk` FOREIGN KEY (`vault_id`) REFERENCES `personal_vaults`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `personal_vault_logins` (
	`id` text PRIMARY KEY,
	`vault_id` text NOT NULL,
	`name` text NOT NULL,
	`wrapped_key` text NOT NULL,
	`username` text NOT NULL,
	`password` text NOT NULL,
	`uri` text NOT NULL,
	`created_at` integer NOT NULL,
	`revision_at` integer NOT NULL,
	CONSTRAINT `fk_personal_vault_logins_vault_id_personal_vaults_id_fk` FOREIGN KEY (`vault_id`) REFERENCES `personal_vaults`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `personal_vaults` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL UNIQUE,
	`kdf_salt` text NOT NULL,
	`kdf_iterations` integer NOT NULL,
	`wrapped_key` text NOT NULL,
	`key_id` text NOT NULL,
	`wrapped_private_key` text NOT NULL,
	`public_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`revision_at` integer NOT NULL,
	CONSTRAINT `fk_personal_vaults_owner_id_accounts_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `bitwarden_authorizations_expiry` ON `bitwarden_authorizations` (`expires_at`);--> statement-breakpoint
CREATE INDEX `bitwarden_device_sessions_expiry` ON `bitwarden_device_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `personal_vault_logins_vault` ON `personal_vault_logins` (`vault_id`);