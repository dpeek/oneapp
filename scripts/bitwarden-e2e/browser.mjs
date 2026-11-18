import assert from "node:assert/strict";
import { chromium } from "playwright";

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
      "--host-resolver-rules=MAP bitwarden.com ~NOTFOUND, MAP login.oneapp.test 127.0.0.1",
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

const openLogin = async (client, section = "/tabs/vault") => {
  const view = new URL(client.url());
  view.hash = section;
  await client.goto(view.href);
  const list = client.locator(
    section === "/trash"
      ? "app-trash-list-items-container"
      : "app-vault-list-items-container",
  );
  await list.getByText(itemName, { exact: true }).click();
};

const editPassword = async (client, password) => {
  await openLogin(client);
  await button(client, "Edit").click();
  await client.locator('input[formcontrolname="password"]').fill(password);
};

const syncNow = async (profile, client) => {
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

const restartWorker = async (app) => {
  const status = await app.evaluate(async (restartKey) => {
    const response = await fetch("/_test/restart", {
      method: "POST",
      headers: { "x-test-restart": restartKey },
    });
    return response.status;
  }, restartKey);
  assert.equal(status, 204);
};

let context;
try {
  const first = await openProfile();
  const { responses, localResponse } = first;
  context = first.context;
  const app = await signInToOneApp(first);

  if (!seeded) {
    step = "creating a vault in OneApp";
    await app
      .getByRole("link", { name: "Password vault", exact: true })
      .click();
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
    await app
      .getByRole("heading", { name: "Your password vault is ready" })
      .waitFor();
    await app.reload();
    await app
      .getByRole("heading", { name: "Your password vault is ready" })
      .waitFor();
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
    const autofill = async () => {
      await site.bringToFront();
      await site.reload();
      await site.waitForFunction(
        ({ itemUsername, rotatedPassword }) =>
          document.querySelector('input[name="username"]').value ===
            itemUsername &&
          document.querySelector('input[name="password"]').value ===
            rotatedPassword,
        { itemUsername, rotatedPassword },
      );
    };
    await autofill();
    console.log(
      "PASS The pinned extension autofilled the username and rotated password in the second profile.",
    );

    step = "moving the login to Trash in the first profile";
    await editPassword(secondClient, stalePassword);
    await openLogin(client);
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
    await openLogin(secondClient, "/trash");
    await button(secondClient, "Restore").waitFor();
    assert.equal(
      await button(secondClient, "Delete forever").isVisible(),
      false,
    );

    step = "checking that the trashed login no longer autofills";
    await site.bringToFront();
    await site.reload();
    await assert.rejects(
      site.waitForFunction(
        () =>
          document.querySelector('input[name="username"]').value !== "" ||
          document.querySelector('input[name="password"]').value !== "",
        null,
        { timeout: 3000 },
      ),
      { name: "TimeoutError" },
    );
    console.log(
      "PASS The trashed login blocked stale edits, survived a restart, and stopped autofilling in the second profile.",
    );

    step = "restoring the login from Trash in the first profile";
    await openLogin(client, "/trash");
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
    await openLogin(client);
    await button(client, "Edit").waitFor();
    console.log(
      "PASS The restored login kept its ID and autofilled again in the second profile.",
    );

    await context.close();
    context = first.context;
  }

  step = "restarting the Worker with its persisted D1 database";
  await restartWorker(app);
  console.log(
    "PASS Local workerd restarted with the same vault, item count, and device session in D1.",
  );

  step = "refreshing the access token via Sync now";
  const isRefresh = (response) =>
    endpoint(response, "/identity/connect/token", "POST") &&
    grantType(response) === "refresh_token";
  const previousRefresh = responses.findLast(
    (response) => isRefresh(response) && response.ok(),
  );
  const currentGrant = previousRefresh ? await previousRefresh.json() : token;
  const beforeRefresh = responses.length;
  const { exp } = JSON.parse(
    Buffer.from(currentGrant.access_token.split(".")[1], "base64url"),
  );
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
