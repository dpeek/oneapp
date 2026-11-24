# OneApp

A Bun workspace for the OneApp CLI, web app, and Chromium extension, with a Swift app for macOS. The web app and extension popup use Foldkit and Effect.

## Getting started

Use Bun 1.4.4 or newer. The dev launcher also uses Node.js for Alchemy. Node.js 24.11.1 is a supported version.

```sh
bun install
bun run dev
```

Open `http://localhost:1337`. The root `dev` command starts the local Cloudflare Worker and the Vite web app on the same origin, applies database migrations, and watches both for changes. On first run it creates `.alchemy/dev.env`. Use its `OWNER_EMAIL` and `OWNER_PASSWORD` to sign in. Local development uses its own credentials and bindings. Pass `--port <port>` to use a different port or `--stage <stage>` to use a different local database.

Run `bun fmt` to format and `bun check` to type-check. `bun run test` runs Vitest on Bun with `@effect/vitest`, and `bun run test:watch` reruns tests as you edit. `bun run verify` formats files, then checks types and runs tests. `bun run build` checks production builds independently of the dev server.

## Mobile mail notifications

OneApp can be installed as a PWA and receive private new-mail alerts while closed.
To enable delivery on a deployment:

1. Run `bun run push:keys` once and store the printed `PUSH_PUBLIC_KEY` and
   `PUSH_PRIVATE_KEY` in that stage's environment. Keep the private key secret
   and both keys stable across deployments.
2. Set `PUSH_SUBJECT` to a contact URI such as `mailto:mail@dpeek.com`.
3. Run `bun run deploy` to apply the migration and publish the Worker and PWA.
4. On iPhone/iPad (iOS 16.4+), use Share → Add to Home Screen, open OneApp from
   its icon, sign in, and choose **Settings → Notifications → Enable notifications**.
   Supported desktop/Android browsers can also opt in.

Only live incoming mail creates alerts. Imports, sent mail and read/archive
changes do not. Alerts contain no sender, subject or message body. Tapping an
alert opens that message in All Mail, preserving the destination through sign-in.
The service worker caches only a static offline page; reading mail requires a
connection.

Subscriptions belong to the browser session. Signing out removes that session's
server subscriptions and unsubscribes the current browser. Expiry, password/email
changes and account revocation stop delivery; sign in and enable notifications
again. Settings checks both browser permission and server registration.

Push work is committed atomically with the mail index, delivered immediately,
and retried by a one-minute cron with exponential backoff and `Retry-After`.
Recovery scans recognize live mail from R2 metadata. Jobs expire after 24 hours;
404/410 push endpoints are removed. A stable notification tag reduces duplicates
if a push provider accepts a request but its response is lost. Delivery is
at-least-once, not an exactly-once guarantee. Provider acceptance also does not
prove that a phone displayed the alert.

Before switching the primary mail address, test on the actual phone: locked and
closed-app delivery, tapping the correct message, reauthentication, lost
connectivity, disabling/re-enabling notifications, and confirming that imports
produce no alerts. Automated tests cover the outbox, encryption, retry/revocation,
registration authorization, permission handling and service-worker navigation.

## Local Mail fixtures

With `bun run dev` running, run `bun run mail:seed --stage dev` and refresh **Mail** (`/mail`). The sample mailbox includes single messages, a long thread with a sent reply and an attachment, newsletters in **Noise**, and an archived conversation. Pass the same stage name to `mail:seed` if you started the app with `--stage`. Rerunning the command preserves existing messages and their read or archive state.

## iCloud mail inventory and sample import

Run the read-only inventory from a terminal:

```sh
bun run mail:inventory --user 'your-login@icloud.com'
```

Enter an [Apple app-specific password](https://support.apple.com/102654) at the hidden prompt. Use the iCloud IMAP login associated with the mailbox, which may differ from a custom-domain address such as `mail@dpeek.com`. The command connects to `imap.mail.me.com:993` with TLS. It does not save the password, fetch message bodies, change flags, or write to OneApp.

For a noninteractive audit, put these values in the root `.env` (already ignored by Git), set its permissions with `chmod 600 .env`, and run `bun run mail:inventory`:

```dotenv
ICLOUD_IMAP_USER=your-login@icloud.com
ICLOUD_IMAP_PASSWORD=your-apple-app-specific-password
```

Bun loads `.env` automatically. `--user` overrides the environment login. The command uses the environment password when present and otherwise prompts in an interactive terminal. Credentials and raw server errors are never printed; connection progress and classified errors go to stderr, and the JSON report goes to stdout. These variables are used by the local inventory, sample and export commands; snapshot replay does not need iCloud credentials.

The JSON report lists every folder, its special-use role and how it was identified, UIDVALIDITY, message count, raw message bytes, and unread/flagged/deleted counts. Sizes include attachments. All addresses sharing the iCloud account are included; the report does not filter by `To` address. Totals count folder copies, not deduplicated messages. Failed or changing folders are marked incomplete and produce a nonzero exit code; rerun to reconcile them.

The server's `ingestRawMail` service in `apps/web/src/server/mail-import.ts` accepts original RFC 822 bytes and validated source metadata. A source identity is `(account, mailbox, UIDVALIDITY, UID)`; use a stable account identifier, including the provider. Callers explicitly map a source folder to Inbox, Archive (`folder: "inbox", archived: true`), or Sent. Preserve custom folders and source flags in the metadata until their UI mapping is decided. Do not map Trash, Junk or Drafts into Inbox automatically.

The service reserves an import receipt, writes the original to R2 conditionally, and completes the receipt atomically with D1 indexing. Retrying identical source bytes resumes pending work or skips completed work, preserving subsequent OneApp read/archive/deletion changes. Different bytes for the same identity are rejected. A changed UIDVALIDITY starts a new identity namespace; cross-folder copies and reset epochs are not deduplicated by Message-ID. Original dates survive reindexing, and Sent imports retain their original MIME data and threading headers.

To evaluate real mail locally, start the isolated sample stage:

```sh
bun run mail:dev
```

Keep that terminal running. `mail:dev` starts Alchemy in local mode with stage `mail_sample`, applies the migrations, and serves OneApp at the URL it prints (normally `http://localhost:1337`). It creates local sign-in credentials in `.alchemy/mail-sample.env` with permissions `600`; use its `OWNER_EMAIL` and `OWNER_PASSWORD` to sign in. It does not inherit production domain, email routing, sending, or authentication configuration.

In another terminal, with the iCloud credentials in the root `.env`, run:

```sh
bun run mail:sample --mailbox personal
```

The runner selects recent mail from `INBOX`, `Sent Messages`, and `Archive`, aiming for ten messages per folder and expanding matching Message-ID/References/In-Reply-To threads across those folders. It never selects Junk, Deleted Messages or Drafts. The sample is bounded to 100 messages and 100 MiB total, with a 25 MiB per-message limit; a thread that exceeds a bound is excluded as a whole. Thread completeness is limited to the three scanned folders and usable threading headers.

The first run saves the chosen UIDs, original dates, flags and folder mappings in `.alchemy/mail-import/mail_sample/plan.json`. Subsequent runs use that exact plan, check UIDVALIDITY, skip completed receipts **before downloading**, and retry unfinished messages one at a time using `BODY.PEEK[]`. The receipt and D1 index are committed together after the original bytes reach R2. Failed/missing/changed messages produce a nonzero exit code; rerun after fixing a transient error. A UIDVALIDITY change requires reviewing the source and creating a new sample plan. Each completed run writes `report.json` beside the plan. Both files are private and git-ignored; report totals count messages, while the UI groups conversations.

`--stage <stage>` supports another already-initialized local Alchemy stage. The runner rejects remote resources and plans for a different account or stage. Changing the folder mapping requires a deliberate new plan; the default command does not grow the sample when new iCloud mail arrives. This is a test import, not ongoing mailbox synchronization.

## Portable mailbox snapshots

Export once, then replay the saved originals while changing parsing or folder mapping:

```sh
bun run mail:export --out .mail-snapshots/icloud
bun run mail:import --snapshot .mail-snapshots/icloud --dry-run
```

Export reads all messages in `INBOX`, `Sent Messages` and `Archive`, across every address in the iCloud account. Junk, Deleted Messages and Drafts are excluded. It opens folders read-only and downloads original RFC 822 bytes with `BODY.PEEK[]` using at most three connections. No mail is sent, moved, marked read or deleted. Files are private (`600`, directories `700`) and `.mail-snapshots/` is git-ignored; snapshots contain the mailbox itself, including attachments, so keep copies private too.

The version-1 format contains:

| File                        | Purpose                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `inventory.json`            | Frozen folder/UID selection, UIDVALIDITY, IMAP dates, flags and expected byte sizes. No OneApp folder mapping or credentials. |
| `messages/<source-id>.eml`  | Unchanged original MIME bytes, including attachments.                                                                         |
| `receipts/<source-id>.json` | Per-file checksums and sizes for resuming an interrupted export.                                                              |
| `manifest.json`             | Completion marker, inventory checksum and checksums for every original. Written only after the entire selection is saved.     |
| `export-report.json`        | Counts and any failed source IDs from the last completed export attempt.                                                      |

Source IDs hash `(account, mailbox, UIDVALIDITY, UID)`. This preserves folder copies; it does not deduplicate by Message-ID. A snapshot freezes each folder's UID range and metadata when inventoried, not one transaction across the entire mailbox. Later arrivals are excluded. Missing or changed source messages prevent completion. Rerun the same export command to verify and reuse completed files; partial files are downloaded again. Once complete, rerunning verifies the snapshot offline. Use a new output directory for a later snapshot. A hard-killed process can leave `.export.lock`; remove that lock only after confirming its recorded process has stopped.

Dry-run verifies the manifest, every original's checksum and all folder mappings without connecting to iCloud or opening a destination. The default mapping is `scripts/mail/icloud-mapping.json`: Inbox → Inbox, Sent Messages → Sent, Archive → archived Inbox. Pass `--mapping <json>` to supply another mapping; each source folder needs an explicit mapping or `{ "skip": true }`.

For a fresh local replay, keep this development environment running:

```sh
bun run mail:dev --stage mail_replay --port 1338
```

Then import in another terminal:

```sh
bun run mail:import --snapshot .mail-snapshots/icloud --stage mail_replay --mailbox personal
```

Sign in at `http://localhost:1338` with the `mail@dpeek.com` credentials in `.alchemy/mail_replay.env`. No dummy mailbox is seeded. The importer requires an explicit local stage and destination `--mailbox`, verifies the entire snapshot before writing, and stores a per-message report in `.alchemy/mail-import/<stage>/<mailbox>/<snapshot-id>-report.json`. Failed messages make the command exit nonzero. Repeat the command to resume; completed receipts are skipped, preserving subsequent read/archive/deletion changes. The local adapter reports messages over 25 MiB as unsupported; their originals remain in the snapshot.

After every selected message has imported successfully and threading is finished, a one-time completion policy marks inactive conversations complete. A conversation qualifies when its latest incoming **or sent** message is strictly older than 30 days, none of its incoming messages is unread, and none of its messages has the source `\\Flagged` flag. The cutoff is fixed at the snapshot's `createdAt` minus 30 days, so retries and imports on another machine make the same age comparison. Deleted messages are ignored; conversations containing mail outside this import are protected. Existing complete conversations stay complete.

The policy, cutoff and per-conversation reasons are recorded in D1's `mail_import_completions` table and the local import report. Decisions and archive updates commit atomically. Retrying a completed import returns its recorded decisions without changing subsequent user choices or reopening/completing conversations again. A failed or partial import never runs this step. Dry-run displays the policy; conversation decisions require the destination's completed thread index. This is an import policy, not an ongoing auto-archive rule.

Folder mappings are recorded separately from the snapshot and bound to the destination. OneApp can reopen archived members while merging them into an active Inbox conversation; the final completion policy runs after those merges. The original folder metadata remains in the snapshot and import receipts. To change mappings, reevaluate completion rules or evaluate changed parsing, replay into a fresh destination mailbox. Do not edit the inventory or original files: their checksums are part of the format. The same snapshot can be copied to another machine without iCloud credentials.

### Import through the deployed API

Deploy the import adapter and its `mail_import_runs` migration before uploading. First validate the snapshot and adapter limits offline:

```sh
bun run mail:import --snapshot .mail-snapshots/icloud --server https://app.dpeek.com --mailbox personal --dry-run
```

Authorize a dedicated import credential through the browser, then upload:

```sh
bun apps/cli/src/index.ts auth login --mail-import --server https://app.dpeek.com
bun run mail:import --snapshot .mail-snapshots/icloud --server https://app.dpeek.com --mailbox personal
```

The browser approval grants `mail:import` for 24 hours. This permission allows importing originals, reading import receipts, and completing eligible imported conversations in mailboxes owned by the signed-in owner. It grants no Links access; ordinary Links CLI credentials grant no import access. Login replaces the CLI's saved credential for that server. Use `one auth logout` (or `bun apps/cli/src/index.ts auth logout`) after importing to revoke it. An expired credential can be replaced with another import login before resuming. Automation may supply `ONEAPP_IMPORT_TOKEN` through the environment instead of the CLI credential store; do not put tokens in command arguments or commit them.

The runner validates every original checksum before contacting the destination. HTTPS is required except for loopback development URLs, redirects are rejected, and the server verifies explicit mailbox ownership. The first request pins the snapshot, checksums, mapping and expected message metadata to an immutable server-side plan. Each upload must match that plan's size and checksum. The adapter currently supports 25 MiB per message, 5,000 selected messages, and a 1 MiB plan; unsupported snapshots stop before uploading.

Rerun the same command after an interruption. Completed receipts skip uploads and preserve subsequent mailbox edits. Transient failures retry automatically; changed bytes or mappings stop with a conflict. Conversation completion runs only after every planned message has a matching completed receipt, and reuses the snapshot's fixed completion cutoff. Reports and destination configuration are stored in `.alchemy/mail-import/remote-<origin-sha256>/<mailbox>/`. `--server` and local `--stage` are mutually exclusive; `--dry-run` never connects to either destination.

### Mailbox ownership and identities

Mail belongs to a mailbox, and each mailbox has an explicit owning account. The initial mailbox is `personal`; the migration assigns existing messages, threading keys, preferences, scans and import receipts to it without changing message IDs or original bytes. The browser still selects this mailbox and requires the existing single owner. Other app features are not yet isolated for multiple users.

Mail queries and operations use a `MailDatabase` with an explicit mailbox ID. Import identity is `(destination mailbox, source ID)`, so replaying the same snapshot into another mailbox creates an independent copy. The original snapshot remains destination-independent. Local import reports and mapping configuration live under `.alchemy/mail-import/<stage>/<mailbox>/`. Legacy receipts migrate into `personal` and still prevent duplicate imports.

`mailbox_addresses` stores owned identities with separate `can_receive` and `can_send` permissions. Login emails do not become mail identities automatically. On first use, the configured receiving/sending address is bootstrapped into `personal`. Optional `MAILBOX_ALIASES` adds comma-separated owned addresses with receiving permission but no send-as permission. Existing rows are never overwritten by bootstrap. Reply All excludes mailbox identities, including aliases; outgoing mail requires both mailbox permission and support from the configured transport.

Exact address routing takes precedence over `mail_domain_routes` catch-all entries, including when an exact address has receiving disabled. Routing records do not provision DNS or Cloudflare Email Routing. Domain administration, family account provisioning, transport setup, address management UI, and choosing among multiple mailboxes remain future work.

The personal mailbox retains its original R2 keys, including legacy timestamp keys. Additional mailboxes use `mailboxes/<mailbox-id>/` prefixes. Bucket adapters restrict listing, reads, attachments, writes and deletion to that namespace. WebSocket updates and background scans/cleanup are also mailbox-scoped. New deliveries preserve their envelope recipient separately; historical imports leave it unknown when the original export does not supply it.

## Workspaces

| Workspace        | Run or build                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cli`       | `bun run --filter @oneapp/cli dev` runs from source. The build produces `apps/cli/dist/one` for the current platform.                                                              |
| `apps/web`       | `bun run --filter @oneapp/web dev` starts the local web app. The static build goes to `apps/web/dist`.                                                                             |
| `apps/extension` | `bun run --filter @oneapp/extension build` builds the popup and manifest. In `chrome://extensions`, enable Developer mode and load `apps/extension/dist` as an unpacked extension. |
| `apps/apple`     | `bun run apple:dev` builds and opens the macOS app.                                                                                                                                |
| `packages/core`  | Shared, runtime-neutral TypeScript imported by all three apps.                                                                                                                     |
| `packages/ui`    | Foldkit starter UI mounted by the extension.                                                                                                                                       |

## macOS app

Install the standalone Command Line Tools with `xcode-select --install` or use an existing Xcode installation. On macOS 14 or later, run `bun run apple:dev` to open OneApp. Quit a running copy before rebuilding to pick up native changes. `bun run apple:build` writes a locally signed app to `apps/apple/dist/OneApp.app`.

Xcode 26 or later compiles `apps/apple/OneApp.icon` into the layered app icon. Builds with the standalone Command Line Tools use the bundled `apps/apple/OneApp.icns`. After editing the icon in Icon Composer, build with Xcode 26 or later selected and copy `apps/apple/dist/OneApp.app/Contents/Resources/OneApp.icns` to `apps/apple/OneApp.icns` to refresh the fallback.

The app loads `https://app.dpeek.com` and keeps its own OneApp sign-in session. Links to other sites open in your default browser.

## Local production backups

Install `age` and `sqlite3`. Generate an age identity once and keep a recoverable copy of it separately from the snapshots. The capture command uses the public recipient.

```sh
age-keygen -o /path/to/oneapp-backup.agekey
age-keygen -y /path/to/oneapp-backup.agekey

CLOUDFLARE_ACCOUNT_ID=<account-id> bun run backup:capture \
  --worker <deployed-worker-name> --recipient <age-public-key>
```

Capture uses the same Cloudflare profile or API token as deployment. It reads the deployed Worker's bindings to find D1 and the Inbox, Sent, ProfilePhotos, and VaultFiles buckets. The token must be able to read Worker bindings and R2 objects and export D1. Cloudflare can pause D1 queries during an export. Run captures in a quiet window. [D1 export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/) · [R2 object API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/)

Snapshots default to `~/.local/share/oneapp/backups`; use `--out` to select a local volume. The command publishes a new encrypted directory after checking database integrity and all referenced objects. Each directory contains the D1 SQL, the four buckets, and a manifest with the D1 bookmark, object keys, HTTP and custom metadata, and SHA-256 checksums. The D1 export includes the migration history and production account state. Keep deployment configuration and Worker secrets separately recoverable.

```sh
bun run backup:restore --snapshot /path/to/snapshot \
  --identity /path/to/oneapp-backup.agekey --out /path/to/new-restore-directory
```

Restore works offline and verifies checksums, SQLite integrity, foreign keys, and object references. The new output directory contains plaintext `database.sql`, a usable `database.sqlite`, and the recovered object bodies. Use its `manifest.json` to map numbered files to their bucket keys and metadata. Keep the restore on a private volume. This workflow recovers the data files for inspection or import into a fresh deployment.

## Cloudflare preview

The Alchemy stack deploys the Foldkit web app and Effect API to one Worker. It creates a D1 database per stage, applies the committed Drizzle migrations, and provisions the owner through Yielded Auth.

Create a private, Git-ignored `.env.preview` from `.env.example` and set its permissions with `chmod 600 .env.preview`. Use the Cloudflare account ID, the name of your authenticated `cf` profile, and the owner's email address. Generate `OWNER_PASSWORD`, `AUTH_SECRET`, and `MCP_OAUTH_SECRET` separately with `bun -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`. Keep the values stable for that stage. The password is used only during provisioning and the database stores its verifier. The session and OAuth signing keys are Worker secrets.

```sh
bun --env-file=.env.preview run deploy --stage preview
```

The deploy script uses the named `cf` profile locally. For CI, supply `CLOUDFLARE_API_TOKEN` and omit `CLOUDFLARE_AUTH_PROFILE`. A fresh stage gets its own Worker and database. `OWNER_EMAIL` and `OWNER_PASSWORD` are required only for the first provisioning of a database. Subsequent deploys use the existing owner in D1, including any email or password changes made in Settings. Use separate credentials for separate stages. Local `alchemy dev` sessions keep their emulator state in `.alchemy/state`. Cloud deployments share encrypted state in the account’s Cloudflare `alchemy-state-store` Worker. The store uses a Durable Object and Cloudflare Secrets Store. Run deploys to the same stage one at a time; this version’s Cloudflare store does not provide a deployment-wide lock. Keep `.alchemy/` private: it caches state-store credentials. A fresh checkout uses the same remote state after authenticating to the same Cloudflare account.

Use the same authentication wrapper for Alchemy maintenance commands:

```sh
bun --env-file=.env.preview scripts/alchemy.ts state list OneApp/preview
bun --env-file=.env.preview scripts/alchemy.ts plan --stage preview
```

The existing `preview` stage has been recovered from live resource identities and moved to remote state. Do not restore its old `.alchemy/state` files over the remote store. For a new Cloudflare account, provision the store once with `bun --env-file=.env.preview scripts/alchemy.ts state bootstrap` before CI deployment. CI needs access to the state-store Worker and Secrets Store in addition to the application resources; set `CI=true` so missing state infrastructure fails rather than being provisioned implicitly. [Alchemy’s state-store documentation](https://alchemy.run/state-store/) describes credentials and bootstrap behavior.

The main deployment uses `APP_DOMAIN=app.dpeek.com`. Alchemy attaches the hostname to the Worker, and Cloudflare manages DNS and TLS. Stages with a custom domain serve traffic on that domain. Stages without one use their `workers.dev` URL.

Set `ONEAPP_EXTERNAL_AUTH_SECRETS=true` for an existing Worker whose `AUTH_SECRET` and `MCP_OAUTH_SECRET` bindings are managed directly in Cloudflare. This keeps their values out of the deployment environment.

Set `ACCOUNT_EMAIL_ZONE_ID` to the Cloudflare DNS zone ID that owns `APP_DOMAIN` to enable account email. Alchemy onboards that hostname for Email Sending and the Worker sends from `accounts@APP_DOMAIN`. Leave this setting unset on preview deployments that should not send mail.

Set `INBOX_EMAIL_ZONE_ID` to the Cloudflare DNS zone ID that owns the `APP_DOMAIN` subdomain to receive mail at `mail@APP_DOMAIN`. Alchemy configures Email Routing for the subdomain and creates a rule for that address. After deploying, send a test email and verify that a `.eml` object appears in the stage's private `InboxMessages` R2 bucket. Each object contains the raw email, including attachments, and stores the SMTP envelope sender and recipient as object metadata.

Sign in and open **Mail** (`/mail`) to browse Inbox conversations by their latest incoming message. Open a conversation to read the selected message and expand earlier emails and sent replies. Select **Back** to return to the folder’s list.

**Contacts** (`/contacts`) holds people and companies. Choose **Add contact**, then select **Person** or **Company**; company contacts can have email addresses, website domains and a logo. Contact details use `/contacts/<id>`.

Automatic sender appearance uses the visible From address and headers. Transactional mailbox tokens (including tagged invoices and product-prefixed no-reply addresses), delivery subdomains such as `email` and `messages`, shared mailboxes, and organization names favor a company/service icon. Public-suffix parsing distinguishes real subdomains from suffixes such as `co.uk` and private hosting tenants. Named people at institutional subdomains and personal mail providers remain personal unless stronger delivery or transactional signals apply. Named employees at company domains are not automatically companies. These are heuristics; explicit sender overrides and saved person/company contacts take precedence. Cached appearances are rebuilt from original headers when the rules change, preserving mailbox state.

Mail loads remote images through the server after displaying the message. Likely tracking pixels (tiny or hidden images and known tracking URL patterns) are blocked before fetching; successful downloads are cached for seven days. The proxy hides browser credentials and the client IP, but a recipient-specific image URL can still reveal the first open. The message’s **More actions** menu offers **Load blocked images** and **Show plain text**; the latter replaces the HTML view and offers **Show formatted email** to switch back. These choices reset when you open another message. Fetches are limited to public HTTP(S) destinations, validated raster formats, 24 unique images, 1 MiB per image, 8 MiB downloaded per request, and eight seconds; HTML image embedding shares a 5 MiB budget with inline attachments. CSS background images remain blocked.

The OneApp vault and Bitwarden clients request website icons from OneApp at `/icons/<hostname>/icon.png`. On a cache miss, the Worker tries the site’s HTTPS favicon and checks its homepage for icon links. It serves raster icons and caches successful lookups for seven days and misses for one hour. IP literals and private DNS addresses are blocked. The web vault shows a generic icon for protected logins and when no website icon is available. Icon requests contain the login hostname, which can appear in Cloudflare’s Worker request logs.

Cloudflare stores invocation logs and traces at 100% sampling and groups recurring errors in Workers Issues. Query strings are redacted from request URLs in telemetry.

Open the URL printed at the end of the deploy and sign in with the configured email and password. Under **Links** (`/links`), enter an HTTP or HTTPS URL and press Enter. Use **Delete** next to a saved link to remove it. **Settings** (`/settings`) shows your account and connected CLI, extension, and MCP access.

In **Settings → Account**, request a code to verify the current email or use your current password to set a new one. Password changes sign out all browser sessions and send a notice to the verified address when email sending is configured. New passwords must have at least 15 characters. For breach screening, the server sends the first five hexadecimal characters of the new password's SHA-1 hash to [Pwned Passwords](https://haveibeenpwned.com/API/v3#PwnedPasswords) and matches the returned hashes locally.

Use **Change email** in the same panel to enter the new address and your current password. The code must be confirmed within five minutes in the session that requested it. OneApp then switches the sign-in address, signs out browser sessions, and sends a notice to the previous address.

**Forgot password?** on the sign-in screen sends a single-use link to the verified sign-in address. It expires in five minutes and can be opened in another browser or on another device. Submitting a new password signs out all browser sessions. Sign in again with the new password.

`GET /api/health` is public. The web app uses a session for `GET /api/me` and for reading and changing links.

After a schema change, generate a migration with `bun run db:generate --name <change>` and commit the resulting files in `apps/web/drizzle`. Alchemy applies them on the next deployment.

## CLI

After installing workspace dependencies, run `bun link` from the CLI package directory to put `one` on your PATH. The link runs the TypeScript source directly with Bun. For a standalone binary, run `bun run --filter @oneapp/cli build`.

```sh
cd apps/cli
bun link
one auth login
one links add https://example.com/
one links list
one links list --ids
one links delete <id>
one auth logout
```

`one auth login` defaults to `https://app.dpeek.com`. Pass `--server <url>` for a different deployment.

Run `one auth login` to start sign-in. The CLI opens a browser approval page and waits for your decision. Check that the code on the page matches your terminal, then choose **Connect CLI**. The request expires after five minutes. Use `--no-browser` to print the approval link for use on another device and `--name <label>` to name this device.

New CLI tokens grant `links:read` to list links and `links:write` to save and delete links. Older CLI tokens issued without delete access are revoked by the scope migration. Run `one auth login` to reconnect. The CLI stores the token in your OS credential store via `Bun.secrets`, keyed by server origin. Logout revokes the active token, and you can revoke any device’s token from the web app.

## Chrome extension

Run `bun run --filter @oneapp/extension build`. In Chrome, open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**. Select the `apps/extension/dist` directory.

Open OneApp from the Chrome toolbar and select **Connect to OneApp**. Approve the connection in the OneApp tab, signing in first if needed. On the page you want to keep, open the extension and select **Save this tab**. Saved links appear in the web app and in `one links list`.

New extension credentials only allow saving links and stay active until revoked. Use **Disconnect** in Chrome or **Settings → Clients** in the web app to revoke one. Credentials issued under the previous 30-day policy keep their original expiry.

## MCP

OneApp serves Streamable HTTP at `https://app.dpeek.com/mcp`. The `links:read` scope exposes `list_links`, which returns links newest first with a `nextOffset` for paging. The `links:write` scope exposes `save_link` and `delete_link`.

Register the server with Codex:

```sh
codex mcp add oneapp --url https://app.dpeek.com/mcp
```

Codex supplies its client ID automatically through its OAuth client metadata. Approve access in your browser. If the approval page doesn't open, run `codex mcp login oneapp`. Start a new Codex session to use the tools. For a setup that used `ONEAPP_MCP_TOKEN`, remove that MCP registration and add it again with the command above.

OneApp requests approval for `links:read` and `links:write` by default. For read-only access, run `codex mcp login oneapp --scopes links:read`. To reconnect a grant issued under the old scopes, run `codex mcp login oneapp`, approve access, then start a new Codex session.

Access tokens refresh automatically within the 30-day grant. Open **Settings → Clients** in the web app to revoke a grant.
