# Complete the Orumai personal vault API

## Goal

Complete personal vault management in the Orumai Worker and web app, with compatibility verified against the unmodified Bitwarden Chrome extension 2026.10.2. An individual user should be able to bring an existing vault into Orumai, manage its items and attachments in either client, and take their data to a fresh personal vault. Keep Orumai sign-in and device authorization in place. Keep vault unlock, encryption, and decryption on the client.

Work through the milestones in order. Finish the API, corresponding web flows, and focused tests for each milestone before committing it. Continue through the final end-to-end gate and report the results.

## Starting point and scope

Orumai already supports vault setup, Bitwarden SSO, local unlock, sync, token refresh, and device revocation. Users can create, edit, trash, and restore logins and Secure Notes in both clients. The existing harness exercises stale writes, retries, autofill, Worker restarts, and data created before the current vault schema. [Existing browser coverage](../scripts/bitwarden-e2e/README.md)

**This goal covers**

- All eight personal item types recognized by the pinned client. These are Login, Secure Note, Card, Identity, SSH Key, Bank Account, Driver’s License, and Passport. Keep the web client able to create, read, edit, trash, and restore each type. Exercise release-gated Bitwarden types with wire fixtures when the pinned UI lacks a corresponding action. [Pinned item types](https://github.com/bitwarden/clients/blob/browser-v2026.10.2/libs/common/src/vault/enums/cipher-type.ts)
- Personal folders, item properties, single and bulk lifecycle operations, import and export, and end-to-end encrypted attachments. Orumai web management includes all these workflows, with documented differences in interaction where appropriate.
- Compatibility with the existing Orumai data and the pinned extension. Explicit browser sync is sufficient for this goal.

**Separate milestones**

Organizations, shared vaults, collections and their permissions, Bitwarden Send, passkey capture and authentication, master-password and vault-key changes, push sync, and additional Bitwarden client platforms or versions. Native Orumai clients, third-party import parsers, backup-only account-restricted formats in Orumai web, and ZIP attachment reimport also have separate scopes. Orumai web should support the portable formats defined below. Verify account-restricted export in the stock extension if the pinned client exposes it. For import files with unsupported material, identify it before any writes and give the user a clear result. This includes passkey records until their lifecycle is supported.

## Working agreements

- Start from the existing vault domain and D1 persistence. Keep vault ownership, revision handling, and transactional writes shared across the web API and Bitwarden adapter. Keep Bitwarden request and response translation at the adapter boundary. Use the local Vaultwarden checkout at `~/code/vaultwarden` to cross-check behavior.
- Reuse the existing browser crypto and vault lock lifecycle. Keep plaintext credentials, export contents, attachment names and contents, and key material inside the client. Keep sensitive values and signed attachment URLs out of logs and test artifacts. Transmit only ciphertext, wrapped keys, and operational metadata needed by the server.
- Keep modules focused and names aligned with the existing domain. Prefer typed schemas and small per-type modules where they make the contract clearer. Reuse item commands across entry points and keep the web list, editors, bulk actions, and file workflows independently understandable. Preserve unrelated fields when either client makes a partial edit.
- Use focused unit and domain tests during implementation. Test parsing and projection, vault ownership, revisions, retries, migrations, and failure paths at the smallest layer that exercises the real behavior. Use the existing in-memory SQLite or Worker test fixtures for transaction and authorization behavior. Small targeted client probes are appropriate for uncertain protocol behavior. Run the complete browser suite at the completion gate.
- Run the relevant focused tests and `bun check` before each milestone commit. For schema changes, run `bun run db:generate`, review the generated SQL for compatibility with existing data, and commit the migration and snapshot with the code. Include the web workflow and its tests in the same milestone as the API. Keep each commit independently reviewable and leave the tree clean.

Start with the [vault domain and D1 store](../apps/web/src/server/vault/personal.ts), the [Bitwarden routes](../apps/web/src/server/bitwarden/routes.ts), [cipher validation](../apps/web/src/server/bitwarden/cipher-request.ts), [wire projections](../apps/web/src/server/bitwarden/wire.ts), [web vault routes](../apps/web/src/server/vault/items.ts), [web vault contracts](../apps/web/src/vault-items-contract.ts), [vault UI](../apps/web/src/vault-reader.ts), and [browser crypto](../apps/web/src/vault-crypto.ts). Follow the [repository instructions](../AGENTS.md) for tooling and migrations.

## Milestone 1. Record the compatibility contract

- Create a compact matrix of pinned-client workflows, HTTP methods and paths, auth expectations, request and response fields, feature gates, and expected errors. Mark which flows already work and which require fixtures or a targeted probe.
- Trace personal import, export confirmation for a Orumai SSO account, and the attachment eligibility and upload handshake. Record which attachment upload and download paths the pinned client actually uses. Use a disposable vault and synthetic data.
- Record the matching Orumai web workflow for each operation and the test that will establish parity. Add characterization tests where current behavior or payload shapes need protection.
- Commit the matrix, any characterization tests, and the attachment protocol findings before implementing the new surface.

## Milestone 2. Complete item types and field management

- Extend the domain model, persistence, and both API contracts to validate and round-trip all eight item types. Add direct item reads and listing wherever the pinned client needs them. Preserve stable item IDs, wrapped keys, and item and vault revision semantics.
- Support the applicable encrypted fields for each item type. Preserve and expose the existing metadata users manage in the vault, including favourites, notes, custom fields, URI match rules, TOTP seeds, password history, and master-password reprompt. Present prior passwords on demand in Orumai after the applicable local unlock or reprompt. Keep client actions that use stored credentials distinct from vault management.
- Implement the Orumai web forms and detail views for the supported types and fields. Keep fields masked and clear decrypted values when the vault locks or the view closes, following the current UI behavior.
- Test each type across create, read, update, and sync projections. Cover malformed input, mixed-type payloads, cross-vault access, stable IDs, partial edits, and preservation of data created before the schema change. Commit the finished item slice.

## Milestone 3. Add folders, archive, and bulk lifecycle

- Add encrypted personal folder CRUD, item assignment and movement, and folder projections in sync. Define how items are handled when a folder is deleted and verify that behavior against the reference client. Scope every item and folder lookup to the personal vault.
- Add archive and unarchive and the single and bulk lifecycle operations supported by the pinned contract, including Trash, Restore, and permanent deletion from Trash. Include an explicit confirmation in Orumai web for irreversible deletion. Carry attachment cleanup through the lifecycle once attachment storage lands.
- Give Orumai web equivalent folder management, archive and trash views, item movement, and bulk actions. Use clear outcomes for stale selections and actions that have already been applied.
- Test mixed-owner and stale selections, retries, revision advancement, and the visibility of archived, trashed, restored, and permanently deleted items. Preserve the existing autofill behavior for Trash and Restore. Commit the folder and lifecycle slices separately if that makes their changes easier to review.

## Milestone 4. Add import and portable export

- Implement the pinned personal bulk-import contract, including encrypted item data and folder relationships. Validate format, types, relationships, and limits before writing. Commit accepted imports atomically within the supported limits and make retrying the same operation safe. Treat a deliberate second import as a separate operation according to the documented import behavior.
- Add Orumai web import and export for Bitwarden JSON and CSV, plus password-protected Bitwarden JSON. Parse or decrypt imports locally, encrypt entries before upload, and show useful errors and counts. Assemble exports from complete vault data after local confirmation and download them directly from the client. Document the fields each format can carry.
- Use the extension’s existing personal exporter and verify its local confirmation flow with Orumai SSO. Keep its encrypted sync projections complete and compatible with supported formats. Implement ZIP export with attachments in Milestone 5. [Pinned import API](https://github.com/bitwarden/clients/blob/browser-v2026.10.2/libs/importer/src/services/import-api.service.ts) · [Pinned personal exporter](https://github.com/bitwarden/clients/blob/browser-v2026.10.2/libs/tools/export-vault-core/src/services/individual-vault-export.service.ts)
- Test mixed item types, folder mappings, invalid entries, duplicate retries, and import rollback. Use synthetic fixtures to check portable export and import round trips and verify that plaintext is confined to the client. Commit the completed import and export slice.

## Milestone 5. Add secure attachments

- Add the pinned client’s attachment upload handshake, upload, listing and sync metadata, download, and deletion. Verify the eligibility signal required by the pinned client and scope it to capabilities Orumai implements.
- Use private Cloudflare R2 for ciphertext and D1 for ownership, item association, encrypted filenames, wrapped attachment keys, size, and upload state. Choose a supported file-size limit and per-vault quota based on the actual upload path. Validate bytes received against the declared limit and make upload retries and cleanup safe. Keep pending uploads out of sync until they are ready.
- Check authorization at every file boundary. Scope any temporary transfer authorization to one object and operation with a short expiry. Handle interrupted uploads, orphan cleanup, and races with session revocation or item deletion. Keep attachments recoverable with an item in Trash and clean up bytes after permanent deletion.
- Add Orumai web attachment listing, upload, download, and removal. Encrypt and decrypt files locally with the compatible attachment format. Add ZIP export with attachments in Orumai web and verify the stock extension’s ZIP export. Make plaintext download explicit to the user and surface any failed attachment so a partial archive is apparent. [Bitwarden attachments](https://bitwarden.com/help/attachments/) · [R2 Worker API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) · [Worker limits](https://developers.cloudflare.com/workers/platform/limits/)
- Test encrypted metadata and byte round trips, ownership checks, expired transfers, quota and size limits, retries, and cleanup after failure or deletion. Commit the finished attachment slice.

## Milestone 6. Run the completion gate

Extend the existing harness as each slice lands where practical, then run the complete suite with the real Worker, on-disk D1, attachment storage, and two isolated profiles using the unmodified pinned extension. Use disposable personal vaults and synthetic fixtures. Run from the repository root.

```sh
bun check
bun run test
bun run build
bun scripts/bitwarden-e2e/run.ts
bun scripts/bitwarden-e2e/run.ts --seeded
```

The full gate should demonstrate these workflows.

1. Retain the existing setup, SSO, local unlock, device revocation, token refresh, stale-write, restart, and autofill checks. Start from both a fresh vault and existing D1 data.
2. Import a mixed vault with folders, sync it into both profiles and Orumai web, and create and edit representative items from each client. Verify that revisions, metadata, folders, and supported item types round-trip.
3. Move and archive items, exercise bulk Trash and Restore, and confirm that permanent deletion propagates. Verify that Bitwarden stops autofilling a trashed login and resumes after restore.
4. Upload an attachment in Orumai web and download it in Bitwarden, then upload another in Bitwarden and download it in Orumai. Compare recovered bytes. Exercise retry, deletion, and restart behavior, including absence of ciphertext blobs after permanent cleanup.
5. Export portable data and reimport it into a fresh personal vault. Compare supported items and folders, verify the supported formats in both clients, and verify that ZIP exports contain the expected attachments. Check that network exchanges contain encrypted vault and file data.

Fix failures with focused regression tests, then rerun the complete gate before marking the goal complete. Commit the completion coverage and record the milestone commit IDs, exact commands and results, supported formats and limits, and any explicitly deferred compatibility rows. A release or production deployment is a separate handoff decision.
