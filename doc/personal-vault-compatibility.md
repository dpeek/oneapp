# Personal vault compatibility

Target release is stock Bitwarden Chrome [2026.10.2](https://github.com/bitwarden/clients/releases/tag/browser-v2026.10.2). Paths below are relative to the self-hosted server. The source trace uses the pinned tag, with Vaultwarden local revision `4051a4d3` as a reference for server behavior.

Desktop SSO was verified with stock Bitwarden Desktop 2026.10.0 on macOS. After approval, the browser shows an **Open Bitwarden** link that carries the code through `bitwarden://sso-callback`. A direct click lets the browser hand off to the app. The authorization code and refresh grant stay bound to the originating client. The D1 migration treats existing grants as browser grants. The macOS test delivered the callback to an isolated Desktop process, redeemed the code, synced, and decrypted a seeded login.

| Workflow | Pinned wire contract | OneApp workflow and evidence |
| --- | --- | --- |
| Setup and authorization | Browser session on `GET/POST /identity/connect/authorize`, PKCE grant to `POST /identity/connect/token`. Token exchange also accepts refresh grants. Config is public. Invalid or revoked grants return 400 or 401 according to the grant. | OneApp sign-in and local master password setup. Existing fresh and seeded browser cases cover sign-in, offline unlock, rotation, and revocation. |
| Sync and individual read | Bearer on `GET /api/sync`, `/api/accounts/profile`, `/api/accounts/keys`, `/api/accounts/revision-date`, and `GET /api/ciphers/{id}[/details]`. Sync carries encrypted ciphers, folders and user decryption options. A direct read returns one cipher. Vaultwarden also exposes `GET /api/ciphers` as a list. | The OneApp snapshot powers the vault list. Existing browser cases cover sync, legacy ciphertext, and restart. Add list and individual projection tests. |
| Create and edit | Bearer on `POST /api/ciphers` and `PUT /api/ciphers/{id}`. Send encrypted `name`, wrapped `key`, selected type payload, `notes`, `favorite`, `fields`, `reprompt`, and login history. Edit supplies `lastKnownRevisionDate`. Return the full cipher including stable ID and revision. Invalid or mixed types return 400, inaccessible IDs 404, and stale edits or edits in Trash 409. | Login and Secure Note already work from both clients. Exercise Card, Identity, and SSH Key in the stock UI where available. Use wire fixtures for Bank Account, Driver’s License, and Passport with `pm-32009-new-item-types` off. Check local detail, edit and history for all applicable types. |
| Personal folders | Bearer on `POST /api/folders`, `GET/PUT/DELETE /api/folders/{id}`. Writes carry the encrypted `name`. Return `id`, `name`, `revisionDate`, and `object: folder` for create/read/update. Folder membership is `folderId` on cipher writes and sync. Vaultwarden detaches folder memberships on delete and preserves the items. | Add folder create, rename, delete, and item movement. Verify folder detachment and foreign ID handling. Check bulk movement against the reference `PUT /api/ciphers/move` with `ids` and `folderId`. |
| Trash, restore and permanent deletion | Bearer on `PUT /api/ciphers/{id}/delete`, `PUT /api/ciphers/{id}/restore` and `DELETE /api/ciphers/{id}`. Bulk requests carry `ids` to `PUT /api/ciphers/delete`, `PUT /api/ciphers/restore`, and `DELETE /api/ciphers`. Restore returns a cipher or a list envelope. Delete needs no response payload. | Existing single Trash and Restore browser cases test stale writes and autofill. Add bulk selection, confirmation for permanent deletion from Trash, ownership and retry tests. |
| Archive | Bearer on `PUT /api/ciphers/archive` and `PUT /api/ciphers/unarchive` with `ids`, even for a single item in the stock UI. Return a list with changed ciphers. `archivedDate` represents state. Stock actions require `hasPremiumFromAnySource`. | Add active and archive views, action tests, and cross-client verification. |
| Import | Bearer on `POST /api/ciphers/import`. The [personal importer](https://github.com/bitwarden/clients/blob/browser-v2026.10.2/libs/importer/src/services/import-api.service.ts) sends `ciphers` with normal encrypted payloads and `folders` with encrypted names. `folderRelationships` maps zero-based cipher indices (`key`) to folder indices (`value`). The client needs a success status only. | OneApp parses or decrypts files locally before sending encrypted records and folder indices. Test invalid input before writes, atomicity, replay of the same encrypted payload and separately encrypted repeat imports. |
| Export | The [personal exporter](https://github.com/bitwarden/clients/blob/browser-v2026.10.2/libs/tools/export-vault-core/src/services/individual-vault-export.service.ts) consumes local synced data. The confirmation service uses proof of decryption when master password unlock is configured. ZIP fetches attachment metadata and ciphertext separately. | The seeded stock Chrome probe confirmed a JSON export while offline and checked the legacy login in the downloaded document. Add OneApp JSON, CSV and password-protected JSON plus ZIP once storage lands. Exercise account-restricted JSON in the stock UI. |
| File metadata and upload | The [attachment button](https://github.com/bitwarden/clients/blob/browser-v2026.10.2/apps/browser/src/vault/popup/components/vault/attachments/open-attachments/open-attachments.component.ts) requires `hasPremiumFromAnySource`. Bearer on `POST /api/ciphers/{id}/attachment/v2` with encrypted `fileName`, wrapped `key`, encrypted byte count `fileSize`, `adminRequest: false` and `lastKnownRevisionDate`. Self-hosted response has `fileUploadType: 0`, `attachmentId`, `cipherResponse`, and `url`. The direct upload service uses Bearer `POST /api/ciphers/{id}/attachment/{attachmentId}`, calculated from the IDs, with encrypted multipart field `data`. | OneApp encrypts bytes locally. Exercise stock upload against the direct path and validate pending visibility, declared size, quota, replay, and revocation. |
| File download and deletion | Bearer `GET /api/ciphers/{id}/attachment/{attachmentId}` returns `id`, `fileName`, `key`, `size`, `sizeName` and a temporary `url`. The client fetches that URL without a Bearer header. Bearer `DELETE` on the metadata route returns an object containing `cipher`. Ready metadata also rides in `cipher.attachments`. The alternate SDK attachment path is gated by `pm-28192-cipher-attachment-ops-to-sdk`, which defaults off. | Exercise both download directions, expired URL, cross-vault denial, deletion and permanent cleanup. The stock browser probe used the metadata GET and then fetched the signed URL without a bearer token. It sent the multipart upload through the direct POST path. |

Personal writes reject organization and collection operations. Use disposable accounts, encrypted fixtures and synthetic file contents for all probes.

## Portable formats

- Bitwarden JSON carries all eight personal item types, non-trashed items, folders and folder membership, archive state, favourites, reprompt settings, custom fields, login URIs and match rules, TOTP seeds, password history, and passkeys. Imported items receive new IDs and revisions. A personal import can reference an existing folder by ID only when that folder belongs to the destination vault. OneApp web imports create fresh folders and item copies even when the same source file is deliberately selected again.
- Password-protected Bitwarden JSON carries the same data in an authenticated encrypted envelope. OneApp exports PBKDF2-SHA-256 at 600,000 iterations. Imports accept Bitwarden PBKDF2 from 5,000 to 2,000,000 iterations and Argon2id with 16–128 MiB of memory, 2–10 iterations and 1–16 lanes.
- Bitwarden CSV carries logins and Secure Notes with named folders, favourites, notes, reprompt and archive state, text custom fields, login URIs, username, password and TOTP seed. CSV omits passkeys, other item types, empty folders, field type and linked field metadata, URI match rules, and history.
- OneApp accepts up to 500 items and 500 folders per import. The file and encrypted request each have a 1 MiB limit, and encrypted items have a 128 KiB limit. Replaying the same encrypted request returns the original outcome without duplicating data. The server checks every entry and relationship before writing.
- Personal portable imports reject shared-vault content, attachment references, and account-restricted exports. Files exported by either client omit Trash. Plaintext exports and file passwords stay in the browser.
- OneApp encrypts passkey values with the login’s item key. The stock Bitwarden extension can use synced passkeys and save signature-counter updates. For older passkeys with a nonzero counter, import a current snapshot so its counter is at least as high as the relying party’s last observed counter.

## Attachment storage and transfer

OneApp stores authenticated encrypted files in a private R2 bucket and stores encrypted names, wrapped file keys and upload reservations in D1. The direct upload mode uses an 8 MiB encrypted file limit and a 64 MiB vault quota. Pending reservations expire after 30 minutes and count toward quota until they expire. Pending uploads are excluded from sync. Bitwarden receives its archive and attachment eligibility through the self-hosted profile only when the attachment binding is configured.

File downloads from Bitwarden use a 60-second URL for one object and one device session. The Worker checks the device session again before serving bytes. Attachment deletion or permanent item deletion queues private object cleanup in the same D1 transaction. A scheduled Worker retries cleanup and releases expired reservations.

OneApp ZIP exports contain `data.json` and an `attachments` directory. Failed files appear in the export result and in `missing-attachments.txt` in the ZIP. ZIP reimport is outside the portable import contract.

## Implementation commits

| Milestone | Commit |
| --- | --- |
| Pinned compatibility contract and offline export confirmation | `4ce56ec` |
| Eight item types, fields and direct reads | `80234a7` |
| Folders, archive and bulk lifecycle | `e1bd539` |
| Atomic import and portable export | `b88fbe2` |
| Private attachments and ZIP export | `d8733b7` |

Bulk lifecycle requests accept up to 100 items. The stock extension’s release flag still governs its UI for Bank Account, Driver’s License and Passport. The Worker tests exercise all eight encrypted payloads through both APIs, and the browser gate syncs a Driver’s License created in OneApp. The portable formats and attachment limits above apply to OneApp imports and storage. Account-restricted export is exercised in Bitwarden, and ZIP reimport and the other separate scopes listed in the plan remain outside this implementation.

## Completion gate

Verified with Bun 1.4.4 and unmodified Bitwarden Chrome 2026.10.2. The harness used two isolated extension profiles, workerd, on-disk D1 and private R2, plus an independently initialized destination vault and profile for reimport.

| Command | Result |
| --- | --- |
| `bun check` | Passed across 97 files. |
| `bun run test` | Passed 28 tests across six files. |
| `bun run build` | Passed for CLI, web and extension. |
| `bun scripts/bitwarden-e2e/run.ts` | Passed. Covered stock SSO, offline unlock, autofill, encrypted mixed import, folder and lifecycle changes, attachment retry and restart, ZIP export, R2 cleanup, device revocation, refresh, and reimport into the destination vault. Verified WebAuthn sign-in with an imported passkey, persisted counter updates, and passkey removal. |
| `bun scripts/bitwarden-e2e/run.ts --seeded` | Passed. Migrated an existing encrypted D1 record, decrypted it offline in stock Bitwarden, exported it offline after local confirmation, and verified restart and token refresh. |

The seeded run observed a background profile request disconnect during the deliberate Worker restart. Its post-restart sync and token checks passed.
