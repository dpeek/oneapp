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
  await button(webVault, "Upload attachment").press("Enter");
  const reservation = await wireResponse(first, base, "POST", uploadIndex);
  assert.equal(reservation.status(), 201);
  const attachment = await reservation.json();
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

  await syncNow(second, secondClient);
  await openStockAttachments(secondClient, itemName, openItem);
  const stockDownload = await downloadBytes(secondClient, () =>
    button(secondClient, /Download.*fixture-from-oneapp/u).click(),
  );
  assert.deepEqual(Buffer.from(stockDownload), webFile.buffer);

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
