import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { MailSampleError } from "./errors.ts";

export const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const hashFile = async (path: string) => {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest("hex"), size };
};
export const atomicJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

export const withFileLock = async <A>(path: string, work: () => Promise<A>) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600).catch(() => {
    throw new MailSampleError(
      "An operation holds this directory's lock. If its process has stopped, remove the .lock file and retry.",
    );
  });
  try {
    await file.writeFile(String(process.pid));
    await file.close();
    return await work();
  } finally {
    await file.close().catch(() => {});
    await rm(path, { force: true });
  }
};
