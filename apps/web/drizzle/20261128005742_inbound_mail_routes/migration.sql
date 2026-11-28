CREATE TABLE `mail_inbound_routes` (
	`address` text PRIMARY KEY,
	`mailbox_id` text NOT NULL,
	`enabled` integer NOT NULL,
	CONSTRAINT `fk_mail_inbound_routes_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`)
);
--> statement-breakpoint
CREATE INDEX `mail_inbound_routes_mailbox` ON `mail_inbound_routes` (`mailbox_id`);
--> statement-breakpoint
-- Copy destinations and disabled rules before retiring the fallback.
INSERT INTO mail_inbound_routes (address, mailbox_id, enabled)
SELECT address, mailbox_id, can_receive FROM mailbox_addresses
WHERE address <> 'mail@app.dpeek.com';
--> statement-breakpoint
DELETE FROM mailbox_addresses WHERE address = 'mail@app.dpeek.com';
--> statement-breakpoint
DELETE FROM person_addresses
WHERE email = 'mail@app.dpeek.com'
  AND person_id IN (SELECT id FROM people WHERE account_id = 'owner');
--> statement-breakpoint
DELETE FROM mail_domain_routes;
