import { expect, it } from "@effect/vitest";
import { Redacted } from "effect";
import { inventoryCredentials } from "./config.ts";
import { inventoryErrorMessage } from "./errors.ts";

it("uses local environment credentials without exposing the password in serialization", () => {
  const credentials = inventoryCredentials(undefined, {
    ICLOUD_IMAP_USER: " user@icloud.com ",
    ICLOUD_IMAP_PASSWORD: " fixture-app-password ",
  });
  expect(credentials.user).toBe("user@icloud.com");
  expect(Redacted.value(credentials.password!)).toBe("fixture-app-password");
  expect(JSON.stringify(credentials)).not.toContain("fixture-app-password");
  expect(
    inventoryCredentials("override@icloud.com", {
      ICLOUD_IMAP_USER: "env@icloud.com",
    }).user,
  ).toBe("override@icloud.com");
  expect(
    inventoryCredentials(undefined, {
      ICLOUD_IMAP_USER: " ",
      ICLOUD_IMAP_PASSWORD: " ",
    }),
  ).toEqual({ user: undefined, password: undefined });
});

it("classifies authentication, network and TLS errors without echoing server input", () => {
  const privateError = Object.assign(new Error("fixture-secret-password"), {
    authenticationFailed: true,
    executedCommand: "LOGIN user fixture-secret-password",
    response: "fixture-secret-password",
  });
  expect(inventoryErrorMessage(privateError)).toContain(
    "rejected authentication",
  );
  expect(inventoryErrorMessage(privateError)).not.toContain(
    "fixture-secret-password",
  );
  expect(inventoryErrorMessage({ code: "ENOTFOUND" })).toContain("resolve");
  expect(inventoryErrorMessage({ code: "CONNECT_TIMEOUT" })).toContain(
    "timed out",
  );
  expect(inventoryErrorMessage({ tlsFailed: true })).toContain(
    "secure connection",
  );
  expect(inventoryErrorMessage({ code: "EPERM" })).toContain("denied");
  for (const error of [
    undefined,
    null,
    "fixture-secret-password",
    new Error("fixture-secret-password"),
    { code: "fixture-secret-password" },
  ])
    expect(inventoryErrorMessage(error)).not.toContain(
      "fixture-secret-password",
    );
});
