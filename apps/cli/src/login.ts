import {
  CliLoginApproval,
  CliTokenLabel,
  CliTokenSecret,
  cliLoginQuery,
  cliLoginInterval,
  cliLoginPath,
  currentCliTokenPath,
} from "@oneapp/core/cli-auth";
import { Console, Effect, Redacted, Schema } from "effect";
import { Prompt } from "effect/cli";
import { Base64Url } from "effect/encoding";
import { readResponse, request, requireSuccess } from "./api.ts";
import { CliError } from "./errors.ts";

export const openBrowser = (url: string) =>
  Effect.sync(() => {
    const command =
      process.platform === "darwin"
        ? ["open"]
        : process.platform === "win32"
          ? ["rundll32.exe", "url.dll,FileProtocolHandler"]
          : ["xdg-open"];
    try {
      Bun.spawn([...command, url], {
        stdout: "ignore",
        stderr: "ignore",
      }).unref();
    } catch {
      // The URL is already printed when a browser opener is unavailable.
    }
  });

export const manualLogin = Effect.fnUntraced(function* (
  origin: string,
  browser: boolean,
) {
  if (!process.stdin.isTTY)
    return yield* new CliError({
      message: "Run manual token login in an interactive terminal.",
    });
  const url = `${origin}/#cli-access`;
  yield* Console.log(`Create a CLI token under CLI access at ${url}`);
  if (browser) yield* openBrowser(url);
  const entered = yield* Prompt.Hidden({ message: "Paste the CLI token" });
  const value = Redacted.value(entered).trim();
  if (!Schema.is(CliTokenSecret)(value))
    return yield* new CliError({
      message: "Paste the CLI token created in OneApp.",
    });

  const token = Redacted.make(value);
  const response = yield* request(origin, token, currentCliTokenPath);
  yield* requireSuccess(response);
  return token;
});

const approvalExpired = () =>
  new CliError({
    message: "The login request expired. Run one auth login again.",
  });

export const browserLogin = Effect.fnUntraced(function* (
  origin: string,
  browser: boolean,
  name: string,
) {
  const label = name.trim();
  if (!Schema.is(CliTokenLabel)(label))
    return yield* new CliError({
      message: "Use a device name of 1 to 60 characters.",
    });
  const token = Redacted.make(
    `one_${Base64Url.encode(crypto.getRandomValues(new Uint8Array(32)))}`,
  );
  const response = yield* request(origin, token, cliLoginPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label }),
  });
  yield* requireSuccess(response);
  const { id, code } = yield* readResponse(CliLoginApproval, response);
  const url = `${origin}/?${cliLoginQuery}=${id}`;
  yield* Console.log(
    `Open ${url}\nCheck that the code in your browser matches ${code}, then choose Connect CLI.`,
  );
  if (browser) yield* openBrowser(url);

  yield* Effect.gen(function* () {
    let interval = cliLoginInterval;
    while (true) {
      yield* Effect.sleep(interval);
      const result = yield* request(
        origin,
        token,
        `${cliLoginPath}/${id}/poll`,
        {
          method: "POST",
        },
      ).pipe(Effect.option);
      if (
        result._tag === "None" ||
        result.value.status === 429 ||
        result.value.status >= 500
      ) {
        interval = Math.min(interval * 2, 30_000);
        continue;
      }
      switch (result.value.status) {
        case 204:
          return;
        case 202:
          break;
        case 403:
          return yield* new CliError({
            message: "CLI login was declined in the browser.",
          });
        case 410:
          return yield* approvalExpired();
        default:
          return yield* new CliError({
            message: `OneApp returned HTTP ${result.value.status} while waiting for approval.`,
          });
      }
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 minutes",
      orElse: () => Effect.fail(approvalExpired()),
    }),
  );
  return token;
});
