import { createCfAuth } from "@cloudflare/workers-auth/cf";
import { chmod, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function cloudflareEnvironment() {
  const env = { ...process.env };
  const stateDirectory = fileURLToPath(new URL("../.alchemy", import.meta.url));
  env.ALCHEMY_HOME ??= stateDirectory;
  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error(
      "Set CLOUDFLARE_ACCOUNT_ID to the account Orumai should deploy to.",
    );
  }

  if (env.CLOUDFLARE_AUTH_PROFILE || !env.CLOUDFLARE_API_TOKEN) {
    const profile = env.CLOUDFLARE_AUTH_PROFILE ?? "dpeek";
    const auth = createCfAuth({
      userAgent: "Orumai deploy",
      logger: { debug() {}, info() {}, log() {}, warn() {}, error() {} },
      prompt: async () => {
        throw new Error("Authenticate with the cf CLI first.");
      },
      select: async () => {
        throw new Error("Select an account with CLOUDFLARE_ACCOUNT_ID.");
      },
      isNoDefaultValueProvidedError: () => false,
    });
    auth.setProfile(profile);
    const token = await auth.getOAuthTokenFromLocalState();
    if (!token)
      throw new Error(
        `No valid cf login for profile ${profile}. Run cf auth create ${profile}.`,
      );
    env.CLOUDFLARE_API_TOKEN = token;
  }

  // Alchemy caches remote-state credentials here; keep the directory private.
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700);

  return env;
}
