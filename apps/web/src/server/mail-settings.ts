import type { D1Database } from "@cloudflare/workers-types";
import type { WorkerEnv } from "../../../../alchemy.run.ts";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  exactInboundAddress,
  InboundRoute,
  InboundRouteEdit,
  inboundRoutesApiPath,
  Mailbox,
  mailboxesApiPath,
  mailDomains,
  MailSettings,
  mailSettingsApiPath,
  NewMailbox,
} from "../mail-settings-contract.ts";
import { normalizePersonEmail } from "../people-contract.ts";
import { jsonError, privateHeaders } from "./api-response.ts";
import { AppAuth, ownerId, type authHttp } from "./auth.ts";
import { ensureDefaultMailbox } from "./mailbox.ts";

const routeDomain = (address: string) =>
  mailDomains.find((domain) => address.endsWith(`@${domain}`));

// Shared Mail settings currently grant route management to any signed-in account.
const requireRouteManager = Effect.gen(function* () {
  const auth = yield* AppAuth;
  return yield* auth.requireSession;
});

export const mailSettingsRoutes = (
  http: ReturnType<typeof authHttp>,
  env: Pick<WorkerEnv, "DB" | "INBOX_EMAIL_FROM">,
) => {
  const db: D1Database = env.DB;
  const bootstrap = (accountId: string) =>
    accountId === ownerId
      ? ensureDefaultMailbox(db, env.INBOX_EMAIL_FROM)
      : Promise.resolve();
  const mailboxes = (accountId: string) =>
    db
      .prepare(
        "SELECT id, name FROM mailboxes WHERE owner_account_id = ? ORDER BY name COLLATE NOCASE, id",
      )
      .bind(accountId)
      .all<Mailbox>();
  const signedIn = Effect.flatMap(AppAuth, (auth) => auth.requireSession);
  const errors = {
    AuthenticationRequired: () => jsonError(401, "Sign in required"),
    HookDenied: () => jsonError(403, "Request not allowed"),
    UnknownError: () => jsonError(503, "Mail settings are unavailable."),
  };
  const readRoutes = Effect.gen(function* () {
    const { subjectId } = yield* requireRouteManager;
    const [routes, destinations, owned] = yield* Effect.tryPromise(async () => {
      await bootstrap(subjectId);
      return Promise.all([
        db
          .prepare(
            "SELECT address, mailbox_id AS mailboxId FROM mail_inbound_routes ORDER BY address",
          )
          .all<InboundRoute>(),
        db
          .prepare(
            "SELECT id, name FROM mailboxes ORDER BY name COLLATE NOCASE, id",
          )
          .all<Mailbox>(),
        mailboxes(subjectId),
      ]);
    });
    return yield* HttpServerResponse.schemaJson(MailSettings)(
      {
        domains: mailDomains,
        routes: routes.results.filter(
          ({ address }) => routeDomain(address) !== undefined,
        ),
        destinations: destinations.results,
        mailboxes: owned.results,
      },
      { headers: privateHeaders },
    );
  });

  const saveRoute = (method: "POST" | "PUT") =>
    HttpRouter.add(
      method,
      inboundRoutesApiPath,
      http
        .protect(
          Effect.gen(function* () {
            yield* requireRouteManager;
            const input: Effect.Effect<
              { route: InboundRoute; previous: InboundRoute | null },
              unknown,
              HttpServerRequest.HttpServerRequest
            > =
              method === "POST"
                ? HttpServerRequest.schemaBodyJson(InboundRoute).pipe(
                    Effect.map((route) => ({ route, previous: null })),
                  )
                : HttpServerRequest.schemaBodyJson(InboundRouteEdit);
            const body = yield* Effect.option(input);
            if (body._tag === "None")
              return yield* jsonError(
                400,
                "Enter a valid address and mailbox.",
              );
            const { route, previous } = body.value;
            const { mailboxId } = route;
            const [name = "", domain = ""] = route.address
              .toLowerCase()
              .split("@");
            const address = exactInboundAddress(name, domain);
            if (!address)
              return yield* jsonError(
                400,
                "Use an exact address on a configured domain.",
              );
            const statement = previous
              ? db
                  .prepare(
                    `UPDATE OR IGNORE mail_inbound_routes SET address = ?1, mailbox_id = ?2
                   WHERE address = ?3 AND mailbox_id = ?4
                     AND EXISTS (SELECT 1 FROM mailboxes WHERE id = ?2)
                   RETURNING address`,
                  )
                  .bind(
                    address,
                    mailboxId,
                    normalizePersonEmail(previous.address),
                    previous.mailboxId,
                  )
              : db
                  .prepare(
                    `INSERT INTO mail_inbound_routes (address, mailbox_id)
                   SELECT ?1, id FROM mailboxes WHERE id = ?2
                   ON CONFLICT (address) DO NOTHING RETURNING address`,
                  )
                  .bind(address, mailboxId);
            const saved = yield* Effect.tryPromise(() =>
              statement.first<{ address: string }>(),
            );
            if (!saved)
              return yield* jsonError(
                409,
                "That address already has a rule, or the rule or mailbox has changed. Check the fields or reload Mail settings.",
              );
            return yield* HttpServerResponse.schemaJson(InboundRoute)(
              { address, mailboxId },
              {
                status: method === "POST" ? 201 : 200,
                headers: privateHeaders,
              },
            );
          }),
        )
        .pipe(Effect.catchTags(errors)),
    );

  const deleteRoute = HttpRouter.add(
    "DELETE",
    inboundRoutesApiPath,
    http
      .protect(
        Effect.gen(function* () {
          yield* requireRouteManager;
          const body = yield* HttpServerRequest.schemaBodyJson(
            InboundRoute,
          ).pipe(Effect.option);
          if (body._tag === "None")
            return yield* jsonError(400, "Select an address rule to delete.");
          const deleted = yield* Effect.tryPromise(() =>
            db
              .prepare(
                "DELETE FROM mail_inbound_routes WHERE address = ? AND mailbox_id = ? RETURNING address",
              )
              .bind(
                normalizePersonEmail(body.value.address),
                body.value.mailboxId,
              )
              .first<{ address: string }>(),
          );
          if (!deleted)
            return yield* jsonError(
              409,
              "The address rule has changed. Reload Mail settings and try again.",
            );
          return HttpServerResponse.empty({
            status: 204,
            headers: privateHeaders,
          });
        }),
      )
      .pipe(Effect.catchTags(errors)),
  );

  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      mailSettingsApiPath,
      readRoutes.pipe(
        Effect.catchTags({
          AuthenticationRequired: errors.AuthenticationRequired,
          UnknownError: errors.UnknownError,
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      mailboxesApiPath,
      Effect.gen(function* () {
        const { subjectId } = yield* signedIn;
        const { results } = yield* Effect.tryPromise(async () => {
          await bootstrap(subjectId);
          return mailboxes(subjectId);
        });
        return yield* HttpServerResponse.json(
          { mailboxes: results },
          { headers: privateHeaders },
        );
      }).pipe(
        Effect.catchTags({
          AuthenticationRequired: errors.AuthenticationRequired,
          UnknownError: errors.UnknownError,
        }),
      ),
    ),
    HttpRouter.add(
      "POST",
      mailboxesApiPath,
      http
        .protect(
          Effect.gen(function* () {
            const { subjectId } = yield* signedIn;
            const body = yield* HttpServerRequest.schemaBodyJson(
              NewMailbox,
            ).pipe(Effect.option);
            if (body._tag === "None")
              return yield* jsonError(
                400,
                "Enter a mailbox name of 1 to 100 characters.",
              );
            const mailbox = { id: crypto.randomUUID(), name: body.value.name };
            yield* Effect.tryPromise(() =>
              db
                .prepare(
                  "INSERT INTO mailboxes (id, owner_account_id, name) VALUES (?, ?, ?)",
                )
                .bind(mailbox.id, subjectId, mailbox.name)
                .run(),
            );
            return yield* HttpServerResponse.schemaJson(Mailbox)(mailbox, {
              status: 201,
              headers: privateHeaders,
            });
          }),
        )
        .pipe(Effect.catchTags(errors)),
    ),
    saveRoute("POST"),
    saveRoute("PUT"),
    deleteRoute,
  );
};
