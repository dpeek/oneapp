import { cloudflareEnvironment } from "../cloudflare-env.ts";

const legacyBucketBindings = [
  "INBOX_MESSAGES",
  "SENT_MESSAGES",
  "PROFILE_PHOTOS",
  "VAULT_FILES",
] as const;
export const bucketBindings = [
  ...legacyBucketBindings,
  "FILE_UPLOADS",
] as const;
export type BucketBinding = (typeof bucketBindings)[number];

type Binding = {
  name: string;
  type: string;
  id?: string;
  bucket_name?: string;
  jurisdiction?: string;
};

type Bucket = { name: string; jurisdiction: string };
export type RemoteObject = {
  key: string;
  etag: string;
  last_modified: string;
  size: number;
  custom_metadata?: Record<string, string>;
  http_metadata?: Record<string, string | null>;
};

type ApiResult<T> = {
  success: boolean;
  result: T;
  result_info?: { cursor?: string; is_truncated?: boolean };
};

export const openSource = async (worker: string) => {
  const env = await cloudflareEnvironment();
  const account = env.CLOUDFLARE_ACCOUNT_ID!;
  const root =
    "https://api.cloudflare.com/client/v4/accounts/" +
    encodeURIComponent(account);
  const headers = { Authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN };

  const request = async (path: string, options: RequestInit = {}) =>
    fetch(root + path, {
      ...options,
      headers: { ...headers, ...options.headers },
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });

  const json = async <T>(
    label: string,
    path: string,
    options?: RequestInit,
  ) => {
    const response = await request(path, options);
    if (!response.ok)
      throw new Error(label + " failed (HTTP " + response.status + ").");
    const result = (await response.json()) as ApiResult<T>;
    if (!result.success) throw new Error(label + " failed.");
    return result;
  };

  const { result: settings } = await json<{ bindings: Binding[] }>(
    "Read Worker bindings",
    "/workers/scripts/" + encodeURIComponent(worker) + "/settings",
  );
  const database = settings.bindings.find(
    (binding) => binding.name === "DB" && binding.type === "d1",
  )?.id;
  if (!database) throw new Error("The Worker is missing its DB binding.");
  const getBucket = (name: BucketBinding) => {
    const binding = settings.bindings.find(
      (item) => item.name === name && item.type === "r2_bucket",
    );
    return binding?.bucket_name
      ? {
          name: binding.bucket_name,
          jurisdiction: binding.jurisdiction ?? "default",
        }
      : undefined;
  };
  const requiredBuckets = Object.fromEntries(
    legacyBucketBindings.map((name) => {
      const bucket = getBucket(name);
      if (!bucket) throw new Error("The Worker is missing " + name + ".");
      return [name, bucket];
    }),
  ) as Record<(typeof legacyBucketBindings)[number], Bucket>;
  const fileUploads = getBucket("FILE_UPLOADS");
  const buckets = {
    ...requiredBuckets,
    ...(fileUploads ? { FILE_UPLOADS: fileUploads } : {}),
  };
  const bucketPath = (bucket: Bucket) =>
    "/r2/buckets/" + encodeURIComponent(bucket.name) + "/objects";
  const jurisdiction = (bucket: Bucket) => ({
    "cf-r2-jurisdiction": bucket.jurisdiction,
  });

  const list = async function* (binding: BucketBinding) {
    const bucket = buckets[binding];
    if (!bucket) return;
    const query = new URLSearchParams({ per_page: "1000" });
    do {
      const page = await json<RemoteObject[]>(
        "List " + binding,
        bucketPath(bucket) + "?" + query,
        { headers: jurisdiction(bucket) },
      );
      yield* page.result;
      if (!page.result_info?.is_truncated) return;
      const cursor = page.result_info.cursor;
      if (!cursor || cursor === query.get("cursor"))
        throw new Error(
          "Cloudflare returned an invalid cursor for " + binding + ".",
        );
      query.set("cursor", cursor);
    } while (true);
  };

  const get = async (binding: BucketBinding, object: RemoteObject) => {
    const bucket = buckets[binding];
    if (!bucket) throw new Error("The Worker is missing " + binding + ".");
    const parts = object.key.split("/");
    if (parts.some((part) => part === "." || part === ".."))
      throw new Error("Unsupported path segment in an object key.");
    const path = parts.map(encodeURIComponent).join("/");
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await request(bucketPath(bucket) + "/" + path, {
        headers: { ...jurisdiction(bucket), "accept-encoding": "identity" },
      });
      if (response.ok && response.body) {
        if (response.headers.get("etag")?.replaceAll('"', "") !== object.etag) {
          await response.body.cancel();
          throw new Error(
            "An object in " + binding + " changed during capture.",
          );
        }
        return response.body;
      }
      await response.body?.cancel();
      if (response.status !== 429 && response.status < 500)
        throw new Error(
          "Read " + binding + " object failed (HTTP " + response.status + ").",
        );
      const seconds =
        Number(response.headers.get("retry-after")) || 2 ** attempt;
      await Bun.sleep(Math.min(seconds, 60) * 1000);
    }
    throw new Error(
      "Cloudflare did not return an object from " +
        binding +
        " after retrying.",
    );
  };

  const exportDatabase = async () => {
    const path = "/d1/database/" + encodeURIComponent(database) + "/export";
    let bookmark: string | undefined;
    do {
      const { result } = await json<{
        at_bookmark?: string;
        status: "complete" | "active" | "error";
        result?: { signed_url: string };
      }>("Export production D1", path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          output_format: "polling",
          current_bookmark: bookmark,
        }),
      });
      if (
        result.status === "complete" &&
        result.result?.signed_url &&
        result.at_bookmark
      ) {
        const url = new URL(result.result.signed_url);
        if (url.protocol !== "https:")
          throw new Error("D1 returned an insecure export URL.");
        const response = await fetch(url, {
          redirect: "error",
          signal: AbortSignal.timeout(300_000),
        });
        if (!response.ok || !response.body)
          throw new Error("Download D1 export failed.");
        return { body: response.body, bookmark: result.at_bookmark };
      }
      if (result.status !== "active" || !result.at_bookmark)
        throw new Error("Cloudflare failed to export D1.");
      bookmark = result.at_bookmark;
      await Bun.sleep(500);
    } while (true);
  };

  return { account, worker, database, buckets, list, get, exportDatabase };
};
