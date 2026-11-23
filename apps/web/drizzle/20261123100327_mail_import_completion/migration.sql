CREATE TABLE `mail_import_completions` (
	`id` text PRIMARY KEY,
	`policy` text NOT NULL,
	`decisions` text NOT NULL,
	`completed_at` integer
);
