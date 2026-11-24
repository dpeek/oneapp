import { Database } from "bun:sqlite";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultBackupDirectory, restoreSnapshot } from "./backup/snapshot.ts";
import {
  defaultDevStage,
  devPointer,
  devState,
  localDirectory,
  prepareDev,
  startDev,
} from "./dev-local.ts";
import {
  localStageState,
  migrateSnapshot,
  restoreBindings,
  snapshotOwner,
} from "./dev-snapshot.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: { type: "boolean" },
    snapshot: { type: "string" },
    identity: { type: "string" },
  },
});

const latestBackup = async () => {
  const entries = await readdir(defaultBackupDirectory, {
    withFileTypes: true,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const candidates = entries
    .filter(
      (entry) => entry.isDirectory() && /^oneapp-\d{4}-/u.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of candidates) {
    const path = join(defaultBackupDirectory, name);
    if (await Bun.file(join(path, "manifest.json.age")).exists()) return path;
  }
  throw new Error("Capture a production backup or pass --snapshot.");
};

const waitForWorker = async (
  stage: string,
  child: ReturnType<typeof startDev>,
) => {
  const workerState = Bun.file(join(localStageState(stage), "Web.json"));
  const deadline = Date.now() + 120_000;
  while (
    Date.now() < deadline &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    const state = await workerState.json().catch((error: unknown) => {
      if (
        error instanceof SyntaxError ||
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        return undefined; // Alchemy can be writing this file as we poll.
      throw error;
    });
    if (state?.providerMode === "local" && state.attr?.url) {
      const url = new URL(state.attr.url);
      if (url.protocol !== "http:" || url.hostname !== "localhost" || !url.port)
        throw new Error("The snapshot Worker must listen on localhost.");
      try {
        const response = await fetch(new URL("/api/health", url), {
          redirect: "error",
          signal: AbortSignal.timeout(1000),
        });
        const ready = response.ok;
        await response.body?.cancel();
        if (ready) return url.origin;
      } catch {
        // The dev proxy can start listening just after state is saved.
      }
    }
    await Bun.sleep(250);
  }
  throw new Error("The local Worker failed to start for this snapshot.");
};

const verifyWorker = async (
  origin: string,
  email: string,
  password: string,
) => {
  const csrf = {
    "x-effect-auth-csrf": "1",
    "content-type": "application/json",
    origin,
  };
  const request = (path: string, init?: RequestInit) =>
    fetch(origin + path, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  const signedIn = await request("/api/auth/signIn", {
    method: "POST",
    headers: csrf,
    body: JSON.stringify({ payload: { email, password } }),
  });
  const cookie = signedIn.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");
  await signedIn.body?.cancel();
  if (!signedIn.ok || !cookie)
    throw new Error("Sign-in with the new local credentials failed.");
  try {
    for (const path of [
      "/api/me",
      "/api/people",
      "/api/files",
      "/api/inbox/unread",
      "/api/vault/setup",
    ]) {
      const response = await request(path, { headers: { cookie } });
      await response.body?.cancel();
      if (!response.ok)
        throw new Error(
          "The restored OneApp failed its check for " + path + ".",
        );
    }
  } finally {
    const signedOut = await request("/api/auth/signOut", {
      method: "POST",
      headers: { ...csrf, cookie },
      body: "{}",
    });
    await signedOut.body?.cancel();
    if (!signedOut.ok)
      throw new Error("Could not close the local verification session.");
  }
};

const publish = async (stage: string, source: string) => {
  const temporary = join(devState, stage + ".json");
  try {
    await writeFile(temporary, JSON.stringify({ stage, source }) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, devPointer);
  } finally {
    await rm(temporary, { force: true });
  }
};

const pull = async () => {
  const source = values.snapshot
    ? resolve(values.snapshot)
    : await latestBackup();
  const identity = resolve(
    values.identity ?? join(homedir(), ".config", "oneapp", "backup.agekey"),
  );
  const stage =
    defaultDevStage +
    "_" +
    crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const temporary = await mkdtemp(join(tmpdir(), "oneapp-dev-pull-"));
  try {
    const directory = join(temporary, "restored");
    const manifest = await restoreSnapshot(source, identity, directory);
    using database = new Database(join(directory, "database.sqlite"));
    const email = snapshotOwner(database);
    await migrateSnapshot(database);

    await mkdir(devState, { recursive: true, mode: 0o700 });
    await chmod(localDirectory, 0o700);
    const { config, password } = await prepareDev(stage, email);
    const child = startDev(stage, 0, config, false);
    const stop = () => child.kill("SIGTERM");
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      const origin = await waitForWorker(stage, child);
      await restoreBindings(stage, directory, manifest, database);
      await verifyWorker(origin, email, password);
    } finally {
      stop();
      await child.exited;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    await publish(stage, source);
    console.log("Local dev is ready. Start or restart it with bun run dev.");
    console.log("Local sign-in credentials are in " + config + ".");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};

if (values.help) {
  console.log(
    "bun run dev:pull [--snapshot <backup-directory>] [--identity <age-key-file>]",
  );
} else {
  try {
    await pull();
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "The local snapshot restore failed.",
    );
    process.exitCode = 1;
  }
}
