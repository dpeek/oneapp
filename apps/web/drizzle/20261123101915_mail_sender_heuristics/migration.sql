-- Recompute derived sender appearances from original headers. User overrides,
-- contacts, unread/archive state, and import completion receipts are unchanged.
UPDATE `mail_index_messages` SET `people` = NULL WHERE `deleted` = 0;
--> statement-breakpoint
DELETE FROM `mail_index_scans` WHERE `folder` IN ('inbox:list-mail', 'sent:people');
