import { ensureDefaultMailbox, mailDatabase } from "./mailbox.ts";
import { expect, it, vi } from "@effect/vitest";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  cliLinkScopes,
  cliLoginPath,
  cliTokensPath,
  taskRunnerMcpPath,
  taskRunnerScopes,
} from "@orumai/core/cli-auth";
import { extensionAccessPath, digestSecret } from "@orumai/core/extension-auth";
import {
  linkPath,
  linksPath,
  linksReadScope,
  linksWriteScope,
} from "@orumai/core/links";
import { EmailDelivery } from "@yielded/auth";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { ConfigProvider, Effect, Redacted, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import type { WorkerEnv } from "../../../../alchemy.run.ts";
import { TaskQueue } from "../../../../scripts/task-runner/queue.ts";
import {
  emailChangePath,
  emailVerificationPath,
  passwordChangePath,
  themePreferencePath,
} from "../account-contract.ts";
import { bitwardenDevicesPath } from "../bitwarden-device-contract.ts";
import { calendarApi, calendarImportLimit } from "../calendar-contract.ts";
import {
  fileApi,
  fileContentApi,
  FileIndex,
  fileNameHeader,
  filesApi,
  filesChanged,
  StoredFile,
} from "../files-contract.ts";
import { Tag, tagApi, tagsApi, tagsChanged } from "../items-contract.ts";
import {
  TaskAttachment,
  taskAttachmentApi,
  taskAttachmentsApi,
} from "../task-attachment-contract.ts";
import {
  Task,
  taskApi,
  TaskIndex,
  tasksApi,
  tasksChanged,
  TaskSnapshot,
} from "../tasks-contract.ts";
import {
  allMailApiPath,
  archiveApiPath,
  conversationApi,
  conversationArchiveApi,
  conversationsApiPath,
  inboxApiPath,
  inboxAttachmentApi,
  inboxAttachmentPreviewApi,
  inboxEventsPath,
  inboxMessageApi,
  inboxOriginalApi,
  inboxReadApi,
  inboxReplyApi,
  inboxSendPath,
  inboxUnreadPath,
  mailMessageApi,
  noiseApiPath,
  noiseSendersApiPath,
  replyCompletionHeader,
  senderRuleApiPath,
  sentApiPath,
  sentCopyHeader,
  sentMessageHeader,
  trashApiPath,
  trashBatchRestoreApi,
  TrashedConversation,
} from "../inbox-contract.ts";
import {
  codexClientId,
  McpGrantList,
  mcpGrantsPath,
  tasksReadScope,
  tasksWriteScope,
} from "../mcp-access-contract.ts";
import {
  passwordResetPath,
  resetPasswordPage,
} from "../password-recovery-contract.ts";
import {
  peopleApiPath,
  personApiPath,
  personLookupPath,
  personPhotoPath,
  restoreContactPath,
  selfProfilePath,
  type Person,
} from "../people-contract.ts";
import {
  vaultAttachmentPath,
  vaultAttachmentsPath,
  vaultAttachmentLimit,
  vaultAttachmentQuota,
} from "../vault-attachment-contract.ts";
import { vaultImportPath } from "../vault-transfer-contract.ts";
import { vaultSetupPath } from "../vault-setup-contract.ts";
import {
  vaultBulkPath,
  vaultFolderPath,
  vaultFoldersPath,
  VaultItem,
  vaultItemPath,
  vaultItemsPath,
  type VaultLifecycleAction,
  vaultLifecyclePath,
  VaultSnapshot,
} from "../vault-items-contract.ts";
import { extraItemTypes, itemTypes } from "../vault-item-content.ts";
import { createVaultSetup } from "../vault-crypto.ts";
import { deviceLifetimeMillis, randomSecret } from "./bitwarden/tokens.ts";
import { digest } from "./digest.ts";
import { ensureOwner } from "./provision-owner.ts";
import { mcpOAuth } from "./mcp-oauth.ts";
import worker from "./worker.ts";
import { collectMailTrash, mailRetentionMs } from "./mail-trash.ts";
import { collectDeletedContacts } from "./people.ts";
import { indexMail, setSenderRule } from "./mail-index.ts";
import { generateVAPIDKeys } from "web-push";

const email = "owner@example.net";
const password = "p".repeat(43);

const setup = async (
  sqlite: Database,
  inbox?: Partial<
    Pick<
      WorkerEnv,
      | "MAILBOX_ALIASES"
      | "INBOX_MESSAGES"
      | "INBOX_EMAIL_ADDRESS"
      | "INBOX_UPDATES"
      | "INBOX_EMAIL_FROM"
      | "SENT_MESSAGES"
      | "PROFILE_PHOTOS"
      | "FILE_UPLOADS"
      | "PUSH_PUBLIC_KEY"
      | "PUSH_PRIVATE_KEY"
      | "PUSH_SUBJECT"
    >
  > & { INBOX_SEND?: SendEmail; INBOX_SEND_LIMIT?: RateLimit },
) => {
  const migrationRoot = new URL("../../drizzle/", import.meta.url).pathname;
  for (const entry of Array.from(
    new Bun.Glob("*/migration.sql").scanSync(migrationRoot),
  ).sort()) {
    sqlite.exec(await Bun.file(migrationRoot + entry).text());
  }

  sqlite.exec("PRAGMA foreign_keys = ON");
  const totalChanges = sqlite.query<{ changes: number }, []>(
    "SELECT total_changes() AS changes",
  );
  const bind = (sql: string, params: SQLQueryBindings[]) => {
    const execute = () => {
      const before = totalChanges.get()!.changes;
      const results = sqlite.query(sql).all(...params);
      return {
        results,
        meta: { changes: totalChanges.get()!.changes - before },
      };
    };
    return {
      execute,
      all: async () => execute(),
      run: async () => execute(),
      first: async (column?: string) => {
        const row = sqlite
          .query<Record<string, unknown>, SQLQueryBindings[]>(sql)
          .get(...params);
        return column === undefined ? row : (row?.[column] ?? null);
      },
      raw: async () => sqlite.query(sql).values(...params),
    };
  };
  let emailAvailable = true;
  const messages: { from: string; to: string; text: string }[] = [];
  const deliveries: Promise<unknown>[] = [];
  let dropStoredFileResponse = false;
  const objects = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; customMetadata: { sha256: string } }
  >();
  const env = {
    INBOX_MESSAGES: {},
    SENT_MESSAGES: {},
    ...inbox,
    VAULT_FILES: {
      put: async (
        id: string,
        bytes: Uint8Array<ArrayBuffer>,
        options: { customMetadata: { sha256: string } },
      ) => {
        if (objects.has(id)) return null;
        const object = {
          bytes: bytes.slice(),
          customMetadata: options.customMetadata,
        };
        objects.set(id, object);
        if (dropStoredFileResponse) {
          dropStoredFileResponse = false;
          throw new Error("Fixture lost response after storing object");
        }
        return object;
      },
      head: async (id: string) => objects.get(id) ?? null,
      get: async (id: string) => {
        const object = objects.get(id);
        return object
          ? { size: object.bytes.length, body: new Response(object.bytes).body }
          : null;
      },
      delete: async (ids: string | string[]) => {
        for (const id of Array.isArray(ids) ? ids : [ids]) objects.delete(id);
      },
    },
    DB: {
      prepare: (sql: string) => ({
        ...bind(sql, []),
        bind: (...params: SQLQueryBindings[]) => bind(sql, params),
      }),
      batch: async (statements: ReturnType<typeof bind>[]) =>
        sqlite.transaction(() =>
          statements.map((statement) => statement.execute()),
        )(),
    },
    APP_ORIGIN: "https://oneapp.example",
    AUTH_SECRET: "x".repeat(43),
    MCP_OAUTH_SECRET: "y".repeat(43),
    AUTH_LIMIT: { limit: async () => ({ success: true }) },
    ACCOUNT_EMAIL_LIMIT: { limit: async () => ({ success: true }) },
    CLI_LOGIN_LIMIT: { limit: async () => ({ success: true }) },
    EMAIL_FROM: "accounts@oneapp.example",
    ASSETS: { fetch: async () => new Response("<html></html>") },
    ACCOUNT_EMAIL: {
      send: async (message: { from: string; to: string; text: string }) => {
        if (!emailAvailable) throw new Error("Email unavailable");
        messages.push(message);
      },
    },
  } as unknown as WorkerEnv;
  const provision = (config: Record<string, string>) =>
    Effect.runPromise(
      ensureOwner(env.DB).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(config),
        ),
      ),
    );
  await provision({
    OWNER_EMAIL: email,
    OWNER_PASSWORD: password,
    AUTH_SECRET: env.AUTH_SECRET,
  });

  const request = (path: string, init: RequestInit) =>
    worker.fetch(new Request(new URL(path, env.APP_ORIGIN), init), env, {
      waitUntil: (work) => deliveries.push(work),
    });
  const call = (
    path: string,
    body?: object,
    cookie?: string,
    origin = env.APP_ORIGIN,
  ) =>
    request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "x-effect-auth-csrf": "1",
        origin,
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const signIn = (candidate: string, address = email) =>
    call("/api/auth/signIn", {
      payload: { email: address, password: candidate },
    });
  const cookies = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((header) => header.split(";")[0])
      .join("; ");

  await ensureDefaultMailbox(
    env.DB,
    env.INBOX_EMAIL_ADDRESS,
    env.INBOX_EMAIL_FROM,
    env.MAILBOX_ALIASES,
  );
  return {
    env,
    call,
    db: mailDatabase(env.DB, "personal"),
    request,
    objects,
    finishWork: () => Promise.all(deliveries),
    loseStoredFileResponse: () => {
      dropStoredFileResponse = true;
    },
    signIn,
    cookies,
    messages,
    from: env.EMAIL_FROM,
    provision,
    awaitDeliveries: () => Promise.all(deliveries.splice(0)),
    setEmailAvailable: (available: boolean) => {
      emailAvailable = available;
    },
  };
};

it("renames shared tags and cascades deletion through tasks and files", async () => {
  using sqlite = new Database(":memory:");
  const published: Array<{ change: string; tasks: number; files: number }> = [];
  let dropNotification = false;
  const { env, call, request, signIn, cookies } = await setup(sqlite, {
    INBOX_UPDATES: {
      getByName: () => ({
        publish: async (change: string) => {
          if (dropNotification) return;
          const versions = sqlite
            .query<{ tasks: number; files: number }, []>(
              `
            SELECT (SELECT version FROM task_changes) AS tasks,
                   (SELECT version FROM file_changes) AS files
          `,
            )
            .get()!;
          published.push({ change, ...versions });
        },
      }),
    } as unknown as WorkerEnv["INBOX_UPDATES"],
    FILE_UPLOADS: {
      put: async (_key: string, bytes: ArrayBuffer) => ({
        size: bytes.byteLength,
      }),
    } as unknown as WorkerEnv["FILE_UPLOADS"],
  });
  const cookie = cookies(await signIn(password));
  const headers = { cookie, origin: env.APP_ORIGIN, "x-effect-auth-csrf": "1" };
  const write = (path: string, method: "PUT" | "DELETE", body?: unknown) =>
    request(path, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const createTag = async (name: string) =>
    Schema.decodeUnknownSync(Tag)(
      await (await call(tagsApi, { name }, cookie)).json(),
    );
  const list = async () => (await call(tagsApi, undefined, cookie)).json();
  const read = (path: string, since: number) =>
    request(`${path}?since=${since}`, { headers: { cookie } });
  expect((await request(tagsApi, {})).status).toBe(401);
  expect(await list()).toEqual([]);
  expect((await read(filesApi, 0)).status).toBe(204);
  const receipts = await createTag("Receipts");
  const review = await createTag("Review");
  expect(await createTag("receipts")).toEqual(receipts);
  expect(published.map(({ change }) => change)).toEqual([
    tagsChanged,
    tagsChanged,
  ]);
  expect(await list()).toEqual([receipts, review]);

  const tagIds = [receipts.id, review.id].sort();
  const taskId = crypto.randomUUID();
  expect(
    (
      await call(
        tasksApi,
        { id: taskId, title: "Review receipts", tagIds },
        cookie,
      )
    ).status,
  ).toBe(201);
  const upload = await request(filesApi, {
    method: "POST",
    headers: {
      ...headers,
      [fileNameHeader]: "receipts.txt",
      "content-type": "text/plain",
    },
    body: new TextEncoder().encode("Receipts"),
  });
  expect(upload.status).toBe(201);
  const uploaded = Schema.decodeUnknownSync(StoredFile)(await upload.json());
  const filePath = fileApi(uploaded.id);
  expect(
    (await write(filePath, "PUT", { revision: uploaded.revision, tagIds }))
      .status,
  ).toBe(200);
  expect(published.slice(-2)).toEqual([
    { change: filesChanged, tasks: 3, files: 3 },
    { change: filesChanged, tasks: 3, files: 4 },
  ]);
  expect(
    (await write(filePath, "PUT", { revision: uploaded.revision, tagIds: [] }))
      .status,
  ).toBe(409);
  expect((await read(filesApi, 4)).status).toBe(204);

  const receiptPath = tagApi(receipts.id);
  expect(
    (await write(receiptPath, "PUT", { name: "Ｒｅｖｉｅｗ" })).status,
  ).toBe(409);
  expect(
    (
      await request(receiptPath, {
        method: "DELETE",
        headers: { cookie, origin: env.APP_ORIGIN },
      })
    ).status,
  ).toBe(403);
  const updated = await write(receiptPath, "PUT", { name: "Expenses" });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toEqual({ ...receipts, name: "Expenses" });
  expect(published.at(-1)).toEqual({ change: tagsChanged, tasks: 4, files: 5 });
  expect(await list()).toEqual([{ ...receipts, name: "Expenses" }, review]);
  const file = async () =>
    (await request(filePath, { headers: { cookie } })).json();
  const tasks = async () => (await call(tasksApi, undefined, cookie)).json();
  expect(await tasks()).toMatchObject({ tasks: [{ id: taskId, tagIds }] });
  expect(await file()).toMatchObject({ id: uploaded.id, tagIds });

  sqlite
    .query(
      "INSERT INTO accounts (id, active, security_revision) VALUES ('other', 1, ?)",
    )
    .run(crypto.randomUUID());
  const foreignTagId = crypto.randomUUID();
  sqlite
    .query(
      "INSERT INTO tags (account_id, id, name, name_key) VALUES ('other', ?, 'Foreign', 'foreign')",
    )
    .run(foreignTagId);
  expect(
    (await write(tagApi(foreignTagId), "PUT", { name: "Renamed" })).status,
  ).toBe(404);
  expect((await write(tagApi(foreignTagId), "DELETE")).status).toBe(404);

  expect((await read(tasksApi, 4)).status).toBe(204);
  expect((await read(filesApi, 5)).status).toBe(204);
  const delivered = published.length;
  dropNotification = true;
  expect((await write(receiptPath, "DELETE")).status).toBe(204);
  dropNotification = false;
  expect((await write(receiptPath, "DELETE")).status).toBe(404);
  expect(published).toHaveLength(delivered);
  expect(await (await read(tasksApi, 4)).json()).toMatchObject({
    version: 5,
    tags: [review],
    tasks: [{ id: taskId, tagIds: [review.id] }],
  });
  expect(await (await read(filesApi, 5)).json()).toMatchObject({
    version: 6,
    tags: [review],
    files: [{ id: uploaded.id, tagIds: [review.id] }],
  });
  expect(await list()).toEqual([review]);
  expect(await tasks()).toMatchObject({
    tasks: [{ id: taskId, tagIds: [review.id] }],
  });
  expect(await file()).toMatchObject({ id: uploaded.id, tagIds: [review.id] });
});

it("requires session ownership for uploaded file metadata, previews and downloads", async () => {
  using sqlite = new Database(":memory:");
  const objects = new Map<string, ArrayBuffer>();
  const reads: string[] = [];
  const { env, request, signIn, cookies } = await setup(sqlite, {
    FILE_UPLOADS: {
      put: async (key: string, bytes: ArrayBuffer) => {
        objects.set(key, bytes);
        return { size: bytes.byteLength };
      },
      get: async (key: string) => {
        reads.push(key);
        const bytes = objects.get(key);
        return bytes
          ? { size: bytes.byteLength, body: new Response(bytes).body }
          : null;
      },
    } as unknown as WorkerEnv["FILE_UPLOADS"],
  });
  const cookie = cookies(await signIn(password));
  const name = 'Résumé "draft".png';
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const upload = await request(filesApi, {
    method: "POST",
    headers: {
      cookie,
      origin: env.APP_ORIGIN,
      "x-effect-auth-csrf": "1",
      [fileNameHeader]: encodeURIComponent(name),
      "content-type": "image/png",
    },
    body: bytes,
  });
  expect(upload.status).toBe(201);
  const file = Schema.decodeUnknownSync(StoredFile)(await upload.json());
  expect(file).toMatchObject({
    name,
    size: bytes.length,
    previewType: "image/png",
  });
  expect([...objects.keys()]).toEqual([`owner/${file.id}`]);

  const foreign = crypto.randomUUID();
  sqlite
    .query(
      "INSERT INTO accounts (id, active, security_revision) VALUES ('other', 1, ?)",
    )
    .run(crypto.randomUUID());
  sqlite
    .query(
      "INSERT INTO items (account_id, id, kind, title, revision, created_at, updated_at) VALUES ('other', ?, 'file', 'private.png', ?, 1, 1)",
    )
    .run(foreign, crypto.randomUUID());
  sqlite
    .query(
      "INSERT INTO files (account_id, item_id, media_type, size, preview_type) VALUES ('other', ?, 'image/png', 8, 'image/png')",
    )
    .run(foreign);
  objects.set(`other/${foreign}`, bytes.buffer);

  for (const path of [
    fileApi(file.id),
    fileContentApi(file.id, "preview"),
    fileContentApi(file.id, "download"),
  ])
    expect((await request(path, {})).status).toBe(401);
  for (const path of [
    fileApi(foreign),
    fileContentApi(foreign, "preview"),
    fileContentApi(foreign, "download"),
  ])
    expect((await request(path, { headers: { cookie } })).status).toBe(404);
  expect(reads).toEqual([]);

  const index = await request(filesApi, { headers: { cookie } });
  expect(Schema.decodeUnknownSync(FileIndex)(await index.json()).files).toEqual(
    [file],
  );
  const preview = await request(fileContentApi(file.id, "preview"), {
    headers: { cookie },
  });
  expect(preview.headers.get("content-type")).toBe("image/png");
  expect(preview.headers.get("cache-control")).toBe("no-store");
  expect(new Uint8Array(await preview.arrayBuffer())).toEqual(bytes);

  const download = await request(fileContentApi(file.id, "download"), {
    headers: { cookie },
  });
  expect(download.headers.get("content-type")).toBe("application/octet-stream");
  expect(download.headers.get("content-disposition")).toContain(
    "filename*=UTF-8''R%C3%A9sum%C3%A9%20%22draft%22.png",
  );
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
});

it("imports a 2 MiB calendar with an older recurring event", async () => {
  using sqlite = new Database(":memory:");
  const { call, signIn, cookies } = await setup(sqlite);
  const session = cookies(await signIn(password));
  const entries = Array.from({ length: 1000 }, (_, index) =>
    [
      "BEGIN:VEVENT",
      `UID:import-limit-${index}`,
      "DTSTAMP:20260101T000000Z",
      index === 0 ? "DTSTART:20150321T003000Z" : "DTSTART:20260101T000000Z",
      ...(index === 0 ? ["RRULE:FREQ=YEARLY"] : []),
      "DESCRIPTION:",
    ].join("\r\n"),
  );
  const render = (description: (index: number) => string) =>
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      ...entries.map(
        (entry, index) => `${entry}${description(index)}\r\nEND:VEVENT`,
      ),
      "END:VCALENDAR",
      "",
    ].join("\r\n");
  const padding = calendarImportLimit - render(() => "").length;
  const descriptionLength = Math.floor(padding / entries.length);
  const remainder = padding % entries.length;
  const ics = render((index) =>
    '"'.repeat(descriptionLength + Number(index < remainder)),
  );
  expect(ics.length).toBe(2 * 1024 * 1024);
  expect(JSON.stringify({ ics }).length).toBeGreaterThan(calendarImportLimit);

  const report = {
    total: entries.length,
    available: entries.length,
    existing: 0,
    imported: 0,
    warnings: [],
  };
  const preview = await call(`${calendarApi}/import/preview`, { ics }, session);
  expect(preview.status).toBe(200);
  expect(await preview.json()).toEqual(report);

  const imported = await call(`${calendarApi}/import`, { ics }, session);
  expect(imported.status).toBe(200);
  expect(await imported.json()).toEqual({
    ...report,
    imported: entries.length,
  });
  const saved = sqlite
    .query<{ ics: string }, [string]>(
      "SELECT ics FROM calendar_events WHERE uid = ?",
    )
    .get("import-limit-0");
  expect(saved?.ics).toContain("DTSTART:20150321T003000Z");
  expect(saved?.ics).toContain("RRULE:FREQ=YEARLY");

  const oversized = await call(
    `${calendarApi}/import/preview`,
    { ics: `${ics}\n` },
    session,
  );
  expect(oversized.status).toBe(400);
  expect(await oversized.json()).toMatchObject({
    error: "Choose an .ics file up to 2 MiB.",
  });
});

it("shares private people profiles across aliases and keeps account addresses linked to the owner", async () => {
  using sqlite = new Database(":memory:");
  const mailbox = "mail@app.example.net";
  const photos = new Map<string, Uint8Array<ArrayBuffer>>();
  const { call, request, signIn, cookies, finishWork } = await setup(sqlite, {
    INBOX_EMAIL_ADDRESS: mailbox,
    PROFILE_PHOTOS: {
      put: async (key: string, bytes: Uint8Array<ArrayBuffer>) =>
        photos.set(key, bytes),
      get: async (key: string) => {
        const bytes = photos.get(key);
        return bytes ? { body: new Response(bytes).body } : null;
      },
      delete: async (key: string) => void photos.delete(key),
    } as unknown as WorkerEnv["PROFILE_PHOTOS"],
  });
  const session = cookies(await signIn(password));
  const lookup = async (address: string): Promise<Person | null> => {
    const response = await call(personLookupPath(address), undefined, session);
    expect(response.status).toBe(200);
    return (await response.json()).person;
  };
  const save = (profile: Person, draft: object) =>
    request(personApiPath(profile.id), {
      method: "PUT",
      headers: {
        cookie: session,
        origin: "https://oneapp.example",
        "content-type": "application/json",
        "x-effect-auth-csrf": "1",
      },
      body: JSON.stringify({ revision: profile.revision, ...draft }),
    });

  expect((await call(selfProfilePath)).status).toBe(401);
  expect((await call(peopleApiPath)).status).toBe(401);
  expect((await call(personLookupPath(mailbox))).status).toBe(401);
  const list = async () => {
    const response = await call(peopleApiPath, undefined, session);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return (await response.json()).people as Person[];
  };
  const [self] = await list();
  if (!self)
    throw new Error("The directory did not include the account profile");
  expect(await list()).toEqual([self]);
  expect(
    await (await call(selfProfilePath, undefined, session)).json(),
  ).toEqual(self);
  expect(self).toMatchObject({
    self: true,
    addresses: [],
    managedAddresses: [mailbox],
  });
  expect(await lookup(mailbox.toUpperCase())).toEqual(self);
  expect(await lookup(email)).toBeNull();

  sqlite
    .query("UPDATE oneapp_auth_identifiers SET verified_at = ? WHERE value = ?")
    .run(Date.now(), email);
  expect(await lookup(email)).toMatchObject({
    id: self.id,
    managedAddresses: [mailbox, email],
  });
  expect(
    (await call(peopleApiPath, { name: "", addresses: [mailbox] }, session))
      .status,
  ).toBe(409);
  const updatedSelf = await save(self, {
    name: "Owner",
    addresses: ["ALIAS@example.net"],
  });
  expect(updatedSelf.status).toBe(200);
  expect(await lookup("alias@example.net")).toMatchObject({
    id: self.id,
    name: "Owner",
    self: true,
  });

  const addresses = ["lena@example.net", "LENA@alt.example.net"] as const;
  const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xd9]);
  const create = await call(
    peopleApiPath,
    { name: "Lena", addresses, photo: photo.toBase64() },
    session,
  );
  expect(create.status).toBe(201);
  const person: Person = await create.json();
  expect(await lookup(addresses[1])).toEqual(person);
  const directory = await list();
  expect(directory).toHaveLength(2);
  expect(directory).toEqual(
    expect.arrayContaining([
      person,
      {
        ...(await updatedSelf.json()),
        managedAddresses: [mailbox, email],
      },
    ]),
  );
  expect(
    (await call(`${peopleApiPath}?email=`, undefined, session)).status,
  ).toBe(400);
  const photoPath = personPhotoPath(person.id, person.photo!);
  expect((await call(photoPath)).status).toBe(401);
  const image = await call(photoPath, undefined, session);
  expect(image.headers.get("content-type")).toBe("image/jpeg");
  expect(image.headers.get("cache-control")).toBe("no-store");
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(photo);

  expect(
    (await save(person, { name: "Changed", addresses: ["alias@example.net"] }))
      .status,
  ).toBe(409);
  expect(await lookup(addresses[0])).toEqual(person);
  expect(
    (await save(person, { name: person.name, addresses, photo: "YQ==" }))
      .status,
  ).toBe(400);
  expect(
    (await save(person, { name: person.name, addresses, photo: null })).status,
  ).toBe(200);
  expect((await save(person, { name: "Stale", addresses })).status).toBe(409);
  expect((await call(photoPath, undefined, session)).status).toBe(404);
  await finishWork();
  expect(photos.size).toBe(0);
});

it("deletes contacts immediately and restores their details with Undo", async () => {
  using sqlite = new Database(":memory:");
  const photos = new Set<string>();
  const { call, request, signIn, cookies, env } = await setup(sqlite, {
    PROFILE_PHOTOS: {
      put: async (key: string) => photos.add(key),
      delete: async (key: string) => void photos.delete(key),
    } as unknown as WorkerEnv["PROFILE_PHOTOS"],
  });
  const session = cookies(await signIn(password));
  const write = (
    path: string,
    method: "DELETE" | "POST",
    options: { body?: object; signedIn?: boolean; csrf?: boolean } = {},
  ) =>
    request(path, {
      method,
      headers: {
        origin: env.APP_ORIGIN,
        ...(options.signedIn !== false ? { cookie: session } : {}),
        ...(options.csrf !== false ? { "x-effect-auth-csrf": "1" } : {}),
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
  const remove = (person: Person) =>
    write(personApiPath(person.id), "DELETE", {
      body: { revision: person.revision },
    });
  const list = async (): Promise<Person[]> =>
    (await (await call(peopleApiPath, undefined, session)).json()).people;
  const lookup = async (address: string): Promise<Person | null> =>
    (await (await call(personLookupPath(address), undefined, session)).json())
      .person;
  const [self] = await list();
  expect((await remove(self!)).status).toBe(403);

  const domains = ["example.com.au", "example.com"];
  const address = "support@example.net";
  const create = await call(
    peopleApiPath,
    {
      name: "Example Co",
      kind: "company",
      domains,
      addresses: [address],
      photo: new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xd9]).toBase64(),
    },
    session,
  );
  expect(create.status).toBe(201);
  const company: Person = await create.json();
  const body = { revision: company.revision };
  expect(
    (
      await write(personApiPath(company.id), "DELETE", {
        body,
        signedIn: false,
      })
    ).status,
  ).toBe(401);
  expect(
    (await write(personApiPath(company.id), "DELETE", { body, csrf: false }))
      .status,
  ).toBe(403);
  expect(
    (await remove({ ...company, revision: crypto.randomUUID() })).status,
  ).toBe(409);

  const deleted = await remove(company);
  expect(deleted.status).toBe(200);
  const { receipt } = await deleted.json();
  const restore = restoreContactPath(receipt);
  expect(await (await remove(company)).json()).toEqual({ receipt });
  expect(await list()).toEqual([self]);
  expect(await lookup(address)).toBeNull();
  expect(await lookup("orders@mailer.example.com.au")).toBeNull();
  expect(photos.has(company.photo!)).toBe(true);
  expect(
    (
      await call(
        personPhotoPath(company.id, company.photo!),
        undefined,
        session,
      )
    ).status,
  ).toBe(404);
  expect((await write(restore, "POST", { signedIn: false })).status).toBe(401);
  expect((await write(restore, "POST", { csrf: false })).status).toBe(403);

  const replacement = await call(
    peopleApiPath,
    {
      kind: "company",
      name: "Replacement",
      domains: [domains[1]],
      addresses: [],
    },
    session,
  );
  expect(replacement.status).toBe(201);
  const replacementPerson: Person = await replacement.json();
  expect((await write(restore, "POST")).status).toBe(409);
  expect((await list()).map(({ id }) => id)).not.toContain(company.id);
  expect(await lookup(address)).toBeNull();
  expect((await remove(replacementPerson)).status).toBe(200);

  const restored = await write(restore, "POST");
  expect(restored.status).toBe(200);
  const person: Person = await restored.json();
  expect(person).toEqual({ ...company, revision: expect.any(String) });
  expect(person.revision).not.toBe(company.revision);
  expect(await lookup(address)).toEqual(person);
  expect(await lookup("orders@mailer.example.com.au")).toEqual(person);
  expect(await lookup("orders@example.com")).toEqual(person);
  expect((await remove(company)).status).toBe(409);

  const deletedAgain = await remove(person);
  expect(deletedAgain.status).toBe(200);
  const second = restoreContactPath((await deletedAgain.json()).receipt);
  expect((await write(restore, "POST")).status).toBe(404);
  sqlite.query("UPDATE contact_deletions SET expires_at = 0").run();
  expect((await write(second, "POST")).status).toBe(404);
  await collectDeletedContacts(env);
  expect(photos.size).toBe(0);
  expect(sqlite.query("SELECT id FROM contact_deletions").all()).toEqual([]);
});

it("saves per-address Noise overrides with contacts in the personal mailbox", async () => {
  using sqlite = new Database(":memory:");
  const { call, db, request, signIn, cookies } = await setup(sqlite);
  const session = cookies(await signIn(password));
  const updates = "updates@example.net";
  const billing = "billing@example.net";
  await setSenderRule(db, { address: billing, priority: "signal" });
  sqlite.exec(`INSERT INTO mailboxes (id, owner_account_id, name)
    SELECT 'work', owner_account_id, 'Work' FROM mailboxes WHERE id = 'personal'`);
  await setSenderRule(mailDatabase(db, "work"), {
    address: updates,
    priority: "signal",
  });
  expect((await call(noiseSendersApiPath)).status).toBe(401);

  const create = await call(
    peopleApiPath,
    {
      name: "Example",
      addresses: [billing, updates],
      noiseChanges: [{ address: updates.toUpperCase(), noise: true }],
    },
    session,
  );
  expect(create.status).toBe(201);
  const person: Person = await create.json();
  const noiseSenders = async () => {
    const response = await call(noiseSendersApiPath, undefined, session);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return response.json();
  };
  expect(await noiseSenders()).toEqual({ addresses: [updates] });
  const save = (revision: string, noiseChanges: object[]) =>
    request(personApiPath(person.id), {
      method: "PUT",
      headers: {
        cookie: session,
        origin: "https://oneapp.example",
        "content-type": "application/json",
        "x-effect-auth-csrf": "1",
      },
      body: JSON.stringify({
        revision,
        name: person.name,
        addresses: person.addresses,
        noiseChanges,
      }),
    });
  expect(
    (
      await save(person.revision, [
        { address: "other@example.net", noise: true },
      ])
    ).status,
  ).toBe(400);
  const cleared = await save(person.revision, [
    { address: updates, noise: false },
  ]);
  expect(cleared.status).toBe(200);
  expect(await noiseSenders()).toEqual({ addresses: [] });
  expect(
    (await save(person.revision, [{ address: updates, noise: true }])).status,
  ).toBe(409);
  expect(
    sqlite
      .query(
        "SELECT mailbox_id, address, priority FROM mail_sender_rules ORDER BY mailbox_id, address",
      )
      .all(),
  ).toEqual([
    { mailbox_id: "personal", address: billing, priority: "signal" },
    { mailbox_id: "work", address: updates, priority: "signal" },
  ]);
});

it("stores company aliases and resolves contact lookup across assigned domains", async () => {
  using sqlite = new Database(":memory:");
  const { call, request, signIn, cookies } = await setup(sqlite);
  const session = cookies(await signIn(password));
  const create = (draft: object) => call(peopleApiPath, draft, session);
  const lookup = async (address: string) =>
    (await call(personLookupPath(address), undefined, session)).json();
  const save = (profile: Person, draft: object) =>
    request(personApiPath(profile.id), {
      method: "PUT",
      headers: {
        cookie: session,
        origin: "https://oneapp.example",
        "content-type": "application/json",
        "x-effect-auth-csrf": "1",
      },
      body: JSON.stringify({ revision: profile.revision, ...draft }),
    });
  const created = await create({
    kind: "company",
    name: "Acme",
    addresses: [],
    domains: ["ACME.COM.", "acme.com", "ACME.CO.UK"],
  });
  expect(created.status).toBe(201);
  let company: Person = await created.json();
  expect(company).toMatchObject({
    kind: "company",
    domains: ["acme.com", "acme.co.uk"],
    iconDomain: "acme.com",
    addresses: [],
  });
  expect(await lookup("accounts@acme.com")).toEqual({ person: company });
  expect(await lookup("press@news.acme.co.uk")).toEqual({ person: company });
  expect(await lookup("accounts@notacme.com")).toEqual({ person: null });
  const employeeResponse = await create({
    name: "Alice",
    addresses: ["alice@acme.com"],
  });
  expect(employeeResponse.status).toBe(201);
  const employee: Person = await employeeResponse.json();
  expect(await lookup("alice@acme.com")).toEqual({ person: employee });

  const assigned = await save(company, {
    kind: "company",
    name: company.name,
    addresses: ["ACCOUNTS@acme.com", "news@acme.co.uk"],
  });
  expect(assigned.status).toBe(200);
  const original = company;
  company = await assigned.json();
  expect(company.domains).toEqual(original.domains);
  expect(await lookup("accounts@acme.com")).toMatchObject({ person: company });
  expect(await lookup("news@acme.co.uk")).toMatchObject({ person: company });
  expect(
    (
      await save(original, {
        name: "Stale",
        addresses: [],
        domains: ["stale.com"],
      })
    ).status,
  ).toBe(409);

  expect(
    (
      await save(company, {
        name: "Conflicting alias",
        addresses: ["alice@acme.com"],
        domains: ["changed.com"],
      })
    ).status,
  ).toBe(409);
  expect(await lookup("accounts@acme.com")).toMatchObject({ person: company });
  expect(await lookup("new@acme.com")).toEqual({ person: company });
  expect(
    (
      await create({
        kind: "company",
        name: "Duplicate",
        addresses: ["new@other.com"],
        domains: ["acme.com"],
      })
    ).status,
  ).toBe(409);
  expect((await lookup("new@other.com")).person).toBeNull();
  expect(
    (
      await create({
        kind: "company",
        name: "Invalid",
        addresses: [],
        domains: ["co.uk"],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await create({
        kind: "company",
        name: "",
        addresses: [],
        domains: ["other.com"],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await create({
        kind: "person",
        name: "Person",
        addresses: ["person@other.com"],
        domains: ["other.com"],
      })
    ).status,
  ).toBe(400);
  const self: Person = await (
    await call(selfProfilePath, undefined, session)
  ).json();
  expect(
    (
      await save(self, {
        kind: "company",
        name: "Owner",
        addresses: [],
        domains: ["other.com"],
      })
    ).status,
  ).toBe(400);
  const companies = await (
    await call(`${peopleApiPath}?kind=company`, undefined, session)
  ).json();
  expect(companies.people).toEqual([company]);

  const converted = await save(company, {
    kind: "person",
    name: "Acme contact",
    addresses: company.addresses,
  });
  expect(converted.status).toBe(200);
  expect((await converted.json()).kind ?? "person").toBe("person");
  expect(await lookup("new@acme.com")).toEqual({ person: null });
  expect(
    (
      await create({
        kind: "company",
        name: "New Acme",
        addresses: [],
        domains: ["acme.com"],
      })
    ).status,
  ).toBe(201);
});

it("resolves mail profiles by exact address and the most specific assigned company domain", async () => {
  using sqlite = new Database(":memory:");
  const mailbox = "mail@billing.acme.com";
  const empty = { list: async () => ({ objects: [], truncated: false }) };
  const { call, db, signIn, cookies } = await setup(sqlite, {
    INBOX_EMAIL_ADDRESS: mailbox,
    INBOX_MESSAGES: {
      ...empty,
      get: async () => null,
    } as unknown as WorkerEnv["INBOX_MESSAGES"],
    SENT_MESSAGES: empty as unknown as WorkerEnv["SENT_MESSAGES"],
  });
  const session = cookies(await signIn(password));
  const company = await call(
    peopleApiPath,
    {
      kind: "company",
      name: "Acme",
      addresses: [],
      domains: ["acme.com", "acme.co.uk"],
    },
    session,
  );
  expect(company.status).toBe(201);
  const billing = await call(
    peopleApiPath,
    {
      kind: "company",
      name: "Acme Billing",
      addresses: [],
      domains: ["acmebilling.net", "billing.acme.com"],
    },
    session,
  );
  expect(billing.status).toBe(201);
  const employee = await call(
    peopleApiPath,
    {
      name: "Alice",
      addresses: ["alice@billing.acme.com"],
    },
    session,
  );
  expect(employee.status).toBe(201);

  const addresses = [
    "orders@acme.com",
    "support@eu.acme.com",
    "accounts@eu.billing.acme.com",
    "ALICE@BILLING.ACME.COM",
    mailbox,
    "press@acme.co.uk",
    "press@news.acme.co.uk",
    "orders@notacme.com",
    "orders@acme.com.evil.net",
  ];
  const members = addresses.map((address) => ({ address, name: "" }));
  const id = "0-8199999999990-00000000-0000-4000-8000-000000000000.eml";
  await indexMail(db, {
    id,
    folder: "inbox",
    from: addresses[0]!,
    to: mailbox,
    subject: "An update",
    timestamp: 1000,
    messageIds: [],
    people: { sender: members[0]!, members },
  });
  const response = await call(conversationApi(id), undefined, session);
  expect(response.status).toBe(200);
  const { profiles } = (await response.json()) as {
    profiles: { email: string; person: { name: string; self: boolean } }[];
  };
  expect(
    Object.fromEntries(
      profiles.map(({ email, person }) => [
        email,
        person.self ? "self" : person.name,
      ]),
    ),
  ).toEqual({
    "orders@acme.com": "Acme",
    "support@eu.acme.com": "Acme",
    "accounts@eu.billing.acme.com": "Acme Billing",
    "alice@billing.acme.com": "Alice",
    "press@acme.co.uk": "Acme",
    "press@news.acme.co.uk": "Acme",
    [mailbox]: "self",
  });
});

it("lets only the owner send plain-text mail from the configured Inbox address", async () => {
  using sqlite = new Database(":memory:");
  const from = "mail@app.example.net";
  const send = vi.fn(async (_message: EmailMessageBuilder) => ({
    messageId: "fixture-mail",
  }));
  const stored = new Map<
    string,
    { key: string; value: string; customMetadata: Record<string, string> }
  >();
  const save = async (
    key: string,
    value: string,
    options: { customMetadata: Record<string, string> },
  ) => {
    const object = { key, value, customMetadata: options.customMetadata };
    stored.set(key, object);
    return object;
  };
  const put = vi.fn(save);
  const limit = vi.fn(async (_input: { key: string }) => ({ success: true }));
  const { call, request, signIn, cookies } = await setup(sqlite, {
    INBOX_EMAIL_ADDRESS: from,
    INBOX_EMAIL_FROM: from,
    INBOX_SEND: { send } as SendEmail,
    INBOX_SEND_LIMIT: { limit },
    INBOX_MESSAGES: {
      list: async () => ({ objects: [], truncated: false }),
    } as WorkerEnv["INBOX_MESSAGES"],
    SENT_MESSAGES: {
      put,
      head: async (id: string) => stored.get(id) ?? null,
      list: async () => ({ objects: [...stored.values()], truncated: false }),
      get: async (id: string) => {
        const object = stored.get(id);
        return object ? { json: async () => JSON.parse(object.value) } : null;
      },
      delete: async (id: string) => void stored.delete(id),
    } as unknown as WorkerEnv["SENT_MESSAGES"],
  });
  const session = cookies(await signIn(password));
  const draft = {
    to: " Alice+Details@Example.NET ",
    subject: " Meeting notes ",
    text: "Hi Alice,\n\nThanks!\n",
  };
  const approved = (input: object = draft) =>
    call(inboxSendPath, input, session);
  expect(
    await (await call(inboxApiPath, undefined, session)).json(),
  ).toMatchObject({ address: from, sender: from });
  expect(
    await (await call(inboxUnreadPath, undefined, session)).json(),
  ).toEqual({ unreadCount: 0, sender: from });
  expect((await call(inboxSendPath, draft)).status).toBe(401);
  expect((await call(sentApiPath)).status).toBe(401);
  expect(
    (await call(inboxSendPath, draft, session, "https://other.example")).status,
  ).toBe(403);
  expect(
    (
      await request(inboxSendPath, {
        method: "POST",
        headers: {
          cookie: session,
          origin: "https://oneapp.example",
          "content-type": "application/json",
        },
        body: JSON.stringify(draft),
      })
    ).status,
  ).toBe(403);
  expect((await approved({ ...draft, from: "other@example.net" })).status).toBe(
    400,
  );
  expect(
    (await approved({ ...draft, to: "bob@example.net,invalid" })).status,
  ).toBe(400);
  expect(
    (await approved({ ...draft, subject: "Hello\r\nBcc: other@example.net" }))
      .status,
  ).toBe(400);
  expect((await approved({ ...draft, text: "  \n" })).status).toBe(400);
  expect(limit).not.toHaveBeenCalled();
  limit.mockResolvedValueOnce({ success: false });
  expect((await approved()).status).toBe(429);
  expect(send).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();

  put.mockImplementationOnce(async (...args) => {
    await save(...args);
    throw new Error("Fixture lost the response to a successful write");
  });
  const accepted = await approved();
  expect(accepted.status).toBe(204);
  expect(accepted.headers.get("cache-control")).toBe("no-store");
  expect(accepted.headers.get(sentCopyHeader)).toBeNull();
  expect(send).toHaveBeenCalledExactlyOnceWith({
    from,
    to: "Alice+Details@Example.NET",
    subject: "Meeting notes",
    text: draft.text,
  });
  expect(put).toHaveBeenCalledTimes(2);
  expect(put.mock.calls[0]).toEqual(put.mock.calls[1]);
  expect(stored.size).toBe(1);
  const [copy] = stored.values();
  if (!copy) throw new Error("Expected an archived copy");
  expect(JSON.parse(copy.value)).toMatchObject({
    id: copy.key,
    text: draft.text,
    providerMessageId: "fixture-mail",
  });
  const sentList = await call(sentApiPath, undefined, session);
  expect(sentList.status).toBe(200);
  expect(sentList.headers.get("cache-control")).toBe("no-store");
  const entrySummary = {
    id: copy.key,
    from,
    to: "Alice+Details@Example.NET",
    subject: "Meeting notes",
    sentAt: expect.any(Number),
  };
  expect(await sentList.json()).toEqual({
    messages: [{ ...entrySummary, bodyPreview: "Hi Alice, Thanks!" }],
    cursor: null,
    address: from,
    sender: from,
  });
  const detail = mailMessageApi("sent", copy.key);
  expect((await call(detail)).status).toBe(401);
  expect(
    (await call(inboxMessageApi(copy.key), undefined, session)).status,
  ).toBe(404);
  expect(await (await call(detail, undefined, session)).json()).toEqual({
    ...entrySummary,
    people: {
      sender: { address: from, name: "" },
      members: [
        { address: from, name: "" },
        { address: "Alice+Details@Example.NET", name: "" },
      ],
    },
    text: draft.text,
    preview: "complete",
  });
  send.mockRejectedValueOnce(
    Object.assign(new Error("Provider details"), {
      code: "E_RECIPIENT_SUPPRESSED",
    }),
  );
  const suppressed = await approved();
  expect(suppressed.status).toBe(422);
  expect(await suppressed.json()).toEqual({
    error: "Cloudflare has suppressed this recipient address.",
  });
  send.mockRejectedValueOnce(new Error("Provider details"));
  const uncertain = await approved();
  expect(uncertain.status).toBe(502);
  expect(await uncertain.json()).toEqual({
    error: "Could not confirm whether the email was sent.",
  });
  expect(send).toHaveBeenCalledTimes(3);
  expect(put).toHaveBeenCalledTimes(2);

  const failure = new Error("Storage unavailable");
  put
    .mockRejectedValueOnce(failure)
    .mockRejectedValueOnce(failure)
    .mockRejectedValueOnce(failure);
  const unsaved = await approved();
  expect(unsaved.status).toBe(204);
  expect(unsaved.headers.get(sentCopyHeader)).toBe("failed");
  expect(send).toHaveBeenCalledTimes(4);
  expect(put).toHaveBeenCalledTimes(5);
  expect(stored.size).toBe(1);

  const remove = (cookie?: string, csrf = false) =>
    request(detail, {
      method: "DELETE",
      headers: {
        origin: "https://oneapp.example",
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { "x-effect-auth-csrf": "1" } : {}),
      },
    });
  expect((await remove()).status).toBe(401);
  expect((await remove(session)).status).toBe(403);
  expect((await remove(session, true)).status).toBe(204);
  expect((await call(detail, undefined, session)).status).toBe(404);
});

it("sanitizes formatted mail before delivery and preserves its Sent copy", async () => {
  using sqlite = new Database(":memory:");
  const send = vi.fn(async (_message: EmailMessageBuilder) => ({
    messageId: "formatted-fixture",
  }));
  const copies = new Map<string, string>();
  const { call, signIn, cookies } = await setup(sqlite, {
    INBOX_EMAIL_ADDRESS: "mail@app.example.net",
    INBOX_EMAIL_FROM: "mail@app.example.net",
    INBOX_SEND: { send } as SendEmail,
    INBOX_SEND_LIMIT: { limit: async () => ({ success: true }) },
    SENT_MESSAGES: {
      put: async (id: string, json: string) => {
        copies.set(id, json);
        return {};
      },
      get: async (id: string) => {
        const json = copies.get(id);
        return json ? { json: async () => JSON.parse(json) } : null;
      },
    } as unknown as WorkerEnv["SENT_MESSAGES"],
  });
  const session = cookies(await signIn(password));
  const draft = {
    to: "person@example.net",
    subject: "Formatted message",
    text: "Mismatched client text",
    html: '<p>Hello <strong>team</strong>!</p><p><a href="https://example.net">Details</a></p><img src="https://tracker.test"><script>evil()</script>',
  };
  for (const html of ["<script>evil()</script>", "x".repeat(131_073)]) {
    expect(
      (await call(inboxSendPath, { ...draft, html }, session)).status,
    ).toBe(400);
  }
  expect(send).not.toHaveBeenCalled();
  const response = await call(inboxSendPath, draft, session);
  expect(response.status).toBe(204);
  const delivered = send.mock.lastCall?.[0];
  expect(delivered?.html).toBe(
    '<p>Hello <strong>team</strong>!</p><p><a href="https://example.net">Details</a></p>',
  );
  expect(delivered?.text).toContain("Hello team!");
  expect(delivered?.text).toContain("https://example.net");
  expect(delivered?.text).not.toContain("Mismatched");
  const id = response.headers.get(sentMessageHeader)!;
  expect(JSON.parse(copies.get(id)!)).toMatchObject({
    text: delivered?.text,
    html: delivered?.html,
  });
  const entry = (await (
    await call(mailMessageApi("sent", id), undefined, session)
  ).json()) as { html: string; text: string };
  expect(entry.text).toBe(delivered?.text);
  expect(entry.html).toContain("<strong>team</strong>");
  expect(entry.html).toContain('target="_blank" rel="noopener noreferrer"');
  expect(entry.html).not.toMatch(/tracker|script|evil/iu);
});

it("threads replies from the stored message and archives the sent copy", async () => {
  using sqlite = new Database(":memory:");
  const from = "mail@app.example.net";
  const originalId = "0-8199999999990-00000000-0000-4000-8000-000000000000.eml";
  const legacyId = "0-8199999999991-00000000-0000-4000-8000-000000000000.eml";
  const messageId = "<parent@example.net>";
  const root = "<root@example.net>";
  const ancestor = "<ancestor@example.net>";
  const encode = (lines: string[]) =>
    new TextEncoder().encode(lines.join("\r\n"));
  const originals = new Map([
    [
      originalId,
      encode([
        "From: Sender <sender@example.net>",
        "Reply-To: Desk <desk@example.net>",
        "Subject: Checking in",
        `Message-ID: ${messageId}`,
        `References: ${root}`,
        ` ${ancestor} ${root}`,
        "",
        "Hello.",
        "",
      ]),
    ],
    [
      legacyId,
      encode([
        "From: Sender <sender@example.net>",
        "Subject: Checking in",
        `In-Reply-To: ${root}`,
        "",
        "Remember me?",
        "",
      ]),
    ],
  ]);
  const get = vi.fn(
    async (key: string, options?: { range: { length: number } }) => {
      const bytes = originals.get(key);
      if (!bytes) return null;
      const body = new Response(bytes.slice(0, options?.range.length));
      return {
        key,
        size: bytes.length,
        uploaded: new Date("2026-11-19T00:15:00.000Z"),
        customMetadata: {
          envelopeFrom: "bounce@example.net",
          envelopeTo: from,
        },
        text: () => body.text(),
        arrayBuffer: () => body.arrayBuffer(),
      };
    },
  );
  const send = vi.fn(async (_message: EmailMessageBuilder) => ({
    messageId: "reply-fixture",
  }));
  const sentCopies = new Map<string, string>();
  const put = vi.fn(async (id: string, json: string) => {
    sentCopies.set(id, json);
    return {};
  });
  const { call, db, signIn, cookies } = await setup(sqlite, {
    INBOX_EMAIL_ADDRESS: from,
    INBOX_EMAIL_FROM: from,
    INBOX_SEND: { send } as SendEmail,
    INBOX_SEND_LIMIT: { limit: async () => ({ success: true }) },
    INBOX_MESSAGES: { get } as unknown as WorkerEnv["INBOX_MESSAGES"],
    SENT_MESSAGES: {
      put,
      get: async (id: string) => {
        const json = sentCopies.get(id);
        return json ? { json: async () => JSON.parse(json) } : null;
      },
    } as unknown as WorkerEnv["SENT_MESSAGES"],
  });
  const incoming = {
    id: originalId,
    folder: "inbox" as const,
    from: "sender@example.net",
    to: from,
    subject: "Checking in",
    timestamp: 1000,
    messageIds: [messageId, root, ancestor],
    unread: true,
  };
  await indexMail(db, incoming);
  const session = cookies(await signIn(password));
  const opened = await call(inboxMessageApi(originalId), undefined, session);
  expect(await opened.json()).toMatchObject({
    reply: { to: "desk@example.net", threaded: true },
  });
  const legacy = await call(inboxMessageApi(legacyId), undefined, session);
  expect(await legacy.json()).toMatchObject({
    reply: { to: "sender@example.net", threaded: false },
  });
  const draft = {
    to: "desk@example.net",
    subject: "Re: Checking in",
    text: "Thanks!\n\n> Hello.",
  };
  const reply = { ...draft, replyToId: originalId };
  expect((await call(inboxSendPath, reply)).status).toBe(401);
  expect(
    (
      await call(
        inboxSendPath,
        { ...reply, headers: { "In-Reply-To": "<forged@example.net>" } },
        session,
      )
    ).status,
  ).toBe(400);
  const missingId = originalId.replace("8199999999990", "8199999999999");
  expect(
    (await call(inboxSendPath, { ...reply, replyToId: missingId }, session))
      .status,
  ).toBe(404);
  expect(send).not.toHaveBeenCalled();

  const accepted = await call(inboxSendPath, reply, session);
  expect(accepted.status).toBe(204);
  expect(accepted.headers.get(replyCompletionHeader)).toBe("done");
  expect(get).toHaveBeenLastCalledWith(originalId, {
    range: { offset: 0, length: 256 * 1024 },
  });
  expect(
    await (await call(conversationApi(originalId), undefined, session)).json(),
  ).toMatchObject({ archived: true });
  const headers = {
    "In-Reply-To": messageId,
    References: `${root} ${ancestor} ${messageId}`,
  };
  expect(send).toHaveBeenCalledExactlyOnceWith({ ...draft, from, headers });
  const [key, record] = put.mock.lastCall ?? [];
  if (!key || !record) throw new Error("Expected a Sent copy");
  expect(accepted.headers.get(sentMessageHeader)).toBe(key);
  expect(JSON.parse(record)).toMatchObject({
    ...draft,
    id: key,
    from,
    providerMessageId: "reply-fixture",
    reply: { originalId, headers },
  });

  const legacyDraft = { ...draft, to: "sender@example.net" };
  expect(
    (
      await call(
        inboxSendPath,
        { ...legacyDraft, replyToId: legacyId },
        session,
      )
    ).status,
  ).toBe(204);
  expect(send).toHaveBeenLastCalledWith({
    ...legacyDraft,
    from,
    headers: { References: root },
  });

  const quick = {
    text: "Quick follow-up",
    html: "<p>Quick <strong>follow-up</strong></p>",
  };
  const inlinePath = inboxReplyApi(originalId);
  expect((await call(inlinePath, quick)).status).toBe(401);
  expect(
    (await call(inlinePath, quick, session, "https://untrusted.example"))
      .status,
  ).toBe(403);
  expect((await call(inlinePath, { text: " " }, session)).status).toBe(400);
  expect(
    (await call(inlinePath, { ...quick, to: "forged@example.net" }, session))
      .status,
  ).toBe(400);
  expect((await call(inboxReplyApi(missingId), quick, session)).status).toBe(
    404,
  );
  expect(send).toHaveBeenCalledTimes(2);

  const sentMessageId = "<quick-sent@example.net>";
  send.mockResolvedValueOnce({ messageId: sentMessageId });
  const quickSend = await call(inlinePath, quick, session);
  expect(quickSend.status).toBe(204);
  expect(quickSend.headers.get(replyCompletionHeader)).toBe("done");
  expect(send).toHaveBeenLastCalledWith({
    from,
    to: draft.to,
    subject: draft.subject,
    text: quick.text,
    html: quick.html,
    headers,
  });
  const [sentId] = put.mock.lastCall ?? [];
  if (!sentId) throw new Error("Expected a quick reply in Sent");
  const newIncoming = originalId.replace("8199999999990", "8199999999998");
  send.mockImplementationOnce(async () => {
    await indexMail(
      db,
      {
        ...incoming,
        id: newIncoming,
        timestamp: 2000,
      },
      { reopensArchive: true },
    );
    return { messageId: "<followup@example.net>" };
  });
  const followUp = await call(
    inboxReplyApi(sentId),
    {
      text: "One more thing",
      completeThrough: originalId,
    },
    session,
  );
  expect(followUp.status).toBe(204);
  expect(followUp.headers.get(replyCompletionHeader)).toBe("new-mail");
  expect(send).toHaveBeenLastCalledWith({
    from,
    to: draft.to,
    subject: draft.subject,
    text: "One more thing",
    headers: {
      "In-Reply-To": sentMessageId,
      References: headers.References + " " + sentMessageId,
    },
  });
  const [, sentReply] = put.mock.lastCall ?? [];
  expect(JSON.parse(sentReply ?? "{}")).toMatchObject({
    text: "One more thing",
    reply: { originalId: sentId },
  });
  const latestReply = { text: "Following up", completeThrough: newIncoming };
  send.mockRejectedValueOnce({ code: "E_DELIVERY_FAILED" });
  expect((await call(inboxReplyApi(sentId), latestReply, session)).status).toBe(
    422,
  );
  expect(
    await (await call(conversationApi(originalId), undefined, session)).json(),
  ).toMatchObject({ archived: false });
  put.mockRejectedValue(new Error("Sent storage unavailable"));
  const sentWithoutCopy = await call(
    inboxReplyApi(sentId),
    latestReply,
    session,
  );
  expect(sentWithoutCopy.status).toBe(204);
  expect(sentWithoutCopy.headers.get(sentCopyHeader)).toBe("failed");
  expect(sentWithoutCopy.headers.get(replyCompletionHeader)).toBe("done");
});

it("classifies the latest incoming message and applies exact sender overrides before pagination", async () => {
  using sqlite = new Database(":memory:");
  const address = "mail@app.example.net";
  const mailId = (n: number) =>
    `0-8199999999990-00000000-0000-4000-8000-${String(n).padStart(12, "0")}.eml`;
  const newsletter = {
    key: mailId(0),
    uploaded: new Date(1000),
    customMetadata: { envelopeFrom: "bounce@example.net", envelopeTo: address },
    text: async () =>
      [
        "From: Newsletter <News@Example.net>",
        `To: ${address}`,
        "Subject: Monthly newsletter",
        "Message-ID: <monthly@example.net>",
        "List-Id: Monthly <monthly.lists.example.net>",
        "",
        "News for this month.",
      ].join("\r\n"),
    size: 1024,
  };
  const empty = async () => ({ objects: [], truncated: false });
  const { call, db, request, signIn, cookies } = await setup(sqlite, {
    INBOX_EMAIL_ADDRESS: address,
    INBOX_MESSAGES: {
      list: async () => ({ objects: [newsletter], truncated: false }),
      get: async () => newsletter,
    } as unknown as WorkerEnv["INBOX_MESSAGES"],
    SENT_MESSAGES: { list: empty } as unknown as WorkerEnv["SENT_MESSAGES"],
  });
  const existing = {
    folder: "inbox" as const,
    from: "bounce@example.net",
    to: address,
    subject: "Monthly newsletter",
    timestamp: 1000,
    messageIds: ["<monthly@example.net>"],
    people: {
      sender: { address: "News@Example.net", name: "Newsletter" },
      members: [],
    },
  };
  await indexMail(db, { ...existing, id: newsletter.key });
  sqlite.exec(
    "INSERT INTO mail_index_scans (folder, scanned_at, ready) VALUES ('inbox:people', 0, 1)",
  );
  for (let i = 1; i <= 21; i++) {
    await indexMail(db, {
      ...existing,
      id: mailId(i),
      from: "team@example.net",
      subject: `Mail ${i}`,
      people: undefined,
      timestamp: 1000 + i,
      messageIds: [],
    });
  }
  expect((await call(noiseApiPath)).status).toBe(401);
  const session = cookies(await signIn(password));
  const get = async (path: string) => {
    const response = await call(path, undefined, session);
    expect(response.status).toBe(200);
    return response.json();
  };
  const rule = (priority: string, csrf = true) =>
    request(senderRuleApiPath, {
      method: "PATCH",
      headers: {
        cookie: session,
        "content-type": "application/json",
        origin: "https://oneapp.example",
        ...(csrf ? { "x-effect-auth-csrf": "1" } : {}),
      },
      body: JSON.stringify({ address: "NEWS@EXAMPLE.NET", priority }),
    });
  expect(await get(noiseApiPath)).toMatchObject({
    messages: [{ id: newsletter.key }],
    cursor: null,
  });
  expect((await rule("signal", false)).status).toBe(403);
  expect((await rule("signal")).status).toBe(204);
  expect(await get(noiseApiPath)).toMatchObject({ messages: [] });
  expect(await get(conversationApi(newsletter.key))).toMatchObject({
    senderRule: { address: "news@example.net", priority: "signal" },
  });
  const { cursor, messages } = await get(conversationsApiPath);
  expect(messages).toHaveLength(20);
  expect(
    await get(`${conversationsApiPath}?${new URLSearchParams({ cursor })}`),
  ).toMatchObject({
    messages: [{ id: mailId(1) }, { id: newsletter.key }],
    cursor: null,
  });
  expect((await rule("automatic")).status).toBe(204);
  expect(await get(noiseApiPath)).toMatchObject({
    messages: [{ id: newsletter.key }],
  });
  await indexMail(db, {
    ...existing,
    id: mailId(22),
    timestamp: 2000,
    from: "team@example.net",
    people: undefined,
    listMail: false,
  });
  expect(await get(noiseApiPath)).toMatchObject({ messages: [] });
  expect(await get(conversationsApiPath)).toMatchObject({
    messages: [{ id: mailId(22), messageCount: 2 }, ...messages.slice(0, 19)],
  });
});

it("groups existing mail across Inbox and Sent as its threads are discovered", async () => {
  using sqlite = new Database(":memory:");
  const address = "mail@app.example.net";
  const subject = "Status update";
  const makeInbox = (
    number: number,
    timestamp: number,
    headers: string[],
    unread = false,
    messageSubject = subject,
  ) => {
    const key = `0-819999999999${number}-00000000-0000-4000-8000-000000000000.eml`;
    const raw = [
      "From: Project Lead <sender@example.net>",
      `Subject: ${messageSubject}`,
      ...headers,
      "",
      "Hello.",
    ].join("\r\n");
    return {
      key,
      size: raw.length,
      uploaded: new Date(timestamp),
      raw,
      customMetadata: {
        envelopeFrom: "sender@example.net",
        envelopeTo: address,
        subject: messageSubject,
        ...(unread ? { initialUnread: "1" } : {}),
      },
    };
  };
  const root = makeInbox(0, 1000, [
    "Message-ID: <a@example.net>",
    `To: ${address}, Customer <customer@example.net>`,
    "Cc: Reviewer <reviewer@example.net>, REVIEWER@example.net",
  ]);
  const branch = makeInbox(1, 2000, ["Message-ID: <b@example.net>"]);
  const latest = makeInbox(
    2,
    4000,
    ["In-Reply-To: <b@example.net>"],
    true,
    ` RE: Re: ${subject} `,
  );
  const bridge = makeInbox(3, 3000, [
    "References: <a@example.net> <b@example.net>",
  ]);
  const separate = makeInbox(
    4,
    5000,
    ["Message-ID: <separate@example.net>"],
    true,
  );
  const objects = new Map(
    [root, branch, latest, bridge, separate].map((item) => [item.key, item]),
  );
  const sentId = "0-8199999999990-00000000-0000-4000-8000-000000000000";
  const sent = {
    id: sentId,
    from: address,
    to: "outreach@example.net",
    subject: `Re: ${subject}`,
    sentAt: 4500,
    text: "A saved reply.\n\nThe update is ready.\n\n> Previous message.",
    providerMessageId: "<sent@example.net>",
    reply: { originalId: root.key },
  };
  const publish = vi.fn(async () => {});
  const { call, db, request, signIn, cookies } = await setup(sqlite, {
    INBOX_EMAIL_ADDRESS: address,
    INBOX_UPDATES: {
      getByName: () => ({ publish }),
    } as WorkerEnv["INBOX_UPDATES"],
    INBOX_MESSAGES: {
      list: async ({ cursor }: { cursor?: string }) =>
        cursor
          ? { objects: [bridge, separate], truncated: false }
          : {
              objects: [root, branch, latest],
              truncated: true,
              cursor: "older",
            },
      get: async (id: string) => {
        const item = objects.get(id);
        return item
          ? {
              ...item,
              text: async () => item.raw,
              arrayBuffer: async () =>
                new TextEncoder().encode(item.raw).buffer,
            }
          : null;
      },
      head: async (id: string) => objects.get(id) ?? null,
      delete: async (id: string) => void objects.delete(id),
    } as unknown as WorkerEnv["INBOX_MESSAGES"],
    SENT_MESSAGES: {
      list: async () => ({ objects: [{ key: sentId }], truncated: false }),
      get: async () => ({ json: async () => sent }),
    } as unknown as WorkerEnv["SENT_MESSAGES"],
  });
  expect((await call(conversationsApiPath)).status).toBe(401);
  expect((await call(allMailApiPath)).status).toBe(401);
  expect((await call(conversationApi(root.key))).status).toBe(401);
  expect((await call(inboxUnreadPath)).status).toBe(401);
  const session = cookies(await signIn(password));
  const customer = await call(
    peopleApiPath,
    { name: "Customer profile", addresses: ["customer@example.net"] },
    session,
  );
  expect(customer.status).toBe(201);
  const customerProfile = await customer.json();
  const get = async (path: string) => {
    const result = await call(path, undefined, session);
    expect(result.status).toBe(200);
    return result.json();
  };
  expect(await get(conversationsApiPath)).toMatchObject({
    indexing: true,
    messages: [
      { id: latest.key, messageCount: 2 },
      { id: root.key, messageCount: 2 },
    ],
  });
  expect(await get(conversationsApiPath)).toMatchObject({
    messages: [
      {
        id: separate.key,
        messageCount: 1,
        unreadCount: 1,
        bodyPreview: "Hello.",
        profiles: [{ email: address, person: { self: true } }],
      },
      {
        id: latest.key,
        subject,
        messageCount: 5,
        unreadCount: 1,
        receivedAt: 4000,
        lastMessageAt: 4500,
        bodyPreview: "A saved reply. The update is ready.",
        senders: [{ address: "sender@example.net", name: "Project Lead" }],
        participants: [
          { address: "sender@example.net", name: "Project Lead" },
          { address, name: "" },
          { address: "customer@example.net", name: "Customer" },
          { address: "reviewer@example.net", name: "Reviewer" },
          { address: "outreach@example.net", name: "" },
        ],
        profiles: [
          { email: address, person: { self: true } },
          {
            email: "customer@example.net",
            person: { id: customerProfile.id, name: "Customer profile" },
          },
        ],
      },
    ],
  });
  const expected = [root.key, branch.key, bridge.key, latest.key, sentId];
  const sentOnlyId = "0-8199999999991-00000000-0000-4000-8000-000000000000";
  await indexMail(db, {
    id: sentOnlyId,
    folder: "sent",
    from: address,
    to: sent.to,
    subject: "Sent only",
    timestamp: 6000,
    messageIds: [],
  });
  expect(await get(allMailApiPath)).toMatchObject({
    messages: [
      { id: sentOnlyId, latestIncomingId: null, archived: false },
      { id: separate.key, latestIncomingId: separate.key, archived: false },
      { id: sentId, latestIncomingId: latest.key, messageCount: 5 },
    ],
  });
  const allCursor = new URLSearchParams({ cursor: `6000/${sentOnlyId}` });
  expect(await get(`${allMailApiPath}?${allCursor}`)).toMatchObject({
    messages: [{ id: separate.key }, { id: sentId }],
  });
  for (const anchor of [root.key, branch.key, sentId, latest.key]) {
    const thread = await get(conversationApi(anchor));
    expect(thread.messages.map(({ id }: { id: string }) => id)).toEqual(
      expected,
    );
    expect(thread.messages[0].bodyPreview).toBe("Hello.");
    expect(thread.messages.at(-1)?.bodyPreview).toBe(
      "A saved reply. The update is ready.",
    );
    expect(thread.messages[0].people).toEqual({
      sender: { address: "sender@example.net", name: "Project Lead" },
      members: [
        { address: "sender@example.net", name: "Project Lead" },
        { address, name: "" },
        { address: "customer@example.net", name: "Customer" },
        { address: "reviewer@example.net", name: "Reviewer" },
      ],
    });
  }
  const qs = new URLSearchParams({ cursor: `5000/${separate.key}` });
  expect(await get(`${conversationsApiPath}?${qs}`)).toMatchObject({
    messages: [{ id: latest.key, messageCount: 5 }],
  });
  expect(await get(inboxMessageApi(root.key))).toMatchObject({ unread: false });
  expect(await get(inboxMessageApi(latest.key))).toMatchObject({
    unread: true,
  });
  expect(await get(inboxUnreadPath)).toEqual({ unreadCount: 2 });
  const mark = (
    id: string,
    unread: boolean,
    headers: Record<string, string> = {},
  ) =>
    request(inboxReadApi(id), {
      method: "PATCH",
      headers: {
        origin: "https://oneapp.example",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ unread }),
    });
  const approved = { cookie: session, "x-effect-auth-csrf": "1" };
  expect((await mark(latest.key, false)).status).toBe(401);
  expect((await mark(latest.key, false, { cookie: session })).status).toBe(403);
  expect((await mark(sentId, true, approved)).status).toBe(404);
  expect((await mark(latest.key, false, approved)).status).toBe(204);
  expect((await mark(latest.key, false, approved)).status).toBe(204);
  expect(publish).toHaveBeenCalledOnce();
  expect(await get(inboxUnreadPath)).toEqual({ unreadCount: 1 });
  const readThread = await get(conversationApi(root.key));
  expect(
    readThread.messages.every(({ unread }: { unread: boolean }) => !unread),
  ).toBe(true);
  expect((await mark(latest.key, true, approved)).status).toBe(204);
  expect(await get(inboxUnreadPath)).toEqual({ unreadCount: 2 });
  const removed = await request(inboxMessageApi(latest.key), {
    method: "DELETE",
    headers: {
      cookie: session,
      origin: "https://oneapp.example",
      "x-effect-auth-csrf": "1",
    },
  });
  expect(removed.status).toBe(204);
  expect(await get(inboxUnreadPath)).toEqual({ unreadCount: 1 });
  expect((await mark(latest.key, true, approved)).status).toBe(404);
  expect(publish).toHaveBeenCalledTimes(3);
  expect(await get(conversationsApiPath)).toMatchObject({
    messages: [
      { id: separate.key, messageCount: 1 },
      { id: bridge.key, messageCount: 4, lastMessageAt: 4500 },
    ],
  });
  const updated = await get(conversationApi(root.key));
  expect(updated.messages.map(({ id }: { id: string }) => id)).toEqual(
    expected.filter((id) => id !== latest.key),
  );

  const archive = (
    id: string,
    archived: boolean,
    headers: Record<string, string> = approved,
  ) =>
    request(conversationArchiveApi(id), {
      method: "PATCH",
      headers: {
        origin: "https://oneapp.example",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ archived }),
    });
  expect((await call(archiveApiPath)).status).toBe(401);
  expect((await archive(bridge.key, true, {})).status).toBe(401);
  expect((await archive(bridge.key, true, { cookie: session })).status).toBe(
    403,
  );
  expect((await archive(root.key, true)).status).toBe(409);
  expect((await mark(bridge.key, true, approved)).status).toBe(204);
  expect((await archive(bridge.key, true)).status).toBe(204);
  expect((await archive(bridge.key, true)).status).toBe(204);
  expect(await get(inboxUnreadPath)).toEqual({ unreadCount: 1 });
  expect(await get(conversationsApiPath)).toMatchObject({
    messages: [{ id: separate.key }],
  });
  expect(await get(archiveApiPath)).toMatchObject({
    messages: [{ id: bridge.key, messageCount: 4, unreadCount: 1 }],
  });
  expect(await get(allMailApiPath)).toMatchObject({
    messages: [
      { id: sentOnlyId },
      { id: separate.key, archived: false },
      { id: sentId, latestIncomingId: bridge.key, archived: true },
    ],
  });
  expect(await get(conversationApi(root.key))).toMatchObject({
    archived: true,
  });
  expect(await get(mailMessageApi("sent", sentId))).toMatchObject({
    id: sentId,
  });
  expect((await archive(latest.key, false)).status).toBe(204);
  expect(await get(archiveApiPath)).toMatchObject({ messages: [] });
  expect(await get(inboxUnreadPath)).toEqual({ unreadCount: 2 });

  expect((await archive(bridge.key, true)).status).toBe(204);
  const member = {
    folder: "inbox" as const,
    from: "sender@example.net",
    to: address,
    subject,
    messageIds: ["<a@example.net>"],
  };
  const older = makeInbox(5, 1500, []);
  await indexMail(db, { ...member, id: older.key, timestamp: 1500 });
  expect(await get(archiveApiPath)).toMatchObject({
    messages: [{ id: bridge.key, messageCount: 5 }],
  });
  const reply = makeInbox(6, 3000, [], true);
  await indexMail(
    db,
    { ...member, id: reply.key, timestamp: 3000, unread: true },
    { reopensArchive: true },
  );
  expect(await get(archiveApiPath)).toMatchObject({ messages: [] });
  expect(await get(conversationsApiPath)).toMatchObject({
    messages: [
      { id: separate.key },
      { id: reply.key, messageCount: 6, unreadCount: 2 },
    ],
  });
  expect((await archive(bridge.key, true)).status).toBe(409);
  expect(
    (
      await request(inboxMessageApi(reply.key), {
        method: "DELETE",
        headers: { ...approved, origin: "https://oneapp.example" },
      })
    ).status,
  ).toBe(204);
  expect(await get(conversationsApiPath)).toMatchObject({
    messages: [{ id: separate.key }, { id: bridge.key }],
  });
});

it("only upgrades Inbox sockets for a same-origin owner session", async () => {
  using sqlite = new Database(":memory:");
  const accept = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(null, { status: 204 }),
  );
  const { request, signIn, cookies } = await setup(sqlite, {
    INBOX_UPDATES: {
      getByName: () => ({ fetch: accept }),
    } as WorkerEnv["INBOX_UPDATES"],
  });
  const cookie = cookies(await signIn(password));
  const headers = {
    upgrade: "websocket",
    origin: "https://oneapp.example",
    "x-oneapp-inbox-session-id": "forged",
    "x-oneapp-inbox-security-revision": "forged",
    "x-oneapp-inbox-mailbox": "family",
  };
  expect((await request(inboxEventsPath, { headers })).status).toBe(401);
  expect(
    (
      await request(inboxEventsPath, {
        headers: { ...headers, cookie, origin: "https://other.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(inboxEventsPath, {
        headers: { origin: headers.origin, cookie },
      })
    ).status,
  ).toBe(426);
  expect(accept).not.toHaveBeenCalled();

  const allowed = await request(inboxEventsPath, {
    headers: { ...headers, cookie },
  });
  expect(allowed.status).toBe(204);
  expect(accept).toHaveBeenCalledOnce();
  const forwarded = new Headers(accept.mock.calls[0]?.[1].headers);
  const session = sqlite
    .query<{ id: string; revision: string }, []>(
      "SELECT session_id AS id, security_revision AS revision FROM oneapp_auth_sessions",
    )
    .get();
  expect(session).not.toBeNull();
  expect(forwarded.get("upgrade")).toBe("websocket");
  expect(forwarded.has("cookie")).toBe(false);
  expect(forwarded.get("x-oneapp-inbox-mailbox")).toBe("personal");
  expect(forwarded.get("x-oneapp-inbox-session-id")).toBe(session?.id);
  expect(forwarded.get("x-oneapp-inbox-security-revision")).toBe(
    session?.revision,
  );
});

it("serves received attachments privately and previews only supported media", async () => {
  using sqlite = new Database(":memory:");
  const id = "0-8200000000000-d92d6b0a-61b8-4776-95cf-767cf1000000.eml";
  const mailbox = "mail@app.example.net";
  const png = Uint8Array.fromBase64(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN9sAAAAASUVORK5CYII=",
  );
  const markup =
    "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>";
  const report = "Name,Total\r\n" + "Alex,10\r\n".repeat(4000);
  const file = (type: string, filename: string, content: string) => [
    "--oneapp-test",
    "Content-Type: " + type,
    "Content-Disposition: attachment; " + filename,
    "Content-Transfer-Encoding: base64",
    "",
    content,
  ];
  const raw = [
    "From: sender@example.net",
    "To: " + mailbox,
    "Subject: Attached report",
    "Content-Type: multipart/mixed; boundary=oneapp-test",
    "",
    "--oneapp-test",
    "Content-Type: text/plain",
    "",
    "Here is the report.",
    ...file(
      "application/octet-stream",
      "filename*=UTF-8''..%2Fr%C3%A9sum%C3%A9.png",
      png.toBase64(),
    ),
    ...file(
      "image/png",
      'filename="drawing.svg"',
      new TextEncoder().encode(markup).toBase64(),
    ),
    ...file(
      "text/csv",
      'filename="report.csv"',
      new TextEncoder().encode(report).toBase64(),
    ),
    "--oneapp-test--",
    "",
  ].join("\r\n");
  const get = vi.fn(async (key: string) => {
    if (key !== id) return null;
    const response = new Response(raw);
    return {
      size: raw.length,
      key,
      uploaded: new Date("2026-11-19T00:15:00.000Z"),
      customMetadata: {
        envelopeFrom: "sender@example.net",
        envelopeTo: mailbox,
      },
      body: response.body,
      arrayBuffer: () => response.arrayBuffer(),
    };
  });
  const { call, signIn, cookies } = await setup(sqlite, {
    INBOX_EMAIL_ADDRESS: mailbox,
    INBOX_MESSAGES: { get } as unknown as WorkerEnv["INBOX_MESSAGES"],
  });
  expect((await call(inboxAttachmentApi(id, 0))).status).toBe(401);
  expect((await call(inboxAttachmentPreviewApi(id, 0))).status).toBe(401);
  expect(get).not.toHaveBeenCalled();
  const session = cookies(await signIn(password));
  const signedIn = (path: string) => call(path, undefined, session);
  const message = await signedIn(inboxMessageApi(id));
  expect(message.status).toBe(200);
  expect(await message.json()).toMatchObject({
    attachments: [
      {
        part: 0,
        name: "résumé.png",
        mediaType: "image/png",
        size: png.byteLength,
        preview: "image",
      },
      { part: 1, name: "drawing.svg", preview: null },
      { part: 2, name: "report.csv", mediaType: "text/csv", preview: "text" },
    ],
  });
  get.mockClear();
  expect((await signedIn(inboxAttachmentApi(id, 512))).status).toBe(404);
  expect((await signedIn(inboxMessageApi(id) + "/attachments/01")).status).toBe(
    404,
  );
  expect(get).not.toHaveBeenCalled();
  expect((await signedIn(inboxAttachmentApi(id, 3))).status).toBe(404);

  const image = await signedIn(inboxAttachmentPreviewApi(id, 0));
  expect(image.headers.get("content-type")).toBe("image/png");
  expect(image.headers.get("content-disposition")).toBe("inline");
  expect(image.headers.get("cache-control")).toBe("no-store");
  expect(image.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
  const download = await signedIn(inboxAttachmentApi(id, 0));
  expect(download.headers.get("content-disposition")).toContain(
    "filename*=UTF-8''r%C3%A9sum%C3%A9.png",
  );
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(png);
  expect((await signedIn(inboxAttachmentPreviewApi(id, 1))).status).toBe(415);
  const unsafe = await signedIn(inboxAttachmentApi(id, 1));
  expect(unsafe.headers.get("content-type")).toBe("application/octet-stream");
  expect(unsafe.headers.get("content-disposition")).toMatch(/^attachment;/u);
  expect(unsafe.headers.get("x-content-type-options")).toBe("nosniff");
  expect(unsafe.headers.get("content-security-policy")).toContain("sandbox");
  expect(await unsafe.text()).toBe(markup);
  const text = await signedIn(inboxAttachmentPreviewApi(id, 2));
  expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(await text.text()).toBe(report.slice(0, 32 * 1024));
  expect(await (await signedIn(inboxAttachmentApi(id, 2))).text()).toBe(report);
});

it("returns sanitized HTML and CID images alongside plain text, with a bounded fallback", async () => {
  using sqlite = new Database(":memory:");
  const id = "0-8200000000000-d92d6b0a-61b8-4776-95cf-767cf1000000.eml";
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN9sAAAAASUVORK5CYII=";
  let html =
    '<p><strong>Rich body</strong></p><img src="cid:photo@mail"><img src="https://tracker.test/pixel"><script>evil()</script>';
  const get = vi.fn(async (key: string) => {
    if (key !== id) return null;
    const raw = [
      "From: sender@example.net",
      "To: mail@app.example.net",
      "Subject: Inline photo",
      "Content-Type: multipart/related; boundary=related",
      "",
      "--related",
      "Content-Type: multipart/alternative; boundary=alternative",
      "",
      "--alternative",
      "Content-Type: text/plain",
      "",
      "Plain body",
      "--alternative",
      "Content-Type: text/html",
      "",
      html,
      "--alternative--",
      "--related",
      "Content-Type: image/png",
      "Content-ID: <photo@mail>",
      "Content-Disposition: inline",
      "Content-Transfer-Encoding: base64",
      "",
      png,
      "--related--",
      "",
    ].join("\r\n");
    const response = new Response(raw);
    return {
      key,
      size: raw.length,
      uploaded: new Date("2026-11-19T00:15:00.000Z"),
      body: response.body,
      arrayBuffer: () => response.arrayBuffer(),
    };
  });
  const { call, request, signIn, cookies } = await setup(sqlite, {
    INBOX_EMAIL_ADDRESS: "mail@app.example.net",
    INBOX_MESSAGES: { get } as unknown as WorkerEnv["INBOX_MESSAGES"],
  });
  expect((await call(inboxMessageApi(id))).status).toBe(401);
  expect(get).not.toHaveBeenCalled();
  const session = cookies(await signIn(password));
  const response = await call(inboxMessageApi(id), undefined, session);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const entry = (await response.json()) as { html: string };
  expect(entry).toMatchObject({ text: "Plain body", preview: "complete" });
  expect(entry.html).toContain("<strong>Rich body</strong>");
  expect(entry.html).toContain(`src="data:image/png;base64,${png}"`);
  expect(entry.html).not.toMatch(/tracker|script|evil/iu);

  const imagesPath = `${inboxMessageApi(id)}?images=safe`;
  expect((await call(imagesPath)).status).toBe(401);
  expect(
    (await call(`${inboxMessageApi(id)}?images=invalid`, undefined, session))
      .status,
  ).toBe(400);
  expect(
    (await request(imagesPath, { headers: { cookie: session } })).status,
  ).toBe(403);
  html =
    '<p>News</p><img src="https://cdn.example.com/open.gif?id=recipient" width="1" height="1">';
  const filtered = await call(imagesPath, undefined, session);
  expect(filtered.status).toBe(200);
  expect(filtered.headers.get("cache-control")).toBe("no-store");
  expect(await filtered.json()).toMatchObject({
    remoteImages: { blocked: 1, loaded: 0 },
  });

  html = "<p>Too much HTML</p>".repeat(60_000);
  const fallback = await (
    await call(inboxMessageApi(id), undefined, session)
  ).json();
  expect(fallback).toMatchObject({ text: "Plain body", preview: "truncated" });
  expect(fallback).not.toHaveProperty("html");
});

it("trashes a conversation across Inbox and Sent and restores only that deletion batch", async () => {
  using sqlite = new Database(":memory:");
  const { call, db, request, signIn, cookies } = await setup(sqlite);
  const session = cookies(await signIn(password));
  const id = (n: number) =>
    `0-8199999999990-00000000-0000-4000-8000-00000000000${n}`;
  const [anchor, sent, alreadyTrashed, arrival] = [
    `${id(1)}.eml`,
    id(2),
    `${id(3)}.eml`,
    `${id(4)}.eml`,
  ];
  const message = {
    from: "alex@example.net",
    to: email,
    subject: "A conversation",
    timestamp: 10,
    messageIds: ["<conversation@example.net>"],
  };
  await indexMail(db, {
    ...message,
    id: anchor,
    folder: "inbox",
    unread: true,
    initialArchived: true,
  });
  await indexMail(db, { ...message, id: sent, folder: "sent", timestamp: 11 });
  await indexMail(db, {
    ...message,
    id: alreadyTrashed,
    folder: "inbox",
    timestamp: 1,
  });
  sqlite.exec(`INSERT INTO mailboxes (id, owner_account_id, name)
    SELECT 'work', owner_account_id, 'Work' FROM mailboxes WHERE id = 'personal'`);
  await indexMail(mailDatabase(db, "work"), {
    ...message,
    id: anchor,
    folder: "inbox",
  });
  const headers = {
    cookie: session,
    origin: "https://oneapp.example",
    "x-effect-auth-csrf": "1",
  };
  const remove = (path: string, authorized: HeadersInit = headers) =>
    request(path, { method: "DELETE", headers: authorized });
  expect((await remove(inboxMessageApi(alreadyTrashed))).status).toBe(204);
  expect((await remove(conversationApi(anchor), {})).status).toBe(401);
  expect(
    (
      await remove(conversationApi(anchor), {
        cookie: session,
        origin: headers.origin,
      })
    ).status,
  ).toBe(403);
  const deleted = await remove(conversationApi(anchor));
  expect(deleted.status).toBe(200);
  const batch = Schema.decodeUnknownSync(TrashedConversation)(
    await deleted.json(),
  );
  expect(new Set(batch.ids)).toEqual(new Set([anchor, sent]));
  expect((await remove(conversationApi(anchor))).status).toBe(404);
  const trash = await (await call(trashApiPath, undefined, session)).json();
  expect(new Set(trash.messages.map(({ id }: { id: string }) => id))).toEqual(
    new Set([anchor, sent, alreadyTrashed]),
  );

  await indexMail(db, {
    ...message,
    id: arrival,
    folder: "inbox",
    timestamp: 12,
  });
  const restorePath = trashBatchRestoreApi(batch.batchId);
  const restored = await call(restorePath, {}, session);
  expect(restored.status).toBe(200);
  expect(new Set((await restored.json()).ids)).toEqual(new Set([anchor, sent]));
  const state = (id: string, mailbox = "personal") =>
    sqlite
      .query(
        "SELECT deleted, archived, unread FROM mail_index_messages WHERE mailbox_id = ? AND id = ?",
      )
      .get(mailbox, id);
  expect(state(anchor)).toEqual({ deleted: 0, archived: 1, unread: 1 });
  expect(state(sent)).toMatchObject({ deleted: 0 });
  expect(state(alreadyTrashed)).toMatchObject({ deleted: 1 });
  expect(state(arrival)).toMatchObject({ deleted: 0 });
  expect(state(anchor, "work")).toMatchObject({ deleted: 0 });

  expect((await remove(conversationApi(anchor))).status).toBe(200);
  expect(await (await call(restorePath, {}, session)).json()).toEqual({
    ids: [],
  });
  expect(state(anchor)).toMatchObject({ deleted: 1 });
  expect(state(arrival)).toMatchObject({ deleted: 1 });
});

it("allows the owner to delete and recover stored mail before automatic expiry", async () => {
  using sqlite = new Database(":memory:");
  const address = "mail@app.example.net";
  const sender = "bounces@example.net";
  const legacy =
    "2026-11-19T00:15:00.000Z-85c03fc3-8e33-42dd-af09-76d1890aa307.eml";
  const newest = "0-8200000000000-85c03fc3-8e33-42dd-af09-76d1890aa307.eml";
  const metadata = { envelopeFrom: sender, envelopeTo: address };
  const raw = [
    "From: Example Team <team@example.net>",
    "Subject: =?UTF-8?Q?Coffee_=E2=98=95?=",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>Hello <strong>there</strong>.</p><script>secret()</script><img src="https://tracking.example.net/pixel">',
    "",
  ].join("\r\n");
  const bytes = new TextEncoder().encode(raw);
  const stored = new Set([legacy, newest]);
  const object = (key: string) => ({
    key,
    size: bytes.length,
    uploaded: new Date("2026-11-19T00:15:00.000Z"),
    customMetadata:
      key === newest ? { ...metadata, subject: "Coffee ☕" } : metadata,
  });
  const list = vi.fn(async ({ cursor }: { cursor?: string }) =>
    cursor
      ? {
          objects: stored.has(legacy) ? [object(legacy)] : [],
          truncated: false,
        }
      : { objects: [object(newest)], truncated: true, cursor: "next-page" },
  );
  const get = vi.fn(
    async (key: string, options?: { range: { length: number } }) => {
      if (!stored.has(key)) return null;
      const response = new Response(
        options ? bytes.slice(0, options.range.length) : bytes,
      );
      return {
        ...object(key),
        body: response.body,
        text: () => response.text(),
        arrayBuffer: () => response.arrayBuffer(),
      };
    },
  );
  const remove = vi.fn(async (key: string) => {
    stored.delete(key);
  });
  const { call, request, signIn, cookies, db } = await setup(sqlite, {
    INBOX_EMAIL_ADDRESS: address,
    INBOX_MESSAGES: {
      list,
      get,
      head: async (id: string) => (stored.has(id) ? object(id) : null),
      delete: remove,
    } as WorkerEnv["INBOX_MESSAGES"],
  });
  for (const path of [
    inboxApiPath,
    inboxMessageApi(legacy),
    inboxOriginalApi(legacy),
  ]) {
    expect((await call(path)).status).toBe(401);
  }
  expect(list).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();

  const session = cookies(await signIn(password));
  const first = await call(inboxApiPath, undefined, session);
  expect(first.headers.get("cache-control")).toBe("no-store");
  const firstPage = await first.json();
  expect(firstPage).not.toHaveProperty("sender");
  expect(firstPage).toMatchObject({
    address,
    cursor: "next-page",
    messages: [{ id: newest, from: sender, subject: "Coffee ☕" }],
  });
  expect(get).not.toHaveBeenCalled();
  const next = await call(
    inboxApiPath + "?cursor=next-page",
    undefined,
    session,
  );
  expect(await next.json()).toMatchObject({
    cursor: null,
    messages: [{ id: legacy, subject: "Coffee ☕" }],
  });
  expect(get).toHaveBeenLastCalledWith(legacy, {
    range: { offset: 0, length: bytes.length },
  });

  const opened = await call(inboxMessageApi(legacy), undefined, session);
  expect(opened.headers.get("cache-control")).toBe("no-store");
  expect(await opened.json()).toMatchObject({
    subject: "Coffee ☕",
    from: "Example Team <team@example.net>",
    to: address,
    text: "Hello there.",
    preview: "complete",
  });
  const original = await call(inboxOriginalApi(legacy), undefined, session);
  expect(original.headers.get("content-disposition")).toBe(
    `attachment; filename="${legacy}"`,
  );
  expect(original.headers.get("cache-control")).toBe("no-store");
  expect(await original.text()).toBe(raw);
  expect(
    (await call(inboxMessageApi("unknown"), undefined, session)).status,
  ).toBe(404);

  const deleteMail = (headers: HeadersInit, key = legacy) =>
    request(inboxMessageApi(key), { method: "DELETE", headers });
  const authorized = {
    cookie: session,
    origin: "https://oneapp.example",
    "x-effect-auth-csrf": "1",
  };
  expect((await deleteMail({})).status).toBe(401);
  expect(
    (await deleteMail({ cookie: session, origin: authorized.origin })).status,
  ).toBe(403);
  expect(
    (await deleteMail({ ...authorized, origin: "https://other.example" }))
      .status,
  ).toBe(403);
  expect((await deleteMail(authorized, "unknown")).status).toBe(404);
  expect(remove).not.toHaveBeenCalled();

  const deleted = await deleteMail(authorized);
  expect(deleted.status).toBe(204);
  expect(deleted.headers.get("cache-control")).toBe("no-store");
  expect(remove).not.toHaveBeenCalled();
  expect(stored.has(legacy)).toBe(true);
  expect((await deleteMail(authorized)).status).toBe(204);
  expect((await call(inboxMessageApi(legacy), undefined, session)).status).toBe(
    404,
  );
  expect(
    (await call(inboxOriginalApi(legacy), undefined, session)).status,
  ).toBe(404);
  const afterDelete = await call(
    inboxApiPath + "?cursor=next-page",
    undefined,
    session,
  );
  expect(await afterDelete.json()).toMatchObject({
    messages: [],
    cursor: null,
  });
  expect(stored.has(newest)).toBe(true);
  const recoveryPath = `${inboxApiPath}/trash`;
  const restorePath = `${recoveryPath}/${legacy}/restore`;
  expect((await call(recoveryPath)).status).toBe(401);
  const trashedMessage = `${recoveryPath}/${legacy}`;
  expect((await call(trashedMessage)).status).toBe(401);
  expect(
    (await call(`${recoveryPath}/${newest}`, undefined, session)).status,
  ).toBe(404);
  const trashEntry = await call(trashedMessage, undefined, session);
  expect(trashEntry.headers.get("cache-control")).toBe("no-store");
  expect(await trashEntry.json()).toMatchObject({
    id: legacy,
    subject: "Coffee ☕",
    text: "Hello there.",
    preview: "complete",
  });
  expect(
    await (await call(`${trashedMessage}/original`, undefined, session)).text(),
  ).toBe(raw);

  expect((await call(restorePath, {})).status).toBe(401);
  expect(
    (
      await request(restorePath, {
        method: "POST",
        headers: { cookie: session, origin: authorized.origin },
      })
    ).status,
  ).toBe(403);
  expect(
    await (await call(recoveryPath, undefined, session)).json(),
  ).toMatchObject({ messages: [{ id: legacy, subject: "Coffee ☕" }] });
  expect((await call(restorePath, {}, session)).status).toBe(204);
  expect((await call(trashedMessage, undefined, session)).status).toBe(404);
  expect((await call(inboxMessageApi(legacy), undefined, session)).status).toBe(
    200,
  );
  expect(
    await (await call(recoveryPath, undefined, session)).json(),
  ).toMatchObject({ messages: [] });
  expect((await deleteMail(authorized)).status).toBe(204);
  const deletedAt = (
    sqlite
      .query("SELECT deleted_at FROM mail_index_messages WHERE id = ?")
      .get(legacy) as { deleted_at: number }
  ).deleted_at;
  sqlite
    .query("UPDATE mail_index_messages SET deleted_at = ? WHERE id = ?")
    .run(Date.now() - mailRetentionMs - 1, legacy);
  expect((await call(trashedMessage, undefined, session)).status).toBe(404);
  expect(
    (await call(`${trashedMessage}/original`, undefined, session)).status,
  ).toBe(404);
  expect((await call(restorePath, {}, session)).status).toBe(404);
  sqlite
    .query("UPDATE mail_index_messages SET deleted_at = ? WHERE id = ?")
    .run(deletedAt, legacy);
  const store = {
    DB: db,
    INBOX_MESSAGES: {
      delete: remove,
    } as unknown as WorkerEnv["INBOX_MESSAGES"],
    SENT_MESSAGES: { delete: remove } as unknown as WorkerEnv["SENT_MESSAGES"],
  };
  await collectMailTrash(store, deletedAt + mailRetentionMs - 1);
  expect(stored.has(legacy)).toBe(true);
  remove.mockRejectedValueOnce(new Error("R2 unavailable"));
  await expect(
    collectMailTrash(store, deletedAt + mailRetentionMs),
  ).rejects.toThrow("cleanup will retry");
  expect((await call(restorePath, {}, session)).status).toBe(404);
  expect(stored.has(legacy)).toBe(true);
  await collectMailTrash(store, deletedAt + mailRetentionMs + 1);
  expect(stored.has(legacy)).toBe(false);
  expect(stored.has(newest)).toBe(true);
  expect(
    sqlite
      .query(
        "SELECT deleted, deleted_at, subject FROM mail_index_messages WHERE id = ?",
      )
      .get(legacy),
  ).toEqual({ deleted: 1, deleted_at: null, subject: "" });
  const deletedIds = Array.from(
    { length: 101 },
    () => `0-8200000000000-${crypto.randomUUID()}.eml`,
  )
    .sort()
    .reverse();
  const stamp = Date.now();
  for (const id of deletedIds)
    sqlite
      .query(
        "INSERT INTO mail_index_messages (id, thread_id, folder, sender, recipient, subject, timestamp, deleted, deleted_at) VALUES (?, ?, 'inbox', 'sender@example.net', '', 'Deleted', 1, 1, ?)",
      )
      .run(id, id, stamp);
  const firstDeleted = (await (
    await call(recoveryPath, undefined, session)
  ).json()) as { messages: { id: string }[]; cursor: string };
  expect(firstDeleted.messages).toHaveLength(100);
  const boundaryId = firstDeleted.messages.at(-1)!.id;
  expect(
    (await call(`${recoveryPath}/${boundaryId}/restore`, {}, session)).status,
  ).toBe(204);
  const older = await (
    await call(
      `${recoveryPath}?cursor=${encodeURIComponent(firstDeleted.cursor)}`,
      undefined,
      session,
    )
  ).json();
  expect(older).toMatchObject({
    messages: [{ id: deletedIds[100] }],
    cursor: null,
  });
  expect(
    (await call(`${recoveryPath}?cursor=invalid`, undefined, session)).status,
  ).toBe(400);
});

it("issues scoped CLI tokens and applies read and write scopes to the Links API", async () => {
  using sqlite = new Database(":memory:");
  const { call, request, signIn, cookies } = await setup(sqlite);
  const session = cookies(await signIn(password));
  const credential = (
    secret: string,
    path: string,
    method = "GET",
    body?: object,
  ) =>
    request(path, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  const secret = `one_${"a".repeat(43)}`;
  const start = await credential(secret, cliLoginPath, "POST", {
    label: "Laptop",
  });
  expect(start.status).toBe(201);
  const { id } = (await start.json()) as { id: string };
  const approval = `${cliLoginPath}/${id}`;
  expect((await call(approval, { approve: true }, session)).status).toBe(400);
  expect(
    (await call(approval, { approve: true, scopes: cliLinkScopes }, session))
      .status,
  ).toBe(204);
  expect((await credential(secret, `${approval}/poll`, "POST")).status).toBe(
    204,
  );

  expect(
    (
      await call(
        cliTokensPath,
        { label: "Mac mini", scopes: cliLinkScopes },
        session,
      )
    ).status,
  ).toBe(404);
  const tokens = await call(cliTokensPath, undefined, session);
  expect(tokens.status).toBe(200);
  expect(await tokens.json()).toMatchObject([{ id, label: "Laptop" }]);
  const save = await credential(secret, linksPath, "POST", {
    url: "https://example.com/",
  });
  expect(save.status).toBe(201);
  const link = (await save.json()) as { id: string };
  expect(await (await credential(secret, linksPath)).json()).toMatchObject([
    link,
  ]);

  sqlite.run("UPDATE cli_tokens SET scopes = ? WHERE id = ?", [
    JSON.stringify([linksReadScope]),
    id,
  ]);
  expect((await credential(secret, linksPath)).status).toBe(200);
  expect(
    (
      await credential(secret, linksPath, "POST", {
        url: "https://example.org/",
      })
    ).status,
  ).toBe(403);
  expect((await credential(secret, linkPath(link.id), "DELETE")).status).toBe(
    403,
  );

  sqlite.run("UPDATE cli_tokens SET scopes = ? WHERE id = ?", [
    JSON.stringify([linksWriteScope]),
    id,
  ]);
  expect((await credential(secret, linksPath)).status).toBe(403);
  expect((await credential(secret, linkPath(link.id), "DELETE")).status).toBe(
    204,
  );

  const revoked = await request(`${cliTokensPath}/${id}`, {
    method: "DELETE",
    headers: {
      cookie: session,
      origin: "https://oneapp.example",
      "x-effect-auth-csrf": "1",
    },
  });
  expect(revoked.status).toBe(204);
  expect((await credential(secret, linksPath)).status).toBe(401);
  expect((await credential(secret, `${approval}/poll`, "POST")).status).toBe(
    410,
  );

  const extensionSecret = `one_ext_${"b".repeat(43)}`;
  expect(
    (
      await call(
        extensionAccessPath,
        {
          id: crypto.randomUUID(),
          digest: await digestSecret(extensionSecret),
        },
        session,
      )
    ).status,
  ).toBe(204);
  const extensionSave = await credential(extensionSecret, linksPath, "POST", {
    url: "https://example.org/",
  });
  expect(extensionSave.status).toBe(201);
  const extensionLink = (await extensionSave.json()) as { id: string };
  expect((await credential(extensionSecret, linksPath)).status).toBe(401);
  expect(
    (await credential(extensionSecret, linkPath(extensionLink.id), "DELETE"))
      .status,
  ).toBe(401);
});

const defaultMcpScopes = [
  linksReadScope,
  linksWriteScope,
  tasksReadScope,
  tasksWriteScope,
];

it("lets a dedicated runner claim opted-in tasks and report only the latest run over MCP", async () => {
  using sqlite = new Database(":memory:");
  const published: string[] = [];
  const { call, request, signIn, cookies } = await setup(sqlite, {
    INBOX_UPDATES: {
      getByName: () => ({
        publish: async (change: string) => {
          published.push(change);
        },
      }),
    } as unknown as WorkerEnv["INBOX_UPDATES"],
  });
  const cookie = cookies(await signIn(password));
  const issue = async (
    scopes: typeof cliLinkScopes | typeof taskRunnerScopes,
  ) => {
    const secret = `one_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    const headers = {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    };
    const start = await request(cliLoginPath, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "Runner test", scopes }),
    });
    expect(start.status).toBe(201);
    const { id } = (await start.json()) as { id: string };
    expect(
      (await call(`${cliLoginPath}/${id}`, { approve: true, scopes }, cookie))
        .status,
    ).toBe(204);
    expect(
      (await request(`${cliLoginPath}/${id}/poll`, { method: "POST", headers }))
        .status,
    ).toBe(204);
    return { id, secret, headers };
  };
  const runner = await issue(taskRunnerScopes);
  const links = await issue(cliLinkScopes);
  expect(
    (await request(taskRunnerMcpPath, { headers: links.headers })).status,
  ).toBe(403);
  expect((await request(linksPath, { headers: runner.headers })).status).toBe(
    403,
  );

  using listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (incoming) =>
      request(new URL(incoming.url).pathname, {
        method: incoming.method,
        headers: incoming.headers,
        body: incoming.body ? await incoming.arrayBuffer() : undefined,
      }),
  });
  const queue = new TaskQueue(
    listener.url.origin,
    runner.secret,
    AbortSignal.timeout(10_000),
  );
  try {
    await queue.connect();
    const createTag = async (name: string) =>
      Schema.decodeUnknownSync(Tag)(
        await (await call(tagsApi, { name }, cookie)).json(),
      );
    const tag = await createTag("ready");
    const otherTag = await createTag("not-ready");
    const readyId = crypto.randomUUID();
    expect(
      (
        await call(
          tasksApi,
          { id: readyId, title: "Fix a typo", tagIds: [tag.id] },
          cookie,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await call(
          tasksApi,
          { id: crypto.randomUUID(), title: "Manual backlog" },
          cookie,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await call(
          tasksApi,
          { id: crypto.randomUUID(), title: "Draft", tagIds: [otherTag.id] },
          cookie,
        )
      ).status,
    ).toBe(201);
    expect(await queue.next()).toEqual({ id: readyId, tagId: tag.id });
    const task = await queue.get(readyId);
    expect(task.latestRun).toBeNull();
    const runId = crypto.randomUUID();
    const revision = await queue.claim(task.id, task.revision, runId);
    expect(revision).toBeDefined();
    expect(await queue.get(task.id)).toMatchObject({
      status: "in-progress",
      revision,
      latestRun: { id: runId, phase: "setup", expiresAt: expect.any(Number) },
    });
    expect(await queue.claim(task.id, task.revision, runId)).toBe(revision);
    expect(
      await queue.claim(task.id, task.revision, crypto.randomUUID()),
    ).toBeUndefined();
    expect(await queue.next()).toBeUndefined();

    const read = async () =>
      Schema.decodeUnknownSync(TaskSnapshot)(
        await (await call(tasksApi, undefined, cookie)).json(),
      );
    const before = await read();
    published.length = 0;
    expect(
      await queue.report(task.id, runId, { phase: "implementation" }),
    ).toBe("updated");
    expect(
      await queue.report(task.id, runId, {
        phase: "checks",
        summary: "Changed the heading and verified it in the browser.",
      }),
    ).toBe("updated");
    expect(
      await queue.report(task.id, runId, {
        phase: "heartbeat",
        activePhase: "implementation",
      }),
    ).toBe("stale");
    const checked = await read();
    expect(checked.version).toBe(before.version + 2);
    expect(published).toEqual([tasksChanged, tasksChanged]);
    expect(checked.tasks.find(({ id }) => id === task.id)).toMatchObject({
      revision,
      latestRun: { id: runId, phase: "checks" },
    });

    expect(
      await queue.report(task.id, runId, {
        phase: "finished",
        outcome: "checks-failed",
        reason: "bun run test exited with code 1.",
      }),
    ).toBe("updated");
    const failed = await queue.get(task.id);
    expect(failed).toMatchObject({
      status: "in-progress",
      revision,
      latestRun: {
        id: runId,
        phase: "finished",
        outcome: "checks-failed",
        summary: "Changed the heading and verified it in the browser.",
        reason: "bun run test exited with code 1.",
        expiresAt: null,
      },
    });
    const reopened = await request(taskApi(task.id), {
      method: "PUT",
      headers: {
        cookie,
        origin: "https://oneapp.example",
        "content-type": "application/json",
        "x-effect-auth-csrf": "1",
      },
      body: JSON.stringify({ ...failed, status: "not-started" }),
    });
    expect(reopened.status).toBe(200);
    const retry = crypto.randomUUID();
    const retryRevision = await queue.claim(
      task.id,
      (await queue.get(task.id)).revision,
      retry,
    );
    expect(retryRevision).toBeDefined();
    expect(await queue.get(task.id)).toMatchObject({
      status: "in-progress",
      latestRun: { id: retry, phase: "setup", summary: null, reason: null },
    });
    expect(
      await queue.report(task.id, retry, { phase: "implementation" }),
    ).toBe("updated");
    expect(
      await queue.report(task.id, retry, {
        phase: "checks",
        summary: "Fixed and verified.",
      }),
    ).toBe("updated");
    expect(await queue.report(task.id, retry, { phase: "deployment" })).toBe(
      "updated",
    );
    expect(
      await queue.report(task.id, runId, {
        phase: "finished",
        outcome: "deployed",
      }),
    ).toBe("stale");
    const deploymentUrl = "https://example.com/build";
    expect(
      await queue.report(task.id, retry, {
        phase: "heartbeat",
        activePhase: "deployment",
        deploymentUrl,
      }),
    ).toBe("updated");
    expect(
      await queue.report(task.id, retry, {
        phase: "finished",
        outcome: "deployed",
      }),
    ).toBe("updated");
    const deployed = await queue.get(task.id);
    expect(deployed.revision).not.toBe(retryRevision);
    expect(deployed).toMatchObject({
      status: "completed",
      latestRun: {
        id: retry,
        outcome: "deployed",
        summary: "Fixed and verified.",
        deploymentUrl,
      },
    });
  } finally {
    await queue.close();
  }
  expect(
    (
      await request(`${cliTokensPath}/${runner.id}`, {
        method: "DELETE",
        headers: {
          cookie,
          origin: "https://oneapp.example",
          "x-effect-auth-csrf": "1",
        },
      })
    ).status,
  ).toBe(204);
  expect(
    (await request(taskRunnerMcpPath, { headers: runner.headers })).status,
  ).toBe(401);
});

const setupMcp = async (
  sqlite: Database,
  bindings?: Parameters<typeof setup>[1],
) => {
  const { call, request, signIn, cookies } = await setup(sqlite, bindings);
  const session = cookies(await signIn(password));
  const origin = "https://oneapp.example";
  const resource = `${origin}/mcp`;
  const redirectUri = "http://127.0.0.1:52127/callback";
  const form = (
    path: string,
    fields: Record<string, string>,
    cookie?: string,
  ) =>
    request(path, {
      method: "POST",
      headers: { origin, ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(fields),
    });

  const connect = async (scopes?: string[]) => {
    const verifier = Base64Url.encode(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const authorization = new URLSearchParams({
      response_type: "code",
      client_id: codexClientId,
      redirect_uri: redirectUri,
      resource,
      code_challenge_method: "S256",
      code_challenge: Base64Url.encode(new Uint8Array(digest)),
      ...(scopes === undefined ? {} : { scope: scopes.join(" ") }),
    });
    const start = await request(
      `${mcpOAuth.paths.authorize}?${authorization}`,
      { headers: { cookie: session } },
    );
    expect(start.status).toBe(303);
    const consentCookie = [session, cookies(start)].join("; ");
    const consent = await request(mcpOAuth.paths.authorize, {
      headers: { cookie: consentCookie },
    });
    expect(consent.status).toBe(200);
    const csrf = (await consent.text()).match(
      /name="csrf" value="([^"]+)"/,
    )?.[1];
    expect(csrf).toBeDefined();
    const approved = await form(
      mcpOAuth.paths.authorize,
      { decision: "approve", csrf: csrf! },
      consentCookie,
    );
    expect(approved.status, await approved.clone().text()).toBe(303);
    const code = new URL(
      approved.headers.get("location") ?? "",
    ).searchParams.get("code");
    expect(code).toBeTruthy();
    const issued = await form(mcpOAuth.paths.token, {
      grant_type: "authorization_code",
      client_id: codexClientId,
      redirect_uri: redirectUri,
      resource,
      code: code!,
      code_verifier: verifier,
    });
    expect(issued.status, await issued.clone().text()).toBe(200);
    const grant = (await issued.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(grant.scope).toBe((scopes ?? defaultMcpScopes).join(" "));
    return grant;
  };

  const mcp = async (token: string, method: string, params = {}) => {
    const response = await request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const data = response.headers
      .get("content-type")
      ?.startsWith("text/event-stream")
      ? body.match(/^data: (.+)$/m)?.[1]
      : body;
    return JSON.parse(data ?? "") as {
      error?: { message: string };
      result?: {
        tools?: { name: string }[];
        structuredContent?: unknown;
        content?: CallToolResult["content"];
        isError?: boolean;
      };
    };
  };
  const names = async (token: string) =>
    (await mcp(token, "tools/list")).result?.tools
      ?.map(({ name }) => name)
      .sort();
  const useTool = (token: string, name: string, args = {}) =>
    mcp(token, "tools/call", { name, arguments: args });
  const listGrants = async () => {
    const response = await call(mcpGrantsPath, undefined, session);
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(McpGrantList)(await response.json());
  };
  return {
    call,
    request,
    session,
    origin,
    resource,
    form,
    connect,
    names,
    useTool,
    listGrants,
  };
};

it("issues MCP link scopes and exposes only the tools a grant authorises", async () => {
  using sqlite = new Database(":memory:");
  const { request, resource, form, connect, names, useTool, listGrants } =
    await setupMcp(sqlite);

  const challenge = await request("/mcp", { method: "POST" });
  expect(challenge.status).toBe(401);
  expect(challenge.headers.get("www-authenticate")).toContain(
    `scope="${defaultMcpScopes.join(" ")}"`,
  );
  const metadata = await request(
    "/.well-known/oauth-protected-resource/mcp",
    {},
  );
  expect(await metadata.json()).toMatchObject({
    scopes_supported: defaultMcpScopes,
  });

  const connectedAfter = Date.now();
  const full = await connect([linksReadScope, linksWriteScope]);
  const readGrant = await connect([linksReadScope]);
  const read = readGrant.access_token;
  const write = (await connect([linksWriteScope])).access_token;
  expect(await names(full.access_token)).toEqual([
    "delete_link",
    "list_links",
    "save_link",
  ]);
  expect(await names(read)).toEqual(["list_links"]);
  expect(await names(write)).toEqual(["delete_link", "save_link"]);

  const url = "https://example.com/";
  const saved = await useTool(write, "save_link", { url });
  const { link } = saved.result?.structuredContent as { link: { id: string } };
  expect((await useTool(read, "save_link", { url })).error).toBeDefined();
  expect(
    (await useTool(read, "delete_link", { id: link.id })).error,
  ).toBeDefined();
  expect((await useTool(write, "list_links")).error).toBeDefined();
  expect(
    (await useTool(read, "list_links")).result?.structuredContent,
  ).toMatchObject({ links: [link] });
  expect(
    (await useTool(write, "delete_link", { id: link.id })).result
      ?.structuredContent,
  ).toEqual({ id: link.id });

  const grants = await listGrants();
  expect(grants).toHaveLength(3);
  for (const grant of grants) {
    expect(grant.createdAt).toBeGreaterThanOrEqual(connectedAfter);
    expect(grant.createdAt).toBeLessThanOrEqual(Date.now());
    expect(grant.expiresAt - grant.createdAt).toBe(30 * 86_400_000);
  }
  const refreshed = await form(mcpOAuth.paths.token, {
    grant_type: "refresh_token",
    client_id: codexClientId,
    resource,
    refresh_token: readGrant.refresh_token,
  });
  expect(refreshed.status, await refreshed.clone().text()).toBe(200);
  expect(await listGrants()).toEqual(grants);

  sqlite.run(
    `UPDATE yielded_oauth_server SET payload = json_set(payload, '$.authorization.scopes', json('["links:read-write","links:delete"]')) WHERE json_array_length(payload, '$.authorization.scopes') = 2`,
  );
  const old = await request("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${full.access_token}` },
  });
  expect(old.status).toBe(401);
  const refresh = await form(mcpOAuth.paths.token, {
    grant_type: "refresh_token",
    client_id: codexClientId,
    resource,
    refresh_token: full.refresh_token,
  });
  expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
  expect(await listGrants()).toHaveLength(2);
});

it("uses scoped MCP tools to read and edit the same tasks and tags as the web app", async () => {
  using sqlite = new Database(":memory:");
  const objects = new Map<string, ArrayBuffer>();
  const {
    call,
    request,
    session,
    origin,
    connect,
    names,
    useTool,
    listGrants,
  } = await setupMcp(sqlite, {
    FILE_UPLOADS: {
      put: async (key: string, bytes: ArrayBuffer) => {
        objects.set(key, bytes);
        return { size: bytes.byteLength };
      },
      get: async (key: string) => {
        const bytes = objects.get(key);
        return bytes
          ? {
              size: bytes.byteLength,
              body: new Response(bytes).body,
              arrayBuffer: async () => bytes,
            }
          : null;
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
    } as unknown as WorkerEnv["FILE_UPLOADS"],
  });
  const defaults = (await connect()).access_token;
  expect(await names(defaults)).toEqual([
    "create_tag",
    "create_task",
    "delete_link",
    "delete_task",
    "get_task",
    "get_task_attachment",
    "list_links",
    "list_tags",
    "list_tasks",
    "save_link",
    "update_task",
  ]);
  const read = (await connect([tasksReadScope])).access_token;
  const write = (await connect([tasksWriteScope])).access_token;
  expect(await names(read)).toEqual([
    "get_task",
    "get_task_attachment",
    "list_tags",
    "list_tasks",
  ]);
  expect(await names(write)).toEqual([
    "create_tag",
    "create_task",
    "delete_task",
    "update_task",
  ]);
  expect(
    (await useTool(read, "create_task", { title: "Restricted" })).error,
  ).toBeDefined();
  expect((await useTool(write, "list_tasks")).error).toBeDefined();
  expect(await listGrants()).toHaveLength(3);

  const receipts = Schema.decodeUnknownSync(Tag)(
    await (await call(tagsApi, { name: "Receipts" }, session)).json(),
  );
  const createTag = async (name: string) => {
    const reply = await useTool(write, "create_tag", { name });
    return Schema.decodeUnknownSync(Schema.Struct({ tag: Tag }))(
      reply.result?.structuredContent,
    ).tag;
  };
  expect(await createTag("ｒｅｃｅｉｐｔｓ")).toEqual(receipts);
  const review = await createTag("Review");
  const finance = await createTag("Finance");
  expect(
    (await useTool(read, "list_tags", { query: "RECEIP" })).result
      ?.structuredContent,
  ).toEqual({ tags: [receipts], nextOffset: null });

  const requestId = crypto.randomUUID();
  const description = "# Receipt\n" + "a".repeat(19_990);
  const creation = {
    requestId,
    title: "Check receipts",
    description,
    status: "in-review",
    priority: "urgent",
    dueOn: "2028-02-29",
    tagIds: [receipts.id, review.id],
  };
  const task = await useTool(write, "create_task", creation);
  const receipt = task.result?.structuredContent as {
    id: string;
    revision: string;
    url: string;
  };
  expect(receipt).toEqual({
    id: requestId,
    revision: expect.any(String),
    url: `${origin}/tasks/${requestId}`,
  });
  const getTask = async () => {
    const reply = await useTool(read, "get_task", { id: requestId });
    return Schema.decodeUnknownSync(Schema.Struct({ task: Task }))(
      reply.result?.structuredContent,
    ).task;
  };
  expect(await getTask()).toMatchObject({
    description,
    revision: receipt.revision,
    dueOn: creation.dueOn,
  });
  expect(
    (await useTool(write, "get_task", { id: requestId })).error,
  ).toBeDefined();

  const completed = await useTool(write, "create_task", {
    title: "Filed receipts",
    status: "completed",
  });
  const completedId = (completed.result?.structuredContent as { id: string })
    .id;
  const png = Uint8Array.fromBase64(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAwsAAAAASUVORK5CYII=",
  );
  const headers = { cookie: session, origin, "x-effect-auth-csrf": "1" };
  const upload = await request(taskAttachmentsApi(requestId), {
    method: "POST",
    headers: {
      ...headers,
      [fileNameHeader]: "receipt.png",
      "content-type": "application/octet-stream",
    },
    body: png,
  });
  expect(upload.status).toBe(201);
  const attachment = Schema.decodeUnknownSync(TaskAttachment)(
    await upload.json(),
  );
  expect(attachment).toMatchObject({
    name: "receipt.png",
    mediaType: "image/png",
    size: png.byteLength,
  });
  expect(
    (await useTool(read, "get_task", { id: requestId })).result
      ?.structuredContent,
  ).toMatchObject({ task: { attachments: [attachment] } });
  const screenshot = { taskId: requestId, attachmentId: attachment.id };
  expect(
    (await useTool(read, "get_task_attachment", screenshot)).result?.content,
  ).toEqual([{ type: "image", mimeType: "image/png", data: png.toBase64() }]);
  expect(
    (await useTool(write, "get_task_attachment", screenshot)).error,
  ).toBeDefined();
  expect(
    (
      await useTool(read, "get_task_attachment", {
        ...screenshot,
        taskId: completedId,
      })
    ).result?.isError,
  ).toBe(true);
  const preview = taskAttachmentApi(requestId, attachment.id);
  expect((await request(preview, { method: "DELETE", headers })).status).toBe(
    204,
  );
  expect((await request(preview, { headers })).status).toBe(404);
  expect(
    (await useTool(read, "get_task_attachment", screenshot)).result?.isError,
  ).toBe(true);
  const page = (
    await useTool(read, "list_tasks", {
      query: "CHECK",
      status: "in-review",
      priority: "urgent",
      tagId: receipts.id,
      dueOnOrAfter: "2028-02-28",
      dueOnOrBefore: "2028-02-29",
    })
  ).result?.structuredContent as {
    tasks: Record<string, unknown>[];
    nextOffset: number | null;
  };
  expect(page).toMatchObject({ tasks: [receipt], nextOffset: null });
  expect(page.tasks[0]).not.toHaveProperty("description");
  expect(
    (await useTool(read, "list_tasks")).result?.structuredContent,
  ).toMatchObject({ tasks: [{ id: requestId }], nextOffset: null });
  expect(
    (await useTool(read, "list_tasks", { status: "all", limit: 1 })).result
      ?.structuredContent,
  ).toMatchObject({ tasks: [{ id: completedId }], nextOffset: 1 });
  expect(
    (await useTool(read, "list_tasks", { status: "all", limit: 1, offset: 1 }))
      .result?.structuredContent,
  ).toMatchObject({ tasks: [{ id: requestId }], nextOffset: null });

  const invalidStatus = await useTool(write, "update_task", {
    id: requestId,
    revision: receipt.revision,
    status: null,
  });
  expect(Boolean(invalidStatus.error || invalidStatus.result?.isError)).toBe(
    true,
  );
  const edited = await useTool(write, "update_task", {
    id: requestId,
    revision: receipt.revision,
    status: "not-started",
    priority: null,
    dueOn: null,
    addTagIds: [finance.id],
    removeTagIds: [receipts.id],
  });
  const persisted = await getTask();
  expect(edited.result?.structuredContent).toMatchObject({
    id: requestId,
    revision: persisted.revision,
  });
  expect(persisted).toMatchObject({
    title: creation.title,
    description,
    status: "not-started",
    priority: null,
    dueOn: null,
  });
  expect(persisted.tagIds.toSorted()).toEqual(
    [review.id, finance.id].toSorted(),
  );
  expect(
    (await useTool(write, "create_task", creation)).result?.structuredContent,
  ).toEqual(edited.result?.structuredContent);
  const browserIndex = Schema.decodeUnknownSync(TaskIndex)(
    await (await call(tasksApi, undefined, session)).json(),
  );
  expect(browserIndex.tasks.find(({ id }) => id === requestId)).toEqual(
    persisted,
  );

  const savedInBrowser = await request(taskApi(requestId), {
    method: "PUT",
    headers: {
      cookie: session,
      origin,
      "content-type": "application/json",
      "x-effect-auth-csrf": "1",
    },
    body: JSON.stringify({ ...persisted, title: "Renamed in the browser" }),
  });
  expect(savedInBrowser.status).toBe(200);
  const stale = await useTool(write, "update_task", {
    id: requestId,
    revision: persisted.revision,
    title: "Stale title",
  });
  expect(stale.result).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("latest revision") }],
  });
  expect((await getTask()).title).toBe("Renamed in the browser");

  const invalid = await useTool(write, "create_task", {
    title: "Bad date",
    dueOn: "2027-02-29",
  });
  expect(Boolean(invalid.error || invalid.result?.isError)).toBe(true);
  const unknownTag = await useTool(write, "create_task", {
    title: "Bad tag",
    tagIds: [crypto.randomUUID()],
  });
  expect(unknownTag.result?.isError).toBe(true);
  expect(sqlite.query("SELECT id FROM items").all()).toHaveLength(2);
});

it("publishes committed task changes and lets the browser recover a missed signal", async () => {
  using sqlite = new Database(":memory:");
  const published: Array<{ change: string; version: number }> = [];
  let drop = false;
  const { call, request, origin, session, connect, useTool } = await setupMcp(
    sqlite,
    {
      INBOX_UPDATES: {
        getByName: () => ({
          publish: async (change: string) => {
            const row = sqlite
              .query<{ version: number }, []>(
                "SELECT version FROM task_changes",
              )
              .get();
            if (!drop && row) published.push({ change, version: row.version });
          },
        }),
      } as unknown as WorkerEnv["INBOX_UPDATES"],
    },
  );
  const read = (since?: number) =>
    call(
      since === undefined ? tasksApi : `${tasksApi}?since=${since}`,
      undefined,
      session,
    );
  const snapshot = async (response: Response) =>
    Schema.decodeUnknownSync(TaskSnapshot)(await response.json());
  expect((await snapshot(await read())).version).toBe(0);
  expect((await read(0)).status).toBe(204);
  const id = crypto.randomUUID();
  const token = (await connect([tasksWriteScope])).access_token;
  const input = { requestId: id, title: "Live task" };
  const created = await useTool(token, "create_task", input);
  const receipt = created.result?.structuredContent as { revision: string };
  expect(published).toEqual([{ change: tasksChanged, version: 1 }]);
  expect(await snapshot(await read(0))).toMatchObject({
    version: 1,
    tasks: [{ id, title: input.title }],
  });

  drop = true;
  const edit = { id, revision: receipt.revision, title: "Updated remotely" };
  const updated = await useTool(token, "update_task", edit);
  expect(updated.result?.isError).toBeFalsy();
  expect(published).toHaveLength(1);
  const recovered = await snapshot(await read(1));
  expect(recovered).toMatchObject({
    version: 2,
    tasks: [{ id, title: edit.title }],
  });
  expect((await read(2)).status).toBe(204);
  expect((await call(`${tasksApi}?since=2`)).status).toBe(401);

  drop = false;
  await useTool(token, "create_task", input);
  const stale = await useTool(token, "update_task", edit);
  expect(stale.result?.isError).toBe(true);
  expect((await read(2)).status).toBe(204);
  expect(published).toHaveLength(1);

  const browserTask = await call(
    tasksApi,
    {
      id: crypto.randomUUID(),
      title: "Added in the browser",
    },
    session,
  );
  expect(browserTask.status).toBe(201);
  expect(published.at(-1)).toEqual({ change: tasksChanged, version: 3 });
  const browserSaved = (await browserTask.json()) as {
    id: string;
    revision: string;
  };
  const headers = {
    cookie: session,
    origin,
    "content-type": "application/json",
  };
  const browserDelete = (csrf: boolean, revision = browserSaved.revision) =>
    request(taskApi(browserSaved.id), {
      method: "DELETE",
      headers: { ...headers, ...(csrf ? { "x-effect-auth-csrf": "1" } : {}) },
      body: JSON.stringify({ revision }),
    });
  expect((await browserDelete(false)).status).toBe(403);
  expect((await browserDelete(true, crypto.randomUUID())).status).toBe(409);
  expect((await read(3)).status).toBe(204);
  expect((await browserDelete(true)).status).toBe(204);
  expect((await browserDelete(true)).status).toBe(404);
  expect(published.at(-1)).toEqual({ change: tasksChanged, version: 4 });
  expect(await snapshot(await read(3))).toMatchObject({
    version: 4,
    tasks: [{ id }],
  });

  const readToken = (await connect([tasksReadScope])).access_token;
  const { revision } = updated.result?.structuredContent as {
    revision: string;
  };
  expect(
    (await useTool(readToken, "delete_task", { id, revision })).error,
  ).toBeDefined();
  expect(
    (await useTool(token, "delete_task", { id, revision: receipt.revision }))
      .result?.isError,
  ).toBe(true);
  expect((await read(4)).status).toBe(204);
  expect(
    (await useTool(token, "delete_task", { id, revision })).result
      ?.structuredContent,
  ).toEqual({ id });
  expect(
    (await useTool(token, "delete_task", { id, revision })).result?.isError,
  ).toBe(true);
  expect(published.map((event) => event.version)).toEqual([1, 3, 4, 5]);
  expect(await snapshot(await read(4))).toMatchObject({
    version: 5,
    tasks: [],
  });
});

it("stores the validated theme for the authenticated account across sessions", async () => {
  using sqlite = new Database(":memory:");
  const { call, signIn, cookies } = await setup(sqlite);
  const session = cookies(await signIn(password));
  const otherSession = cookies(await signIn(password));
  sqlite.run(
    "INSERT INTO accounts (id, active, security_revision, theme) VALUES ('other', 1, 'revision', 'light')",
  );

  expect(
    await (await call("/api/me", undefined, session)).json(),
  ).toMatchObject({
    theme: "system",
  });
  expect((await call(themePreferencePath, { theme: "dark" })).status).toBe(401);
  expect(
    (
      await call(
        themePreferencePath,
        { theme: "dark" },
        session,
        "https://another.example",
      )
    ).status,
  ).toBe(403);
  expect(
    (await call(themePreferencePath, { theme: "automatic" }, session)).status,
  ).toBe(400);

  for (const theme of ["dark", "light", "system"]) {
    expect((await call(themePreferencePath, { theme }, session)).status).toBe(
      204,
    );
    expect(
      await (await call("/api/me", undefined, otherSession)).json(),
    ).toMatchObject({ theme });
  }
  expect(
    sqlite.query("SELECT theme FROM accounts WHERE id = 'other'").get(),
  ).toEqual({
    theme: "light",
  });
});

it("verifies the signed-in address and changes the password with session invalidation", async () => {
  using sqlite = new Database(":memory:");
  const { call, signIn, cookies, messages, from, setEmailAvailable } =
    await setup(sqlite);
  const newPassword = "example test password phrase";
  const signInResponse = await signIn(password);
  expect(signInResponse.status, await signInResponse.text()).toBe(200);
  const session = cookies(signInResponse);
  const otherSession = cookies(await signIn(password));
  expect(
    await (await call("/api/me", undefined, session)).json(),
  ).toMatchObject({ email, emailVerified: false });
  expect((await call(emailVerificationPath, {})).status).toBe(401);
  expect(
    (await call(emailVerificationPath, {}, session, "https://another.example"))
      .status,
  ).toBe(403);

  const issued = await call(emailVerificationPath, {}, session);
  expect(issued.status, await issued.clone().text()).toBe(200);
  const challenge = (await issued.json()) as object;
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ from, to: email });
  const code = messages[0]?.text.match(/\b\d{6}\b/)?.[0];
  expect(code).toBeDefined();
  const verificationCookie = [session, cookies(issued)].join("; ");
  setEmailAvailable(false);
  const failedSend = await call(emailVerificationPath, {}, verificationCookie);
  expect(failedSend.status).toBe(503);
  expect(cookies(failedSend)).toBe("");
  setEmailAvailable(true);
  const mismatchedSession = [otherSession, cookies(issued)].join("; ");
  expect(
    (
      await call(
        `${emailVerificationPath}/confirm`,
        { ...challenge, code },
        mismatchedSession,
      )
    ).status,
  ).toBe(400);
  const verify = (code: string | undefined) =>
    call(
      `${emailVerificationPath}/confirm`,
      { ...challenge, code },
      verificationCookie,
    );
  expect((await verify(code === "000000" ? "111111" : "000000")).status).toBe(
    400,
  );
  const verified = await verify(code);
  expect(verified.status, await verified.text()).toBe(204);
  expect((await verify(code)).status).toBe(403);
  expect(
    await (await call("/api/me", undefined, session)).json(),
  ).toMatchObject({ email, emailVerified: true });

  const screening = vi.fn(
    async () => new Response("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:0"),
  );
  vi.stubGlobal("fetch", screening);
  try {
    expect(
      (
        await call(
          passwordChangePath,
          { currentPassword: "incorrect", newPassword },
          session,
        )
      ).status,
    ).toBe(400);
    expect(screening).not.toHaveBeenCalled();
    const changed = await call(
      passwordChangePath,
      { currentPassword: password, newPassword },
      session,
    );
    expect(changed.status, await changed.text()).toBe(204);
    expect(cookies(changed)).toContain("__Host-effect-auth-session=");
    expect(messages).toHaveLength(2);
    expect(messages[1]?.text).toContain("password was changed");
    expect((await call("/api/me", undefined, session)).status).toBe(401);
    expect((await call("/api/me", undefined, otherSession)).status).toBe(401);
    expect((await signIn(password)).status).toBe(400);
    expect((await signIn(newPassword)).status).toBe(200);
  } finally {
    vi.unstubAllGlobals();
  }
}, 20_000);

it("changes the sign-in address after password and code verification and keeps owner bootstrap idempotent", async () => {
  using sqlite = new Database(":memory:");
  const { call, signIn, cookies, messages, provision } = await setup(sqlite);
  const session = cookies(await signIn(password));
  const otherSession = cookies(await signIn(password));
  const newEmail = "new-owner@example.net";
  const savedUrl = "https://example.net/bookmark";
  expect((await call(linksPath, { url: savedUrl }, session)).ok).toBe(true);
  const start = (currentPassword: string) =>
    call(
      emailChangePath,
      { email: newEmail.toUpperCase(), currentPassword },
      session,
    );
  const confirm = (id: string, code: string, cookie = session) =>
    call(`${emailChangePath}/confirm`, { id, code }, cookie);

  expect((await start("incorrect")).status).toBe(400);
  expect(messages).toHaveLength(0);

  // Verify the old address first so the redirect also exercises an existing email credential.
  const issueVerification = await call(emailVerificationPath, {}, session);
  const originalCode = messages.pop()?.text.match(/\b\d{6}\b/)?.[0];
  expect(
    (
      await call(
        `${emailVerificationPath}/confirm`,
        { ...(await issueVerification.json()), code: originalCode },
        [session, cookies(issueVerification)].join("; "),
      )
    ).status,
  ).toBe(204);

  const request = await start(password);
  expect(request.status, await request.clone().text()).toBe(200);
  const change = (await request.json()) as { id: string; email: string };
  expect(change.email).toBe(newEmail);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.to).toBe(newEmail);
  const code = messages[0]?.text.match(/\b\d{6}\b/)?.[0] ?? "";
  expect(code).toHaveLength(6);
  expect((await signIn(password, newEmail)).status).toBe(400);
  expect((await signIn(password)).status).toBe(200);
  expect((await confirm(change.id, code, otherSession)).status).toBe(400);
  const wrongCode = code === "000000" ? "111111" : "000000";
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await confirm(change.id, wrongCode)).status).toBe(400);
  }
  expect((await confirm(change.id, code)).status).toBe(400);
  expect(messages).toHaveLength(1);

  const retried = await start(password);
  expect(retried.status).toBe(200);
  const { id } = (await retried.json()) as { id: string };
  const freshCode = messages[1]?.text.match(/\b\d{6}\b/)?.[0] ?? "";
  const outcomes = await Promise.all([
    confirm(id, freshCode),
    confirm(id, freshCode),
  ]);
  const changed = outcomes.find((response) => response.ok);
  expect(changed?.status).toBe(200);
  expect(await changed?.json()).toEqual({ oldAddressNotified: true });
  expect(outcomes.filter((response) => response.ok)).toHaveLength(1);
  expect(messages).toHaveLength(3);
  expect(messages[2]).toMatchObject({ to: email });
  expect(messages[2]?.text).toContain("sign-in email was changed");
  expect((await call("/api/me", undefined, session)).status).toBe(401);
  expect((await call("/api/me", undefined, otherSession)).status).toBe(401);
  expect((await signIn(password)).status).toBe(400);

  await expect(provision({})).resolves.toEqual({ ready: true });
  await expect(provision({ OWNER_EMAIL: email })).resolves.toEqual({
    ready: true,
  });
  const signedIn = await signIn(password, newEmail);
  expect(signedIn.status).toBe(200);
  const newSession = cookies(signedIn);
  expect(
    await (await call(linksPath, undefined, newSession)).json(),
  ).toMatchObject([{ url: savedUrl }]);
  expect(
    await (await call("/api/me", undefined, newSession)).json(),
  ).toMatchObject({
    id: "owner",
    email: newEmail,
    emailVerified: true,
  });
  expect(
    sqlite
      .query(
        "SELECT identifier_value FROM oneapp_auth_emailCredentials WHERE active = 1",
      )
      .get(),
  ).toEqual({ identifier_value: newEmail });
}, 20_000);

it("recovers only a verified address with a single-use link and revokes browser sessions", async () => {
  using sqlite = new Database(":memory:");
  const { call, signIn, cookies, messages, awaitDeliveries, from } =
    await setup(sqlite);
  const session = cookies(await signIn(password));
  const otherSession = cookies(await signIn(password));
  const requestReset = (address = email) =>
    call(passwordResetPath, { email: address });
  const completePath = `${passwordResetPath}/complete`;
  const newPassword = "example replacement password phrase";

  expect((await requestReset()).status).toBe(204);
  expect((await requestReset("unknown@example.net")).status).toBe(204);
  await awaitDeliveries();
  expect(messages).toHaveLength(0);

  const verification = await call(emailVerificationPath, {}, session);
  const code = messages.pop()?.text.match(/\b\d{6}\b/)?.[0];
  const verified = await call(
    `${emailVerificationPath}/confirm`,
    { ...(await verification.json()), code },
    [session, cookies(verification)].join("; "),
  );
  expect(verified.status).toBe(204);

  expect((await requestReset()).status).toBe(204);
  await awaitDeliveries();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ from, to: email });
  const findLink = (body: string) => {
    const link = body.match(/https:\/\/\S+/)?.[0];
    if (!link) throw new Error("Reset email did not include a link");
    return new URL(link);
  };
  const link = findLink(messages[0]!.text);
  expect(link.origin).toBe("https://oneapp.example");
  expect(link.pathname).toBe(resetPasswordPage);
  expect(link.search).toBe("");
  expect(link.hash).toMatch(/^#eal1\./);
  expect((await requestReset()).status).toBe(204);
  await awaitDeliveries();
  expect(messages).toHaveLength(1);

  const landing = await call(link.pathname);
  expect(landing.status).toBe(200);
  expect(landing.headers.get("cache-control")).toBe("no-store");
  expect(landing.headers.get("referrer-policy")).toBe("no-referrer");
  expect(landing.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  expect((await call("/api/me", undefined, session)).status).toBe(200);

  const bodyFor = async (url: URL) => {
    const { reference, secret } = await Effect.runPromise(
      EmailDelivery.parseLinkFragment(Redacted.make(url.hash)),
    );
    return { reference, secret: Redacted.value(secret), newPassword };
  };
  const expired = await bodyFor(link);
  sqlite.run(
    "UPDATE oneapp_auth_proofs SET expires_at = 0 WHERE purpose = 'password-reset'",
  );
  expect((await call(completePath, expired)).status).toBe(400);
  sqlite.run(
    "UPDATE oneapp_auth_proofs SET issued_at = 0 WHERE purpose = 'password-reset'",
  );
  expect((await requestReset()).status).toBe(204);
  await awaitDeliveries();

  const body = await bodyFor(findLink(messages[1]!.text));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:0")),
  );
  try {
    expect(
      (await call(completePath, body, undefined, "https://another.example"))
        .status,
    ).toBe(403);
    expect(
      (
        await call(completePath, {
          ...body,
          secret: (body.secret[0] === "A" ? "B" : "A") + body.secret.slice(1),
        })
      ).status,
    ).toBe(400);
    expect((await call("/api/me", undefined, session)).status).toBe(200);
    const outcome = await call(completePath, body);
    expect(outcome.status, await outcome.text()).toBe(204);
    expect((await call(completePath, body)).status).toBe(400);
    expect((await call("/api/me", undefined, session)).status).toBe(401);
    expect((await call("/api/me", undefined, otherSession)).status).toBe(401);
    expect((await signIn(password)).status).toBe(400);
    expect((await signIn(newPassword)).status).toBe(200);
  } finally {
    vi.unstubAllGlobals();
  }
}, 20_000);

it("authorizes Bitwarden Desktop and binds its code and refresh token to the desktop client", async () => {
  using sqlite = new Database(":memory:");
  const { request, signIn, cookies } = await setup(sqlite);
  const origin = "https://oneapp.example";
  const cookie = cookies(await signIn(password));
  sqlite.run(
    `INSERT INTO personal_vaults (id, owner_id, kdf_salt, kdf_iterations, wrapped_key,
      key_id, wrapped_private_key, public_key, created_at, revision_at)
     VALUES (?, 'owner', ?, 600000, 'wrapped', ?, 'private', 'public', 1, 1)`,
    [crypto.randomUUID(), email, "0".repeat(32)],
  );

  const callback = "bitwarden://sso-callback";
  const browserCallback = `${origin}/sso-connector.html`;
  const state = "s".repeat(64);
  const verifier = "v".repeat(64);
  const authorize = "/identity/connect/authorize";
  const query = new URLSearchParams({
    client_id: "desktop",
    redirect_uri: callback,
    response_type: "code",
    scope: "api offline_access",
    state,
    code_challenge: await digest(verifier),
    code_challenge_method: "S256",
  });
  const start = (params: URLSearchParams, headers = {}) =>
    request(`${authorize}?${params}`, { headers });
  expect((await start(query)).status).toBe(303);
  for (const redirect_uri of [
    browserCallback,
    `${callback}?extra=1`,
    "bitwarden://unrelated",
  ]) {
    const invalid = new URLSearchParams(query);
    invalid.set("redirect_uri", redirect_uri);
    expect((await start(invalid, { cookie })).status).toBe(400);
  }
  const page = await start(query, { cookie });
  expect(page.status).toBe(200);
  const approval = (await page.text()).match(
    /name="approval" value="([^"]+)"/u,
  )?.[1];
  expect(approval).toBeDefined();
  const form = (path: string, body: Record<string, string>, headers = {}) =>
    request(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(body),
    });
  const approved = await form(
    authorize,
    { approval: approval! },
    { cookie, origin },
  );
  expect(approved.status).toBe(200);
  expect(approved.headers.get("cache-control")).toBe("no-store");
  expect(approved.headers.get("referrer-policy")).toBe("no-referrer");
  const handoff = await approved.text();
  const href = handoff.match(/<a href="([^"]+)">Open Bitwarden<\/a>/u)?.[1];
  expect(href).toBeDefined();
  expect(handoff).not.toContain("Connect vault");
  const target = new URL(href!.replaceAll("&amp;", "&"));
  expect(`${target.protocol}//${target.host}${target.pathname}`).toBe(callback);
  expect(target.searchParams.get("state")).toBe(state);
  const repeatedApproval = await form(
    authorize,
    { approval: approval! },
    { cookie, origin },
  );
  expect(repeatedApproval.status).toBe(400);
  expect(await repeatedApproval.text()).toContain(
    "Start a new Bitwarden sign-in",
  );
  const code = target.searchParams.get("code")!;
  const token = (body: Record<string, string>) =>
    form("/identity/connect/token", { client_id: "desktop", ...body });
  const redeem = {
    grant_type: "authorization_code",
    redirect_uri: callback,
    code,
    code_verifier: verifier,
    deviceIdentifier: crypto.randomUUID(),
    deviceName: "Mac desktop",
  };
  expect(
    (await token({ ...redeem, redirect_uri: browserCallback })).status,
  ).toBe(400);
  expect(
    (
      await token({
        ...redeem,
        client_id: "browser",
        redirect_uri: browserCallback,
      })
    ).status,
  ).toBe(400);
  const exchanged = await token(redeem);
  expect(exchanged.status).toBe(200);
  const issued = (await exchanged.json()) as {
    access_token: string;
    refresh_token: string;
  };
  const checkClient = (jwt: string) =>
    JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString())
      .client_id;
  expect(checkClient(issued.access_token)).toBe("desktop");
  expect((await token(redeem)).status).toBe(400);
  const refresh = {
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
  };
  expect((await token({ ...refresh, client_id: "browser" })).status).toBe(400);
  const refreshed = await token(refresh);
  expect(refreshed.status).toBe(200);
  const successor = (await refreshed.json()) as typeof issued;
  expect(checkClient(successor.access_token)).toBe("desktop");
  expect(
    (
      await request("/api/sync", {
        headers: { authorization: `Bearer ${successor.access_token}` },
      })
    ).status,
  ).toBe(200);
});

it("scopes Bitwarden and web writes to the current account and vault", async () => {
  using sqlite = new Database(":memory:");
  const origin = "https://oneapp.example";
  const {
    call,
    request,
    signIn,
    cookies,
    objects,
    finishWork,
    loseStoredFileResponse,
  } = await setup(sqlite);
  const vaultId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  const otherVaultId = crypto.randomUUID();
  const keyId = "0".repeat(32);
  sqlite
    .query(
      "INSERT INTO accounts (id, active, security_revision) VALUES ('other', 1, '1')",
    )
    .run();
  const seedVault = sqlite.query(`
    INSERT INTO personal_vaults (id, owner_id, kdf_salt, kdf_iterations, wrapped_key, key_id,
       wrapped_private_key, public_key, created_at, revision_at)
    VALUES (?, ?, ?, 600000, 'wrapped', ?, 'wrapped-private', 'public', 1, 1)
  `);
  seedVault.run(vaultId, "owner", email, keyId);
  seedVault.run(otherVaultId, "other", "other@example.net", keyId);
  const encrypted = (bytes: number, fill = 0) => {
    const block = (length: number) =>
      Buffer.alloc(length, fill).toString("base64");
    return `2.${block(16)}|${block(bytes)}|${block(32)}`;
  };
  const legacyDetails = {
    credentials: {
      username: encrypted(16, 40),
      password: encrypted(16, 41),
      uris: [{ uri: encrypted(16, 42), match: null }],
    },
  };
  const seedLogin = sqlite.query(`
    INSERT INTO personal_vault_logins (id, vault_id, name, wrapped_key, details, created_at, revision_at)
    VALUES (?, ?, 'encrypted', 'wrapped', ?, 1, 1)
  `);
  seedLogin.run(itemId, vaultId, JSON.stringify(legacyDetails));
  const otherItemId = crypto.randomUUID();
  seedLogin.run(otherItemId, otherVaultId, JSON.stringify(legacyDetails));

  const callback = `${origin}/sso-connector.html`;
  const verifier = "v".repeat(64);
  const challenge = Base64Url.encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const authorization = "/identity/connect/authorize";
  const authorize = `${authorization}?${new URLSearchParams({
    client_id: "browser",
    redirect_uri: callback,
    response_type: "code",
    scope: "api offline_access",
    state: `${"s".repeat(64)}:clientId=browser`,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })}`;
  const guest = await request(authorize, {});
  expect(guest.status).toBe(303);
  expect(
    new URL(guest.headers.get("location")!).searchParams.get(
      "connectBitwarden",
    ),
  ).toBe("1");

  const cookie = cookies(await signIn(password));
  const otherBrowser = cookies(await signIn(password));
  const page = await request(authorize, { headers: { cookie } });
  expect(page.status).toBe(200);
  const approval = (await page.text()).match(
    /name="approval" value="([^"]+)"/u,
  )?.[1];
  expect(approval).toBeDefined();

  const form = (
    path: string,
    body: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    request(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(body),
    });
  const consent = { approval: approval! };
  expect(
    (
      await form(authorization, consent, {
        cookie,
        origin: "https://other.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (await form(authorization, consent, { cookie: otherBrowser, origin }))
      .status,
  ).toBe(400);
  const approved = await form(authorization, consent, { cookie, origin });
  expect(approved.status).toBe(303);
  const code = new URL(approved.headers.get("location")!).searchParams.get(
    "code",
  )!;

  const token = (body: Record<string, string>) =>
    form("/identity/connect/token", { client_id: "browser", ...body });
  const codeGrant = {
    grant_type: "authorization_code",
    code,
    redirect_uri: callback,
    deviceIdentifier: "test-device",
  };
  expect(
    (await token({ ...codeGrant, code_verifier: "x".repeat(64) })).status,
  ).toBe(400);
  const redemption = await Promise.all([
    token({ ...codeGrant, code_verifier: verifier }),
    token({ ...codeGrant, code_verifier: verifier }),
  ]);
  expect(redemption.map((response) => response.status).sort()).toEqual([
    200, 400,
  ]);
  const issued = (await redemption.find((response) => response.ok)!.json()) as {
    access_token: string;
    refresh_token: string;
  };
  const sync = (accessToken: string) =>
    request("/api/sync", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  const snapshot = (await (await sync(issued.access_token)).json()) as {
    ciphers: { id: string }[];
  };
  expect(snapshot.ciphers.map(({ id }) => id)).toEqual([itemId]);

  const login = {
    type: 1,
    encryptedFor: vaultId,
    encryptedByKeyId: keyId,
    name: encrypted(16),
    key: encrypted(80),
    notes: encrypted(16, 1),
    favorite: true,
    login: {
      password: encrypted(16, 2),
      uris: [
        { uri: encrypted(32, 3), match: null, uriChecksum: encrypted(48, 4) },
        { uri: encrypted(32, 5), match: 3 },
      ],
    },
  };
  const write = (accessToken: string, body: object, id?: string) =>
    request(id ? `/api/ciphers/${id}` : "/api/ciphers", {
      method: id ? "PUT" : "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
  const save = (accessToken: string, body: object = login) =>
    write(accessToken, body);
  expect((await save("unknown")).status).toBe(401);
  expect(
    (await save(issued.access_token, { ...login, encryptedFor: otherVaultId }))
      .status,
  ).toBe(400);
  expect(
    (
      await save(issued.access_token, {
        ...login,
        encryptedByKeyId: "1".repeat(32),
      })
    ).status,
  ).toBe(409);
  expect(
    (await save(issued.access_token, { ...login, name: "plaintext" })).status,
  ).toBe(400);
  expect(
    (
      await save(issued.access_token, {
        ...login,
        organizationId: otherVaultId,
      })
    ).status,
  ).toBe(400);
  const saves = await Promise.all([
    save(issued.access_token),
    save(issued.access_token),
  ]);
  expect(saves.map((response) => response.status)).toEqual([200, 200]);
  const created = (await saves[0]!.json()) as {
    id: string;
    creationDate: string;
    revisionDate: string;
    deletedDate: string | null;
  };
  expect(created).toMatchObject({
    name: login.name,
    key: login.key,
    notes: login.notes,
    favorite: true,
    login: login.login,
  });
  expect(await saves[1]!.json()).toEqual(created);
  expect(
    sqlite
      .query(
        "SELECT vault_id, revision_at FROM personal_vault_logins WHERE id = ?",
      )
      .get(created.id),
  ).toEqual({
    vault_id: vaultId,
    revision_at: Date.parse(created.revisionDate),
  });
  const revision = await request("/api/accounts/revision-date", {
    headers: { authorization: `Bearer ${issued.access_token}` },
  });
  expect(await revision.json()).toBe(Date.parse(created.revisionDate));
  const afterSave = (await (
    await sync(issued.access_token)
  ).json()) as typeof snapshot;
  expect(afterSave.ciphers.map(({ id }) => id).sort()).toEqual(
    [itemId, created.id].sort(),
  );

  const changed = {
    ...login,
    lastKnownRevisionDate: created.revisionDate,
    login: { ...login.login, password: encrypted(16, 6) },
  };
  const edit = (body: object = changed, id = created.id) =>
    write(issued.access_token, body, id);
  expect((await edit(login)).status).toBe(400);
  expect(
    (await edit({ ...changed, lastKnownRevisionDate: "invalid" })).status,
  ).toBe(400);
  expect((await edit(changed, otherItemId)).status).toBe(404);
  expect((await write("unknown", changed, created.id)).status).toBe(401);
  expect((await edit({ ...changed, encryptedFor: otherVaultId })).status).toBe(
    400,
  );
  const edits = await Promise.all([
    edit(),
    edit({ ...changed, login: { ...login.login, password: encrypted(16, 7) } }),
  ]);
  expect(edits.map((response) => response.status).sort()).toEqual([200, 409]);
  const winner = edits.findIndex((response) => response.ok);
  const edited = (await edits[winner]!.json()) as typeof created;
  expect(edited).toMatchObject({
    id: created.id,
    creationDate: created.creationDate,
    edit: true,
    organizationUseTotp: false,
    login: { ...login.login, password: encrypted(16, 6 + winner) },
  });
  expect(Date.parse(edited.revisionDate)).toBeGreaterThan(
    Date.parse(created.revisionDate),
  );
  expect(await edits[1 - winner]!.json()).toMatchObject({
    error: "stale_cipher",
  });
  expect(await (await save(issued.access_token)).json()).toEqual(edited);
  expect((await edit()).status).toBe(409);
  const afterEdit = (await (
    await sync(issued.access_token)
  ).json()) as typeof snapshot;
  expect(afterEdit.ciphers.find(({ id }) => id === created.id)).toEqual(edited);
  expect(
    sqlite
      .query("SELECT revision_at FROM personal_vaults WHERE id = ?")
      .get(vaultId),
  ).toEqual({ revision_at: Date.parse(edited.revisionDate) });

  const lifecycle = (
    action: "delete" | "restore",
    id = created.id,
    accessToken = issued.access_token,
  ) =>
    request(`/api/ciphers/${id}/${action}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  const readLogin = async () => {
    const snapshot = (await (await sync(issued.access_token)).json()) as {
      ciphers: (typeof created & { login: typeof login.login })[];
    };
    return snapshot.ciphers.find(({ id }) => id === created.id)!;
  };
  expect((await lifecycle("delete", otherItemId)).status).toBe(404);
  expect((await lifecycle("restore", otherItemId)).status).toBe(404);
  expect((await lifecycle("delete", created.id, "unknown")).status).toBe(401);
  expect(await (await lifecycle("restore")).json()).toEqual(edited);

  expect((await lifecycle("delete")).status).toBe(204);
  const trashed = await readLogin();
  expect(trashed).toEqual({
    ...edited,
    deletedDate: trashed.revisionDate,
    revisionDate: trashed.revisionDate,
    permissions: { delete: false, restore: true },
  });
  expect(Date.parse(trashed.revisionDate)).toBeGreaterThan(
    Date.parse(edited.revisionDate),
  );
  expect((await lifecycle("delete")).status).toBe(204);
  expect(await (await save(issued.access_token)).json()).toEqual(trashed);
  for (const revision of [edited.revisionDate, trashed.revisionDate]) {
    const rejected = await edit({
      ...changed,
      lastKnownRevisionDate: revision,
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: "cipher_trashed" });
  }
  expect(await readLogin()).toEqual(trashed);
  expect(
    sqlite
      .query("SELECT revision_at FROM personal_vaults WHERE id = ?")
      .get(vaultId),
  ).toEqual({ revision_at: Date.parse(trashed.revisionDate) });

  const restore = await lifecycle("restore");
  expect(restore.status).toBe(200);
  const restored = (await restore.json()) as typeof created;
  expect(restored).toEqual({ ...edited, revisionDate: restored.revisionDate });
  expect(Date.parse(restored.revisionDate)).toBeGreaterThan(
    Date.parse(trashed.revisionDate),
  );
  expect(await (await lifecycle("restore")).json()).toEqual(restored);
  expect(
    (await edit({ ...changed, lastKnownRevisionDate: edited.revisionDate }))
      .status,
  ).toBe(409);
  expect(await readLogin()).toEqual(restored);
  expect(
    sqlite
      .query("SELECT revision_at FROM personal_vaults WHERE id = ?")
      .get(vaultId),
  ).toEqual({ revision_at: Date.parse(restored.revisionDate) });

  const noteMetadata = {
    favorite: true,
    reprompt: 1,
    fields: [{ type: 0, name: encrypted(16, 11), value: encrypted(32, 11) }],
  };
  const note = {
    type: 2,
    name: encrypted(16, 9),
    key: encrypted(80, 9),
    notes: encrypted(32, 9),
    secureNote: { type: 0 },
    ...noteMetadata,
  };
  for (const invalid of [
    { ...note, notes: "plaintext" },
    { ...note, secureNote: { type: 1 } },
    { ...note, login: login.login },
    { ...note, type: 3 },
  ]) {
    expect((await save(issued.access_token, invalid)).status).toBe(400);
  }
  const noteCreation = await save(issued.access_token, note);
  expect(noteCreation.status).toBe(200);
  const savedNote = (await noteCreation.json()) as typeof created;
  expect(savedNote).toMatchObject({
    type: 2,
    name: note.name,
    notes: note.notes,
    secureNote: { type: 0 },
  });
  expect(savedNote).not.toHaveProperty("login");
  expect(await (await save(issued.access_token, note)).json()).toEqual(
    savedNote,
  );
  const nextNote = {
    ...note,
    notes: encrypted(32, 10),
    lastKnownRevisionDate: savedNote.revisionDate,
  };
  expect(
    (
      await edit(
        { ...note, lastKnownRevisionDate: restored.revisionDate },
        restored.id,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await edit(
        { ...login, lastKnownRevisionDate: savedNote.revisionDate },
        savedNote.id,
      )
    ).status,
  ).toBe(400);
  const noteEdit = await edit(nextNote, savedNote.id);
  expect(noteEdit.status).toBe(200);
  const updatedNote = (await noteEdit.json()) as typeof created;
  expect(updatedNote).toEqual({
    ...savedNote,
    notes: nextNote.notes,
    revisionDate: updatedNote.revisionDate,
  });
  expect(Date.parse(updatedNote.revisionDate)).toBeGreaterThan(
    Date.parse(savedNote.revisionDate),
  );
  expect((await edit(nextNote, savedNote.id)).status).toBe(409);
  const persisted = sqlite
    .query<{ type: number; details: string }, [string]>(
      "SELECT type, details FROM personal_vault_logins WHERE id = ?",
    )
    .get(savedNote.id);
  expect(persisted?.type).toBe(2);
  expect(JSON.parse(persisted!.details)).toEqual({
    ...noteMetadata,
    notes: nextNote.notes,
  });
  const mixedVault = (await (
    await sync(issued.access_token)
  ).json()) as typeof snapshot;
  expect(mixedVault.ciphers).toHaveLength(3);
  expect(mixedVault.ciphers).toContainEqual(restored);
  expect(mixedVault.ciphers).toContainEqual(updatedNote);

  expect((await request(vaultItemsPath, {})).status).toBe(401);
  expect(
    (
      await request(vaultItemsPath, {
        headers: { authorization: `Bearer ${issued.access_token}` },
      })
    ).status,
  ).toBe(401);
  sqlite
    .query("UPDATE personal_vault_logins SET deleted_at = 1 WHERE id = ?")
    .run(itemId);
  const webVault = await request(vaultItemsPath, { headers: { cookie } });
  expect(webVault.status).toBe(200);
  expect(webVault.headers.get("cache-control")).toBe("no-store");
  expect(await webVault.json()).toMatchObject({
    keyId,
    wrappedKey: "wrapped",
    kdfSalt: email,
    kdfIterations: 600_000,
    items: [
      {
        id: restored.id,
        type: 1,
        name: login.name,
        wrappedKey: login.key,
        notes: login.notes,
        requiresMasterPassword: false,
        revision: Date.parse(restored.revisionDate),
        username: null,
        password: encrypted(16, 6 + winner),
        uris: login.login.uris.map(({ uri }) => uri),
      },
      {
        id: updatedNote.id,
        type: 2,
        name: note.name,
        wrappedKey: note.key,
        notes: nextNote.notes,
        requiresMasterPassword: true,
        revision: Date.parse(updatedNote.revisionDate),
      },
    ].sort((a, b) => a.id.localeCompare(b.id)),
    trash: [
      {
        id: itemId,
        type: 1,
        name: "encrypted",
        wrappedKey: "wrapped",
        notes: null,
        requiresMasterPassword: false,
        revision: 1,
        username: legacyDetails.credentials.username,
        password: legacyDetails.credentials.password,
        uris: legacyDetails.credentials.uris.map(({ uri }) => uri),
        details: legacyDetails,
      },
    ],
  });

  const webNote = {
    keyId,
    name: encrypted(16, 12),
    wrappedKey: encrypted(80, 12),
    notes: encrypted(32, 12),
  };
  const postNote = (body = webNote) => call(vaultItemsPath, body, cookie);
  expect((await call(vaultItemsPath, webNote)).status).toBe(401);
  expect(
    (await call(vaultItemsPath, webNote, cookie, "https://other.example"))
      .status,
  ).toBe(403);
  expect(
    (
      await request(vaultItemsPath, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify(webNote),
      })
    ).status,
  ).toBe(403);
  for (const invalid of [
    { ...webNote, name: "plaintext" },
    { ...webNote, notes: "plaintext" },
    { ...webNote, wrappedKey: encrypted(16, 12) },
    { ...webNote, vaultId: otherVaultId },
  ]) {
    expect((await postNote(invalid)).status).toBe(400);
  }
  expect((await postNote({ ...webNote, keyId: "f".repeat(32) })).status).toBe(
    409,
  );
  const savedInWeb = await postNote();
  expect(savedInWeb.status).toBe(201);
  expect(savedInWeb.headers.get("cache-control")).toBe("no-store");
  const webItem = (await savedInWeb.json()) as {
    id: string;
    type: 2;
    revision: number;
  };
  expect(webItem).toMatchObject({
    id: expect.any(String),
    type: 2,
    name: webNote.name,
    wrappedKey: webNote.wrappedKey,
    notes: webNote.notes,
    requiresMasterPassword: false,
    revision: expect.any(Number),
  });
  const vaultRevision = sqlite.query(
    "SELECT revision_at FROM personal_vaults WHERE id = ?",
  );
  const revisionAfterCreate = vaultRevision.get(vaultId);
  expect(await (await postNote()).json()).toEqual(webItem);
  expect(vaultRevision.get(vaultId)).toEqual(revisionAfterCreate);
  expect(vaultRevision.get(otherVaultId)).toEqual({ revision_at: 1 });
  const withWebNote = (await (
    await sync(issued.access_token)
  ).json()) as typeof snapshot;
  expect(withWebNote.ciphers).toHaveLength(4);
  expect(withWebNote.ciphers.find(({ id }) => id === webItem.id)).toMatchObject(
    {
      type: 2,
      name: webNote.name,
      key: webNote.wrappedKey,
      notes: webNote.notes,
      secureNote: { type: 0 },
    },
  );

  const webEdit = {
    keyId,
    expectedRevision: Date.parse(updatedNote.revisionDate),
    name: encrypted(16, 13),
    notes: null,
  };
  const putNote = (
    body: object = webEdit,
    id = savedNote.id,
    headers: HeadersInit = { origin, cookie, "x-effect-auth-csrf": "1" },
  ) => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("content-type", "application/json");
    return request(vaultItemPath(id), {
      method: "PUT",
      headers: requestHeaders,
      body: JSON.stringify(body),
    });
  };
  expect(
    (
      await putNote(webEdit, savedNote.id, {
        origin,
        "x-effect-auth-csrf": "1",
      })
    ).status,
  ).toBe(401);
  expect(
    (await putNote(webEdit, savedNote.id, { origin, cookie })).status,
  ).toBe(403);
  expect((await putNote(webEdit, "invalid")).status).toBe(400);
  expect((await putNote(webEdit, otherItemId)).status).toBe(404);
  expect((await putNote(webEdit, restored.id)).status).toBe(404);
  for (const invalid of [
    { ...webEdit, name: "plaintext" },
    { ...webEdit, notes: "plaintext" },
    { ...webEdit, expectedRevision: 1.5 },
    { ...webEdit, wrappedKey: webNote.wrappedKey },
  ]) {
    expect((await putNote(invalid)).status).toBe(400);
  }
  expect((await putNote({ ...webEdit, keyId: "f".repeat(32) })).status).toBe(
    409,
  );
  expect(
    (
      await putNote({
        ...webEdit,
        expectedRevision: Date.parse(savedNote.revisionDate),
      })
    ).status,
  ).toBe(409);
  expect(vaultRevision.get(vaultId)).toEqual(revisionAfterCreate);

  const savedEdit = await putNote();
  expect(savedEdit.status).toBe(200);
  expect(savedEdit.headers.get("cache-control")).toBe("no-store");
  const editedInWeb = (await savedEdit.json()) as { revision: number };
  expect(editedInWeb).toMatchObject({
    id: savedNote.id,
    type: 2,
    name: webEdit.name,
    wrappedKey: note.key,
    notes: null,
    requiresMasterPassword: true,
    revision: expect.any(Number),
  });
  expect(editedInWeb.revision).toBeGreaterThan(webEdit.expectedRevision);
  expect(vaultRevision.get(vaultId)).toEqual({
    revision_at: editedInWeb.revision,
  });
  expect(await (await putNote()).json()).toEqual(editedInWeb);
  expect(vaultRevision.get(vaultId)).toEqual({
    revision_at: editedInWeb.revision,
  });
  const syncedEdit = (await (
    await sync(issued.access_token)
  ).json()) as typeof snapshot;
  expect(
    syncedEdit.ciphers.find(({ id }) => id === savedNote.id),
  ).toMatchObject({
    ...noteMetadata,
    name: webEdit.name,
    notes: null,
    key: note.key,
    revisionDate: new Date(editedInWeb.revision).toISOString(),
  });

  expect((await lifecycle("delete", savedNote.id)).status).toBe(204);
  const revisionAfterTrash = vaultRevision.get(vaultId);
  const trashedNoteEdit = await putNote({
    ...webEdit,
    expectedRevision: editedInWeb.revision,
  });
  expect(trashedNoteEdit.status).toBe(409);
  expect(await trashedNoteEdit.json()).toEqual({
    error: "This note is in Trash.",
  });
  expect(vaultRevision.get(vaultId)).toEqual(revisionAfterTrash);

  const webLogin = {
    type: 1,
    keyId,
    name: encrypted(16, 14),
    wrappedKey: encrypted(80, 14),
    username: encrypted(16, 15),
    password: encrypted(32, 16),
    website: {
      uri: encrypted(32, 17),
      uriChecksum: encrypted(48, 18),
    },
  };
  const postLogin = (body: object = webLogin) =>
    call(vaultItemsPath, body, cookie);
  expect((await call(vaultItemsPath, webLogin)).status).toBe(401);
  expect(
    (await call(vaultItemsPath, webLogin, cookie, "https://other.example"))
      .status,
  ).toBe(403);
  for (const invalid of [
    { ...webLogin, name: "plaintext" },
    { ...webLogin, username: "plaintext" },
    { ...webLogin, password: "plaintext" },
    {
      ...webLogin,
      website: { ...webLogin.website, uri: "https://example.net" },
    },
    { ...webLogin, website: { ...webLogin.website, uriChecksum: "plaintext" } },
    { ...webLogin, website: { uri: webLogin.website.uri } },
    { ...webLogin, website: { ...webLogin.website, match: 0 } },
    { ...webLogin, vaultId: otherVaultId },
    { ...webLogin, notes: null },
  ]) {
    expect((await postLogin(invalid)).status).toBe(400);
  }
  expect((await postLogin({ ...webLogin, keyId: "f".repeat(32) })).status).toBe(
    409,
  );
  expect(vaultRevision.get(vaultId)).toEqual(revisionAfterTrash);

  const createdLogin = await postLogin();
  expect(createdLogin.status).toBe(201);
  expect(createdLogin.headers.get("cache-control")).toBe("no-store");
  const savedWebLogin = (await createdLogin.json()) as { id: string };
  expect(savedWebLogin).toMatchObject({
    id: expect.any(String),
    type: 1,
    name: webLogin.name,
    wrappedKey: webLogin.wrappedKey,
    notes: null,
    requiresMasterPassword: false,
    revision: expect.any(Number),
    username: webLogin.username,
    password: webLogin.password,
    uris: [webLogin.website.uri],
  });
  const revisionAfterLogin = vaultRevision.get(vaultId);
  expect(await (await postLogin()).json()).toEqual(savedWebLogin);
  expect(vaultRevision.get(vaultId)).toEqual(revisionAfterLogin);
  expect(vaultRevision.get(otherVaultId)).toEqual({ revision_at: 1 });
  const withWebLogin = (await (
    await sync(issued.access_token)
  ).json()) as typeof snapshot;
  expect(withWebLogin.ciphers).toHaveLength(5);
  expect(
    withWebLogin.ciphers.find(({ id }) => id === savedWebLogin.id),
  ).toMatchObject({
    type: 1,
    name: webLogin.name,
    key: webLogin.wrappedKey,
    login: {
      username: webLogin.username,
      password: webLogin.password,
      uris: [{ ...webLogin.website, match: 1 }],
    },
  });
  const passwordOnly = await postLogin({
    ...webLogin,
    username: null,
    website: null,
  });
  expect(passwordOnly.status).toBe(201);
  expect(await passwordOnly.json()).toMatchObject({
    type: 1,
    username: null,
    password: webLogin.password,
    uris: [],
  });

  const editWebLogin = {
    type: 1,
    keyId,
    expectedRevision: Date.parse(restored.revisionDate),
    name: encrypted(16, 19),
    username: encrypted(16, 20),
    password: encrypted(32, 21),
    website: {
      previousUri: login.login.uris[0]!.uri,
      replacement: webLogin.website,
    },
  };
  const putLogin = (body: object = editWebLogin, id = restored.id) =>
    putNote(body, id);
  expect((await putLogin(editWebLogin, otherItemId)).status).toBe(404);
  expect((await putLogin(editWebLogin, webItem.id)).status).toBe(404);
  expect(
    (await putLogin({ ...editWebLogin, password: "plaintext" })).status,
  ).toBe(400);
  expect(
    (
      await putLogin({
        ...editWebLogin,
        expectedRevision: Date.parse(edited.revisionDate),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await putLogin({
        ...editWebLogin,
        website: { ...editWebLogin.website, previousUri: null },
      })
    ).status,
  ).toBe(409);
  const rotatedInWeb = await putLogin();
  expect(rotatedInWeb.status).toBe(200);
  const editedWebLogin = (await rotatedInWeb.json()) as { revision: number };
  expect(editedWebLogin).toMatchObject({
    id: restored.id,
    name: editWebLogin.name,
    wrappedKey: login.key,
    username: editWebLogin.username,
    password: editWebLogin.password,
    uris: [webLogin.website.uri, login.login.uris[1]!.uri],
  });
  expect(editedWebLogin.revision).toBeGreaterThan(
    editWebLogin.expectedRevision,
  );
  expect(await (await putLogin()).json()).toEqual(editedWebLogin);
  expect(vaultRevision.get(vaultId)).toEqual({
    revision_at: editedWebLogin.revision,
  });
  const afterWebRotation = await readLogin();
  expect(afterWebRotation).toMatchObject({
    id: restored.id,
    key: login.key,
    name: editWebLogin.name,
    notes: login.notes,
    favorite: true,
    login: {
      username: editWebLogin.username,
      password: editWebLogin.password,
      passwordRevisionDate: expect.any(String),
      uris: [{ ...webLogin.website, match: 1 }, login.login.uris[1]],
    },
    passwordHistory: [
      { password: encrypted(16, 6 + winner), lastUsedDate: expect.any(String) },
    ],
  });

  const removeWebsite = {
    ...editWebLogin,
    expectedRevision: editedWebLogin.revision,
    website: { previousUri: webLogin.website.uri, replacement: null },
  };
  const clearedWebsite = await putLogin(removeWebsite);
  expect(clearedWebsite.status).toBe(200);
  const clearedWebLogin = (await clearedWebsite.json()) as { revision: number };
  expect(clearedWebLogin).toMatchObject({ uris: [login.login.uris[1]!.uri] });
  expect(await (await putLogin(removeWebsite)).json()).toEqual(clearedWebLogin);
  const afterClear = await readLogin();
  expect(afterClear).toMatchObject({
    ...afterWebRotation,
    revisionDate: new Date(clearedWebLogin.revision).toISOString(),
    login: { ...afterWebRotation.login, uris: [login.login.uris[1]] },
  });

  const newestPassword = encrypted(32, 22);
  const latestDeviceEdit = await edit({
    ...login,
    name: editWebLogin.name,
    lastKnownRevisionDate: afterClear.revisionDate,
    login: { ...afterClear.login, password: newestPassword },
  });
  expect(latestDeviceEdit.status).toBe(200);
  const beforeStaleSave = await readLogin();
  expect(
    (
      await putLogin({
        ...removeWebsite,
        expectedRevision: clearedWebLogin.revision,
        password: encrypted(16, 23),
      })
    ).status,
  ).toBe(409);
  expect(await readLogin()).toEqual(beforeStaleSave);

  const loginRevision = Date.parse(beforeStaleSave.revisionDate);
  const webLifecycle = (
    action: VaultLifecycleAction,
    expectedRevision: number,
    id = restored.id,
    headers: HeadersInit = { cookie, origin, "x-effect-auth-csrf": "1" },
  ) => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("content-type", "application/json");
    return request(vaultLifecyclePath(id, action), {
      method: "PUT",
      headers: requestHeaders,
      body: JSON.stringify({ keyId, expectedRevision }),
    });
  };
  const readWebVault = async () =>
    Schema.decodeUnknownSync(VaultSnapshot)(
      await (await request(vaultItemsPath, { headers: { cookie } })).json(),
    );

  expect(
    (
      await webLifecycle("trash", loginRevision, restored.id, {
        origin,
        "x-effect-auth-csrf": "1",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await webLifecycle("trash", loginRevision, restored.id, {
        origin,
        cookie,
      })
    ).status,
  ).toBe(403);
  expect((await webLifecycle("trash", loginRevision, otherItemId)).status).toBe(
    404,
  );
  expect((await webLifecycle("trash", clearedWebLogin.revision)).status).toBe(
    409,
  );
  expect(await readLogin()).toEqual(beforeStaleSave);

  const webTrash = await webLifecycle("trash", loginRevision);
  expect(webTrash.status).toBe(200);
  expect(webTrash.headers.get("cache-control")).toBe("no-store");
  const trashedInWeb = (await webTrash.json()) as {
    id: string;
    revision: number;
  };
  expect(trashedInWeb.id).toBe(restored.id);
  expect(trashedInWeb.revision).toBeGreaterThan(loginRevision);
  expect(await (await webLifecycle("trash", loginRevision)).json()).toEqual(
    trashedInWeb,
  );
  expect(vaultRevision.get(vaultId)).toEqual({
    revision_at: trashedInWeb.revision,
  });
  const trashSnapshot = await readWebVault();
  expect(trashSnapshot.items.some(({ id }) => id === restored.id)).toBe(false);
  expect(trashSnapshot.trash).toContainEqual(trashedInWeb);
  const visibleInBitwardenTrash = await readLogin();
  expect(visibleInBitwardenTrash).toEqual({
    ...beforeStaleSave,
    deletedDate: new Date(trashedInWeb.revision).toISOString(),
    revisionDate: new Date(trashedInWeb.revision).toISOString(),
    permissions: { delete: false, restore: true },
  });
  expect((await webLifecycle("restore", loginRevision)).status).toBe(409);
  expect(vaultRevision.get(vaultId)).toEqual({
    revision_at: trashedInWeb.revision,
  });

  const webRestore = await webLifecycle("restore", trashedInWeb.revision);
  expect(webRestore.status).toBe(200);
  const restoredInWeb = (await webRestore.json()) as typeof trashedInWeb;
  expect(restoredInWeb).toEqual({
    ...trashedInWeb,
    revision: expect.any(Number),
  });
  expect(restoredInWeb.revision).toBeGreaterThan(trashedInWeb.revision);
  expect(
    await (await webLifecycle("restore", trashedInWeb.revision)).json(),
  ).toEqual(restoredInWeb);
  expect((await webLifecycle("trash", loginRevision)).status).toBe(409);
  expect(vaultRevision.get(vaultId)).toEqual({
    revision_at: restoredInWeb.revision,
  });
  expect(await readLogin()).toEqual({
    ...beforeStaleSave,
    revisionDate: new Date(restoredInWeb.revision).toISOString(),
  });
  const restoredSnapshot = await readWebVault();
  expect(restoredSnapshot.items).toContainEqual(restoredInWeb);
  expect(restoredSnapshot.trash.some(({ id }) => id === restored.id)).toBe(
    false,
  );

  const webNoteTrash = await webLifecycle(
    "trash",
    webItem.revision,
    webItem.id,
  );
  expect(webNoteTrash.status).toBe(200);
  const trashedWebNote = (await webNoteTrash.json()) as typeof webItem;
  expect((await readWebVault()).trash).toContainEqual(trashedWebNote);
  const webNoteRestore = await webLifecycle(
    "restore",
    trashedWebNote.revision,
    webItem.id,
  );
  expect(webNoteRestore.status).toBe(200);
  expect((await readWebVault()).items).toContainEqual(
    await webNoteRestore.json(),
  );

  const getCipher = (id: string) =>
    request(`/api/ciphers/${id}`, {
      headers: { authorization: `Bearer ${issued.access_token}` },
    });
  const getWebItem = (id: string) =>
    request(vaultItemPath(id), { headers: { cookie } });
  expect((await getCipher(otherItemId)).status).toBe(404);
  expect((await getWebItem(otherItemId)).status).toBe(404);
  for (const type of extraItemTypes) {
    const { wire, fields } = itemTypes[type];
    const data = Object.fromEntries(
      Object.keys(fields).map((field, index) => [
        field,
        encrypted(16, index + 40),
      ]),
    );
    const firstKey = Object.keys(data)[0]!;
    const properties = {
      name: encrypted(16, type),
      favorite: true,
      notes: encrypted(16, 32),
    };
    const cipher = {
      ...properties,
      type,
      key: encrypted(80, type),
      [wire]: data,
    };
    expect(
      (await save(issued.access_token, { ...cipher, login: {} })).status,
    ).toBe(400);
    expect(
      (
        await save(issued.access_token, {
          ...cipher,
          [wire]: { ...data, invalidField: encrypted(16) },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await save(issued.access_token, {
          ...cipher,
          [wire]: { ...data, [firstKey]: "plaintext" },
        })
      ).status,
    ).toBe(400);

    const saved = await save(issued.access_token, cipher);
    expect(saved.status).toBe(200);
    const original = (await saved.json()) as {
      id: string;
      revisionDate: string;
    };
    expect(await (await getCipher(original.id)).json()).toEqual(original);
    const put = await request(vaultItemPath(original.id), {
      method: "PUT",
      headers: {
        cookie,
        origin,
        "content-type": "application/json",
        "x-effect-auth-csrf": "1",
      },
      body: JSON.stringify({
        keyId,
        type,
        name: properties.name,
        expectedRevision: Date.parse(original.revisionDate),
        details: { data: { [firstKey]: null } },
      }),
    });
    expect(put.status).toBe(200);
    const expectedData = { ...data, [firstKey]: null };
    expect(await (await getWebItem(original.id)).json()).toMatchObject({
      id: original.id,
      type,
      wrappedKey: cipher.key,
      details: { data: expectedData, notes: properties.notes, favorite: true },
    });

    const current = (await (
      await getCipher(original.id)
    ).json()) as typeof original;
    const updated = await write(
      issued.access_token,
      {
        type,
        name: properties.name,
        key: cipher.key,
        favorite: false,
        lastKnownRevisionDate: current.revisionDate,
      },
      original.id,
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      id: original.id,
      type,
      key: cipher.key,
      notes: properties.notes,
      favorite: false,
      [wire]: expectedData,
    });
    const synced = (await (
      await sync(issued.access_token)
    ).json()) as typeof snapshot;
    expect(synced.ciphers.find(({ id }) => id === original.id)).toMatchObject({
      id: original.id,
      [wire]: expectedData,
    });

    const webCreate = await call(
      vaultItemsPath,
      {
        ...properties,
        favorite: undefined,
        notes: undefined,
        keyId,
        type,
        wrappedKey: encrypted(80, type + 16),
        details: { data },
      },
      cookie,
    );
    expect(webCreate.status).toBe(201);
    const { id } = (await webCreate.json()) as { id: string };
    expect(await (await getCipher(id)).json()).toMatchObject({
      id,
      type,
      [wire]: data,
    });
  }

  const folderName = encrypted(16, 81);
  const newFolder = await call(
    vaultFoldersPath,
    { keyId, name: folderName },
    cookie,
  );
  expect(newFolder.status).toBe(201);
  const folder = (await newFolder.json()) as {
    id: string;
    name: string;
    revision: number;
  };
  const authorized = { authorization: `Bearer ${issued.access_token}` };
  const browserJson = {
    cookie,
    origin,
    "content-type": "application/json",
    "x-effect-auth-csrf": "1",
  };
  const deviceJson = { ...authorized, "content-type": "application/json" };
  expect(
    await (
      await call(vaultFoldersPath, { keyId, name: folderName }, cookie)
    ).json(),
  ).toEqual(folder);
  expect(
    await (
      await request(`/api/folders/${folder.id}`, { headers: authorized })
    ).json(),
  ).toMatchObject({ id: folder.id, name: folderName });
  const rename = await request(`/api/folders/${folder.id}`, {
    method: "PUT",
    headers: deviceJson,
    body: JSON.stringify({ name: encrypted(16, 82) }),
  });
  expect(rename.status).toBe(200);
  const renamed = (await rename.json()) as { revisionDate: string };
  const browse = async (id: string) =>
    (await (await getWebItem(id)).json()) as {
      id: string;
      revision: number;
      folderId: string | null;
      archivedAt: number | null;
    };
  const select = (
    ids: { id: string; revision: number }[],
    kind: string,
    extra = {},
  ) =>
    request(vaultBulkPath, {
      method: "PUT",
      headers: browserJson,
      body: JSON.stringify({
        keyId,
        kind,
        items: ids.map(({ id, revision }) => ({ id, revision })),
        ...extra,
      }),
    });
  const otherFolder = crypto.randomUUID();
  sqlite.run("INSERT INTO personal_vault_folders VALUES (?, ?, ?, 1, NULL)", [
    otherFolder,
    otherVaultId,
    encrypted(16, 83),
  ]);
  const original = await browse(webItem.id);
  const editedName = encrypted(16, 84);
  const editNote = (folderId: string | null, expectedRevision: number) =>
    request(vaultItemPath(webItem.id), {
      method: "PUT",
      headers: browserJson,
      body: JSON.stringify({
        keyId,
        type: 2,
        name: editedName,
        details: {},
        expectedRevision,
        folderId,
      }),
    });
  expect((await editNote(otherFolder, original.revision)).status).toBe(409);
  expect(await browse(webItem.id)).toEqual(original);
  const filed = await editNote(folder.id, original.revision);
  expect(filed.status).toBe(200);
  const filedItem = Schema.decodeUnknownSync(VaultItem)(await filed.json());
  expect(filedItem).toMatchObject({ name: editedName, folderId: folder.id });
  expect(await (await editNote(folder.id, original.revision)).json()).toEqual(
    filedItem,
  );
  expect((await editNote(null, original.revision)).status).toBe(409);
  expect(await (await editNote(null, filedItem.revision)).json()).toMatchObject(
    {
      folderId: null,
    },
  );
  const initial = await Promise.all([browse(restored.id), browse(webItem.id)]);
  const beforeMove = vaultRevision.get(vaultId);
  expect(
    (await select(initial, "move", { folderId: otherFolder })).status,
  ).toBe(404);
  expect(
    (
      await select([initial[0]!, { id: otherItemId, revision: 1 }], "move", {
        folderId: folder.id,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await select([initial[0]!, { ...initial[1]!, revision: 1 }], "move", {
        folderId: folder.id,
      })
    ).status,
  ).toBe(409);
  expect(vaultRevision.get(vaultId)).toEqual(beforeMove);
  const move = await select(initial, "move", { folderId: folder.id });
  expect(move.status).toBe(200);
  const moved = await Promise.all([browse(restored.id), browse(webItem.id)]);
  expect(moved.every(({ folderId }) => folderId === folder.id)).toBe(true);
  expect(moved[0]!.revision).toBe(moved[1]!.revision);
  expect((await select(initial, "move", { folderId: folder.id })).status).toBe(
    200,
  );
  expect(vaultRevision.get(vaultId)).toEqual({
    revision_at: moved[0]!.revision,
  });

  const archive = await request("/api/ciphers/archive", {
    method: "PUT",
    headers: deviceJson,
    body: JSON.stringify({ ids: moved.map(({ id }) => id) }),
  });
  expect(archive.status).toBe(200);
  const archived = await Promise.all([browse(restored.id), browse(webItem.id)]);
  expect(archived.every(({ archivedAt }) => archivedAt !== null)).toBe(true);
  expect((await select(archived, "unarchive")).status).toBe(200);
  const unarchived = await Promise.all([
    browse(restored.id),
    browse(webItem.id),
  ]);
  expect(unarchived.every(({ archivedAt }) => archivedAt === null)).toBe(true);

  const partial = await request(`/api/ciphers/${restored.id}/partial`, {
    method: "PUT",
    headers: deviceJson,
    body: JSON.stringify({ folderId: folder.id }),
  });
  expect(partial.status).toBe(200);
  expect(await partial.json()).toMatchObject({
    favorite: true,
    folderId: folder.id,
  });

  const removeFolder = (expectedRevision: number) =>
    request(vaultFolderPath(folder.id), {
      method: "DELETE",
      headers: browserJson,
      body: JSON.stringify({ keyId, expectedRevision }),
    });
  expect((await removeFolder(folder.revision)).status).toBe(409);
  expect((await removeFolder(Date.parse(renamed.revisionDate))).status).toBe(
    204,
  );
  const detached = await Promise.all([browse(restored.id), browse(webItem.id)]);
  expect(detached.every(({ folderId }) => folderId === null)).toBe(true);
  expect(detached[0]!.revision).toBeGreaterThan(unarchived[0]!.revision);
  expect((await readWebVault()).folders).toEqual([]);

  expect((await select(detached, "purge")).status).toBe(409);
  expect((await select(detached, "trash")).status).toBe(200);
  const trashSelection = await Promise.all([
    browse(restored.id),
    browse(webItem.id),
  ]);
  const bulkRestore = await request("/api/ciphers/restore", {
    method: "PUT",
    headers: deviceJson,
    body: JSON.stringify({ ids: trashSelection.map(({ id }) => id) }),
  });
  expect(bulkRestore.status).toBe(200);
  expect((await readWebVault()).items).toEqual(
    expect.arrayContaining(
      trashSelection.map(({ id }) => expect.objectContaining({ id })),
    ),
  );
  const chosen = [await browse(webItem.id)];
  expect((await select(chosen, "trash")).status).toBe(200);
  const toPurge = [await browse(webItem.id)];
  expect((await select(toPurge, "purge")).status).toBe(200);
  const purgeRevision = vaultRevision.get(vaultId);
  expect((await select(toPurge, "purge")).status).toBe(200);
  expect(vaultRevision.get(vaultId)).toEqual(purgeRevision);
  expect((await getCipher(webItem.id)).status).toBe(404);

  const importBody = {
    folders: [{ name: encrypted(16, 96) }],
    ciphers: [
      { ...login, name: encrypted(16, 97) },
      {
        type: 3,
        name: encrypted(16, 98),
        key: encrypted(80, 8),
        card: { response: null, number: encrypted(16, 99) },
        archivedDate: "2026-01-01T00:00:00Z",
      },
    ],
    folderRelationships: [{ key: 1, value: 0 }],
  };
  const importDevice = (body: object) =>
    request("/api/ciphers/import", {
      method: "POST",
      headers: deviceJson,
      body: JSON.stringify(body),
    });
  const revisionBeforeImport = vaultRevision.get(vaultId);
  expect(
    (
      await importDevice({
        ...importBody,
        folderRelationships: [{ key: 2, value: 0 }],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await importDevice({
        ...importBody,
        folderRelationships: [
          { key: 1, value: 0 },
          { key: 1, value: 0 },
        ],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await importDevice({
        ...importBody,
        ciphers: [login, { ...login, login: { fido2Credentials: [{}] } }],
      })
    ).status,
  ).toBe(400);
  expect(vaultRevision.get(vaultId)).toEqual(revisionBeforeImport);

  sqlite.exec(`CREATE TRIGGER fail_test_import BEFORE INSERT ON personal_vault_logins
    WHEN NEW.type = 3 BEGIN SELECT RAISE(ABORT, 'fixture import failure'); END;`);
  expect((await importDevice(importBody)).status).toBe(503);
  expect(vaultRevision.get(vaultId)).toEqual(revisionBeforeImport);
  expect((await readWebVault()).folders).toEqual([]);
  expect(sqlite.query("SELECT id FROM personal_vault_imports").all()).toEqual(
    [],
  );
  sqlite.exec("DROP TRIGGER fail_test_import");

  const importedResponses = await Promise.all([
    importDevice(importBody),
    call(vaultImportPath, { keyId, ...importBody }, cookie),
  ]);
  expect(importedResponses.map((response) => response.status)).toEqual([
    204, 200,
  ]);
  expect(await importedResponses[1]!.json()).toEqual({ items: 2, folders: 1 });
  const imported = await readWebVault();
  expect(imported.folders).toHaveLength(1);
  expect(
    imported.items.filter(({ name }) => name === importBody.ciphers[0]!.name),
  ).toHaveLength(1);
  expect(
    imported.items.find(({ name }) => name === importBody.ciphers[1]!.name),
  ).toMatchObject({
    type: 3,
    folderId: imported.folders[0]!.id,
    archivedAt: Date.parse("2026-01-01T00:00:00Z"),
  });
  const revisionAfterImport = vaultRevision.get(vaultId);
  expect((await importDevice(importBody)).status).toBe(204);
  expect(vaultRevision.get(vaultId)).toEqual(revisionAfterImport);

  const fileItem = await browse(restored.id);
  const initialFile = {
    keyId,
    expectedRevision: fileItem.revision,
    name: encrypted(16, 100),
    wrappedKey: encrypted(80, 100),
    size: 65,
  };
  const reserve = (item: string, input = initialFile) =>
    call(vaultAttachmentsPath(item), input, cookie);
  expect((await reserve(otherItemId)).status).toBe(404);
  expect(
    (
      await reserve(fileItem.id, {
        ...initialFile,
        size: vaultAttachmentLimit + 1,
      })
    ).status,
  ).toBe(400);
  expect(
    (await reserve(fileItem.id, { ...initialFile, size: 66 })).status,
  ).toBe(413);
  expect(
    (await reserve(fileItem.id, { ...initialFile, expectedRevision: 1 }))
      .status,
  ).toBe(409);
  const oldPending = crypto.randomUUID().replaceAll("-", "");
  sqlite.run(
    `INSERT INTO personal_vault_attachments
    (id, item_id, name, wrapped_key, size, item_key, revision_at, expires_at, create_digest)
    SELECT ?, id, ?, ?, ?, wrapped_key, revision_at, ?, ? FROM personal_vault_logins WHERE id = ?`,
    [
      oldPending,
      initialFile.name,
      initialFile.wrappedKey,
      vaultAttachmentQuota - 64,
      Date.now() + 60_000,
      "quota fixture",
      fileItem.id,
    ],
  );
  expect((await reserve(fileItem.id)).status).toBe(413);
  sqlite.run(
    "UPDATE personal_vault_attachments SET expires_at = 0 WHERE id = ?",
    [oldPending],
  );
  const reserved = await reserve(fileItem.id);
  expect(reserved.status).toBe(201);
  const file = (await reserved.json()) as { id: string };
  expect(await (await reserve(fileItem.id)).json()).toMatchObject({
    id: file.id,
  });
  const wireFilePath = `/api/ciphers/${fileItem.id}/attachment/${file.id}`;
  const webFilePath = vaultAttachmentPath(fileItem.id, file.id);
  expect((await request(wireFilePath, { headers: authorized })).status).toBe(
    404,
  );
  expect(await (await getCipher(fileItem.id)).json()).toMatchObject({
    attachments: [],
  });
  const bytes = new Uint8Array(65).fill(7);
  bytes[0] = 2;
  const putFile = (content: Uint8Array<ArrayBuffer>) =>
    request(webFilePath, {
      method: "PUT",
      headers: { ...browserJson, "content-type": "application/octet-stream" },
      body: content,
    });
  expect((await putFile(bytes.subarray(0, 64))).status).toBe(413);
  loseStoredFileResponse();
  expect((await putFile(bytes)).status).toBeGreaterThanOrEqual(500);
  expect(objects.size).toBe(1);
  expect(await (await getCipher(fileItem.id)).json()).toMatchObject({
    attachments: [],
  });
  expect((await putFile(bytes)).status).toBe(204);
  expect((await putFile(bytes)).status).toBe(204);
  expect(objects.size).toBe(1);
  const revised = await browse(fileItem.id);
  expect(revised.revision).toBeGreaterThan(fileItem.revision);
  expect(await (await getCipher(fileItem.id)).json()).toMatchObject({
    attachments: [
      {
        id: file.id,
        fileName: initialFile.name,
        key: initialFile.wrappedKey,
        size: "65",
        url: "",
      },
    ],
  });
  const rewrapped = {
    ...login,
    key: encrypted(80, 104),
    lastKnownRevisionDate: new Date(revised.revision).toISOString(),
    attachments: { [file.id]: encrypted(16, 105) },
    attachments2: {
      [file.id]: {
        fileName: encrypted(16, 105),
        key: encrypted(80, 105),
        lastKnownRevisionDate: new Date(revised.revision).toISOString(),
      },
    },
  };
  const staleRewrap = await write(
    issued.access_token,
    {
      ...rewrapped,
      lastKnownRevisionDate: new Date(fileItem.revision).toISOString(),
    },
    fileItem.id,
  );
  expect(staleRewrap.status).toBe(409);
  const savedRewrap = await write(issued.access_token, rewrapped, fileItem.id);
  expect(savedRewrap.status).toBe(200);
  expect(await savedRewrap.json()).toMatchObject({
    key: rewrapped.key,
    attachments: [
      {
        id: file.id,
        fileName: rewrapped.attachments2[file.id]!.fileName,
        key: rewrapped.attachments2[file.id]!.key,
      },
    ],
  });
  expect(await (await getCipher(fileItem.id)).json()).toMatchObject({
    attachments: [{ id: file.id, key: rewrapped.attachments2[file.id]!.key }],
  });
  const fileMetadata = await request(wireFilePath, { headers: authorized });
  expect(fileMetadata.status).toBe(200);
  const transfer = (await fileMetadata.json()) as { url: string };
  expect(
    new Uint8Array(await (await request(transfer.url, {})).arrayBuffer()),
  ).toEqual(bytes);
  expect(
    (await request(transfer.url.replace(file.id, "f".repeat(32)), {})).status,
  ).toBe(401);
  const realNow = Date.now();
  const later = vi.spyOn(Date, "now").mockReturnValue(realNow + 61_000);
  try {
    expect((await request(transfer.url, {})).status).toBe(401);
  } finally {
    later.mockRestore();
  }
  sqlite.run(
    "UPDATE bitwarden_device_sessions SET security_revision = 'revoked fixture' WHERE vault_id = ?",
    [vaultId],
  );
  try {
    expect((await request(transfer.url, {})).status).toBe(404);
  } finally {
    sqlite.run(
      "UPDATE bitwarden_device_sessions SET security_revision = (SELECT security_revision FROM accounts WHERE id = 'owner') WHERE vault_id = ?",
      [vaultId],
    );
  }
  expect(
    (
      await request(vaultAttachmentPath(otherItemId, file.id), {
        headers: { cookie },
      })
    ).status,
  ).toBe(404);
  expect((await request(webFilePath, {})).status).toBe(401);
  expect((await select([await browse(fileItem.id)], "trash")).status).toBe(200);
  expect(
    new Uint8Array(
      await (await request(webFilePath, { headers: { cookie } })).arrayBuffer(),
    ),
  ).toEqual(bytes);
  expect((await select([await browse(fileItem.id)], "purge")).status).toBe(200);
  await finishWork();
  expect(objects.has(file.id)).toBe(false);
  expect((await request(transfer.url, {})).status).toBe(404);
  expect(
    sqlite
      .query("SELECT id FROM personal_vault_attachment_cleanup WHERE id = ?")
      .all(file.id),
  ).toEqual([]);

  const refresh = {
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
  };
  const rotated = await Promise.all([token(refresh), token(refresh)]);
  expect(rotated.map((response) => response.status)).toEqual([200, 200]);
  const successor = (await rotated[0]!.json()) as typeof issued;
  expect(
    ((await rotated[1]!.json()) as typeof issued).refresh_token ===
      successor.refresh_token,
  ).toBe(true);
  expect(successor.refresh_token !== issued.refresh_token).toBe(true);
  expect((await sync(successor.access_token)).status).toBe(200);
  expect((await request("/api/sync", { method: "POST" })).status).toBe(405);
  sqlite.query("UPDATE bitwarden_device_sessions SET retry_until = 0").run();
  expect((await sync(issued.access_token)).status).toBe(401);
  expect((await token(refresh)).status).toBe(400);

  sqlite
    .query(
      "UPDATE accounts SET security_revision = 'changed' WHERE id = 'owner'",
    )
    .run();
  expect((await sync(successor.access_token)).status).toBe(401);
  expect((await postNote()).status).toBe(401);
  expect((await putNote()).status).toBe(401);
  expect((await postLogin()).status).toBe(401);
  expect((await webLifecycle("trash", restoredInWeb.revision)).status).toBe(
    401,
  );
  expect((await save(successor.access_token)).status).toBe(401);
  expect(
    (await lifecycle("restore", created.id, successor.access_token)).status,
  ).toBe(401);
  expect(
    (await write(successor.access_token, changed, created.id)).status,
  ).toBe(401);
  expect(
    (await token({ ...refresh, refresh_token: successor.refresh_token }))
      .status,
  ).toBe(400);
  expect((await token(refresh)).status).toBe(400);
}, 20_000);

it("lists Bitwarden devices and revokes all grants for just the selected installation", async () => {
  using sqlite = new Database(":memory:");
  const { request, signIn, cookies } = await setup(sqlite);
  const origin = "https://oneapp.example";
  const cookie = cookies(await signIn(password));
  const list = (session?: string) =>
    request(bitwardenDevicesPath, {
      headers: session ? { cookie: session } : {},
    });
  const revoke = (id: string, from = origin) =>
    request(`${bitwardenDevicesPath}/${id}`, {
      method: "DELETE",
      headers: { cookie, origin: from, "x-effect-auth-csrf": "1" },
    });
  expect((await list()).status).toBe(401);
  expect(await (await list(cookie)).json()).toEqual([]);

  const vaultId = crypto.randomUUID();
  const otherVaultId = crypto.randomUUID();
  sqlite
    .query(
      "INSERT INTO accounts (id, active, security_revision) VALUES ('other', 1, '1')",
    )
    .run();
  const vault = sqlite.query(`
    INSERT INTO personal_vaults (id, owner_id, kdf_salt, kdf_iterations, wrapped_key,
      key_id, wrapped_private_key, public_key, created_at, revision_at)
    VALUES (?, ?, ?, 600000, 'wrapped', 'key', 'private', 'public', 1, 1)
  `);
  vault.run(vaultId, "owner", email);
  vault.run(otherVaultId, "other", "other@example.net");

  const now = Date.now();
  const seedDevice = async (
    vault: string,
    id: string,
    name: string | null,
    expiresAt: number,
  ) => {
    const access = randomSecret();
    const refresh = randomSecret();
    const previousAccess = randomSecret();
    const previousRefresh = randomSecret();
    const [
      accessDigest,
      refreshDigest,
      previousAccessDigest,
      previousRefreshDigest,
    ] = await Promise.all([
      digest(access),
      digest(refresh),
      digest(previousAccess),
      digest(previousRefresh),
    ]);
    sqlite
      .query(
        `
      INSERT INTO bitwarden_device_sessions (id, vault_id, device_id, device_name, security_revision,
        email, email_verified, expires_at, generation, issued_at, access_digest, refresh_digest,
        previous_access_digest, previous_refresh_digest, retry_until)
      SELECT ?, v.id, ?, ?, a.security_revision, v.kdf_salt, 1, ?, 1, ?, ?, ?, ?, ?, ?
      FROM personal_vaults v JOIN accounts a ON a.id = v.owner_id WHERE v.id = ?
    `,
      )
      .run(
        crypto.randomUUID(),
        id,
        name,
        expiresAt,
        Math.floor(now / 1000),
        accessDigest,
        refreshDigest,
        previousAccessDigest,
        previousRefreshDigest,
        now + 60_000,
        vault,
      );
    return { access, refresh, previousAccess, previousRefresh };
  };
  const expires = now + deviceLifetimeMillis;
  const target = "selected-chrome";
  const other = "other-browser";
  const [current, older, survivor, foreign] = await Promise.all([
    seedDevice(vaultId, target, "Chrome", expires),
    seedDevice(vaultId, target, "Older connection", expires - 2_000),
    seedDevice(vaultId, other, null, expires - 1_000),
    seedDevice(otherVaultId, target, "Another account", expires + 1_000),
    seedDevice(vaultId, "expired", "Expired", now - 1),
  ]);
  const listed = await list(cookie);
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  expect(await listed.json()).toEqual([
    { id: target, name: "Chrome", createdAt: now },
    { id: other, name: "Browser extension", createdAt: now - 1_000 },
  ]);

  const sync = (access: string) =>
    request("/api/sync", { headers: { authorization: `Bearer ${access}` } });
  const refresh = (credential: string) =>
    request("/identity/connect/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "browser",
        grant_type: "refresh_token",
        refresh_token: credential,
      }),
    });
  expect((await revoke(target, "https://other.example")).status).toBe(403);
  expect((await sync(current.access)).status).toBe(200);
  expect((await sync(current.previousAccess)).status).toBe(200);
  expect((await revoke(target)).status).toBe(204);
  expect((await revoke(target)).status).toBe(204);
  expect(await (await list(cookie)).json()).toEqual([
    { id: other, name: "Browser extension", createdAt: now - 1_000 },
  ]);
  for (const grant of [current, older]) {
    for (const access of [grant.access, grant.previousAccess]) {
      expect((await sync(access)).status).toBe(401);
    }
    for (const credential of [grant.refresh, grant.previousRefresh]) {
      const rejected = await refresh(credential);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ error: "invalid_grant" });
    }
  }
  expect((await sync(survivor.access)).status).toBe(200);
  expect((await sync(foreign.access)).status).toBe(200);
  expect((await refresh(survivor.refresh)).status).toBe(200);
});

it("initializes a personal vault once and preserves its keys on retries and concurrent setup", async () => {
  using sqlite = new Database(":memory:");
  const { call, cookies, signIn } = await setup(sqlite);
  const [first, second] = await Promise.all([
    createVaultSetup("first test vault password", email),
    createVaultSetup("second test vault password", email),
  ]);
  expect((await call(vaultSetupPath)).status).toBe(401);
  expect((await call(vaultSetupPath, first)).status).toBe(401);

  const cookie = cookies(await signIn(password));
  expect(await (await call(vaultSetupPath, undefined, cookie)).json()).toEqual({
    initialized: false,
    kdfSalt: email,
  });
  expect(
    (await call(vaultSetupPath, first, cookie, "https://other.example")).status,
  ).toBe(403);
  expect(
    (
      await call(
        vaultSetupPath,
        { ...first, kdfSalt: "other@example.net" },
        cookie,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call(
        vaultSetupPath,
        { ...first, masterPassword: "unexpected" },
        cookie,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        vaultSetupPath,
        { ...first, publicKey: "A".repeat(392) },
        cookie,
      )
    ).status,
  ).toBe(400);

  const [left, right] = await Promise.all([
    call(vaultSetupPath, first, cookie),
    call(vaultSetupPath, second, cookie),
  ]);
  expect([left.status, right.status].sort()).toEqual([201, 409]);
  const winner = left.status === 201 ? first : second;
  const loser = left.status === 201 ? second : first;
  expect((await call(vaultSetupPath, winner, cookie)).status).toBe(204);
  expect((await call(vaultSetupPath, loser, cookie)).status).toBe(409);
  expect(await (await call(vaultSetupPath, undefined, cookie)).json()).toEqual({
    initialized: true,
  });

  const vaults = sqlite
    .query("SELECT owner_id, key_id, wrapped_key FROM personal_vaults")
    .all();
  expect(vaults).toEqual([
    { owner_id: "owner", key_id: winner.keyId, wrapped_key: winner.wrappedKey },
  ]);
  expect(sqlite.query("SELECT id FROM personal_vault_logins").all()).toEqual(
    [],
  );
});
import type {
  EmailMessageBuilder,
  RateLimit,
  SendEmail,
} from "@cloudflare/workers-types";

it("sends binary attachments to multiple recipients and retains downloadable Sent copies", async () => {
  using sqlite = new Database(":memory:");
  const send = vi.fn(async (_message: EmailMessageBuilder) => ({
    messageId: "files-fixture",
  }));
  const copies = new Map<string, string>();
  const { call, request, signIn, cookies } = await setup(sqlite, {
    INBOX_EMAIL_ADDRESS: "mail@app.example.net",
    INBOX_EMAIL_FROM: "mail@app.example.net",
    INBOX_SEND: { send } as SendEmail,
    INBOX_SEND_LIMIT: { limit: async () => ({ success: true }) },
    SENT_MESSAGES: {
      put: async (id: string, json: string) => {
        copies.set(id, json);
        return {};
      },
      get: async (id: string) => {
        const json = copies.get(id);
        return json
          ? {
              size: json.length,
              httpMetadata: { contentType: "application/json" },
              json: async () => JSON.parse(json),
            }
          : null;
      },
    } as unknown as WorkerEnv["SENT_MESSAGES"],
  });
  const session = cookies(await signIn(password));
  const attachment = {
    filename: "data.bin",
    type: "application/octet-stream",
    content: "AAECA/8=",
  };
  const draft = {
    to: "alice@example.net, bob@example.net",
    cc: "other@example.net",
    subject: "Fwd: Files",
    text: "Here are the files.",
    attachments: [attachment],
  };
  expect(
    (
      await call(
        inboxSendPath,
        { ...draft, attachments: [{ ...attachment, content: "%%%" }] },
        session,
      )
    ).status,
  ).toBe(400);
  expect(send).not.toHaveBeenCalled();
  const response = await call(inboxSendPath, draft, session);
  expect(response.status).toBe(204);
  expect(send.mock.lastCall?.[0]).toMatchObject({
    to: ["alice@example.net", "bob@example.net"],
    cc: ["other@example.net"],
    attachments: [
      {
        filename: "data.bin",
        disposition: "attachment",
        content: new Uint8Array([0, 1, 2, 3, 255]),
      },
    ],
  });
  expect(send.mock.lastCall?.[0].headers).toBeUndefined();
  const id = response.headers.get(sentMessageHeader)!;
  const copy = await call(mailMessageApi("sent", id), undefined, session);
  expect(await copy.json()).toMatchObject({
    cc: draft.cc,
    attachments: [{ name: "data.bin", size: 5, part: 0 }],
  });
  const path = `${inboxApiPath}/${id}/attachments/0`;
  expect((await call(path)).status).toBe(401);
  const download = await call(path, undefined, session);
  expect(download.status).toBe(200);
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(
    new Uint8Array([0, 1, 2, 3, 255]),
  );
  expect(download.headers.get("content-disposition")).toContain("data.bin");
  expect((await call(`${path}/preview`, undefined, session)).status).toBe(415);
  expect(
    (
      await request(mailMessageApi("sent", id), {
        method: "DELETE",
        headers: {
          cookie: session,
          origin: "https://oneapp.example",
          "x-effect-auth-csrf": "1",
        },
      })
    ).status,
  ).toBe(204);
  expect(
    (await call(mailMessageApi("sent", id), undefined, session)).status,
  ).toBe(404);
  expect((await call(path, undefined, session)).status).toBe(404);
  const trashPath = `${inboxApiPath}/trash/${id}`;
  expect(
    await (await call(trashPath, undefined, session)).json(),
  ).toMatchObject({ id, subject: draft.subject, text: draft.text });
  expect((await call(`${path}?trash=1`)).status).toBe(401);
  expect(
    new Uint8Array(
      await (await call(`${path}?trash=1`, undefined, session)).arrayBuffer(),
    ),
  ).toEqual(new Uint8Array([0, 1, 2, 3, 255]));
  expect(
    (await call(`${path}/preview?trash=1`, undefined, session)).status,
  ).toBe(415);
  expect((await call(`${trashPath}/restore`, {}, session)).status).toBe(204);
  expect((await call(`${path}?trash=1`, undefined, session)).status).toBe(404);
  expect((await call(path, undefined, session)).status).toBe(200);
});

it("uses the oldest unread sender for conversation avatars, then the latest incoming sender", async () => {
  using sqlite = new Database(":memory:");
  const { db, call, signIn, cookies } = await setup(sqlite, {
    INBOX_MESSAGES: {
      list: async () => ({ objects: [], truncated: false }),
      get: async () => null,
    } as unknown as WorkerEnv["INBOX_MESSAGES"],
    SENT_MESSAGES: {
      list: async () => ({ objects: [], truncated: false }),
      get: async () => null,
    } as unknown as WorkerEnv["SENT_MESSAGES"],
  });
  const ids = Array.from(
    { length: 4 },
    () => `0-8200000000000-${crypto.randomUUID()}.eml`,
  );
  for (let n = 0; n < ids.length; n++)
    await indexMail(db, {
      id: ids[n]!,
      folder: "inbox",
      timestamp: n + 1,
      from: `sender${n}@example.net`,
      to: "owner@example.net",
      subject: "Avatars",
      unread: n !== 2,
      messageIds: ["<avatars@example.net>"],
    });
  // Even a newer sent copy must not replace the incoming sender's avatar.
  await indexMail(db, {
    id: `0-8200000000000-${crypto.randomUUID()}`,
    folder: "sent",
    timestamp: 10,
    from: "owner@example.net",
    to: "sender3@example.net",
    subject: "Re: Avatars",
    messageIds: ["<avatars@example.net>"],
  });
  const session = cookies(await signIn(password));
  const sender = async () => {
    const response = await call(conversationsApiPath, undefined, session);
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      messages: { avatarSender: { address: string } }[];
    };
    return page.messages[0]!.avatarSender.address;
  };
  expect(await sender()).toBe("sender0@example.net");
  sqlite
    .query("UPDATE mail_index_messages SET unread = 0 WHERE id = ?")
    .run(ids[0]!);
  expect(await sender()).toBe("sender1@example.net");
  sqlite
    .query("UPDATE mail_index_messages SET deleted = 1 WHERE id = ?")
    .run(ids[1]!);
  expect(await sender()).toBe("sender3@example.net");
  sqlite.query("UPDATE mail_index_messages SET unread = 0").run();
  expect(await sender()).toBe("sender3@example.net");
});

it("persists sender avatar overrides separately from Signal/Noise and restores automatic detection", async () => {
  using sqlite = new Database(":memory:");
  const { mailPeople } = await import("./mail-people.ts");
  const { senderAppearanceApiPath } = await import("../inbox-contract.ts");
  const { call, request, db, signIn, cookies } = await setup(sqlite, {
    INBOX_MESSAGES: {
      list: async () => ({ objects: [], truncated: false }),
      get: async () => null,
    } as unknown as WorkerEnv["INBOX_MESSAGES"],
    SENT_MESSAGES: {
      list: async () => ({ objects: [], truncated: false }),
      get: async () => null,
    } as unknown as WorkerEnv["SENT_MESSAGES"],
  });
  const id = `0-8200000000000-${crypto.randomUUID()}.eml`;
  const address = "accounts@news.acme.co.uk";
  await indexMail(db, {
    id,
    folder: "inbox",
    timestamp: 1000,
    from: "bounce@mailer.example.net",
    to: email,
    subject: "Receipt",
    unread: true,
    messageIds: [],
    people: mailPeople(
      (key) => (key === "from" ? `Acme <${address}>` : undefined),
      "bounce@mailer.example.net",
      email,
    ),
  });
  const session = cookies(await signIn(password));
  const patch = (mode: string, cookie?: string, csrf = true) =>
    request(senderAppearanceApiPath, {
      method: "PATCH",
      headers: {
        origin: "https://oneapp.example",
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { "x-effect-auth-csrf": "1" } : {}),
      },
      body: JSON.stringify({ address: address.toUpperCase(), mode }),
    });
  expect((await patch("person")).status).toBe(401);
  expect((await patch("person", session, false)).status).toBe(403);
  expect((await patch("bogus", session)).status).toBe(400);
  const appearance = async () => {
    const response = await call(conversationsApiPath, undefined, session);
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      messages: { avatarSender: { appearance: object } }[];
    };
    return page.messages[0]!.avatarSender.appearance;
  };
  expect(await appearance()).toEqual({
    kind: "service",
    mode: "auto",
    domain: "acme.co.uk",
  });
  expect((await patch("person", session)).status).toBe(204);
  expect(await appearance()).toEqual({
    kind: "person",
    mode: "person",
    domain: null,
  });
  const thread = await (
    await call(conversationApi(id), undefined, session)
  ).json();
  expect(thread).toMatchObject({
    messages: [
      {
        people: { sender: { appearance: { kind: "person", mode: "person" } } },
      },
    ],
    senderRule: { priority: "automatic" },
  });
  expect(sqlite.query("SELECT * FROM mail_sender_rules").all()).toEqual([]);
  expect((await patch("service", session)).status).toBe(204);
  expect(await appearance()).toEqual({
    kind: "service",
    mode: "service",
    domain: "acme.co.uk",
  });
  expect((await patch("auto", session)).status).toBe(204);
  expect(await appearance()).toEqual({
    kind: "service",
    mode: "auto",
    domain: "acme.co.uk",
  });
  expect(sqlite.query("SELECT * FROM mail_sender_avatars").all()).toEqual([]);
});

it("uses mailbox aliases for Reply All and never reads another mailbox's originals", async () => {
  using sqlite = new Database(":memory:");
  const id = "0-8199999999990-00000000-0000-4000-8000-000000000000.eml";
  const privateId = "0-8199999999991-00000000-0000-4000-8000-000000000000.eml";
  const raw = new TextEncoder().encode(
    [
      "From: sender@example.net",
      "To: mail@dpeek.com, david@winterpeek.com, delivered@dpeek.com",
      "Cc: other@example.net",
      "Subject: Multiple identities",
      "",
      "Hello",
    ].join("\r\n"),
  );
  const get = vi.fn(async (key: string) => {
    if (key !== id && key !== `mailboxes/work/${privateId}`) return null;
    return {
      key,
      size: raw.length,
      uploaded: new Date(),
      customMetadata: {
        envelopeFrom: "sender@example.net",
        envelopeTo: "delivered@dpeek.com",
      },
      arrayBuffer: async () => raw.buffer,
      body: new Response(raw).body,
    };
  });
  const { call, signIn, cookies } = await setup(sqlite, {
    INBOX_EMAIL_ADDRESS: "mail@app.example.net",
    MAILBOX_ALIASES: "mail@dpeek.com,david@winterpeek.com",
    INBOX_MESSAGES: { get } as unknown as WorkerEnv["INBOX_MESSAGES"],
  });
  const session = cookies(await signIn(password));
  expect(
    await (await call(inboxMessageApi(id), undefined, session)).json(),
  ).toMatchObject({
    reply: {
      to: "sender@example.net",
      allTo: "sender@example.net",
      cc: "other@example.net",
    },
  });
  expect(
    (await call(inboxMessageApi(privateId), undefined, session)).status,
  ).toBe(404);
  expect(
    (await call(inboxOriginalApi(privateId), undefined, session)).status,
  ).toBe(404);
  expect(
    (await call(inboxAttachmentApi(privateId, 0), undefined, session)).status,
  ).toBe(404);
  expect(get.mock.calls.every(([key]) => !key.includes("/"))).toBe(true);
});

it("imports through a separately approved CLI permission with pinned plans, bounded uploads and resumable receipts", async () => {
  const { mailImportScope, MailImportPlan } =
    await import("@orumai/core/mail-import");
  const { importHash } = await import("./mail-import-runs.ts");
  const { openRemoteMailSink } =
    await import("../../../../scripts/mail/remote-sink.ts");
  using sqlite = new Database(":memory:");
  const stored = new Map<
    string,
    {
      key: string;
      size: number;
      uploaded: Date;
      customMetadata: Record<string, string>;
      bytes: Uint8Array<ArrayBuffer>;
    }
  >();
  let losePut = true;
  const bucket = {
    put: async (
      key: string,
      bytes: Uint8Array<ArrayBuffer>,
      options: { customMetadata: Record<string, string> },
    ) => {
      if (stored.has(key)) return null;
      const object = {
        key,
        size: bytes.length,
        uploaded: new Date(),
        customMetadata: options.customMetadata,
        bytes: bytes.slice(),
      };
      stored.set(key, object);
      if (losePut) {
        losePut = false;
        throw new Error("Lost storage response");
      }
      return object;
    },
    head: async (key: string) => stored.get(key) ?? null,
  };
  const { request, call, signIn, cookies, db } = await setup(sqlite, {
    INBOX_MESSAGES: bucket as unknown as WorkerEnv["INBOX_MESSAGES"],
    SENT_MESSAGES: bucket as unknown as WorkerEnv["SENT_MESSAGES"],
  });
  const session = cookies(await signIn(password));
  const secret = `one_${"i".repeat(43)}`;
  const api = (
    path: string,
    method = "GET",
    body?: BodyInit,
    contentType = "application/json",
    token = secret,
  ) =>
    request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": contentType,
      },
      body,
    });
  const beginLogin = await api(
    cliLoginPath,
    "POST",
    JSON.stringify({ label: "Mailbox import", scopes: [mailImportScope] }),
  );
  expect(beginLogin.status).toBe(201);
  const approval = (await beginLogin.json()) as { id: string };
  expect(
    await (
      await call(`${cliLoginPath}/${approval.id}`, undefined, session)
    ).json(),
  ).toMatchObject({ scopes: [mailImportScope] });
  // A browser cannot approve a different permission than the CLI requested.
  expect(
    (
      await call(
        `${cliLoginPath}/${approval.id}`,
        { approve: true, scopes: cliLinkScopes },
        session,
      )
    ).status,
  ).toBe(410);
  expect(
    (
      await call(
        `${cliLoginPath}/${approval.id}`,
        { approve: true, scopes: [mailImportScope] },
        session,
      )
    ).status,
  ).toBe(204);
  expect(
    (await api(`${cliLoginPath}/${approval.id}/poll`, "POST")).status,
  ).toBe(204);
  const grant = sqlite
    .query("SELECT expires_at, scopes FROM cli_tokens WHERE id = ?")
    .get(approval.id) as { expires_at: number; scopes: string };
  expect(grant.expires_at).toBeGreaterThan(Date.now());
  expect(grant.expires_at).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60_000);
  expect((await api(linksPath)).status).toBe(403);
  const base = "/api/mail-import/personal";
  expect((await call(base, undefined, session)).status).toBe(401); // No ambient cookie authority.
  expect((await api(base)).status).toBe(200);
  expect((await api("/api/mail-import/missing")).status).toBe(404);
  sqlite.exec(
    "INSERT INTO accounts (id, active, security_revision) VALUES ('family',1,'1'); INSERT INTO mailboxes VALUES ('family','family','Family')",
  );
  expect((await api("/api/mail-import/family")).status).toBe(404);
  const bytes = new TextEncoder().encode(
    "From: sender@example.net\r\nTo: owner@example.net\r\nMessage-ID: <import@example.net>\r\n\r\nOriginal message",
  );
  const source = {
    account: "icloud:test@icloud.com",
    mailbox: "INBOX",
    uidValidity: 1,
    uid: 1,
  };
  const sourceId = await importHash(
    JSON.stringify([
      source.account,
      source.mailbox,
      source.uidValidity,
      source.uid,
    ]),
  );
  const plan = Schema.decodeUnknownSync(MailImportPlan)({
    version: 1,
    snapshotId: crypto.randomUUID(),
    inventorySha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    mappingHash: "c".repeat(64),
    asOf: "2026-11-23T00:00:00.000Z",
    sourceAccount: source.account,
    entries: [
      {
        sourceId,
        sha256: await importHash(bytes),
        size: bytes.length,
        metadata: {
          source,
          folder: "inbox",
          archived: false,
          timestamp: 1_600_000_000_000,
          flags: ["\\Seen"],
        },
      },
    ],
  });
  const run = `${base}/${plan.snapshotId}`;
  expect(
    (
      await api(
        run,
        "PUT",
        JSON.stringify({
          ...plan,
          entries: [...plan.entries, ...plan.entries],
        }),
      )
    ).status,
  ).toBe(400);
  expect((await api(run, "PUT", JSON.stringify(plan))).status).toBe(200);
  expect(
    (
      await api(
        run,
        "PUT",
        JSON.stringify({ ...plan, mappingHash: "d".repeat(64) }),
      )
    ).status,
  ).toBe(409);
  expect((await api(`${run}/complete`, "POST")).status).toBe(409);
  const upload = `${run}/${sourceId}`;
  expect(
    (await api(upload, "PUT", bytes.slice(1), "message/rfc822")).status,
  ).toBe(413);
  expect(
    (
      await api(
        upload,
        "PUT",
        new Uint8Array(bytes.length + 1),
        "message/rfc822",
      )
    ).status,
  ).toBe(413);
  const corrupt = bytes.slice();
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  expect((await api(upload, "PUT", corrupt, "message/rfc822")).status).toBe(
    422,
  );
  expect(
    (await api(`${run}/${"f".repeat(64)}`, "PUT", bytes, "message/rfc822"))
      .status,
  ).toBe(404);
  expect(stored.size).toBe(0);
  let loseUploadResponse = true;
  const transport = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      const path = new URL(String(url)).pathname;
      const response = await request(path, init!);
      if (
        path === upload &&
        init?.method === "PUT" &&
        response.ok &&
        loseUploadResponse
      ) {
        loseUploadResponse = false;
        throw new Error("Lost successful upload response");
      }
      return response;
    }) as typeof fetch,
    sleep: async (_ms: number) => {},
  };
  const remote = await openRemoteMailSink(
    "https://oneapp.example",
    "personal",
    plan,
    secret,
    transport,
  );
  await remote.begin();
  expect(await remote.sink.receipt(source)).toBeNull();
  const imported = await remote.sink.ingest(plan.entries[0]!.metadata, bytes);
  expect(imported.status).toBe("skipped");
  expect(stored.size).toBe(1);
  expect(stored.get(imported.id!)?.bytes).toEqual(bytes);
  expect((await remote.sink.receipt(source))?.completedAt).not.toBeNull();
  expect((await remote.sink.completeImport()).completedConversations).toBe(1);
  await db
    .prepare(
      "UPDATE mail_index_messages SET archived = 0, unread = 1 WHERE mailbox_id = 'personal'",
    )
    .run();
  expect(
    (await remote.sink.ingest(plan.entries[0]!.metadata, bytes)).status,
  ).toBe("skipped");
  expect((await remote.sink.completeImport()).completedConversations).toBe(1);
  expect(
    sqlite.query("SELECT archived, unread FROM mail_index_messages").get(),
  ).toEqual({ archived: 0, unread: 1 });
  const conflict = {
    ...plan,
    snapshotId: crypto.randomUUID(),
    entries: plan.entries.map((entry) => ({
      ...entry,
      sha256: "f".repeat(64),
    })),
  };
  expect(
    (
      await api(
        `${base}/${conflict.snapshotId}`,
        "PUT",
        JSON.stringify(conflict),
      )
    ).status,
  ).toBe(200);
  expect((await api(`${base}/${conflict.snapshotId}/${sourceId}`)).status).toBe(
    409,
  );
  expect(
    (await api(`${base}/${conflict.snapshotId}/complete`, "POST")).status,
  ).toBe(409);
  sqlite
    .query("UPDATE cli_tokens SET expires_at = ? WHERE id = ?")
    .run(Date.now() - 1, approval.id);
  expect((await api(base)).status).toBe(401);
  sqlite
    .query("UPDATE cli_tokens SET expires_at = NULL, scopes = ? WHERE id = ?")
    .run(JSON.stringify(cliLinkScopes), approval.id);
  expect((await api(base)).status).toBe(403);
  sqlite.query("DELETE FROM cli_tokens WHERE id = ?").run(approval.id);
  expect((await api(base)).status).toBe(401);
});

it("registers push for the signed-in mailbox, checks status, validates destinations, and removes it on logout", async () => {
  using sqlite = new Database(":memory:");
  const vapid = generateVAPIDKeys();
  const receiver = generateVAPIDKeys();
  const { call, request, signIn, cookies } = await setup(sqlite, {
    PUSH_PUBLIC_KEY: vapid.publicKey,
    PUSH_PRIVATE_KEY: vapid.privateKey,
    PUSH_SUBJECT: "mailto:mail@example.com",
  });
  const input = {
    endpoint: "https://web.push.apple.com/test-device",
    keys: {
      p256dh: receiver.publicKey,
      auth: Buffer.alloc(16, 1).toString("base64url"),
    },
  };
  expect((await call("/api/push")).status).toBe(401);
  expect((await call("/api/push/subscription", input)).status).toBe(401);
  const cookie = cookies(await signIn(password));
  expect(await (await call("/api/push", undefined, cookie)).json()).toEqual({
    publicKey: vapid.publicKey,
  });
  expect(
    (
      await call(
        "/api/push/subscription",
        input,
        cookie,
        "https://attacker.example",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/api/push/subscription", {
        method: "POST",
        headers: {
          cookie,
          origin: "https://oneapp.example",
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      })
    ).status,
  ).toBe(403);
  for (const endpoint of [
    "http://web.push.apple.com/token",
    "https://127.0.0.1/private",
    "https://web.push.apple.com.attacker.test/token",
    "https://user:password@web.push.apple.com/token",
    "https://web.push.apple.com:444/token",
  ]) {
    expect(
      (await call("/api/push/subscription", { ...input, endpoint }, cookie))
        .status,
    ).toBe(400);
  }
  expect(
    (
      await call(
        "/api/push/subscription",
        { ...input, keys: { ...input.keys, auth: "invalid" } },
        cookie,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        "/api/push/subscription",
        { ...input, keys: { ...input.keys, p256dh: "B" + "A".repeat(86) } },
        cookie,
      )
    ).status,
  ).toBe(400);
  expect((await call("/api/push/subscription", input, cookie)).status).toBe(
    204,
  );
  expect((await call("/api/push/subscription", input, cookie)).status).toBe(
    204,
  );
  expect(
    sqlite.query("SELECT mailbox_id FROM push_subscriptions").all(),
  ).toEqual([{ mailbox_id: "personal" }]);
  expect(
    await (
      await call("/api/push/status", { endpoint: input.endpoint }, cookie)
    ).json(),
  ).toEqual({ enabled: true });
  expect((await call("/api/auth/signOut", {}, cookie)).status).toBe(200);
  expect(sqlite.query("SELECT id FROM push_subscriptions").all()).toHaveLength(
    0,
  );
  expect((await call("/api/push/subscription", input, cookie)).status).toBe(
    401,
  );
});

it("keeps push subscriptions isolated across devices and resets pending alerts when re-enabling in a new session", async () => {
  using sqlite = new Database(":memory:");
  const vapid = generateVAPIDKeys();
  const { call, request, signIn, cookies, db } = await setup(sqlite, {
    PUSH_PUBLIC_KEY: vapid.publicKey,
    PUSH_PRIVATE_KEY: vapid.privateKey,
    PUSH_SUBJECT: "mailto:mail@example.com",
  });
  const first = cookies(await signIn(password));
  const second = cookies(await signIn(password));
  const input = {
    endpoint: "https://web.push.apple.com/first",
    keys: {
      p256dh: generateVAPIDKeys().publicKey,
      auth: Buffer.alloc(16, 1).toString("base64url"),
    },
  };
  await call("/api/push/subscription", input, first);
  await call(
    "/api/push/subscription",
    { ...input, endpoint: "https://web.push.apple.com/second" },
    second,
  );
  await indexMail(db, {
    id: "incoming",
    folder: "inbox",
    from: "sender@example.com",
    to: "mail@example.com",
    subject: "test",
    timestamp: Date.now() + 1,
    unread: true,
    messageIds: [],
    notifyIncoming: true,
  });
  expect(sqlite.query("SELECT * FROM mail_push_outbox").all()).toHaveLength(2);
  expect(
    await (
      await call("/api/push/status", { endpoint: input.endpoint }, second)
    ).json(),
  ).toEqual({ enabled: false });
  const renewed = cookies(await signIn(password));
  await call("/api/push/subscription", input, renewed);
  expect(sqlite.query("SELECT * FROM mail_push_outbox").all()).toHaveLength(1);
  await call("/api/auth/signOut", {}, first);
  expect(sqlite.query("SELECT * FROM push_subscriptions").all()).toHaveLength(
    2,
  );
  const removed = await request("/api/push/subscription", {
    method: "DELETE",
    headers: {
      cookie: renewed,
      origin: "https://oneapp.example",
      "x-effect-auth-csrf": "1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ endpoint: input.endpoint }),
  });
  expect(removed.status).toBe(204);
  expect(sqlite.query("SELECT endpoint FROM push_subscriptions").all()).toEqual(
    [{ endpoint: "https://web.push.apple.com/second" }],
  );
});

it("persists reusable task tags and rejects stale or cross-account task edits atomically", async () => {
  using sqlite = new Database(":memory:");
  const { call, request, signIn, cookies, env } = await setup(sqlite);
  const session = cookies(await signIn(password));
  expect((await call(tasksApi)).status).toBe(401);

  const firstInput = { id: crypto.randomUUID(), title: "Capture a task" };
  expect(
    (await call(tasksApi, { ...firstInput, status: null }, session)).status,
  ).toBe(400);
  const created = await call(tasksApi, firstInput, session);
  expect(created.status).toBe(201);
  const first = Schema.decodeUnknownSync(Task)(await created.json());
  expect(first).toMatchObject({
    status: "not-started",
    priority: null,
    tagIds: [],
  });
  const tag = Schema.decodeUnknownSync(Tag)(
    await (await call(tagsApi, { name: "Receipts" }, session)).json(),
  );
  const reused = await call(tagsApi, { name: "ｒｅｃｅｉｐｔｓ" }, session);
  expect(await reused.json()).toEqual(tag);

  const save = (
    task: typeof Task.Type,
    changes: Partial<typeof Task.Type>,
    csrf = true,
  ) =>
    request(taskApi(task.id), {
      method: "PUT",
      headers: {
        cookie: session,
        origin: env.APP_ORIGIN,
        "content-type": "application/json",
        ...(csrf ? { "x-effect-auth-csrf": "1" } : {}),
      },
      body: JSON.stringify({ ...task, ...changes }),
    });
  const changes = {
    title: "Review the receipt",
    description: "## Receipt\n\n- Check the total",
    status: "in-review",
    priority: "urgent",
    dueOn: "2028-02-29",
    tagIds: [tag.id],
  } as const;
  const secondInput = {
    ...changes,
    id: crypto.randomUUID(),
    title: "Follow up",
  };
  expect(
    (await call(tasksApi, { ...secondInput, dueOn: "2027-02-29" }, session))
      .status,
  ).toBe(400);
  const secondResponse = await call(tasksApi, secondInput, session);
  expect(secondResponse.status).toBe(201);
  const second = Schema.decodeUnknownSync(Task)(await secondResponse.json());
  expect(second).toMatchObject(secondInput);
  expect(await (await call(tasksApi, secondInput, session)).json()).toEqual(
    second,
  );

  expect((await save(first, changes, false)).status).toBe(403);
  expect((await save(first, { dueOn: "2027-02-29" })).status).toBe(400);
  const edited = await save(first, changes);
  expect(edited.status).toBe(200);
  const saved = Schema.decodeUnknownSync(Task)(await edited.json());
  expect(saved).toMatchObject(changes);
  expect(saved.revision).not.toBe(first.revision);

  const stale = await save(first, { title: "Stale title", tagIds: [] });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual(saved);
  const foreignTag = crypto.randomUUID();
  sqlite.run(
    "INSERT INTO accounts (id, active, security_revision) VALUES ('other', 1, 'revision')",
  );
  sqlite.run("INSERT INTO tags VALUES ('other', ?, 'Other tag', 'other tag')", [
    foreignTag,
  ]);
  const rejectedId = crypto.randomUUID();
  expect(
    (
      await call(
        tasksApi,
        { ...secondInput, id: rejectedId, tagIds: [foreignTag] },
        session,
      )
    ).status,
  ).toBe(409);
  expect(
    (await save(saved, { title: "Invalid title change", tagIds: [foreignTag] }))
      .status,
  ).toBe(400);
  expect(await (await call(tasksApi, firstInput, session)).json()).toEqual(
    saved,
  );

  const index = Schema.decodeUnknownSync(TaskIndex)(
    await (await call(tasksApi, undefined, session)).json(),
  );
  expect(index.tags).toEqual([tag]);
  expect(index.tasks.find(({ id }) => id === first.id)).toEqual(saved);
  expect(index.tasks.find(({ id }) => id === second.id)).toEqual(second);
  expect(index.tasks.some(({ id }) => id === rejectedId)).toBe(false);
});
