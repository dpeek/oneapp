CREATE TABLE `oneapp_auth_emailCredentials` (
	`module_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`identifier_namespace` text NOT NULL,
	`identifier_value` text NOT NULL,
	`credential_revision` text NOT NULL,
	`active` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oneapp_auth_emailCredentials_key_0` ON `oneapp_auth_emailCredentials` (`module_id`,`credential_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `oneapp_auth_emailCredentials_key_1` ON `oneapp_auth_emailCredentials` (`module_id`,`identifier_namespace`,`identifier_value`);