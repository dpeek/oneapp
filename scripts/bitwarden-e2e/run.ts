import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fixtureEmail,
  itemName,
  itemPassword,
  itemUsername,
  makeFixture,
  masterPassword,
} from "./fixture.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const release = "2026.10.2";
const seeded = process.argv.includes("--seeded");
const releaseDigest =
  "2ebc61246a2ea82a65c589b8484e26a5678253fa6474c26dc5b6a7a7fcacbda4";
const chromeVersion = "158.0.8127.36";
const playwrightVersion = "1.57.0";
const miniflareVersion = "4.20260730.0";
const workerdVersion = "1.20261026.1";

const work = await mkdtemp(join(tmpdir(), "oneapp-bitwarden-"));
const run = async (cmd: string[], cwd = root) => {
  const child = Bun.spawn({ cmd, cwd, stdout: "inherit", stderr: "inherit" });
  if (await child.exited) throw new Error(`${cmd[0]} failed`);
};
const download = async (url: string, destination: string) => {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Download failed (${response.status}): ${url}`);
  await Bun.write(destination, response);
};
const unzip = (archive: string, destination: string) =>
  run(
    process.platform === "darwin"
      ? ["/usr/bin/ditto", "-x", "-k", archive, destination]
      : ["unzip", "-q", archive, "-d", destination],
  );

const prepareExtension = async () => {
  const archive = join(work, "extension.zip");
  const directory = join(work, "extension");
  await download(
    `https://github.com/bitwarden/clients/releases/download/browser-v${release}/dist-chrome-${release}.zip`,
    archive,
  );
  const sha = createHash("sha256")
    .update(await Bun.file(archive).bytes())
    .digest("hex");
  if (sha !== releaseDigest)
    throw new Error("Bitwarden extension archive checksum mismatch.");
  await unzip(archive, directory);
  const manifest = await Bun.file(join(directory, "manifest.json")).json();
  if (manifest.version !== release)
    throw new Error("Unexpected extension version.");
  return directory;
};

const prepareBrowser = async () => {
  if (process.env.ONEAPP_BITWARDEN_E2E_CHROME)
    return process.env.ONEAPP_BITWARDEN_E2E_CHROME;
  const platform = [process.platform, process.arch].join("/");
  const build = {
    "darwin/arm64": "mac-arm64",
    "darwin/x64": "mac-x64",
    "linux/x64": "linux64",
    "linux/arm64": "linux-arm64",
  }[platform];
  if (!build)
    throw new Error(
      "Set ONEAPP_BITWARDEN_E2E_CHROME to a Chrome for Testing executable.",
    );
  const archive = join(work, "chrome.zip");
  await download(
    `https://storage.googleapis.com/chrome-for-testing-public/${chromeVersion}/${build}/chrome-${build}.zip`,
    archive,
  );
  await unzip(archive, work);
  return join(
    work,
    `chrome-${build}`,
    process.platform === "darwin"
      ? "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
      : "chrome",
  );
};

let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  console.log(`Preparing stock Bitwarden Chrome ${release}`);
  const [extension, chrome] = await Promise.all([
    prepareExtension(),
    prepareBrowser(),
    run([
      "bun",
      "add",
      "--cwd",
      work,
      `playwright@${playwrightVersion}`,
      `miniflare@${miniflareVersion}`,
      `workerd@${workerdVersion}`,
      "fflate@0.8.3",
    ]),
    run([
      "bun",
      "build",
      "apps/web/src/server/worker.ts",
      "--target=browser",
      "--external",
      "node:*",
      "--outfile",
      join(work, "worker.mjs"),
    ]),
    run(["bun", "run", "--filter", "@oneapp/web", "build"]),
  ]);

  const cert = join(work, "cert.pem");
  const key = join(work, "key.pem");
  const openssl = Bun.spawn({
    cmd: [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:login.oneapp.test,DNS:login.oneapp-vault.test",
      "-out",
      cert,
      "-keyout",
      key,
    ],
    stdout: "ignore",
    stderr: "pipe",
  });
  const errors = await new Response(openssl.stderr).text();
  if (await openssl.exited) throw new Error(errors);
  const ca = await Bun.file(cert).text();
  const spki = new X509Certificate(ca).publicKey.export({
    type: "spki",
    format: "der",
  });
  const certificatePin = createHash("sha256").update(spki).digest("base64");

  const socket = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.error(),
  });
  const port = socket.port!;
  await socket.stop();
  const origin = `https://127.0.0.1:${port}`;
  if (seeded)
    await Bun.write(
      join(work, "vault.json"),
      JSON.stringify(makeFixture(origin)),
    );
  const ownerPassword = randomBytes(32).toString("base64url");
  const restartKey = randomBytes(32).toString("base64url");
  server = Bun.spawn({
    cmd: ["bun", "scripts/bitwarden-e2e/server.ts"],
    cwd: root,
    env: {
      ...process.env,
      ONEAPP_BITWARDEN_E2E_PORT: String(port),
      ONEAPP_BITWARDEN_E2E_DIRECTORY: work,
      ONEAPP_BITWARDEN_E2E_RESTART_KEY: restartKey,
      NODE_EXTRA_CA_CERTS: cert,
      MINIFLARE_WORKERD_PATH: join(
        work,
        "node_modules",
        "workerd",
        "bin",
        "workerd",
      ),
      ONEAPP_BITWARDEN_E2E_OWNER_PASSWORD: ownerPassword,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const canReachServer = () =>
    new Promise<boolean>((resolve) => {
      const probe = request(origin, { ca }, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      probe.on("error", () => resolve(false));
      probe.setTimeout(500, () => probe.destroy());
      probe.end();
    });
  const deadline = Date.now() + 10_000;
  while (!(await canReachServer())) {
    if (Date.now() > deadline || server.exitCode !== null)
      throw new Error("Bitwarden browser test server did not start.");
    await Bun.sleep(100);
  }

  // Resolve Playwright from the temporary directory, without adding a workspace dependency.
  const flow = join(work, "browser.mjs");
  await Promise.all(
    ["browser.mjs", "attachments.mjs", "transfers.mjs"].map((file) =>
      Bun.write(join(work, file), Bun.file(new URL(file, import.meta.url))),
    ),
  );
  const browser = Bun.spawn({
    cmd: ["node", flow],
    env: {
      ...process.env,
      ONEAPP_BITWARDEN_E2E_BROWSER: JSON.stringify({
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
      }),
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await browser.exited) throw new Error("Bitwarden browser checks failed.");
} finally {
  server?.kill();
  await server?.exited;
  await rm(work, { recursive: true, force: true });
}
