ALTER TABLE `bitwarden_authorizations` ADD `client_id` text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
ALTER TABLE `bitwarden_device_sessions` ADD `client_id` text DEFAULT 'browser' NOT NULL;