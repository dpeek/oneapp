DELETE FROM person_addresses
WHERE person_id IN (SELECT id FROM people WHERE kind = 'company');
--> statement-breakpoint
UPDATE contact_deletions SET addresses = '[]'
WHERE kind = 'company' AND addresses <> '[]';
