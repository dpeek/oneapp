-- Rebuild previews that may have spent their character budget on joiner padding.
-- Original MIME, message state, and meaningful joiners remain unchanged.
UPDATE `mail_index_messages` SET `body_preview` = NULL
WHERE instr(`body_preview`, char(8204)) > 0 OR instr(`body_preview`, char(8205)) > 0;
