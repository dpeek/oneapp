CREATE TABLE `yielded_oauth_client_assertion` (
	`namespace` text NOT NULL,
	`assertion_id` text NOT NULL,
	`expires_at_millis` integer NOT NULL,
	CONSTRAINT `yielded_oauth_client_assertion_pk` PRIMARY KEY(`namespace`, `assertion_id`)
);
--> statement-breakpoint
CREATE TABLE `yielded_oauth_server` (
	`namespace` text NOT NULL,
	`grant_id` text NOT NULL,
	`version` text NOT NULL,
	`revoked` integer DEFAULT 0 NOT NULL,
	`expires_at_millis` integer NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `yielded_oauth_server_pk` PRIMARY KEY(`namespace`, `grant_id`)
);
