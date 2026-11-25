import assert from "node:assert/strict";
import { chromium } from "playwright";
import { checkAttachmentCleanup, checkAttachments } from "./attachments.mjs";
import {
  captureFixturePasskey,
  checkTransfers,
  importFixturePasskey,
  restoreIntoFreshVault,
} from "./transfers.mjs";

const {
  extension,
  chrome,
  certificatePin,
  origin,
  fixtureEmail,
  seeded,
  ownerPassword,
  restartKey,
  masterPassword,
  itemName,
  itemUsername,
  itemPassword,
  release,
} = JSON.parse(process.env.ONEAPP_BITWARDEN_E2E_BROWSER);

const endpoint = (response, path, method = "GET") =>
  new URL(response.url()).pathname === path &&
  response.request().method() === method;
const grantType = (response) =>
  new URLSearchParams(response.request().postData() ?? "").get("grant_type");
const isRefresh = (response) =>
  endpoint(response, "/identity/connect/token", "POST") &&
  grantType(response) === "refresh_token";
const latestGrant = async (profile, initial) => {
  const refresh = profile.responses.findLast(
    (response) => isRefresh(response) && response.ok(),
  );
  return refresh ? refresh.json() : initial;
};
const claims = (grant) =>
  JSON.parse(Buffer.from(grant.access_token.split(".")[1], "base64url"));
const button = (page, name) => page.getByRole("button", { name, exact: true });
const profiles = new Set();
const openProfile = async () => {
  const context = await chromium.launchPersistentContext("", {
    executablePath: chrome,
    channel: "chromium",
    headless: false,
    locale: "en-US",
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--ignore-certificate-errors-spki-list=${certificatePin}`,
      "--host-resolver-rules=MAP bitwarden.com ~NOTFOUND, MAP login.oneapp.test 127.0.0.1, MAP login.oneapp-vault.test 127.0.0.1",
    ],
  });
  profiles.add(context);
  context.on("close", () => profiles.delete(context));
  const responses = [];
  context.on("response", (response) => {
    if (new URL(response.url()).origin === origin) responses.push(response);
  });
  const localResponse = (match) => {
    const known = responses.find(match);
    return known
      ? Promise.resolve(known)
      : context.waitForEvent("response", {
          predicate: (response) =>
            new URL(response.url()).origin === origin && match(response),
          timeout: 30_000,
        });
  };
  return { context, responses, localResponse };
};

let step = "opening the first Chrome profile";
const siteUrl = `https://login.oneapp.test:${new URL(origin).port}/fixture-login`;
const webLoginUrl = `https://login.oneapp-vault.test:${new URL(origin).port}/fixture-login`;
const signInToOneApp = async ({ context, localResponse }) => {
  step = "signing in to OneApp";
  const app = context.pages()[0];
  await app.goto(origin);
  await app.getByLabel("Email", { exact: true }).fill(fixtureEmail);
  await app.getByLabel("Password", { exact: true }).fill(ownerPassword);
  await button(app, "Sign in").click();
  const auth = await localResponse((response) =>
    endpoint(response, "/api/auth/signIn", "POST"),
  );
  assert.equal(auth.status(), 200, "OneApp did not issue a session");
  const identity = await localResponse(
    (response) => endpoint(response, "/api/me") && response.ok(),
  );
  assert.equal((await identity.json()).email, fixtureEmail);
  return app;
};

const connectBitwarden = async ({ context, responses, localResponse }) => {
  const background =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  assert.equal(
    await background.evaluate(() => chrome.runtime.getManifest().version),
    release,
  );
  const workerUrl = new URL(background.url());
  const extensionOrigin = `chrome-extension://${workerUrl.host}`;

  step = "opening the Bitwarden login form";
  const popup = await context.newPage();
  const popupUrl = `${extensionOrigin}/popup/index.html`;
  await popup.goto(popupUrl);
  await popup.bringToFront();
  const email = popup.getByTestId("login-email-input");
  const skip = popup.locator(
    "#default-password-manager-prompt_button_skip-for-now",
  );
  const introLogin = button(popup.locator("app-intro-carousel"), "Log in");
  const onboardingDeadline = Date.now() + 60_000;
  while (!(await email.isVisible())) {
    if (Date.now() >= onboardingDeadline)
      throw new Error("The extension login form did not open.");
    await email.or(skip).or(introLogin).first().waitFor({ timeout: 20_000 });
    if (await skip.isVisible()) await skip.click();
    else if (await introLogin.isVisible()) await introLogin.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  step = "selecting a self-hosted server";
  await button(popup, "bitwarden.com").click();
  await popup.getByText("self-hosted", { exact: true }).click();
  await popup.getByLabel("Server URL", { exact: true }).fill(origin);
  await button(popup, "Save").click();
  const config = await localResponse((response) =>
    endpoint(response, "/api/config"),
  );
  assert.equal(config.status(), 200);
  await email.fill(fixtureEmail);

  step = "authorizing Bitwarden with the existing OneApp session";
  const consentPage = context.waitForEvent("page", { timeout: 15_000 });
  await popup.getByTestId("login-sso-button").click();
  const consent = await consentPage;
  await button(consent, "Connect vault").waitFor();
  const popoutPage = context.waitForEvent("page", { timeout: 20_000 });
  await button(consent, "Connect vault").click();
  const client = await popoutPage;
  await popup.close();
  const redemption = await localResponse(
    (response) =>
      endpoint(response, "/identity/connect/token", "POST") &&
      grantType(response) === "authorization_code",
  );
  assert.equal(redemption.status(), 200);
  assert.equal(
    responses.filter((response) =>
      endpoint(response, "/api/auth/signIn", "POST"),
    ).length,
    1,
  );
  const token = await redemption.json();
  console.log(
    "PASS OneApp SSO used the existing sign-in and exchanged a PKCE code.",
  );
  return { client, token };
};

const openItem = async (client, name, section = "/tabs/vault") => {
  await client.bringToFront();
  const view = new URL(client.url());
  view.hash = section;
  await client.goto(view.href);
  const list = client.locator(
    section === "/trash"
      ? "app-trash-list-items-container"
      : "app-vault-list-items-container",
  );
  await list.getByText(name, { exact: true }).click();
};

const editPassword = async (client, password) => {
  await openItem(client, itemName);
  await button(client, "Edit").click();
  await client.locator('input[formcontrolname="password"]').fill(password);
};

const syncNow = async (profile, client) => {
  await client.bringToFront();
  const settings = new URL(client.url());
  settings.hash = "/vault-settings";
  await client.goto(settings.href);
  const index = profile.responses.length;
  await client.getByRole("button", { name: /^Sync now/u }).click();
  const synced = await profile.localResponse(
    (response) =>
      endpoint(response, "/api/sync") &&
      profile.responses.indexOf(response) >= index,
  );
  assert.equal(synced.status(), 200);
  return synced.json();
};

const restartWorker = async (app, expectedItems = 1) => {
  const status = await app.evaluate(
    async ({ restartKey, expectedItems }) => {
      const response = await fetch(`/_test/restart?items=${expectedItems}`, {
        method: "POST",
        headers: { "x-test-restart": restartKey },
      });
      return response.status;
    },
    { restartKey, expectedItems },
  );
  assert.equal(status, 204);
};

let context;
let transfer;
try {
  const first = await openProfile();
  const { responses, localResponse } = first;
  context = first.context;
  const app = await signInToOneApp(first);

  if (!seeded) {
    step = "creating a vault in OneApp";
    await app.getByRole("link", { name: "Vault", exact: true }).click();
    const status = await localResponse((response) =>
      endpoint(response, "/api/vault/setup"),
    );
    assert.equal(status.status(), 200);
    assert.deepEqual(await status.json(), {
      initialized: false,
      kdfSalt: fixtureEmail,
    });

    await app
      .getByLabel("Vault master password", { exact: true })
      .fill(masterPassword);
    const confirmation = app.getByLabel("Confirm vault master password", {
      exact: true,
    });
    await confirmation.fill("A different fixture password");
    await button(app, "Create vault").click();
    await app
      .getByText("The master passwords must match.", { exact: true })
      .waitFor();

    await confirmation.fill(masterPassword);
    await button(app, "Create vault").click();
    const creation = await localResponse((response) =>
      endpoint(response, "/api/vault/setup", "POST"),
    );
    assert.equal(creation.status(), 201);
    const submitted = creation.request().postData();
    assert.ok(
      submitted && !submitted.includes(masterPassword),
      "The master password left the browser.",
    );
    const material = JSON.parse(submitted);
    assert.deepEqual(Object.keys(material).sort(), [
      "kdfSalt",
      "keyId",
      "publicKey",
      "wrappedKey",
      "wrappedPrivateKey",
    ]);
    const unlock = app.locator("oneapp-vault-reader");
    await unlock.getByLabel("Vault master password", { exact: true }).waitFor();
    await app.reload();
    await unlock.getByLabel("Vault master password", { exact: true }).waitFor();
    console.log(
      "PASS A fresh OneApp account created a vault with browser-generated keys.",
    );
  }

  const { client, token } = await connectBitwarden(first);

  step = "syncing and unlocking the vault";
  const master = client.getByLabel("Master password", { exact: false }).first();
  await master.waitFor();
  const sync = await localResponse((response) =>
    endpoint(response, "/api/sync"),
  );
  assert.equal(sync.status(), 200);
  const vault = await sync.json();
  assert.equal(vault.ciphers.length, seeded ? 1 : 0);
  assert.match(vault.profile.key, /^2\./u);
  if (!seeded) {
    const setup = responses.find((response) =>
      endpoint(response, "/api/vault/setup", "POST"),
    );
    const material = JSON.parse(setup.request().postData());
    assert.equal(vault.userDecryption.userKeyId, material.keyId);
    assert.equal(vault.profile.key, material.wrappedKey);
  }
  await context.setOffline(true);
  await master.fill(masterPassword);
  await button(client, "Unlock").click();
  if (seeded) {
    assert.match(vault.ciphers[0].login.password, /^2\./u);
    assert.notEqual(vault.ciphers[0].name, itemName);
    await client.getByText(itemName, { exact: true }).click();
    const username = client.getByTestId("login-username");
    await username.waitFor();
    assert.equal(await username.inputValue(), itemUsername);
    await client.getByTestId("toggle-password").click();
    await client.getByTestId("login-password-color").waitFor();
    assert.equal(
      await client.getByTestId("login-password").inputValue(),
      itemPassword,
    );
  } else {
    await client.waitForURL((url) => url.hash.startsWith("#/tabs/"));
    assert.equal(await master.isVisible(), false);
  }
  await context.setOffline(false);
  console.log(
    seeded
      ? "PASS Bitwarden unlocked offline and decrypted the synced fixture username and password."
      : "PASS Bitwarden synced the web-created empty vault and unlocked it offline.",
  );

  if (seeded) {
    step = "confirming a stock Bitwarden export locally";
    const exportUrl = new URL(client.url());
    exportUrl.hash = "/export";
    await client.goto(exportUrl.href);
    await client
      .locator('select[formcontrolname="format"]')
      .selectOption("json");
    await context.setOffline(true);
    await button(client, "Export").click();
    const dialog = client.getByRole("dialog");
    await dialog.locator('input[type="password"]').fill(masterPassword);
    const exportDownload = client.waitForEvent("download");
    await button(dialog, "Continue").click();
    const download = await exportDownload;
    const data = await new Response(await download.createReadStream()).json();
    assert.equal(data.encrypted, false);
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].name, itemName);
    assert.equal(data.items[0].login.username, itemUsername);
    assert.equal(data.items[0].login.password, itemPassword);
    await download.delete();
    await context.setOffline(false);
    console.log(
      "PASS Bitwarden confirmed and exported the seeded login offline.",
    );
  }

  if (!seeded) {
    step = "saving a personal login in the first Bitwarden profile";
    const formUrl = new URL(client.url());
    formUrl.hash = "/add-cipher?type=1";
    await client.goto(formUrl.href);
    await client.locator('input[formcontrolname="name"]').fill(itemName);
    await client
      .locator('input[formcontrolname="username"]')
      .fill(itemUsername);
    await client
      .locator('input[formcontrolname="password"]')
      .fill(itemPassword);
    await client
      .locator("vault-autofill-uri-option input")
      .first()
      .fill(siteUrl);
    await button(client, "Save").click();
    const creation = await localResponse((response) =>
      endpoint(response, "/api/ciphers", "POST"),
    );
    const posted = creation.request().postData();
    const body = JSON.parse(posted);
    assert.ok(
      ![itemName, itemUsername, itemPassword, siteUrl].some((value) =>
        posted.includes(value),
      ),
      "The extension sent a plaintext login field.",
    );
    assert.equal(creation.status(), 200);
    const saved = await creation.json();
    assert.match(saved.id, /^[0-9a-f-]{36}$/u);
    assert.ok(
      saved.name === body.name &&
        saved.key === body.key &&
        saved.login.username === body.login.username &&
        saved.login.password === body.login.password &&
        saved.login.uris[0].uri === body.login.uris[0].uri &&
        saved.login.uris[0].uriChecksum === body.login.uris[0].uriChecksum,
      "The adapter changed the encrypted login fields.",
    );
    vault.ciphers = [saved];
    console.log(
      "PASS Bitwarden saved an encrypted personal login in the first profile.",
    );
  }

  if (!seeded) {
    step = "starting an independent second Chrome profile";
    const second = await openProfile();
    context = second.context;
    await signInToOneApp(second);
    const { client: secondClient, token: secondToken } =
      await connectBitwarden(second);
    assert.notEqual(secondToken.access_token, token.access_token);

    step = "syncing and unlocking the saved login in the second profile";
    const synced = await second.localResponse((response) =>
      endpoint(response, "/api/sync"),
    );
    assert.equal(synced.status(), 200);
    assert.equal(
      await synced.request().headerValue("authorization"),
      `Bearer ${secondToken.access_token}`,
    );
    assert.deepEqual((await synced.json()).ciphers, vault.ciphers);
    const master = secondClient
      .getByLabel("Master password", { exact: false })
      .first();
    await master.fill(masterPassword);
    await button(secondClient, "Unlock").click();
    await secondClient.getByText(itemName, { exact: true }).waitFor();
    console.log(
      "PASS An independent Bitwarden profile synced and unlocked the saved login.",
    );

    step = "opening the same login for editing in both profiles";
    const [original] = vault.ciphers;
    const cipherPath = `/api/ciphers/${original.id}`;
    const rotatedPassword = "OneApp rotated fixture password #42";
    const stalePassword = "OneApp stale fixture password #73";
    await editPassword(secondClient, stalePassword);
    await editPassword(client, rotatedPassword);

    step = "rotating the saved password in the first profile";
    await button(client, "Save").click();
    const update = await localResponse((response) =>
      endpoint(response, cipherPath, "PUT"),
    );
    assert.equal(update.status(), 200);
    const updated = await update.json();
    const submittedUpdate = update.request().postData();
    assert.ok(
      !submittedUpdate.includes(rotatedPassword),
      "The updated password left Chrome as plaintext.",
    );
    const updateBody = JSON.parse(submittedUpdate);
    assert.equal(updateBody.lastKnownRevisionDate, original.revisionDate);
    assert.equal(updated.id, original.id);
    assert.equal(updated.creationDate, original.creationDate);
    assert.ok(
      Date.parse(updated.revisionDate) > Date.parse(original.revisionDate),
    );
    assert.ok(
      updated.login.password === updateBody.login.password &&
        updated.login.password !== original.login.password,
      "The Worker did not preserve the newly encrypted password.",
    );
    const toast = client.getByTestId("toast-message").first();
    await toast.waitFor({ timeout: 8_000 });
    assert.equal((await toast.textContent()).trim(), "Item saved");
    vault.ciphers = [updated];
    console.log(
      "PASS Bitwarden saved a password rotation with the same item ID.",
    );

    step = "rejecting the stale edit in the second profile";
    await button(secondClient, "Save").click();
    const conflict = await second.localResponse((response) =>
      endpoint(response, cipherPath, "PUT"),
    );
    assert.equal(
      JSON.parse(conflict.request().postData()).lastKnownRevisionDate,
      original.revisionDate,
    );
    assert.equal(conflict.status(), 409);
    const { message } = await conflict.json();
    await secondClient
      .getByText(message, { exact: true })
      .first()
      .waitFor({ timeout: 8_000 });
    console.log(
      "PASS Bitwarden showed the conflict and told the user to sync and reopen the item.",
    );

    step = "syncing the winning revision in the second profile";
    const recovered = await syncNow(second, secondClient);
    assert.deepEqual(recovered.ciphers, vault.ciphers);

    step = "autofilling the rotated password on the fixture site";
    const site = await context.newPage();
    await site.goto(siteUrl);
    const username = site.getByLabel("Username", { exact: true });
    const password = site.getByLabel("Password", { exact: true });
    assert.equal(await username.inputValue(), "");
    assert.equal(await password.inputValue(), "");

    const autofillSettings = new URL(secondClient.url());
    autofillSettings.hash = "/autofill";
    await secondClient.goto(autofillSettings.href);
    const defaultAutofill = secondClient.locator("#defaultAutofill");
    const settingValue = defaultAutofill.getByTestId("bit-select-value");
    await settingValue.waitFor();
    const toggle = secondClient.locator("#autofillOnPageLoad");
    if (!(await toggle.isChecked())) {
      await secondClient.locator('bit-label[for="autofillOnPageLoad"]').click();
      assert.equal(await toggle.isChecked(), true);
    }
    if (/\b(?:do not|never)\b/iu.test(await settingValue.textContent())) {
      await defaultAutofill.locator(".ng-select-container").click();
      // The pinned settings list puts the enabled choice before the disabled one.
      const choices = secondClient.locator("ng-dropdown-panel .ng-option");
      await choices.first().click({ timeout: 8_000 });
    }
    const autofill = async (
      target = site,
      expectedUsername = itemUsername,
      expectedPassword = rotatedPassword,
    ) => {
      await target.bringToFront();
      await target.reload();
      await target.waitForFunction(
        ({ expectedUsername, expectedPassword }) =>
          document.querySelector('input[name="username"]')?.value ===
            expectedUsername &&
          document.querySelector('input[name="password"]')?.value ===
            expectedPassword,
        { expectedUsername, expectedPassword },
      );
    };
    const assertNoAutofill = async (target) => {
      await target.bringToFront();
      await target.reload();
      await assert.rejects(
        target.waitForFunction(
          () =>
            Boolean(
              document.querySelector('input[name="username"]')?.value ||
              document.querySelector('input[name="password"]')?.value,
            ),
          null,
          { timeout: 3000 },
        ),
        { name: "TimeoutError" },
      );
      assert.equal(
        await target.getByLabel("Username", { exact: true }).inputValue(),
        "",
      );
      assert.equal(
        await target.getByLabel("Password", { exact: true }).inputValue(),
        "",
      );
    };
    await autofill();
    console.log(
      "PASS The pinned extension autofilled the username and rotated password in the second profile.",
    );

    step = "moving the login to Trash in the first profile";
    await editPassword(secondClient, stalePassword);
    await openItem(client, itemName);
    await button(client, "Delete").click();
    await button(client.getByRole("dialog"), "Yes").click();
    const deleted = await localResponse((response) =>
      endpoint(response, `${cipherPath}/delete`, "PUT"),
    );
    assert.equal(deleted.status(), 204);

    step = "rejecting a pending edit of the trashed login";
    const afterDelete = second.responses.length;
    await button(secondClient, "Save").click();
    const trashedEdit = await second.localResponse(
      (response) =>
        endpoint(response, cipherPath, "PUT") &&
        second.responses.indexOf(response) >= afterDelete,
    );
    assert.equal(
      JSON.parse(trashedEdit.request().postData()).lastKnownRevisionDate,
      updated.revisionDate,
    );
    assert.equal(trashedEdit.status(), 409);
    const rejectedEdit = await trashedEdit.json();
    assert.equal(rejectedEdit.error, "cipher_trashed");
    await secondClient
      .getByTestId("toast-message")
      .filter({ hasText: rejectedEdit.message })
      .waitFor();

    step = "syncing the trashed login after restarting the Worker";
    await restartWorker(app);
    const afterTrash = await syncNow(second, secondClient);
    const [trashed] = afterTrash.ciphers;
    assert.deepEqual(afterTrash.ciphers, [
      {
        ...updated,
        deletedDate: trashed.revisionDate,
        revisionDate: trashed.revisionDate,
        permissions: { delete: false, restore: true },
      },
    ]);
    assert.ok(
      Date.parse(trashed.revisionDate) > Date.parse(updated.revisionDate),
    );
    await openItem(secondClient, itemName, "/trash");
    await button(secondClient, "Restore").waitFor();
    assert.equal(
      await button(secondClient, "Delete forever").isVisible(),
      false,
    );

    step = "checking that the trashed login no longer autofills";
    await assertNoAutofill(site);
    console.log(
      "PASS The trashed login blocked stale edits, survived a restart, and stopped autofilling in the second profile.",
    );

    step = "restoring the login from Trash in the first profile";
    await openItem(client, itemName, "/trash");
    await button(client, "Restore").click();
    const restore = await localResponse((response) =>
      endpoint(response, `${cipherPath}/restore`, "PUT"),
    );
    assert.equal(restore.status(), 200);
    const restored = await restore.json();
    assert.deepEqual(restored, {
      ...updated,
      revisionDate: restored.revisionDate,
    });
    assert.ok(
      Date.parse(restored.revisionDate) > Date.parse(trashed.revisionDate),
    );
    vault.ciphers = [restored];

    step = "syncing and autofilling the restored login in the second profile";
    const afterRestore = await syncNow(second, secondClient);
    assert.deepEqual(afterRestore.ciphers, vault.ciphers);
    await autofill();
    await openItem(client, itemName);
    await button(client, "Edit").waitFor();
    console.log(
      "PASS The restored login kept its ID and autofilled again in the second profile.",
    );

    step = "creating an encrypted Secure Note in the first profile";
    const noteName = "OneApp test Secure Note";
    const initialNote = "Synthetic note for Chrome.\nFirst revision.";
    const revisedNote = "Synthetic note for Chrome.\nRevised in profile one.";
    const newNote = new URL(client.url());
    newNote.hash = "/add-cipher?type=2";
    await client.goto(newNote.href);
    await client.locator('input[formcontrolname="name"]').fill(noteName);
    const noteInput = client.locator('textarea[formcontrolname="notes"]');
    await noteInput.fill(initialNote);
    const beforeNote = responses.length;
    await button(client, "Save").click();
    const noteCreated = await localResponse(
      (response) =>
        endpoint(response, "/api/ciphers", "POST") &&
        responses.indexOf(response) >= beforeNote,
    );
    assert.equal(noteCreated.status(), 200);
    const createdNote = await noteCreated.json();
    const submittedNote = noteCreated.request().postData();
    assert.ok(
      !submittedNote.includes(noteName) &&
        !submittedNote.includes(initialNote.split("\n")[0]),
    );
    const createdBody = JSON.parse(submittedNote);
    assert.equal(createdBody.type, 2);
    assert.equal(createdBody.secureNote.type, 0);
    assert.match(createdBody.notes, /^2\./u);
    assert.equal(createdNote.notes, createdBody.notes);
    const visibleNote = client.locator("textarea#notes");
    await visibleNote.waitFor();
    assert.equal(await visibleNote.inputValue(), initialNote);

    step = "editing the Secure Note in the first profile";
    await button(client, "Edit").click();
    await noteInput.fill(revisedNote);
    await button(client, "Save").click();
    const noteChanged = await localResponse((response) =>
      endpoint(response, `/api/ciphers/${createdNote.id}`, "PUT"),
    );
    assert.equal(noteChanged.status(), 200);
    const submittedEdit = noteChanged.request().postData();
    assert.ok(!submittedEdit.includes(revisedNote.split("\n")[1]));
    const editedBody = JSON.parse(submittedEdit);
    assert.equal(editedBody.lastKnownRevisionDate, createdNote.revisionDate);
    const updatedNote = await noteChanged.json();
    assert.equal(updatedNote.id, createdNote.id);
    assert.equal(updatedNote.type, 2);
    assert.deepEqual(updatedNote.secureNote, { type: 0 });
    assert.ok(
      updatedNote.notes === editedBody.notes &&
        updatedNote.notes !== createdNote.notes,
    );
    assert.ok(
      Date.parse(updatedNote.revisionDate) >
        Date.parse(createdNote.revisionDate),
    );
    vault.ciphers = [restored, updatedNote].sort((a, b) =>
      a.id.localeCompare(b.id),
    );

    step = "syncing and decrypting the Secure Note in the second profile";
    const mixed = await syncNow(second, secondClient);
    assert.deepEqual(mixed.ciphers, vault.ciphers);
    await context.setOffline(true);
    await openItem(secondClient, noteName);
    const decryptedNote = secondClient.locator("textarea#notes");
    await decryptedNote.waitFor();
    assert.equal(await decryptedNote.inputValue(), revisedNote);
    await context.setOffline(false);
    await autofill();
    console.log(
      "PASS Bitwarden created, edited, and decrypted the Secure Note across profiles. The login still autofilled.",
    );

    step = "opening the encrypted vault in the OneApp web app";
    await app.goto(new URL("/vault", origin).href);
    const webVault = app.locator("oneapp-vault-reader");
    const unlockPassword = webVault.getByLabel("Vault master password", {
      exact: true,
    });
    // Exercise the vault by keyboard because Bitwarden can overlay its controls.
    const unlockWeb = async (password) => {
      await unlockPassword.fill(password);
      await unlockPassword.press("Enter");
    };
    await unlockWeb("Incorrect test master password");
    await webVault
      .getByRole("alert")
      .filter({ hasText: /check your master password/iu })
      .waitFor();
    assert.equal(
      await unlockPassword.evaluate(
        (input) => input === document.activeElement,
      ),
      true,
    );
    assert.equal(await button(webVault, itemName).count(), 0);
    await unlockWeb(masterPassword);
    await button(webVault, itemName).waitFor();
    const snapshot = await localResponse((response) =>
      endpoint(response, "/api/vault/items"),
    );
    assert.equal(snapshot.status(), 200);
    assert.equal(snapshot.request().postData(), null);
    assert.equal(await snapshot.headerValue("cache-control"), "no-store");
    const encryptedSnapshot = await snapshot.text();
    assert.ok(
      ![
        masterPassword,
        itemName,
        itemUsername,
        rotatedPassword,
        noteName,
        "Revised in profile one.",
      ].some((value) => encryptedSnapshot.includes(value)),
      "OneApp returned a plaintext vault value.",
    );

    step = "reading the login and Secure Note in OneApp";
    await button(webVault, noteName).press("Enter");
    const noteText = webVault
      .locator("dd")
      .filter({ hasText: "Revised in profile one." });
    await noteText.waitFor();
    assert.equal(await noteText.textContent(), revisedNote);
    await button(webVault, "Back to items").press("Enter");
    assert.equal(await webVault.getByRole("alert").count(), 0);
    await button(webVault, itemName).press("Enter");
    await webVault.getByText(itemUsername, { exact: true }).waitFor();
    await webVault.getByText(siteUrl, { exact: true }).waitFor();
    assert.equal(
      await webVault.getByText(rotatedPassword, { exact: true }).count(),
      0,
    );
    await button(webVault, "Show password").press("Enter");
    await webVault.getByText(rotatedPassword, { exact: true }).waitFor();

    step = "clearing the web vault on lock and navigation";
    await button(webVault, "Lock vault").press("Enter");
    await unlockPassword.waitFor();
    const lockedContent = await webVault.textContent();
    assert.ok(
      ![
        itemName,
        itemUsername,
        rotatedPassword,
        noteName,
        revisedNote,
        siteUrl,
      ].some((value) => lockedContent.includes(value)),
      "The locked page retained a decrypted vault value.",
    );
    assert.equal(
      await webVault
        .getByLabel("Vault master password", { exact: true })
        .inputValue(),
      "",
    );
    await unlockWeb(masterPassword);
    await button(webVault, noteName).press("Enter");
    await noteText.waitFor();
    await app.getByRole("link", { name: "Links", exact: true }).press("Enter");
    await webVault.waitFor({ state: "detached" });
    await app.getByRole("link", { name: "Vault", exact: true }).press("Enter");
    await unlockPassword.waitFor();
    assert.equal(await noteText.count(), 0);
    assert.equal(await button(webVault, noteName).count(), 0);
    console.log(
      "PASS OneApp opened both Bitwarden items locally and cleared decrypted values on lock and navigation.",
    );

    step = "creating a Secure Note in OneApp";
    const webNoteTitle = "Created in the OneApp web vault";
    const webNoteBody =
      "Encrypted before sending.\nSecond line with Unicode 🔒";
    const itemsPath = "/api/vault/items";
    const isWebSave = (response) => endpoint(response, itemsPath, "POST");
    await unlockWeb(masterPassword);
    await button(webVault, "New Secure Note").press("Enter");
    await webVault.getByLabel("Title", { exact: true }).fill(webNoteTitle);
    await webVault.getByLabel("Note", { exact: true }).fill(webNoteBody);
    await app.evaluate((path) => {
      const original = window.fetch;
      window.fetch = async (input, init) => {
        if (input !== path || init?.method !== "POST")
          return original.call(window, input, init);
        window.fetch = original;
        const response = await original.call(window, input, init);
        await response.arrayBuffer();
        throw new TypeError("Simulated loss of the save response");
      };
    }, itemsPath);
    await button(webVault, "Save").press("Enter");
    const firstSave = await localResponse(isWebSave);
    const submitted = firstSave.request().postData();
    assert.equal(firstSave.status(), 201);
    assert.ok(
      submitted &&
        ![webNoteTitle, "Encrypted before sending.", masterPassword].some(
          (value) => submitted.includes(value),
        ),
      "OneApp sent a plaintext vault value.",
    );
    const sealed = JSON.parse(submitted);
    assert.deepEqual(Object.keys(sealed).sort(), [
      "keyId",
      "name",
      "notes",
      "wrappedKey",
    ]);
    for (const value of [sealed.name, sealed.notes, sealed.wrappedKey])
      assert.match(value, /^2\./u);
    await webVault
      .getByRole("alert")
      .getByText("Could not save your note. Try again.")
      .waitFor({ timeout: 10_000 });
    assert.equal(
      await webVault.getByLabel("Note", { exact: true }).inputValue(),
      webNoteBody,
    );
    await button(webVault, "Save").press("Enter");
    const retry = await localResponse(
      (response) => isWebSave(response) && response !== firstSave,
    );
    assert.equal(retry.status(), 201);
    assert.equal(retry.request().postData(), submitted);
    const savedWebNote = await retry.json();
    step = "opening the saved note in the OneApp web vault";
    await webVault
      .getByRole("heading", { name: webNoteTitle, exact: true })
      .waitFor({ timeout: 10_000 });
    assert.equal(
      await webVault.locator("dd").textContent({ timeout: 10_000 }),
      webNoteBody,
    );

    step = "syncing the OneApp Secure Note into the second Bitwarden profile";
    const afterWebSave = await syncNow(second, secondClient);
    const syncedWebNote = afterWebSave.ciphers.find(
      ({ id }) => id === savedWebNote.id,
    );
    assert.deepEqual(
      afterWebSave.ciphers.filter(({ id }) => id !== savedWebNote.id),
      vault.ciphers,
    );
    assert.equal(syncedWebNote.type, 2);
    assert.deepEqual(syncedWebNote.secureNote, { type: 0 });
    assert.equal(syncedWebNote.name, sealed.name);
    assert.equal(syncedWebNote.notes, sealed.notes);
    assert.equal(syncedWebNote.key, sealed.wrappedKey);
    vault.ciphers = afterWebSave.ciphers;
    await context.setOffline(true);
    await openItem(secondClient, webNoteTitle);
    await decryptedNote.waitFor();
    assert.equal(await decryptedNote.inputValue(), webNoteBody);
    await context.setOffline(false);
    console.log(
      "PASS OneApp saved an encrypted Secure Note once across a retry and Bitwarden opened it offline.",
    );

    step = "editing a Secure Note in OneApp";
    const editedWebTitle = "Renamed in OneApp";
    const editedWebBody = "First edit from the OneApp web vault.";
    const webEditPath = `${itemsPath}/${savedWebNote.id}`;
    const isWebEdit = (response) => endpoint(response, webEditPath, "PUT");
    const editWebNote = button(webVault, "Edit");
    const webTitle = webVault.getByLabel("Title", { exact: true });
    const webBody = webVault.getByLabel("Note", { exact: true });
    const saveWebNote = button(webVault, "Save");
    await editWebNote.press("Enter", { timeout: 10_000 });
    assert.equal(await webTitle.inputValue(), webNoteTitle);
    assert.equal(await webBody.inputValue(), webNoteBody);
    await webTitle.fill(editedWebTitle);
    await webBody.fill(editedWebBody);
    await saveWebNote.press("Enter");
    const savedWebEdit = await localResponse(isWebEdit);
    assert.equal(savedWebEdit.status(), 200);
    const submittedWebEdit = savedWebEdit.request().postData();
    assert.ok(
      ![editedWebTitle, editedWebBody, masterPassword].some((value) =>
        submittedWebEdit.includes(value),
      ),
    );
    const editedFields = JSON.parse(submittedWebEdit);
    assert.deepEqual(Object.keys(editedFields).sort(), [
      "expectedRevision",
      "keyId",
      "name",
      "notes",
    ]);
    assert.match(editedFields.name, /^2\./u);
    assert.match(editedFields.notes, /^2\./u);
    assert.equal(editedFields.expectedRevision, savedWebNote.revision);
    const editedWebNote = await savedWebEdit.json();
    assert.equal(editedWebNote.id, savedWebNote.id);
    assert.equal(editedWebNote.wrappedKey, savedWebNote.wrappedKey);
    assert.ok(editedWebNote.revision > savedWebNote.revision);
    await webVault
      .getByRole("heading", { name: editedWebTitle, exact: true })
      .waitFor({ timeout: 10_000 });
    assert.equal(await webVault.locator("dd").textContent(), editedWebBody);

    step = "syncing the OneApp edit into Bitwarden";
    const afterWebEdit = await syncNow(second, secondClient);
    const syncedWebEdit = afterWebEdit.ciphers.find(
      ({ id }) => id === savedWebNote.id,
    );
    assert.deepEqual(syncedWebEdit, {
      ...syncedWebNote,
      name: editedFields.name,
      notes: editedFields.notes,
      revisionDate: new Date(editedWebNote.revision).toISOString(),
    });
    await context.setOffline(true);
    await openItem(secondClient, editedWebTitle);
    await secondClient.waitForURL((url) =>
      url.hash.startsWith("#/view-cipher?"),
    );
    await secondClient.reload();
    await secondClient.waitForFunction(
      (expected) =>
        document.querySelector("textarea#notes")?.value === expected,
      editedWebBody,
      { timeout: 10_000 },
    );
    await context.setOffline(false);
    console.log(
      "PASS Bitwarden synced the encrypted web edit and opened the renamed note offline.",
    );

    step =
      "saving a newer Bitwarden edit while an older draft is open in OneApp";
    const staleDraft = "Unsent changes in the OneApp editor.";
    const deviceNoteBody = "A newer revision saved in Bitwarden.";
    await editWebNote.press("Enter");
    await webBody.fill(staleDraft);
    await button(secondClient, "Edit").click();
    await secondClient
      .locator('textarea[formcontrolname="notes"]')
      .fill(deviceNoteBody);
    await button(secondClient, "Save").click();
    const savedDeviceEdit = await second.localResponse((response) =>
      endpoint(response, `/api/ciphers/${savedWebNote.id}`, "PUT"),
    );
    assert.equal(savedDeviceEdit.status(), 200);
    const deviceEdit = await savedDeviceEdit.json();
    assert.ok(Date.parse(deviceEdit.revisionDate) > editedWebNote.revision);

    step = "rejecting the stale OneApp edit and reloading the winning note";
    await saveWebNote.press("Enter");
    const rejectedWebEdit = await localResponse(
      (response) => isWebEdit(response) && response !== savedWebEdit,
    );
    assert.equal(rejectedWebEdit.status(), 409);
    assert.equal(
      JSON.parse(rejectedWebEdit.request().postData()).expectedRevision,
      editedWebNote.revision,
    );
    await webVault
      .getByRole("alert")
      .filter({ hasText: "This note changed since you opened it." })
      .waitFor({ timeout: 10_000 });
    assert.equal(await webBody.inputValue(), staleDraft);
    await button(webVault, "Cancel").press("Enter");
    await webVault
      .getByText(deviceNoteBody, { exact: true })
      .waitFor({ timeout: 10_000 });
    vault.ciphers = afterWebEdit.ciphers.map((item) =>
      item.id === deviceEdit.id ? deviceEdit : item,
    );
    console.log(
      "PASS OneApp preserved the stale draft, rejected its save, and reloaded the newer Bitwarden edit.",
    );

    step = "creating a personal login in OneApp";
    const webLoginTitle = "Personal login created in OneApp";
    const webLoginUsername = "oneapp-login-test@example.net";
    const webLoginPassword = "Synthetic-OneApp-Login-Password!37";
    await button(webVault, "Back to items").press("Enter");
    await button(webVault, "New Login").press("Enter");
    await webVault.getByLabel("Title", { exact: true }).fill(webLoginTitle);
    await webVault
      .getByLabel("Username", { exact: true })
      .fill(webLoginUsername);
    const webPassword = webVault.getByLabel("Password", { exact: true });
    assert.equal(await webPassword.getAttribute("type"), "password");
    await webPassword.fill(webLoginPassword);
    await webVault.getByLabel("Website", { exact: true }).fill(webLoginUrl);
    const beforeWebLogin = responses.length;
    await button(webVault, "Save").press("Enter");
    const webLoginResponse = await localResponse(
      (response) =>
        isWebSave(response) && responses.indexOf(response) >= beforeWebLogin,
    );
    assert.equal(webLoginResponse.status(), 201);
    const submittedLogin = webLoginResponse.request().postData();
    assert.ok(
      ![
        webLoginTitle,
        webLoginUsername,
        webLoginPassword,
        webLoginUrl,
        masterPassword,
      ].some((value) => submittedLogin.includes(value)),
      "OneApp sent a plaintext login field.",
    );
    const encryptedLogin = JSON.parse(submittedLogin);
    assert.equal(encryptedLogin.type, 1);
    assert.deepEqual(Object.keys(encryptedLogin).sort(), [
      "keyId",
      "name",
      "password",
      "type",
      "username",
      "website",
      "wrappedKey",
    ]);
    assert.deepEqual(Object.keys(encryptedLogin.website).sort(), [
      "uri",
      "uriChecksum",
    ]);
    for (const value of [
      encryptedLogin.name,
      encryptedLogin.username,
      encryptedLogin.password,
      encryptedLogin.website.uri,
      encryptedLogin.website.uriChecksum,
      encryptedLogin.wrappedKey,
    ]) {
      assert.match(value, /^2\./u);
    }
    const savedLogin = await webLoginResponse.json();
    await webVault
      .getByRole("heading", { name: webLoginTitle, exact: true })
      .waitFor({ timeout: 10_000 });
    await webVault
      .getByText(webLoginUsername, { exact: true })
      .waitFor({ timeout: 10_000 });
    await webVault
      .getByText(webLoginUrl, { exact: true })
      .waitFor({ timeout: 10_000 });
    const websiteActions = webVault
      .getByRole("group", { name: "Website", exact: true })
      .locator('[data-slot="input-group-addon"]');
    assert.equal(await websiteActions.locator("button:visible").count(), 1);
    assert.equal(
      await webVault.getByText(webLoginPassword, { exact: true }).count(),
      0,
    );

    step =
      "syncing and autofilling the OneApp login in the second Bitwarden profile";
    const afterWebLogin = await syncNow(second, secondClient);
    const syncedWebLogin = afterWebLogin.ciphers.find(
      ({ id }) => id === savedLogin.id,
    );
    assert.deepEqual(
      afterWebLogin.ciphers.filter(({ id }) => id !== savedLogin.id),
      vault.ciphers,
    );
    assert.equal(syncedWebLogin.type, 1);
    assert.equal(syncedWebLogin.name, encryptedLogin.name);
    assert.equal(syncedWebLogin.key, encryptedLogin.wrappedKey);
    assert.equal(syncedWebLogin.login.username, encryptedLogin.username);
    assert.equal(syncedWebLogin.login.password, encryptedLogin.password);
    assert.deepEqual(syncedWebLogin.login.uris, [
      { ...encryptedLogin.website, match: 1 },
    ]);
    vault.ciphers = afterWebLogin.ciphers;
    const webLoginSite = await context.newPage();
    await webLoginSite.goto(webLoginUrl);
    await autofill(webLoginSite, webLoginUsername, webLoginPassword);
    await autofill();
    console.log(
      "PASS OneApp encrypted a personal login before saving and Bitwarden autofilled it on the matching fixture site.",
    );

    step = "rotating the personal login password in OneApp";
    const rotatedWebPassword = "Rotated-In-OneApp!45";
    const editWebLogin = button(webVault, "Edit");
    const saveWebLogin = button(webVault, "Save");
    const isWebLoginEdit = (response) =>
      endpoint(response, `${itemsPath}/${savedLogin.id}`, "PUT");
    await editWebLogin.press("Enter");
    assert.equal(await webTitle.inputValue(), webLoginTitle);
    assert.equal(
      await webVault.getByLabel("Username", { exact: true }).inputValue(),
      webLoginUsername,
    );
    assert.equal(
      await webVault.getByLabel("Website", { exact: true }).inputValue(),
      webLoginUrl,
    );
    assert.equal(await webPassword.inputValue(), webLoginPassword);
    await webPassword.fill(rotatedWebPassword);
    await saveWebLogin.press("Enter");
    const loginEditResponse = await localResponse(isWebLoginEdit);
    assert.equal(loginEditResponse.status(), 200);
    const loginEditRequest = loginEditResponse.request().postData();
    assert.ok(
      ![
        rotatedWebPassword,
        webLoginPassword,
        webLoginUsername,
        webLoginUrl,
      ].some((value) => loginEditRequest.includes(value)),
      "OneApp sent a plaintext login field when editing.",
    );
    const loginEdit = JSON.parse(loginEditRequest);
    assert.equal(loginEdit.expectedRevision, savedLogin.revision);
    assert.equal(loginEdit.name, encryptedLogin.name);
    assert.equal(loginEdit.username, encryptedLogin.username);
    assert.ok(loginEdit.password !== encryptedLogin.password);
    assert.match(loginEdit.password, /^2\./u);
    assert.equal(loginEdit.website, undefined);
    const editedLogin = await loginEditResponse.json();
    assert.equal(editedLogin.id, savedLogin.id);
    assert.equal(editedLogin.wrappedKey, savedLogin.wrappedKey);
    assert.ok(editedLogin.revision > savedLogin.revision);

    await button(webVault, "Show password history").press("Enter");
    await button(webVault, "Show previous password").press("Enter");
    await webVault.getByText(webLoginPassword, { exact: true }).waitFor();
    await button(webVault, "Hide password history").press("Enter");
    assert.equal(
      await webVault.getByText(webLoginPassword, { exact: true }).count(),
      0,
    );

    step = "syncing and autofilling the rotated password in Bitwarden";
    const afterWebRotation = await syncNow(second, secondClient);
    const rotatedLogin = afterWebRotation.ciphers.find(
      ({ id }) => id === savedLogin.id,
    );
    assert.deepEqual(rotatedLogin, {
      ...syncedWebLogin,
      revisionDate: new Date(editedLogin.revision).toISOString(),
      login: {
        ...syncedWebLogin.login,
        password: loginEdit.password,
        passwordRevisionDate: rotatedLogin.login.passwordRevisionDate,
      },
      passwordHistory: [
        {
          password: encryptedLogin.password,
          lastUsedDate: rotatedLogin.login.passwordRevisionDate,
        },
      ],
    });
    assert.ok(
      Number.isFinite(Date.parse(rotatedLogin.login.passwordRevisionDate)),
    );
    await autofill(webLoginSite, webLoginUsername, rotatedWebPassword);
    console.log(
      "PASS Bitwarden synced and autofilled the password rotated in OneApp.",
    );

    step =
      "rejecting a stale OneApp login edit after a newer Bitwarden rotation";
    const staleLoginDraft = "Unsaved-web-draft!48";
    const latestLoginPassword = "Newer-Bitwarden-password!51";
    await editWebLogin.press("Enter");
    await webPassword.fill(staleLoginDraft);
    await openItem(secondClient, webLoginTitle);
    await button(secondClient, "Edit").click();
    await secondClient
      .locator('input[formcontrolname="password"]')
      .fill(latestLoginPassword);
    await button(secondClient, "Save").click();
    const deviceLoginResponse = await second.localResponse((response) =>
      endpoint(response, `/api/ciphers/${savedLogin.id}`, "PUT"),
    );
    assert.equal(deviceLoginResponse.status(), 200);
    const latestLogin = await deviceLoginResponse.json();
    assert.ok(Date.parse(latestLogin.revisionDate) > editedLogin.revision);

    await saveWebLogin.press("Enter");
    const staleLoginResponse = await localResponse(
      (response) => isWebLoginEdit(response) && response !== loginEditResponse,
    );
    assert.equal(staleLoginResponse.status(), 409);
    assert.equal(
      JSON.parse(staleLoginResponse.request().postData()).expectedRevision,
      editedLogin.revision,
    );
    await webVault
      .getByRole("alert")
      .filter({ hasText: "This login changed since you opened it." })
      .waitFor({ timeout: 10_000 });
    assert.equal(await webPassword.inputValue(), staleLoginDraft);
    await button(webVault, "Cancel").press("Enter");
    await button(webVault, "Show password").press("Enter");
    await webVault
      .getByText(latestLoginPassword, { exact: true })
      .waitFor({ timeout: 10_000 });
    vault.ciphers = afterWebRotation.ciphers.map((item) =>
      item.id === latestLogin.id ? latestLogin : item,
    );
    console.log(
      "PASS OneApp rejected the stale login save, kept the draft, and reloaded the newer Bitwarden password.",
    );

    step = "moving the login to Trash in OneApp";
    await autofill(webLoginSite, webLoginUsername, latestLoginPassword);
    const lifecyclePath = `${itemsPath}/${savedLogin.id}`;
    await button(webVault, "Delete").press("Enter");
    const movedToTrash = await localResponse((response) =>
      endpoint(response, `${lifecyclePath}/trash`, "PUT"),
    );
    assert.equal(movedToTrash.status(), 200);
    assert.deepEqual(JSON.parse(movedToTrash.request().postData()), {
      keyId: encryptedLogin.keyId,
      expectedRevision: Date.parse(latestLogin.revisionDate),
    });
    const trashedWebLogin = await movedToTrash.json();
    assert.equal(trashedWebLogin.id, savedLogin.id);
    assert.ok(trashedWebLogin.revision > Date.parse(latestLogin.revisionDate));
    await webVault
      .getByRole("status")
      .filter({ hasText: "Moved to Trash." })
      .waitFor();
    assert.equal(await button(webVault, webLoginTitle).count(), 0);

    step = "loading Trash after the Worker restarts";
    await restartWorker(app, vault.ciphers.length);
    await app.reload();
    await unlockWeb(masterPassword);
    await button(webVault, "Trash").press("Enter");
    await webVault
      .getByRole("heading", { name: "Trash", exact: true })
      .waitFor();
    await button(webVault, webLoginTitle).press("Enter");
    await button(webVault, "Restore").waitFor();
    assert.equal(await editWebLogin.count(), 0);

    step = "syncing the web-trashed login and checking that autofill stops";
    const afterWebTrash = await syncNow(second, secondClient);
    const trashDate = new Date(trashedWebLogin.revision).toISOString();
    assert.deepEqual(
      afterWebTrash.ciphers,
      vault.ciphers.map((item) =>
        item.id === savedLogin.id
          ? {
              ...item,
              deletedDate: trashDate,
              revisionDate: trashDate,
              permissions: { delete: false, restore: true },
            }
          : item,
      ),
    );
    await openItem(secondClient, webLoginTitle, "/trash");
    await button(secondClient, "Restore").waitFor();
    await assertNoAutofill(webLoginSite);
    console.log(
      "PASS Bitwarden synced the OneApp-trashed login, and the matching site stayed blank.",
    );

    step =
      "restoring the login in OneApp and checking that Bitwarden autofills it";
    await button(webVault, "Restore").press("Enter");
    const restoredFromWeb = await localResponse((response) =>
      endpoint(response, `${lifecyclePath}/restore`, "PUT"),
    );
    assert.equal(restoredFromWeb.status(), 200);
    assert.deepEqual(JSON.parse(restoredFromWeb.request().postData()), {
      keyId: encryptedLogin.keyId,
      expectedRevision: trashedWebLogin.revision,
    });
    const restoredWebLogin = await restoredFromWeb.json();
    assert.deepEqual(restoredWebLogin, {
      ...trashedWebLogin,
      revision: restoredWebLogin.revision,
    });
    assert.ok(restoredWebLogin.revision > trashedWebLogin.revision);
    await webVault
      .getByRole("status")
      .filter({ hasText: "Restored to your vault." })
      .waitFor();
    assert.equal(await button(webVault, webLoginTitle).count(), 0);
    await button(webVault, "Back to items").press("Enter");
    await button(webVault, webLoginTitle).waitFor();
    const afterWebRestore = await syncNow(second, secondClient);
    vault.ciphers = vault.ciphers.map((item) =>
      item.id === savedLogin.id
        ? {
            ...item,
            revisionDate: new Date(restoredWebLogin.revision).toISOString(),
          }
        : item,
    );
    assert.deepEqual(afterWebRestore.ciphers, vault.ciphers);
    await autofill(webLoginSite, webLoginUsername, latestLoginPassword);
    console.log(
      "PASS Restoring the login in OneApp let Bitwarden sync and autofill it again.",
    );

    step = "exchanging attachments and exporting ZIP files in both clients";
    const storedAttachments = await checkAttachments({
      app,
      webVault,
      first,
      second,
      secondClient,
      item: savedLogin.id,
      itemName: webLoginTitle,
      password: masterPassword,
      openItem,
      syncNow,
      restartWorker,
      items: vault.ciphers.length,
    });
    step = "deleting an attachment and purging its trashed item";
    await checkAttachmentCleanup({
      app,
      webVault,
      second,
      secondClient,
      item: savedLogin.id,
      itemName: webLoginTitle,
      openItem,
      syncNow,
      restartKey,
      password: masterPassword,
      ...storedAttachments,
    });
    vault.ciphers = (await syncNow(second, secondClient)).ciphers;

    step = "moving, archiving, importing, and exporting in both clients";
    transfer = await checkTransfers({
      app,
      web: webVault,
      first,
      second,
      client,
      secondClient,
      password: masterPassword,
      openItem,
      syncNow,
    });
    step = "registering and exporting a stock Bitwarden passkey";
    transfer.passkey = await captureFixturePasskey({
      app,
      web: webVault,
      source: first,
      client,
      password: masterPassword,
      siteUrl: webLoginUrl,
      syncNow,
    });
    vault.ciphers = transfer.passkey.sync.ciphers;

    step = "revoking the second Bitwarden profile in OneApp Settings";
    const devicesPath = "/api/bitwarden/devices";
    const firstDevice = claims(token).device;
    const secondDevice = claims(secondToken).device;
    assert.notEqual(firstDevice, secondDevice);
    await app.goto(new URL("/settings/clients", origin).href);
    const listing = await localResponse((response) =>
      endpoint(response, devicesPath),
    );
    assert.equal(listing.status(), 200);
    const devices = await listing.json();
    assert.deepEqual(
      devices.map(({ id }) => id).sort(),
      [firstDevice, secondDevice].sort(),
    );
    for (const device of devices) assert.match(device.name, /chrome/iu);
    const clients = app.getByRole("region", { name: "Clients" });
    const rowFor = (id) =>
      clients
        .getByRole("listitem")
        .filter({ hasText: id.slice(-8).toUpperCase() });
    await rowFor(firstDevice).getByText("Bitwarden", { exact: true }).waitFor();
    const target = rowFor(secondDevice);
    const revokedGrant = await latestGrant(second, secondToken);
    await target.getByRole("button", { name: /^Revoke /u }).click();
    const revoked = await localResponse((response) =>
      endpoint(response, `${devicesPath}/${secondDevice}`, "DELETE"),
    );
    assert.equal(revoked.status(), 204);
    await target.waitFor({ state: "hidden" });
    await rowFor(firstDevice).waitFor();

    step = "checking the revoked access and refresh tokens";
    const statuses = await app.evaluate(async (grant) => {
      const [access, refresh] = await Promise.all([
        fetch("/api/sync", {
          headers: { authorization: `Bearer ${grant.access_token}` },
        }),
        fetch("/identity/connect/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: "browser",
            grant_type: "refresh_token",
            refresh_token: grant.refresh_token,
          }),
        }),
      ]);
      return {
        access: access.status,
        refresh: refresh.status,
        grantError: (await refresh.json()).error,
      };
    }, revokedGrant);
    assert.deepEqual(statuses, {
      access: 401,
      refresh: 400,
      grantError: "invalid_grant",
    });
    assert.deepEqual((await syncNow(first, client)).ciphers, vault.ciphers);
    await app.reload();
    await rowFor(firstDevice).waitFor();
    assert.equal(await target.count(), 0);
    console.log(
      "PASS OneApp revoked one Bitwarden profile's access and refresh tokens. The other profile still synced.",
    );

    await context.close();
    context = first.context;
  }

  step = "restarting the Worker with its persisted D1 database";
  await restartWorker(app, vault.ciphers.length);
  console.log(
    "PASS Local workerd restarted with the same vault, item count, and device session in D1.",
  );

  step = "refreshing the access token via Sync now";
  const currentGrant = await latestGrant(first, token);
  const beforeRefresh = responses.length;
  const { exp } = claims(currentGrant);
  const refreshDelay = Math.max(0, (exp - 298) * 1000 - Date.now());
  await new Promise((resolve) => setTimeout(resolve, refreshDelay));
  const settings = new URL(client.url());
  settings.hash = "/vault-settings";
  await client.goto(settings.href);
  await client.getByRole("button", { name: /^Sync now/u }).click();
  const refreshed = await localResponse(
    (response) =>
      isRefresh(response) && responses.indexOf(response) >= beforeRefresh,
  );
  assert.equal(refreshed.status(), 200);
  const renewal = await refreshed.json();
  assert.notEqual(renewal.access_token, currentGrant.access_token);
  assert.notEqual(renewal.refresh_token, currentGrant.refresh_token);

  // Reproduce the duplicate grant seen when two extension contexts refresh together.
  const retried = await client.evaluate(
    async ({ origin, body }) => {
      const response = await fetch(`${origin}/identity/connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      return { status: response.status, payload: await response.json() };
    },
    { origin, body: refreshed.request().postData() },
  );
  assert.equal(retried.status, 200);
  assert.ok(
    retried.payload.access_token === renewal.access_token &&
      retried.payload.refresh_token === renewal.refresh_token,
    "A duplicate refresh issued different successor tokens.",
  );

  const resync = await localResponse(
    (response) =>
      endpoint(response, "/api/sync") &&
      response.ok() &&
      responses.indexOf(response) > responses.indexOf(refreshed),
  );
  assert.ok(
    (await resync.request().headerValue("authorization")) ===
      `Bearer ${renewal.access_token}`,
    "Sync did not use the newly issued access token.",
  );
  assert.deepEqual((await resync.json()).ciphers, vault.ciphers);
  console.log(
    "PASS Bitwarden rotated both tokens and synced again with the refreshed access token.",
  );
  if (transfer) {
    step = "reimporting both clients' exports into a new D1 vault";
    const status = await app.evaluate(
      async (key) =>
        (
          await fetch("/_test/fresh-vault", {
            method: "POST",
            headers: { "x-test-restart": key },
          })
        ).status,
      restartKey,
    );
    assert.equal(status, 204);
    const destination = await openProfile();
    context = destination.context;
    const destinationApp = await signInToOneApp(destination);
    step = "reimporting both clients' exports into a new D1 vault";
    await restoreIntoFreshVault({
      app: destinationApp,
      password: masterPassword,
      ...transfer,
    });
    const { client: destinationClient } = await connectBitwarden(destination);
    step = "unlocking Bitwarden in the destination profile";
    await destinationClient
      .getByLabel("Master password", { exact: false })
      .first()
      .fill(masterPassword);
    await button(destinationClient, "Unlock").click();
    await destinationClient.waitForURL((url) => url.hash.startsWith("#/tabs/"));
    step = "importing, using, and removing a passkey in the destination vault";
    await importFixturePasskey({
      app: destinationApp,
      profile: destination,
      client: destinationClient,
      password: masterPassword,
      siteUrl: webLoginUrl,
      fixture: transfer.passkey,
      syncNow,
      openItem,
    });
  }
} catch (error) {
  console.error(`Bitwarden browser check failed while ${step}.`);
  for (const page of context?.pages() ?? []) {
    const url = new URL(page.url());
    if (url.protocol === "chrome-extension:")
      console.error("Extension route", url.hash.split("?")[0]);
  }
  throw error;
} finally {
  await Promise.all(Array.from(profiles, (profile) => profile.close()));
}
