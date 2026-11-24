CREATE TABLE `files` (
	`account_id` text NOT NULL,
	`item_id` text NOT NULL,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`preview_type` text,
	CONSTRAINT `files_pk` PRIMARY KEY(`account_id`, `item_id`),
	CONSTRAINT `fk_files_account_id_item_id_items_account_id_id_fk` FOREIGN KEY (`account_id`,`item_id`) REFERENCES `items`(`account_id`,`id`) ON DELETE CASCADE
);
