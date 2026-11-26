CREATE TABLE `mail_changes` (
	`mailbox_id` text PRIMARY KEY,
	`version` integer NOT NULL,
	CONSTRAINT `fk_mail_changes_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE CASCADE
);

--> statement-breakpoint
-- Keep mail versions in the same transaction as the indexed changes.
CREATE TRIGGER `mail_index_messages_version_insert`
AFTER INSERT ON `mail_index_messages`
BEGIN
  INSERT INTO mail_changes (mailbox_id, version) VALUES (NEW.mailbox_id, 1)
  ON CONFLICT(mailbox_id) DO UPDATE SET version = version + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `mail_index_messages_version_update`
AFTER UPDATE OF thread_id, folder, sender, recipient, subject, timestamp, envelope_recipient, deleted, deleted_at, trash_batch, unread, archived, people, list_mail ON `mail_index_messages`
BEGIN
  INSERT INTO mail_changes (mailbox_id, version) VALUES (NEW.mailbox_id, 1)
  ON CONFLICT(mailbox_id) DO UPDATE SET version = version + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `mail_index_messages_version_delete`
AFTER DELETE ON `mail_index_messages`
BEGIN
  INSERT INTO mail_changes (mailbox_id, version) VALUES (OLD.mailbox_id, 1)
  ON CONFLICT(mailbox_id) DO UPDATE SET version = version + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `mail_sender_rules_version_insert`
AFTER INSERT ON `mail_sender_rules`
BEGIN
  INSERT INTO mail_changes (mailbox_id, version) VALUES (NEW.mailbox_id, 1)
  ON CONFLICT(mailbox_id) DO UPDATE SET version = version + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `mail_sender_rules_version_update`
AFTER UPDATE OF priority ON `mail_sender_rules`
BEGIN
  INSERT INTO mail_changes (mailbox_id, version) VALUES (NEW.mailbox_id, 1)
  ON CONFLICT(mailbox_id) DO UPDATE SET version = version + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `mail_sender_rules_version_delete`
AFTER DELETE ON `mail_sender_rules`
BEGIN
  INSERT INTO mail_changes (mailbox_id, version) VALUES (OLD.mailbox_id, 1)
  ON CONFLICT(mailbox_id) DO UPDATE SET version = version + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `mail_sender_avatars_version_insert`
AFTER INSERT ON `mail_sender_avatars`
BEGIN
  INSERT INTO mail_changes (mailbox_id, version) VALUES (NEW.mailbox_id, 1)
  ON CONFLICT(mailbox_id) DO UPDATE SET version = version + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `mail_sender_avatars_version_update`
AFTER UPDATE OF kind ON `mail_sender_avatars`
BEGIN
  INSERT INTO mail_changes (mailbox_id, version) VALUES (NEW.mailbox_id, 1)
  ON CONFLICT(mailbox_id) DO UPDATE SET version = version + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `mail_sender_avatars_version_delete`
AFTER DELETE ON `mail_sender_avatars`
BEGIN
  INSERT INTO mail_changes (mailbox_id, version) VALUES (OLD.mailbox_id, 1)
  ON CONFLICT(mailbox_id) DO UPDATE SET version = version + 1;
END;
--> statement-breakpoint
-- Contact matches use the shared directory. Address and domain edits
-- change the profile revision in the same batch as the mappings.
CREATE TRIGGER `mail_contact_version_insert`
AFTER INSERT ON `people`
BEGIN
  INSERT INTO mail_changes (mailbox_id, version) SELECT id, 1 FROM mailboxes WHERE true
  ON CONFLICT(mailbox_id) DO UPDATE SET version = version + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `mail_contact_version_update`
AFTER UPDATE OF revision ON `people`
BEGIN
  INSERT INTO mail_changes (mailbox_id, version) SELECT id, 1 FROM mailboxes WHERE true
  ON CONFLICT(mailbox_id) DO UPDATE SET version = version + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `mail_contact_version_delete`
AFTER DELETE ON `people`
BEGIN
  INSERT INTO mail_changes (mailbox_id, version) SELECT id, 1 FROM mailboxes WHERE true
  ON CONFLICT(mailbox_id) DO UPDATE SET version = version + 1;
END;
