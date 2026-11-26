import { D1Client } from "@effect/sql-d1/D1Client";
import {
  cliLinkScopes,
  CliRequestedScopes,
  CliLoginApproval,
  CliLoginDecision,
  CliLoginId,
  CliLoginRequest,
  cliLoginPath,
} from "@orumai/core/cli-auth";
import { ByteSize, Clock, Effect, Layer, Schema } from "effect";
import { Hex } from "effect/encoding";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { jsonError, privateHeaders } from "./api-response.ts";
import { AppAuth, type authHttp } from "./auth.ts";
import {
  invalidTokenResponse,
  requireCliDigest,
  requireCliToken,
} from "./cli-tokens.ts";

const lifetime = 5 * 60_000;
const isId = Schema.is(CliLoginId);
const detailsPath = `${cliLoginPath}/:id`;
const authRequired = () => jsonError(401, "Sign in required");
const expired = () =>
  jsonError(410, "This CLI login request is no longer available");
const denied = () => jsonError(403, "Request not allowed");
const empty = (status: number) =>
  HttpServerResponse.empty({ status, headers: privateHeaders });
const owner = Effect.flatMap(AppAuth, (auth) => auth.requireSession);

const readInput = <A>(schema: Schema.Decoder<A>) =>
  HttpServerRequest.schemaBodyJson(schema).pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.kibibytes(2)),
    Effect.option,
  );

const start = Effect.gen(function* () {
  const digest = yield* requireCliDigest;
  const input = yield* readInput(CliLoginRequest);
  if (input._tag === "None")
    return yield* jsonError(400, "Enter a CLI name of 1 to 60 characters");
  const now = yield* Clock.currentTimeMillis;
  const random = Hex.encode(
    crypto.getRandomValues(new Uint8Array(4)),
  ).toUpperCase();
  const approval = {
    id: crypto.randomUUID(),
    code: `${random.slice(0, 4)}-${random.slice(4)}`,
    label: input.value.label,
    expiresAt: now + lifetime,
    scopes: input.value.scopes ?? cliLinkScopes,
  };
  const sql = yield* D1Client;
  const [, inserted] = yield* sql.batch([
    sql`DELETE FROM cli_logins WHERE expires_at <= ${now}`,
    sql<{ id: string }>`
      INSERT INTO cli_logins (id, digest, code, label, expires_at, scopes)
      VALUES (${approval.id}, ${digest}, ${approval.code}, ${approval.label}, ${approval.expiresAt}, ${JSON.stringify(approval.scopes)})
      ON CONFLICT DO NOTHING RETURNING id
    `,
  ]);
  if (inserted.length === 0)
    return yield* jsonError(
      409,
      "A request already exists for this credential",
    );
  return yield* HttpServerResponse.schemaJson(CliLoginApproval)(approval, {
    status: 201,
    headers: privateHeaders,
  });
}).pipe(Effect.catchTag("InvalidCliToken", invalidTokenResponse));

const details = Effect.gen(function* () {
  yield* owner;
  const { id } = yield* HttpRouter.params;
  if (!isId(id)) return yield* expired();
  const now = yield* Clock.currentTimeMillis;
  const sql = yield* SqlClient.SqlClient;
  const [approval] = yield* sql<
    Omit<typeof CliLoginApproval.Type, "scopes"> & { scopes: string | null }
  >`
    SELECT id, code, label, expires_at AS "expiresAt", scopes
    FROM cli_logins WHERE id = ${id} AND expires_at > ${now}
      AND owner_id IS NULL AND denied_at IS NULL
  `;
  if (!approval) return yield* expired();
  return yield* HttpServerResponse.schemaJson(CliLoginApproval)(
    {
      ...approval,
      scopes: Schema.decodeUnknownSync(
        Schema.fromJsonString(CliRequestedScopes),
      )(approval.scopes ?? JSON.stringify(cliLinkScopes)),
    },
    {
      headers: privateHeaders,
    },
  );
}).pipe(Effect.catchTag("AuthenticationRequired", authRequired));

const poll = Effect.gen(function* () {
  const digest = yield* requireCliDigest;
  const { id } = yield* HttpRouter.params;
  if (!isId(id)) return yield* expired();
  const now = yield* Clock.currentTimeMillis;
  const sql = yield* D1Client;
  const [login] = yield* sql<{
    ownerId: string | null;
    deniedAt: number | null;
    redeemedAt: number | null;
  }>`
    SELECT owner_id AS "ownerId", denied_at AS "deniedAt", redeemed_at AS "redeemedAt"
    FROM cli_logins WHERE id = ${id} AND digest = ${digest} AND expires_at > ${now}
  `;
  if (!login) return yield* expired();
  if (login.deniedAt !== null)
    return yield* jsonError(403, "CLI login was declined");
  if (login.ownerId === null) return empty(202);
  if (login.redeemedAt === null) {
    // Consume the approval in the same batch as issuance so a revoked token cannot be reissued.
    yield* sql.batch([
      sql`
        INSERT INTO cli_tokens (id, owner_id, label, digest, created_at, scopes, expires_at)
        SELECT l.id, l.owner_id, l.label, l.digest, ${now}, l.scopes, CASE WHEN l.scopes = '["mail:import"]' THEN ${now + 24 * 60 * 60_000} ELSE NULL END
        FROM cli_logins l JOIN accounts a ON a.id = l.owner_id
        WHERE l.id = ${id} AND l.digest = ${digest} AND l.expires_at > ${now}
          AND l.denied_at IS NULL AND l.redeemed_at IS NULL AND l.scopes IS NOT NULL AND a.active = 1
        ON CONFLICT DO NOTHING
      `,
      sql`
        UPDATE cli_logins SET redeemed_at = ${now}
        WHERE id = ${id} AND EXISTS (SELECT 1 FROM cli_tokens WHERE id = ${id} AND digest = ${digest})
      `,
    ]);
  }
  const token = yield* requireCliToken.pipe(Effect.option);
  return token._tag === "Some" && token.value.id === id
    ? empty(204)
    : yield* expired();
}).pipe(Effect.catchTag("InvalidCliToken", invalidTokenResponse));

export const cliLoginRoutes = (http: ReturnType<typeof authHttp>) =>
  Layer.mergeAll(
    HttpRouter.add("POST", cliLoginPath, start),
    HttpRouter.add("GET", detailsPath, details),
    HttpRouter.add("POST", `${detailsPath}/poll`, poll),
    HttpRouter.add(
      "POST",
      detailsPath,
      Effect.gen(function* () {
        const session = yield* owner;
        return yield* http.protect(
          Effect.gen(function* () {
            const { id } = yield* HttpRouter.params;
            if (!isId(id)) return yield* expired();
            const decision = yield* readInput(CliLoginDecision);
            if (decision._tag === "None")
              return yield* jsonError(400, "Invalid approval decision");
            const now = yield* Clock.currentTimeMillis;
            const sql = yield* SqlClient.SqlClient;
            const [updated] = yield* sql<{ id: string }>`
            UPDATE cli_logins
            SET owner_id = ${decision.value.approve ? session.subjectId : null},
                denied_at = ${decision.value.approve ? null : now},
                scopes = ${decision.value.approve ? JSON.stringify(decision.value.scopes) : null}
            WHERE id = ${id} AND expires_at > ${now}
              AND owner_id IS NULL AND denied_at IS NULL
              AND (${!decision.value.approve} OR coalesce(scopes, ${JSON.stringify(cliLinkScopes)}) = ${decision.value.approve ? JSON.stringify(decision.value.scopes) : ""})
            RETURNING id
          `;
            return updated ? empty(204) : yield* expired();
          }),
        );
      }).pipe(
        Effect.catchTags({
          AuthenticationRequired: authRequired,
          HookDenied: denied,
        }),
      ),
    ),
  );
