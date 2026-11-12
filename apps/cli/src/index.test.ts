import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { fileURLToPath } from "node:url";
import { serverOrigin } from "./credentials.ts";

it.effect("the CLI entry point runs from the workspace", () =>
  Effect.sync(() => {
    const entryPoint = fileURLToPath(new URL("./index.ts", import.meta.url));
    const result = Bun.spawnSync([process.execPath, entryPoint, "--help"], {
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const help = result.stdout.toString();
    expect(help).toContain("OneApp");
    expect(help).toContain("Manage CLI access");
    expect(help).toContain("Manage saved links");
  }),
);

it("allows login without a server flag and advertises the default origin", () => {
  const entryPoint = fileURLToPath(new URL("./index.ts", import.meta.url));
  const command = [process.execPath, entryPoint, "auth", "login"];
  const help = Bun.spawnSync([...command, "--help"], { stderr: "pipe" });

  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("https://app.dpeek.com");

  const browserLogin = Bun.spawnSync([...command, "--name", ""], {
    stdin: "ignore",
    stderr: "pipe",
  });
  expect(browserLogin.exitCode).toBe(1);
  expect(browserLogin.stderr.toString()).toContain("Use a device name");

  const login = Bun.spawnSync([...command, "--manual-token"], {
    stdin: "ignore",
    stderr: "pipe",
  });

  expect(login.exitCode).toBe(1);
  expect(login.stderr.toString()).toContain("in an interactive terminal");
});

it("normalizes the server origin for the credential store", () => {
  expect(serverOrigin("HTTPS://EXAMPLE.COM:443/")).toBe("https://example.com");
  expect(serverOrigin("http://localhost:8787")).toBe("http://localhost:8787");
});

it.each([
  "http://example.com",
  "https:example.com",
  "https://example.com/path",
  "https://example.com/?x=1",
  "https://user:pass@example.com",
])("rejects unsafe or ambiguous server configuration %s", (origin) => {
  expect(() => serverOrigin(origin)).toThrow();
});
