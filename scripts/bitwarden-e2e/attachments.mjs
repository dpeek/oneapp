import assert from "node:assert/strict";
import { unzipSync } from "fflate";

const button = (page, name) =>
  page.getByRole("button", { name, exact: typeof name === "string" });

export const downloadBytes = async (page, click) => {
  const pending = page.waitForEvent("download");
  await click();
  const download = await pending;
  try {
    return new Uint8Array(
      await new Response(await download.createReadStream()).arrayBuffer(),
    );
  } finally {
    await download.delete();
  }
};

const wireResponse = (profile, path, method, since) =>
  profile.localResponse(
    (response) =>
      new URL(response.url()).pathname === path &&
      response.request().method() === method &&
      profile.responses.indexOf(response) >= since,
  );

const openStockAttachments = async (client, name, openItem) => {
  await openItem(client, name);
  await button(client, "Edit").click();
  await button(client, /^Attachments/u).click();
  await client.waitForURL((url) => url.hash.startsWith("#/attachments"));
};

const exportStockZip = async (client, password) => {
  const url = new URL(client.url());
  url.hash = "/export";
  await client.goto(url.href);
  await client.locator('select[formcontrolname="format"]').selectOption("zip");
  await button(client, "Export").click();
  const dialog = client.getByRole("dialog");
  await dialog.locator('input[type="password"]').fill(password);
  return downloadBytes(client, () => button(dialog, "Continue").click());
};

const webFile = {
  name: "fixture-from-oneapp.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("Synthetic OneApp web file.\n"),
};
const stockFile = {
  name: "fixture-from-bitwarden.bin",
  mimeType: "application/octet-stream",
  buffer: Buffer.from([0, 3, 26, 255, 10, 41]),
};

const assertZip = (bytes) => {
  const files = unzipSync(bytes);
  assert.ok(Object.hasOwn(files, "data.json"), "ZIP data.json is missing");
  for (const file of [webFile, stockFile]) {
    const path = Object.keys(files).find((name) =>
      name.endsWith(`/${file.name}`),
    );
    assert.ok(path, "ZIP is missing a synthetic attachment");
    assert.deepEqual(Buffer.from(files[path]), file.buffer);
  }
};

export const checkAttachments = async ({
  app,
  webVault,
  first,
  second,
  secondClient,
  item,
  itemName,
  password,
  openItem,
  syncNow,
  restartWorker,
  items,
}) => {
  const base = `/api/vault/attachments/${item}`;
  const wire = `/api/ciphers/${item}/attachment`;
  await button(webVault, itemName).press("Enter");
  await button(webVault, "Attachments").press("Enter");
  await webVault.getByLabel("Choose attachment").setInputFiles(webFile);
  const uploadIndex = first.responses.length;
  await app.evaluate((path) => {
    const fetchOriginal = window.fetch;
    window.fetch = async (input, init) => {
      const result = await fetchOriginal.call(window, input, init);
      if (
        init?.method !== "PUT" ||
        typeof input !== "string" ||
        !input.startsWith(path + "/")
      )
        return result;
      window.fetch = fetchOriginal;
      await result.arrayBuffer();
      throw new TypeError("Simulated loss of encrypted upload response");
    };
  }, base);
  await button(webVault, "Upload attachment").press("Enter");
  const reservation = await wireResponse(first, base, "POST", uploadIndex);
  assert.equal(reservation.status(), 201);
  const attachment = await reservation.json();
  assert.equal(reservation.request().postData().includes(webFile.name), false);
  assert.match(attachment.name, /^2\./u);
  assert.match(attachment.wrappedKey, /^2\./u);
  const sent = await wireResponse(
    first,
    `${base}/${attachment.id}`,
    "PUT",
    uploadIndex,
  );
  assert.equal(sent.status(), 204);
  const encrypted = sent.request().postDataBuffer();
  assert.equal(encrypted[0], 2);
  assert.equal(encrypted.includes(webFile.buffer), false);
  await webVault
    .getByRole("alert")
    .filter({ hasText: "Simulated loss" })
    .waitFor();
  const retryIndex = first.responses.length;
  await button(webVault, "Upload attachment").press("Enter");
  const retried = await wireResponse(
    first,
    `${base}/${attachment.id}`,
    "PUT",
    retryIndex,
  );
  assert.equal(retried.status(), 204);
  assert.deepEqual(retried.request().postDataBuffer(), encrypted);
  await webVault
    .getByRole("status")
    .filter({ hasText: "Attachment uploaded." })
    .waitFor();

  await syncNow(second, secondClient);
  await openStockAttachments(secondClient, itemName, openItem);
  const downloadIndex = second.responses.length;
  const stockDownload = await downloadBytes(secondClient, () =>
    button(secondClient, /Download.*fixture-from-oneapp/u).click(),
  );
  assert.deepEqual(Buffer.from(stockDownload), webFile.buffer);
  const attachmentInfo = await wireResponse(
    second,
    `${wire}/${attachment.id}`,
    "GET",
    downloadIndex,
  );
  assert.equal(attachmentInfo.status(), 200);
  const privateDownload = await wireResponse(
    second,
    `/api/attachment-download/${item}/${attachment.id}`,
    "GET",
    downloadIndex,
  );
  assert.equal(privateDownload.status(), 200);
  assert.equal(
    await privateDownload.request().headerValue("authorization"),
    null,
  );

  const stockIndex = second.responses.length;
  await secondClient
    .locator("app-cipher-attachments input[type=file]")
    .setInputFiles(stockFile);
  await button(secondClient, "Upload").click();
  const handshake = await wireResponse(
    second,
    `${wire}/v2`,
    "POST",
    stockIndex,
  );
  assert.equal(handshake.status(), 200);
  const stockMetadata = JSON.parse(handshake.request().postData());
  assert.match(stockMetadata.fileName, /^2\./u);
  assert.match(stockMetadata.key, /^2\./u);
  const { attachmentId, fileUploadType } = await handshake.json();
  assert.equal(fileUploadType, 0);
  const stockUpload = await wireResponse(
    second,
    `${wire}/${attachmentId}`,
    "POST",
    stockIndex,
  );
  assert.equal(stockUpload.status(), 200);
  assert.equal(
    stockUpload.request().postDataBuffer().includes(stockFile.buffer),
    false,
  );
  await openItem(secondClient, itemName);
  await button(secondClient, "Edit").click();
  await secondClient
    .locator('input[formcontrolname="username"]')
    .fill("synthetic-user-after-attachment");
  const editIndex = second.responses.length;
  await button(secondClient, "Save").click();
  const edited = await wireResponse(
    second,
    `/api/ciphers/${item}`,
    "PUT",
    editIndex,
  );
  assert.equal(edited.status(), 200);
  assert.deepEqual(
    (await edited.json()).attachments.map(({ id }) => id).sort(),
    [attachment.id, attachmentId].sort(),
  );

  await button(webVault, "Lock vault").press("Enter");
  await webVault.getByLabel("Vault master password").fill(password);
  await button(webVault, "Unlock vault").press("Enter");
  await button(webVault, itemName).press("Enter");
  await button(webVault, "Attachments").press("Enter");
  const fileRow = webVault.locator("li").filter({ hasText: stockFile.name });
  const webDownload = await downloadBytes(app, () =>
    button(fileRow, "Download plaintext").press("Enter"),
  );
  assert.deepEqual(Buffer.from(webDownload), stockFile.buffer);

  await restartWorker(app, items);
  const persisted = await downloadBytes(app, () =>
    button(fileRow, "Download plaintext").press("Enter"),
  );
  assert.deepEqual(Buffer.from(persisted), stockFile.buffer);
  assertZip(await exportStockZip(secondClient, password));
  await button(webVault, "Back to items").press("Enter");
  await button(webVault, "Back to items").press("Enter");
  await button(webVault, "Export").press("Enter");
  await webVault.getByLabel("File format").selectOption("zip");
  await webVault.getByLabel("Vault master password").fill(password);
  assertZip(
    await downloadBytes(app, () =>
      button(webVault, "Download export").press("Enter"),
    ),
  );
  console.log(
    "PASS Both clients exchanged encrypted attachments, recovered the original bytes after restart, and exported ZIP files.",
  );
  return { webAttachment: attachment.id, stockAttachment: attachmentId };
};

export const checkAttachmentCleanup = async ({
  app,
  webVault,
  second,
  secondClient,
  item,
  itemName,
  openItem,
  syncNow,
  restartKey,
  password,
  webAttachment,
  stockAttachment,
}) => {
  await syncNow(second, secondClient);
  await openStockAttachments(secondClient, itemName, openItem);
  const deletionIndex = second.responses.length;
  await button(secondClient, /Delete.*fixture-from-bitwarden/u).click();
  const dialog = secondClient.getByRole("dialog");
  await button(dialog, /^(Yes|Delete)$/u).click();
  const removed = await wireResponse(
    second,
    `/api/ciphers/${item}/attachment/${stockAttachment}`,
    "DELETE",
    deletionIndex,
  );
  assert.equal(removed.status(), 200);
  assert.deepEqual(
    (await removed.json()).cipher.attachments.map(({ id }) => id),
    [webAttachment],
  );

  await button(webVault, "Lock vault").press("Enter");
  const next = await syncNow(second, secondClient);
  assert.equal(
    next.ciphers.find(({ id }) => id === item)?.attachments.length,
    1,
  );
  await webVault.getByLabel("Vault master password").fill(password);
  await button(webVault, "Unlock vault").press("Enter");
  await webVault.getByRole("checkbox", { name: `Select ${itemName}` }).check();
  await button(webVault, "Move selected to Trash").press("Enter");
  await webVault
    .getByRole("status")
    .filter({ hasText: "Items updated." })
    .waitFor();
  const trashed = (await syncNow(second, secondClient)).ciphers.find(
    ({ id }) => id === item,
  );
  assert.ok(trashed.deletedDate);
  assert.equal(trashed.attachments[0].id, webAttachment);
  await button(webVault, "Trash").press("Enter");
  await webVault.getByRole("checkbox", { name: `Select ${itemName}` }).check();
  await button(webVault, "Permanently delete selected").press("Enter");
  await button(webVault, "Permanently delete").press("Enter");
  await webVault
    .getByRole("status")
    .filter({ hasText: "Items permanently deleted." })
    .waitFor();
  assert.ok(
    !(await syncNow(second, secondClient)).ciphers.some(
      ({ id }) => id === item,
    ),
  );
  const count = await app.evaluate(async (key) => {
    for (let retry = 0; retry < 10; retry++) {
      const response = await fetch("/_test/attachment-objects", {
        headers: { "x-test-restart": key },
      });
      const { count } = await response.json();
      if (count === 0) return 0;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return -1;
  }, restartKey);
  assert.equal(
    count,
    0,
    "Private R2 still contains attachment objects after cleanup",
  );
  await button(webVault, "Back to items").press("Enter");
  console.log(
    "PASS Stock file deletion and permanent deletion from web Trash removed the private R2 objects.",
  );
};
