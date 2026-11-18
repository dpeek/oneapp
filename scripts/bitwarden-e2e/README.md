# Bitwarden Chrome end-to-end test

Run from the OneApp repository root.

```sh
bun scripts/bitwarden-e2e/run.ts
```

The runner needs Bun, Node, OpenSSL, and a graphical desktop. It checks the SHA-256 of the stock [Bitwarden Chrome 2026.10.2 release](https://github.com/bitwarden/clients/releases/tag/browser-v2026.10.2) and loads the archive unchanged into temporary Chrome for Testing profiles. Set `ONEAPP_BITWARDEN_E2E_CHROME` to an existing Chrome for Testing executable to reuse a browser download.

The runner builds the Worker and web assets, starts local workerd through Miniflare, and applies the repository migrations to a temporary on-disk D1 database. It provisions a disposable OneApp account, opens **Password vault**, and completes setup through the real web form. It checks that the request contains the wrapped keys, public key, key ID, and KDF salt, and that the vault is ready after reloading.

The pinned extension reuses the OneApp session to authorize with PKCE, syncs the empty vault, and unlocks it with the same master password while Chrome is offline. In the first Chrome profile, the runner saves a login through the Bitwarden form and checks that the request carries encrypted values.

The runner opens a fresh second profile, authorizes it separately, and checks that it syncs and unlocks the same login. It opens the login for editing in both profiles, rotates the password in the first profile, and confirms the extension displays the conflict when the second profile attempts to save its stale edit. The second profile uses **Sync now**, then Bitwarden fills the username and rotated password on a separate local HTTPS fixture site.

The first profile sends the login to Trash. The runner checks that the second profile's pending edit is rejected, restarts workerd, and verifies that the second profile sees the item in Trash and no longer autofills it. The first profile restores the item, and the second profile syncs and autofills the same login again.

The runner restarts workerd with the restored item and checks that D1 held the vault, item, and device session. It also checks token rotation, duplicate-refresh handling, and sync of the saved revision with the refreshed access token.

Run `bun scripts/bitwarden-e2e/run.ts --seeded` to apply the login migration to an existing encrypted item and verify that the pinned extension can still sync and decrypt its username and password. Both modes use synthetic credentials and trace HTTP paths, methods, grant types, and status codes.
