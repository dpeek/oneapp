import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { downloadBytes } from "./attachments.mjs";

const button = (page, name) => page.getByRole("button", { name, exact: true });
const text = (bytes) => new TextDecoder().decode(bytes);
const at = async (page, hash) => {
  const url = new URL(page.url());
  url.hash = hash;
  await page.goto(url.href);
};

const folderId = "c1e726d2-cbcf-473d-a71a-eb4b57e24a08";
const folderName = "Synthetic import folder";
const fixture = {
  encrypted: false,
  folders: [{ id: folderId, name: folderName }],
  items: [
    {
      type: 1,
      name: "Imported fixture login",
      folderId,
      favorite: true,
      login: {
        username: "synthetic-user",
        password: "synthetic-import-login-password",
        totp: "JBSWY3DPEHPK3PXP",
        uris: [{ uri: "https://example.invalid/sign-in", match: 3 }],
      },
    },
    {
      type: 2,
      name: "Imported fixture note",
      folderId,
      notes: "Synthetic imported note.",
      secureNote: { type: 0 },
    },
    {
      type: 3,
      name: "Imported fixture card",
      folderId,
      card: {
        cardholderName: "Synthetic cardholder",
        number: "4111111111111111",
        brand: "Visa",
      },
    },
    {
      type: 4,
      name: "Imported fixture identity",
      identity: { firstName: "Sample", lastName: "Person" },
    },
  ],
};
const protectedPassword = "Only for this synthetic portable export";

const stockExport = async (client, password, format, filePassword) => {
  await at(client, "/export");
  await client.locator('select[formcontrolname="format"]').selectOption(format);
  if (format === "encrypted_json" && !filePassword)
    await client.getByText("Account restricted", { exact: true }).click();
  if (filePassword) {
    await client.getByText("Password protected", { exact: true }).click();
    await client.locator("#filePassword").fill(filePassword);
    await client.locator("#confirmFilePassword").fill(filePassword);
  }
  await button(client, "Export").click();
  const dialog = client.getByRole("dialog");
  await dialog.locator('input[type="password"]').fill(password);
  return text(
    await downloadBytes(client, () => button(dialog, "Continue").click()),
  );
};

const webExport = async (app, web, password, format, filePassword) => {
  await button(web, "Export").press("Enter");
  await web.getByLabel("File format").selectOption(format);
  if (filePassword) {
    await web.getByLabel("Export password", { exact: true }).fill(filePassword);
    await web
      .getByLabel("Confirm export password", { exact: true })
      .fill(filePassword);
  }
  await web.getByLabel("Vault master password", { exact: true }).fill(password);
  const bytes = await downloadBytes(app, () =>
    button(web, "Download export").press("Enter"),
  );
  await button(web, "Export").waitFor();
  return text(bytes);
};

const unlockWeb = async (web, password) => {
  await web.getByLabel("Vault master password", { exact: true }).fill(password);
  await button(web, "Unlock vault").press("Enter");
  await button(web, "Import").waitFor();
};

const importWeb = async (web, contents, filePassword) => {
  await button(web, "Import").press("Enter");
  await web.getByLabel("Bitwarden export file").setInputFiles({
    name: "fixture.json",
    mimeType: "application/json",
    buffer: Buffer.from(contents),
  });
  if (filePassword)
    await web.getByLabel("File password, if protected").fill(filePassword);
  await button(web, "Review import").press("Enter");
  await button(web, "Import items").press("Enter");
  await web
    .getByRole("status")
    .filter({ hasText: /^Imported /u })
    .waitFor();
};

const stockImport = async (first, client) => {
  // Pass through the stock import form so the harness verifies encrypt_list and
  // the actual personal import wrapper used by this release.
  await at(client, "/import");
  await client
    .locator('bit-select[formcontrolname="source"]')
    .getByRole("combobox")
    .click();
  await client.getByText("Bitwarden (json)", { exact: true }).click();
  await client
    .locator("#import_textarea_fileContents")
    .fill(JSON.stringify(fixture));
  const before = first.responses.length;
  await button(client, "Import").click();
  const result = await first.localResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/ciphers/import" &&
      response.request().method() === "POST" &&
      first.responses.indexOf(response) >= before,
  );
  assert.equal(
    result.status(),
    204,
    result.ok() ? undefined : (await result.json()).message,
  );
  await client.getByTestId("ok-button").click();
  const sent = result.request().postData();
  for (const value of [
    folderName,
    "synthetic-import-login-password",
    "Synthetic imported note.",
  ])
    assert.equal(sent.includes(value), false);
  const imported = JSON.parse(sent);
  assert.equal(imported.ciphers.length, fixture.items.length);
  assert.equal(imported.folderRelationships.length, 3);
  assert.match(imported.folders[0].name, /^2\./u);
  return imported;
};

export const checkTransfers = async ({
  app,
  web,
  first,
  second,
  client,
  secondClient,
  password,
  openItem,
  syncNow,
}) => {
  const imported = await stockImport(first, client);
  const synced = await syncNow(second, secondClient);
  const importedFolder = synced.folders.find(
    (folder) => folder.name === imported.folders[0].name,
  );
  assert.ok(importedFolder);
  assert.equal(
    synced.ciphers.filter((item) => item.folderId === importedFolder.id).length,
    3,
  );

  await button(web, "Lock vault").press("Enter");
  await unlockWeb(web, password);
  await button(web, "Imported fixture note").press("Enter");
  await web.getByText("Synthetic imported note.", { exact: true }).waitFor();
  await web.getByText(folderName, { exact: true }).waitFor();
  await button(web, "Back to items").press("Enter");

  await openItem(secondClient, "Imported fixture card");
  await button(secondClient, "Edit").click();
  await secondClient
    .locator('input[formcontrolname="name"]')
    .fill("Edited fixture card");
  await button(secondClient, "Save").click();
  const archivedNote = "Imported fixture note";
  await openItem(secondClient, archivedNote);
  await button(secondClient, "Archive").click();
  await button(secondClient.getByRole("dialog"), "Archive").click();
  const archived = await syncNow(first, client);
  assert.ok(
    archived.ciphers.some(
      (item) => item.folderId === importedFolder.id && item.archivedDate,
    ),
  );

  await button(web, "Lock vault").press("Enter");
  await unlockWeb(web, password);
  await button(web, "Archive").press("Enter");
  await button(web, archivedNote).waitFor();
  await web.getByRole("checkbox", { name: `Select ${archivedNote}` }).check();
  await button(web, "Unarchive selected").press("Enter");
  await web.getByRole("status").filter({ hasText: "Items updated." }).waitFor();
  await button(web, "Back to items").press("Enter");

  const titles = ["Imported fixture login", "Edited fixture card"];
  for (const title of titles)
    await web.getByRole("checkbox", { name: `Select ${title}` }).check();
  await button(web, "Move selected to folder").press("Enter");
  await web
    .getByLabel("Destination folder")
    .selectOption({ label: "No folder" });
  await button(web, "Move items").press("Enter");
  await web.getByRole("status").filter({ hasText: "Items updated." }).waitFor();
  for (const title of titles)
    await web.getByRole("checkbox", { name: `Select ${title}` }).check();
  await button(web, "Move selected to Trash").press("Enter");
  await web.getByRole("status").filter({ hasText: "Items updated." }).waitFor();
  const trash = await syncNow(second, secondClient);
  const trashed = trash.ciphers.filter((item) => item.deletedDate != null);
  assert.equal(trashed.length, 2);
  await button(web, "Trash").press("Enter");
  for (const title of titles)
    await web.getByRole("checkbox", { name: `Select ${title}` }).check();
  await button(web, "Restore selected").press("Enter");
  await web.getByRole("status").filter({ hasText: "Items updated." }).waitFor();
  const restored = await syncNow(first, client);
  assert.equal(
    restored.ciphers.filter((item) => item.deletedDate != null).length,
    0,
  );
  for (const item of trashed)
    assert.equal(
      restored.ciphers.find(({ id }) => id === item.id)?.folderId,
      null,
    );
  await button(web, "Back to items").press("Enter");

  // The release-gated types are exercised as encrypted wire
  // fixtures by the Worker test. Create one through the real web form too.
  await button(web, "Other item types").press("Enter");
  await button(web, "Driver’s License").press("Enter");
  await web
    .getByLabel("Title", { exact: true })
    .fill("Fixture driver’s license");
  await web.getByLabel("License number", { exact: true }).fill("SYNTHETIC-DL");
  await button(web, "Save Driver’s License").press("Enter");
  await web
    .getByRole("heading", { name: "Fixture driver’s license" })
    .waitFor();
  await button(web, "Back to items").press("Enter");
  const withLicense = await syncNow(second, secondClient);
  assert.ok(
    withLicense.ciphers.some(
      ({ type, driversLicense }) =>
        type === 7 && /^2\./u.test(driversLicense.licenseNumber),
    ),
  );
  const otherProfile = await syncNow(first, client);
  assert.deepEqual(otherProfile.ciphers, withLicense.ciphers);
  console.log(
    "PASS Stock import reached both profiles and OneApp. Folder movement, archive, bulk Trash and Restore kept the same IDs.",
  );

  const plain = JSON.parse(await webExport(app, web, password, "json"));
  assert.ok(
    plain.items.some(
      ({ type, driversLicense }) =>
        type === 7 && driversLicense.licenseNumber === "SYNTHETIC-DL",
    ),
  );
  const csv = await webExport(app, web, password, "csv");
  assert.ok(csv.includes("Imported fixture login"));
  assert.equal(csv.includes("Edited fixture card"), false);
  const toRestore = await webExport(
    app,
    web,
    password,
    "protected",
    protectedPassword,
  );
  assert.equal(JSON.parse(toRestore).passwordProtected, true);
  assert.equal(toRestore.includes("synthetic-import-login-password"), false);

  const stockCsv = await stockExport(secondClient, password, "csv");
  assert.ok(stockCsv.includes("Imported fixture login"));
  assert.equal(stockCsv.includes("Edited fixture card"), false);
  const stockJson = JSON.parse(
    await stockExport(secondClient, password, "json"),
  );
  assert.ok(stockJson.items.some(({ name }) => name === "Edited fixture card"));
  const accountRestricted = await stockExport(
    secondClient,
    password,
    "encrypted_json",
  );
  const restricted = JSON.parse(accountRestricted);
  assert.equal(restricted.encrypted, true);
  assert.notEqual(restricted.passwordProtected, true);
  assert.match(restricted.encKeyValidation_DO_NOT_EDIT, /^2\./u);
  assert.equal(
    accountRestricted.includes("synthetic-import-login-password"),
    false,
  );
  const stockProtected = await stockExport(
    secondClient,
    password,
    "encrypted_json",
    protectedPassword,
  );
  assert.equal(JSON.parse(stockProtected).passwordProtected, true);
  assert.equal(
    stockProtected.includes("synthetic-import-login-password"),
    false,
  );
  console.log(
    "PASS Stock and OneApp exported JSON, CSV and password-protected JSON. Stock also exported account-restricted JSON.",
  );
  return { withLicense, plain, toRestore, stockProtected };
};

const canonical = (vault) => {
  const names = new Map(vault.folders.map(({ id, name }) => [id, name]));
  return {
    folders: vault.folders.map(({ name }) => name).sort(),
    items: vault.items
      .map(({ id, folderId, ...item }) => ({
        ...item,
        folder: names.get(folderId) ?? null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
};

export const restoreIntoFreshVault = async ({
  app,
  password,
  plain,
  toRestore,
  stockProtected,
}) => {
  const web = app.locator("oneapp-vault-reader");
  await app.getByRole("link", { name: "Password vault", exact: true }).click();
  await app.getByLabel("Vault master password", { exact: true }).fill(password);
  await app
    .getByLabel("Confirm vault master password", { exact: true })
    .fill(password);
  await button(app, "Create vault").click();
  await unlockWeb(web, password);
  await importWeb(web, toRestore, protectedPassword);
  const restored = JSON.parse(await webExport(app, web, password, "json"));
  assert.ok(
    isDeepStrictEqual(canonical(restored), canonical(plain)),
    "Portable reimport changed an item or folder field",
  );
  const oldIds = new Set(plain.items.map(({ id }) => id));
  assert.ok(restored.items.every(({ id }) => !oldIds.has(id)));
  await importWeb(web, stockProtected, protectedPassword);
  assert.equal(await button(web, "Imported fixture login").count(), 2);
  console.log(
    "PASS A fresh vault recovered all supported OneApp export fields and accepted Bitwarden’s password-protected export.",
  );
};
