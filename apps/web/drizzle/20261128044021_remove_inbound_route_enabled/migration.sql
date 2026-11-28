DELETE FROM `mail_inbound_routes` WHERE `enabled` <> 1;
--> statement-breakpoint
ALTER TABLE `mail_inbound_routes` DROP COLUMN `enabled`;
