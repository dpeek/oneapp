import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Option, Redacted, Schema } from "effect";
import { Command, Flag, Prompt } from "effect/cli";
import { ImapFlow } from "imapflow";
import { inventoryMailbox } from "./mail/inventory.ts";
import { inventoryCredentials } from "./mail/config.ts";
import { inventoryErrorMessage } from "./mail/errors.ts";

class InventoryError extends Schema.TaggedError<InventoryError>()(
  "InventoryError",
  { message: Schema.String },
) {}

Command.make(
  "mail:inventory",
  {
    user: Flag.String("user").pipe(
      Flag.withSchema(Schema.NonEmptyString),
      Flag.withDescription(
        "Your iCloud IMAP login (defaults to ICLOUD_IMAP_USER)",
      ),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ user }) {
    const configured = inventoryCredentials(
      Option.getOrUndefined(user),
      process.env,
    );
    if (!configured.user)
      return yield* new InventoryError({
        message:
          "Set ICLOUD_IMAP_USER in .env or pass --user with your iCloud IMAP login.",
      });
    if (!configured.password && !process.stdin.isTTY)
      return yield* new InventoryError({
        message:
          "Set ICLOUD_IMAP_PASSWORD in .env, or run in a terminal to enter an app-specific password privately.",
      });
    const password =
      configured.password ??
      (yield* Prompt.Hidden({
        message: "iCloud app-specific password",
      }));
    yield* Console.error("Connecting to iCloud IMAP…");
    let phase = "Connection";
    const report = yield* Effect.tryPromise({
      try: async () => {
        await using client = new ImapFlow({
          host: "imap.mail.me.com",
          port: 993,
          secure: true,
          auth: { user: configured.user!, pass: Redacted.value(password) },
          logger: false,
          disableAutoIdle: true,
          connectionTimeout: 30_000,
          socketTimeout: 60_000,
        });
        // Do not print protocol errors: servers can include account information.
        client.on("error", () => {});
        await client.connect();
        phase = "Folder inventory";
        console.error("Connected. Reading folder sizes and flags…");
        return await inventoryMailbox(client);
      },
      catch: (error) =>
        new InventoryError({
          message: `${phase}: ${inventoryErrorMessage(error)}`,
        }),
    });
    yield* Console.log(JSON.stringify(report, null, 2));
    if (!report.complete) process.exitCode = 1;
  }),
).pipe(
  Command.withDescription(
    "Read-only iCloud folder inventory; fetches sizes and flags, never message bodies. Includes all addresses sharing the account.",
  ),
  Command.run({ version: "0.0.0" }),
  Effect.provide(BunServices.layer),
  Effect.catchTag("InventoryError", (error) =>
    Console.error(error.message).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    ),
  ),
  BunRuntime.runMain,
);
