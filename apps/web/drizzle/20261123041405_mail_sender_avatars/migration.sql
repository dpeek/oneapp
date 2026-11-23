CREATE TABLE `mail_sender_avatars` (
	`address` text PRIMARY KEY,
	`kind` text NOT NULL
);

--> statement-breakpoint
-- Rebuild derived sender metadata so existing mail gains header-based detection.
UPDATE `mail_index_messages` SET `people` = NULL WHERE `people` IS NOT NULL;
--> statement-breakpoint
DELETE FROM `mail_index_scans` WHERE `folder` IN ('inbox:list-mail', 'sent:people');
