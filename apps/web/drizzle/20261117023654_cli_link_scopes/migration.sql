ALTER TABLE `cli_logins` ADD `scopes` text;--> statement-breakpoint
ALTER TABLE `cli_tokens` ADD `scopes` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
UPDATE `cli_logins` SET `scopes` = '["links:read","links:write"]' WHERE `can_delete` = 1;--> statement-breakpoint
UPDATE `cli_tokens` SET `scopes` = '["links:read","links:write"]' WHERE `can_delete` = 1;--> statement-breakpoint
DELETE FROM `cli_logins` WHERE `owner_id` IS NOT NULL AND `can_delete` != 1;--> statement-breakpoint
DELETE FROM `cli_tokens` WHERE `can_delete` != 1;--> statement-breakpoint
ALTER TABLE `cli_logins` DROP COLUMN `can_delete`;--> statement-breakpoint
ALTER TABLE `cli_tokens` DROP COLUMN `can_delete`;
