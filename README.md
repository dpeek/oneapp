# Orumai

A Bun workspace for the Orumai CLI, web app, and Chromium extension, with a Swift app for macOS. The web app and extension popup use Foldkit and Effect.

## Getting started

Use Bun 1.4.4 or newer. The dev launcher also uses Node.js for Alchemy. Node.js 24.11.1 is a supported version.

```sh
bun install
bun run dev
```

Open `http://localhost:1337`. The root `dev` command starts the local Cloudflare Worker and Vite web app together and watches both for changes. On first run it populates local dev from the latest encrypted backup. Use the `OWNER_EMAIL` and `OWNER_PASSWORD` from the local environment file printed at startup. See [Local production backups](#local-production-backups) for setup and refresh.

For a fresh checkout without a backup, follow [Run the full web stack with an empty database](#run-the-full-web-stack-with-an-empty-database).

Run `bun fmt` to format and `bun check` to type-check. `bun run test` runs Vitest on Bun with `@effect/vitest`, and `bun run test:watch` reruns tests as you edit. `bun run verify` formats files, then checks types and runs tests. `bun run build` checks production builds independently of the dev server.

### Run the full web stack with an empty database

From the repository root, use a fresh named stage and an unused port. In a workspace-write sandbox, put Alchemy's profile and local Worker registry in the checkout so their writes work.

```sh
bun install
mkdir -p .alchemy/home .alchemy/xdg-state
ALCHEMY_HOME="$PWD/.alchemy/home" XDG_STATE_HOME="$PWD/.alchemy/xdg-state" \
  bun run dev --stage clean_clone --port 18373
```

The root launcher starts the local Worker and Vite, applies the migrations to an empty local database, and provisions a local owner. Use a different stage name for another empty database. The launcher reuses the named stage's database on restart.

Open `http://localhost:18373/tasks` and sign in with `OWNER_EMAIL` and `OWNER_PASSWORD` from `.alchemy/clean_clone.env`. The Tasks page should show **No tasks yet**.

With the runner's browser, skip its external Chrome version check, which the sandbox blocks. Wait for the sign-in form to appear in `snapshot -i`, then use its references to `fill` the fields and `click` **Sign in**. Read the login values inside a helper process that passes the commands via `batch --bail` on stdin and suppresses the batch output.

```sh
export AGENT_BROWSER_NO_VERSION_CHECK=1
"$ORUMAI_BROWSER" open http://localhost:18373/tasks
"$ORUMAI_BROWSER" snapshot -i
```

Close the browser session with `"$ORUMAI_BROWSER" close` if you used it. Stop a foreground dev server with Ctrl+C. For automation, keep the supervisor that launched the dev server alive and have it send `SIGINT` to the dev process group even if the browser check fails. The sandbox can reject signals sent from a separate tool invocation. Wait for Alchemy to stop its children, then confirm `lsof -nP -iTCP:18373 -sTCP:LISTEN` reports no listener on the chosen port.

## iPhone Home Screen icon

Orumai supplies a single white spiral on a black tile for Safari's **Add to Home
Screen**. To verify an icon update, install from Safari and check the tile in
both Light and Dark Home Screen appearances without reinstalling. On an iPhone
with the previous icon installed, reopen the web app after the update and check
the tile again. If it still shows the old artwork, remove the Home Screen web
app and add it again from Safari. Automatic refresh of existing installations
still needs verification on the affected iOS version.

## Mobile mail notifications

Orumai can be installed as a PWA and receive private new-mail alerts while closed.
To enable delivery on a deployment:

1. Run `bun run push:keys` once and store the printed `PUSH_PUBLIC_KEY` and
   `PUSH_PRIVATE_KEY` in that stage's environment. Keep the private key secret
   and both keys stable across deployments.
2. Set `PUSH_SUBJECT` to a contact URI such as `mailto:mail@dpeek.com`.
3. Run `bun run deploy` to apply the migration and publish the Worker and PWA.
4. On iPhone/iPad (iOS 16.4+), use Share → Add to Home Screen, open Orumai from
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

## iCloud mail inventory and sample import

Run the read-only inventory from a terminal:

```sh
bun run mail:inventory --user 'your-login@icloud.com'
```

Enter an [Apple app-specific password](https://support.apple.com/102654) at the hidden prompt. Use the iCloud IMAP login associated with the mailbox, which may differ from a custom-domain address such as `mail@dpeek.com`. The command connects to `imap.mail.me.com:993` with TLS. It does not save the password, fetch message bodies, change flags, or write to Orumai.

For a noninteractive audit, put these values in the root `.env` (already ignored by Git), set its permissions with `chmod 600 .env`, and run `bun run mail:inventory`:

```dotenv
ICLOUD_IMAP_USER=your-login@icloud.com
ICLOUD_IMAP_PASSWORD=your-apple-app-specific-password
```

Bun loads `.env` automatically. `--user` overrides the environment login. The command uses the environment password when present and otherwise prompts in an interactive terminal. Credentials and raw server errors are never printed; connection progress and classified errors go to stderr, and the JSON report goes to stdout. These variables are used by the local inventory, sample and export commands; snapshot replay does not need iCloud credentials.

The JSON report lists every folder, its special-use role and how it was identified, UIDVALIDITY, message count, raw message bytes, and unread/flagged/deleted counts. Sizes include attachments. All addresses sharing the iCloud account are included; the report does not filter by `To` address. Totals count folder copies, not deduplicated messages. Failed or changing folders are marked incomplete and produce a nonzero exit code; rerun to reconcile them.

The server's `ingestRawMail` service in `apps/web/src/server/mail-import.ts` accepts original RFC 822 bytes and validated source metadata. A source identity is `(account, mailbox, UIDVALIDITY, UID)`; use a stable account identifier, including the provider. Callers explicitly map a source folder to Inbox, Archive (`folder: "inbox", archived: true`), or Sent. Preserve custom folders and source flags in the metadata until their UI mapping is decided. Do not map Trash, Junk or Drafts into Inbox automatically.

The service reserves an import receipt, writes the original to R2 conditionally, and completes the receipt atomically with D1 indexing. Retrying identical source bytes resumes pending work or skips completed work, preserving subsequent Orumai read/archive/deletion changes. Different bytes for the same identity are rejected. A changed UIDVALIDITY starts a new identity namespace; cross-folder copies and reset epochs are not deduplicated by Message-ID. Original dates survive reindexing, and Sent imports retain their original MIME data and threading headers.

To evaluate real mail locally, start the isolated sample stage:

```sh
bun run mail:dev
```

Keep that terminal running. `mail:dev` starts Alchemy in local mode with stage `mail_sample`, applies the migrations, and serves Orumai at the URL it prints (normally `http://localhost:1337`). It creates local sign-in credentials in `.alchemy/mail-sample.env` with permissions `600`; use its `OWNER_EMAIL` and `OWNER_PASSWORD` to sign in. It does not inherit production domain, email routing, sending, or authentication configuration.

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
| `inventory.json`            | Frozen folder/UID selection, UIDVALIDITY, IMAP dates, flags and expected byte sizes. No Orumai folder mapping or credentials. |
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

Sign in at `http://localhost:1338` with the `mail@dpeek.com` credentials in `.alchemy/mail_replay.env`. The importer requires an explicit local stage and destination `--mailbox`, verifies the entire snapshot before writing, and stores a per-message report in `.alchemy/mail-import/<stage>/<mailbox>/<snapshot-id>-report.json`. Failed messages make the command exit nonzero. Repeat the command to resume; completed receipts are skipped, preserving subsequent read/archive/deletion changes. The local adapter reports messages over 25 MiB as unsupported; their originals remain in the snapshot.

After every selected message has imported successfully and threading is finished, a one-time completion policy marks inactive conversations complete. A conversation qualifies when its latest incoming **or sent** message is strictly older than 30 days, none of its incoming messages is unread, and none of its messages has the source `\\Flagged` flag. The cutoff is fixed at the snapshot's `createdAt` minus 30 days, so retries and imports on another machine make the same age comparison. Deleted messages are ignored; conversations containing mail outside this import are protected. Existing complete conversations stay complete.

The policy, cutoff and per-conversation reasons are recorded in D1's `mail_import_completions` table and the local import report. Decisions and archive updates commit atomically. Retrying a completed import returns its recorded decisions without changing subsequent user choices or reopening/completing conversations again. A failed or partial import never runs this step. Dry-run displays the policy; conversation decisions require the destination's completed thread index. This is an import policy, not an ongoing auto-archive rule.

Folder mappings are recorded separately from the snapshot and bound to the destination. Orumai can reopen archived members while merging them into an active Inbox conversation; the final completion policy runs after those merges. The original folder metadata remains in the snapshot and import receipts. To change mappings, reevaluate completion rules or evaluate changed parsing, replay into a fresh destination mailbox. Do not edit the inventory or original files: their checksums are part of the format. The same snapshot can be copied to another machine without iCloud credentials.

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

The browser approval grants `mail:import` for 24 hours. This permission allows importing originals, reading import receipts, and completing eligible imported conversations in mailboxes owned by the signed-in owner. It grants no Links access; ordinary Links CLI credentials grant no import access. Login replaces the CLI's saved credential for that server. Use `oru auth logout` (or `bun apps/cli/src/index.ts auth logout`) after importing to revoke it. An expired credential can be replaced with another import login before resuming. Automation may supply `ONEAPP_IMPORT_TOKEN` through the environment instead of the CLI credential store; do not put tokens in command arguments or commit them.

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
| `apps/cli`       | `bun run --filter @orumai/cli dev` runs from source. The build produces `apps/cli/dist/oru` for the current platform.                                                              |
| `apps/web`       | `bun run --filter @orumai/web dev` starts the local web app. The static build goes to `apps/web/dist`.                                                                             |
| `apps/extension` | `bun run --filter @orumai/extension build` builds the popup and manifest. In `chrome://extensions`, enable Developer mode and load `apps/extension/dist` as an unpacked extension. |
| `apps/apple`     | `bun run apple:dev` builds and opens the macOS app.                                                                                                                                |
| `packages/core`  | Shared, runtime-neutral TypeScript imported by all three apps.                                                                                                                     |
| `packages/ui`    | Foldkit starter UI mounted by the extension.                                                                                                                                       |

## macOS app

Install the standalone Command Line Tools with `xcode-select --install` or use an existing Xcode installation. On macOS 14 or later, run `bun run apple:dev` to open Orumai. Quit a running copy before rebuilding to pick up native changes. `bun run apple:build` writes a locally signed app to `apps/apple/dist/Orumai.app`.

The macOS build bundles the static [Orumai icon](apps/apple/Orumai.icns). Open the [spiral explorer](doc/brand/spiral-explorer.html) in a browser to revisit the settings used for the mark.

The app loads `https://app.dpeek.com` and keeps its own Orumai sign-in session. Links to other sites open in your default browser.

## Local production backups

Install `age` and `sqlite3`. Generate an age identity once and keep a recoverable copy of it separately from the snapshots. The capture command uses the public recipient.

```sh
age-keygen -o /path/to/oneapp-backup.agekey
age-keygen -y /path/to/oneapp-backup.agekey

CLOUDFLARE_ACCOUNT_ID=<account-id> bun run backup:capture \
  --worker oneapp-web-production --recipient <age-public-key>
```

Capture uses the same Cloudflare profile or API token as deployment. It reads the deployed Worker's bindings to find D1 and the Inbox, Sent, ProfilePhotos, VaultFiles, and FileUploads buckets. The token must be able to read Worker bindings and R2 objects and export D1. Cloudflare can pause D1 queries during an export. Run captures in a quiet window. [D1 export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/) · [R2 object API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/)

Snapshots default to `~/.local/share/oneapp/backups`; use `--out` to select a local volume. The command publishes a new encrypted directory after checking database integrity and all referenced objects. Each directory contains the D1 SQL, the R2 buckets, and a manifest with the D1 bookmark, object keys, HTTP and custom metadata, and SHA-256 checksums. The D1 export includes the migration history and production account state. Keep deployment configuration and Worker secrets separately recoverable.

```sh
bun run backup:restore --snapshot /path/to/snapshot \
  --identity /path/to/oneapp-backup.agekey --out /path/to/new-restore-directory
```

Restore works offline and verifies checksums, SQLite integrity, foreign keys, and object references. The new output directory contains plaintext `database.sql`, a usable `database.sqlite`, and the recovered object bodies. Use its `manifest.json` to map numbered files to their bucket keys and metadata. Keep the restore on a private volume. This workflow recovers the data files for inspection or import into a fresh deployment.

### Restore to a fresh Cloudflare stage

Import into an empty D1 database with the target Worker isolated and its scheduled jobs and email disabled. Preserve the `__alchemy_migrations` table and its rows, then apply pending repository migrations after the import.

1. Rebuild the SQL import from the verified restore. Create tables in foreign-key dependency order and create indexes before inserting rows, so foreign keys can resolve referenced unique keys. Insert parent rows before their dependents and recreate triggers after the bulk load to avoid replaying their side effects.
2. Load rows whose literal `INSERT` would exceed D1's 100,000-byte statement limit through short parameterized queries with bound values. Preserve dependency order for those rows as well. At cutover, `mail_import_completions` and `mail_import_runs` each had one oversized row, and both tables could be loaded after the bulk import. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
3. Compare the imported rows to the verified SQLite restore and run `PRAGMA foreign_key_check`. Restore all five R2 buckets using the manifest's keys and metadata, and verify object checksums before routing traffic to the stage.

### Refresh local development data

```sh
bun run dev:pull
bun run dev
```

`bun run dev` runs the initial pull automatically. `dev:pull` uses the newest completed backup in `~/.local/share/oneapp/backups` and the age identity at `~/.config/oneapp/backup.agekey`. Use `--snapshot <directory>` or `--identity <file>` to override either. The pull verifies and decrypts the backup locally, applies branch migrations to a temporary copy, then loads application records and R2 objects into local dev. Resolve any migration-history error by restoring the original applied migration files and adding forward migrations.

Sign in with the local credentials in the environment file printed by the launcher. The Vault uses its original master password. Local dev uses local sessions and device connections, with outbound mail, push, and scheduled maintenance disabled. Restored data persists under the private `.alchemy/` directory.

Ordinary restarts reuse the current data, including local edits. A successful pull replaces the data used by the next `bun run dev`. Restart any running dev server to switch to the refreshed copy. Earlier copies remain on disk.

## Cloudflare production

Orumai uses the existing `OneApp/production` stage and `oneapp-web-production` Worker to serve `app.dpeek.com`. The former `OneApp/preview` stage was retired after the cutover.

The Alchemy stack deploys the Foldkit web app and Effect API to one Worker. It creates a D1 database per stage, applies the committed Drizzle migrations, and provisions the owner through Yielded Auth.

Use a private, Git-ignored `.env.production` with permissions `600`. `.env.example` lists the deployment settings. Keep the production session and OAuth signing keys and web push key pair stable across deployments.

```sh
bun --env-file=.env.production run deploy --stage production
```

The deploy script uses the named `cf` profile locally. For CI, supply `CLOUDFLARE_API_TOKEN` and omit `CLOUDFLARE_AUTH_PROFILE`. A fresh stage gets its own Worker and database. `OWNER_EMAIL` and `OWNER_PASSWORD` are required only for the first provisioning of a database. Subsequent deploys use the existing owner in D1, including any email or password changes made in Settings. Use separate credentials for separate stages. Local `alchemy dev` sessions keep their emulator state in `.alchemy/state`. Cloud deployments share encrypted state in the account’s Cloudflare `alchemy-state-store` Worker. The store uses a Durable Object and Cloudflare Secrets Store. Run deploys to the same stage one at a time; this version’s Cloudflare store does not provide a deployment-wide lock. Keep `.alchemy/` private: it caches state-store credentials. A fresh checkout uses the same remote state after authenticating to the same Cloudflare account.

Use the same authentication wrapper for Alchemy maintenance commands:

```sh
bun --env-file=.env.production scripts/alchemy.ts state list OneApp/production
bun --env-file=.env.production scripts/alchemy.ts plan --stage production
bun --env-file=.env.production scripts/alchemy.ts logs --stage production --resource Web --since 1h
```

For a new Cloudflare account, provision the remote store once with `bun --env-file=.env.production scripts/alchemy.ts state bootstrap` before CI deployment. CI needs access to the state-store Worker and Secrets Store in addition to the application resources; set `CI=true` so missing state infrastructure fails rather than being provisioned implicitly. [Alchemy’s state-store documentation](https://alchemy.run/state-store/) describes credentials and bootstrap behavior.

The main deployment uses `APP_DOMAIN=app.dpeek.com`. Alchemy attaches the hostname to the Worker, and Cloudflare manages DNS and TLS. Stages with a custom domain serve traffic on that domain. Stages without one use their `workers.dev` URL.

Set `ONEAPP_EXTERNAL_AUTH_SECRETS=true` for an existing Worker whose `AUTH_SECRET` and `MCP_OAUTH_SECRET` bindings are managed directly in Cloudflare. This keeps their values out of the deployment environment.

Set `ACCOUNT_EMAIL_ZONE_ID` to the Cloudflare DNS zone ID that owns `APP_DOMAIN` to enable account email. Alchemy onboards that hostname for Email Sending and the Worker sends from `accounts@APP_DOMAIN`. Leave this setting unset on preview deployments that should not send mail.

The production stack looks up the active `dpeek.com` and `orumai.app` zones by name. It provisions the owner and seeds D1 before enabling Email Routing and installing one catch-all per apex, both targeting `oneapp-web-production`. Cloudflare adds the apex MX records when Email Routing is enabled. Alchemy removes the legacy `mail@app.dpeek.com` rule and its inbound subdomain DNS after applying the new resources.

D1 first checks the SMTP envelope recipient against `mailbox_addresses`. A disabled exact address is rejected. An unlisted `dpeek.com` recipient goes to `personal` through `mail_domain_routes`. On `orumai.app`, only enabled exact addresses are accepted. The initial aliases `support@orumai.app`, `team@orumai.app`, and `admin@orumai.app` receive into `personal` and have no send permission.

The primary mailbox address is `mail@dpeek.com`. Production uses the `dpeek.com` zone ID in `ACCOUNT_EMAIL_ZONE_ID` for Email Sending. Outbound mailbox mail becomes available once Cloudflare verifies that sending domain. Account email continues to use `accounts@APP_DOMAIN`.

After applying the production changes, check both apex MX records. Send test mail to an existing and an unlisted `dpeek.com` address and to each provisioned `orumai.app` alias, then confirm the arrivals in Mail. Check that an unassigned `orumai.app` recipient is rejected and that a message sent from the inbox arrives with `mail@dpeek.com` as its sender.

Sign in and open **Mail** (`/mail`) to browse Inbox conversations by their latest incoming message. Open a conversation to read the selected message and expand earlier emails and sent replies. Select **Back** to return to the folder’s list.

**Contacts** (`/contacts`) holds people and companies. Choose **Add contact**, then select **Person** or **Company**; company contacts can have email addresses, website domains and a logo. Contact details use `/contacts/<id>`.

Automatic sender appearance uses the visible From address and headers. Transactional mailbox tokens (including tagged invoices and product-prefixed no-reply addresses), delivery subdomains such as `email` and `messages`, shared mailboxes, and organization names favor a company/service icon. Public-suffix parsing distinguishes real subdomains from suffixes such as `co.uk` and private hosting tenants. Named people at institutional subdomains and personal mail providers remain personal unless stronger delivery or transactional signals apply. Named employees at company domains are not automatically companies. These are heuristics; explicit sender overrides and saved person/company contacts take precedence. Cached appearances are rebuilt from original headers when the rules change, preserving mailbox state.

Mail loads remote images through the server after displaying the message. Likely tracking pixels (tiny or hidden images and known tracking URL patterns) are blocked before fetching; successful downloads are cached for seven days. The proxy hides browser credentials and the client IP, but a recipient-specific image URL can still reveal the first open. The message’s **More actions** menu offers **Load blocked images** and **Show plain text**; the latter replaces the HTML view and offers **Show formatted email** to switch back. These choices reset when you open another message. Fetches are limited to public HTTP(S) destinations, validated raster formats, 24 unique images, 1 MiB per image, 8 MiB downloaded per request, and eight seconds; HTML image embedding shares a 5 MiB budget with inline attachments. CSS background images remain blocked.

The Orumai vault and Bitwarden clients request website icons from Orumai at `/icons/<hostname>/icon.png`. On a cache miss, the Worker tries the site’s HTTPS favicon and checks its homepage for icon links. It serves raster icons and caches successful lookups for seven days and misses for one hour. IP literals and private DNS addresses are blocked. The web vault shows a generic icon for protected logins and when no website icon is available. Icon requests contain the login hostname, which can appear in Cloudflare’s Worker request logs.

Cloudflare stores invocation logs and traces at 100% sampling and groups recurring errors in Workers Issues. Query strings are redacted from request URLs in telemetry. Open **Workers & Pages → oneapp-web-production → Observability** to inspect production logs and traces. [Cloudflare Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/) also documents the telemetry API.

Open the URL printed at the end of the deploy and sign in with the configured email and password. Under **Links** (`/links`), enter an HTTP or HTTPS URL and press Enter. Use **Delete** next to a saved link to remove it. **Settings** (`/settings`) opens Account, with separate pages for Notifications and Clients.

In **Settings → Account**, request a code to verify the current email or use your current password to set a new one. Password changes sign out all browser sessions and send a notice to the verified address when email sending is configured. New passwords must have at least 15 characters. For breach screening, the server sends the first five hexadecimal characters of the new password's SHA-1 hash to [Pwned Passwords](https://haveibeenpwned.com/API/v3#PwnedPasswords) and matches the returned hashes locally.

Use **Change email** in the same panel to enter the new address and your current password. The code must be confirmed within five minutes in the session that requested it. Orumai then switches the sign-in address, signs out browser sessions, and sends a notice to the previous address.

**Forgot password?** on the sign-in screen sends a single-use link to the verified sign-in address. It expires in five minutes and can be opened in another browser or on another device. Submitting a new password signs out all browser sessions. Sign in again with the new password.

`GET /api/health` is public. The web app uses a session for `GET /api/me` and for reading and changing links.

After a schema change, generate a migration with `bun run db:generate --name <change>` and commit the resulting files in `apps/web/drizzle`. Alchemy applies them on the next deployment.

## CLI

After installing workspace dependencies, run `bun link` from the CLI package directory to put `oru` on your PATH. The link runs the TypeScript source directly with Bun. For a standalone binary, run `bun run --filter @orumai/cli build`.

```sh
cd apps/cli
bun link
oru auth login
oru links add https://example.com/
oru links list
oru links list --ids
oru links delete <id>
oru auth logout
```

`oru auth login` defaults to `https://app.dpeek.com`. Pass `--server <url>` for a different deployment.

Run `oru auth login` to start sign-in. The CLI opens a browser approval page and waits for your decision. Check that the code on the page matches your terminal, then choose **Connect CLI**. The request expires after five minutes. Use `--no-browser` to print the approval link for use on another device and `--name <label>` to name this device.

New CLI tokens grant `links:read` to list links and `links:write` to save and delete links. Older CLI tokens issued without delete access are revoked by the scope migration. Run `oru auth login` to reconnect. The CLI stores the token in your OS credential store via `Bun.secrets`, keyed by server origin. Logout revokes the active token, and you can revoke any device’s token from the web app.

## Chrome extension

Run `bun run --filter @orumai/extension build`. In Chrome, open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**. Select the `apps/extension/dist` directory.

Open Orumai from the Chrome toolbar and select **Connect to Orumai**. Approve the connection in the Orumai tab, signing in first if needed. On the page you want to keep, open the extension and select **Save this tab**. Saved links appear in the web app and in `oru links list`.

New extension credentials only allow saving links and stay active until revoked. Use **Disconnect** in Chrome or **Settings → Clients** in the web app to revoke one. Credentials issued under the previous 30-day policy keep their original expiry.

## MCP

Orumai serves Streamable HTTP at `https://app.dpeek.com/mcp`. The `links:read` scope exposes `list_links`, which returns links newest first with a `nextOffset` for paging. The `links:write` scope exposes `save_link` and `delete_link`.

Register the server with Codex:

```sh
codex mcp add orumai --url https://app.dpeek.com/mcp
```

Codex supplies its client ID automatically through its OAuth client metadata. Approve access in your browser. If the approval page doesn't open, run `codex mcp login orumai`. Start a new Codex session to use the tools. Existing registrations can continue to use their configured name, such as `oneapp`. For a setup that used `ONEAPP_MCP_TOKEN`, remove that MCP registration and add it again with the command above.

Orumai requests approval for `links:read`, `links:write`, `tasks:read`, and `tasks:write` by default. To add Tasks to an existing connection, run `codex mcp login <connection-name>`, approve access in the browser, then start a new Codex session.

For read-only access to both features, request the read scopes.

```sh
codex mcp login orumai --scopes links:read,tasks:read
```

`tasks:read` exposes `list_tasks`, `get_task`, `get_task_attachment`, and `list_tags`. The task list defaults to active tasks and supports title, status, priority, tag ID, and due-date filters. `get_task` returns the Markdown description and screenshot metadata. Pass the task ID and attachment ID to `get_task_attachment` to view the screenshot as a native MCP image. Both list tools return `nextOffset` for paging.

`tasks:write` exposes `create_task`, `update_task`, `delete_task`, and `create_tag`. Pass the task's latest `revision` when updating or deleting it. Deletion permanently removes the task and its screenshots. Use `addTagIds` or `removeTagIds` to change its tags. Omitted update fields keep their values. A UUID `requestId` lets a client safely retry task creation.

Files requires an explicit `files:read` grant. Request it with `codex mcp login orumai --scopes files:read`, approve access, and start a new Codex session. Include any other scopes you want to use on the same connection.

- `search_files` filters by filename substring (`query`) and exact tag name (`tag`, case-insensitive). Results include tags and a browser URL. Results default to 50 per page, up to 100. Pass `nextOffset` back as `offset` with the same filters.
- `get_file` returns metadata by file ID. Set `includeContent` to read PNG, JPEG, GIF, and WebP as native MCP images, or UTF-8 plain text, Markdown, CSV, TSV, and JSON as text. Inline content is available for files up to 1 MiB. Text previews are limited to 32 KiB and report `truncated` when more text is available. Use the file URL to open larger files, PDFs, and other unsupported formats in Orumai.

Calendar requires an explicit `calendar:read` grant. Request it with `codex mcp login orumai --scopes calendar:read` and include any other scopes you want on the connection. After approval, start a new Codex session.

- `list_calendar_events` takes local `start` and `end` dates (YYYY-MM-DD, end exclusive, up to 31 days), an IANA `timeZone`, and an optional `calendarId`. It returns calendar IDs and names, overlapping event occurrences in chronological order, and a Calendar URL. All-day times are dates and timed values are UTC timestamps. Pass `nextOffset` as `offset` with the same filters to continue. `incomplete` indicates that some occurrences could not be expanded.

Mail requires an explicit `mail:read` grant and uses the same personal mailbox as the web app. To search Mail and create or review tasks from the same connection, request these scopes and approve the new grant in your browser. Start a new Codex session after approval.

```sh
codex mcp login orumai --scopes mail:read,tasks:read,tasks:write
```

- `search_mail` browses All Mail by default. Filter with `subject` words, an exact `participantEmail`, inclusive UTC dates in `onOrAfter` and `onOrBefore` (YYYY-MM-DD), a `view` (`all`, `inbox`, `archive`, `sent`, or `noise`), or conversation `status` (`all`, `read`, or `unread`). Each conversation is represented by its newest matching message, which may be an older reply. Search uses message metadata. An `incomplete` value in `indexCoverage` means results may omit mail still being indexed.
- `get_mail_thread` takes a `messageId` and returns incoming and sent messages from oldest to newest. Both paged tools default to 10 results and allow up to 20. Pass `nextCursor` back as `cursor` with the same filters or message ID.
- `get_mail_message` takes a `messageId` and returns plain text and attachment details. Check `textStatus` for `complete`, `truncated`, or `unavailable`. Mail reads preserve unread status. Add the message's `url` as a Markdown link in a task description to open that message in Orumai.

Access tokens refresh automatically within the 30-day grant. Open **Settings → Clients** in the web app to revoke a grant.

### Run tagged tasks with Codex

After deploying the runner's MCP endpoint, set up Bun, Git, the GitHub CLI (`gh`), and the Codex CLI on an always-on machine. The runner needs Git credentials and a commit identity for `origin`. Sign in with `gh auth login --hostname github.com` or supply a `GH_TOKEN` with access to read the repository's contents and checks. Codex needs its own login or `CODEX_API_KEY`. From an Orumai checkout, run:

```sh
bun install --frozen-lockfile
bun --no-env-file run tasks:runner --configure-browser /path/to/chrome-headless-shell
bun --no-env-file run tasks:runner --login
bun --no-env-file run tasks:runner --dry-run
bun --no-env-file run tasks:runner --once
```

Approve the runner in your browser. `--login --no-browser` prints the approval URL for a machine without a browser. The runner stores its task credential in the OS credential store, separately from `oru auth login`. A service can also supply an approved credential as `ORUMAI_RUNNER_TOKEN` through its secret store. Revoke the credential under **Settings → Clients**. Use `--server <origin>` on each command to work against a different Orumai server.

Add the `ready` tag to a **Not started** task or assign it to **Oru** to opt it in. The runner checks tagged tasks first. **Dry run** prints the next eligible task without claiming it. **Once** attempts one task and waits for pending deployments. Omit `--once` to keep running. The runner picks up the next eligible task after a push and polls every minute when idle. Each claimed task gets a fresh clone of `origin/main` and runs Codex with GPT-6.2 Sol at high reasoning effort.

Codex commits locally and uses the runner's commands from the task checkout.

- `bun --no-env-file "$ORUMAI_WORKFLOW" fetch` refreshes the local mirror using the runner's Git credentials. Codex then runs `git fetch origin` and `git rebase origin/main` in its checkout.
- `bun --no-env-file "$ORUMAI_WORKFLOW" verify` takes the clean checkout's HEAD and verifies that commit in a separate checkout. It installs with the frozen lockfile, checks types, runs all tests, and builds the apps. The task shows **Running checks** during the command and **Agent working** when it finishes. The full output is saved in `verify.log` alongside `run.jsonl`.
- `bun --no-env-file "$ORUMAI_WORKFLOW" publish "Summary"` checks the claim and the verified commit, then attempts a fast-forward push to `origin/main`. If main advances, Codex fetches, rebases, resolves conflicts, and verifies the new commit in the same session. An accepted push or an uncertain transport result starts deployment tracking.

Install Chrome Headless Shell for your platform from [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) and run `--configure-browser` once per runner account. The path is saved in `$XDG_CONFIG_HOME/orumai-task-runner/config.json` or `~/.config/orumai-task-runner/config.json`. The runner can also find `chrome-headless-shell` on `PATH`, and `ORUMAI_CHROME_HEADLESS_SHELL` overrides the saved path for one launch.

The Codex sandbox allows writes to the runner account's Bun package cache, resolved with `bun pm cache`. Runner commands can reach localhost, the npm registry at `registry.npmjs.org`, and Node.js downloads at `nodejs.org`. Agents can use `bun add` and leave the updated manifest and lockfile for the runner's frozen-lockfile check.

For each task, the runner starts a fresh development server on a free localhost port and opens an isolated headless browser. Agents get the dev URL in `ORUMAI_DEV_URL`, the generated local sign-in file in `ORUMAI_DEV_ENV_FILE`, and the browser CLI in `ORUMAI_BROWSER`. The runner stops the browser and dev process group when the agent exits, including on failure. The server log is saved as `dev.log` alongside the run log.

Run logs live under `$XDG_STATE_HOME/orumai-task-runner` or `~/.local/state/orumai-task-runner`. `run.jsonl` records the push SHA and deployment result. The runner tracks Cloudflare's `Workers Builds: oneapp-web-production` check on GitHub while working on the next task. Pending deployments resume after restart. A successful production check on the pushed commit or the current `main` tip containing it marks the task **Completed** through MCP, provided the task still has the claimed revision. A failed build stays **In progress** and can be retried in Cloudflare. The runner stops tracking after 30 minutes without a successful deployment and leaves the task open for review. Failed implementation runs retain their checkout. To retry implementation, review the log and move the task back to **Not started**.
