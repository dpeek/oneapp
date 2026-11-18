import { Clock, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import {
  BitwardenDeviceId,
  BitwardenDeviceList,
  bitwardenDevicesPath,
} from "../../bitwarden-device-contract.ts";
import { jsonError, privateHeaders } from "../api-response.ts";
import { AppAuth, type authHttp } from "../auth.ts";
import { deviceLifetimeMillis } from "./tokens.ts";

const requireSession = Effect.flatMap(AppAuth, (auth) => auth.requireSession);
const authRequired = () => jsonError(401, "Sign in required");
const isDeviceId = Schema.is(BitwardenDeviceId);

export const bitwardenDeviceRoutes = (http: ReturnType<typeof authHttp>) =>
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      bitwardenDevicesPath,
      Effect.gen(function* () {
        const session = yield* requireSession;
        const now = yield* Clock.currentTimeMillis;
        const sql = yield* SqlClient.SqlClient;
        // The original connection time is encoded in the fixed session expiry.
        // Pick the newest active grant for each installed Bitwarden device.
        const devices = yield* sql<(typeof BitwardenDeviceList.Type)[number]>`
          WITH active_devices AS (
            SELECT d.device_id AS id, COALESCE(d.device_name, 'Browser extension') AS name,
                   d.expires_at - ${deviceLifetimeMillis} AS "createdAt",
                   row_number() OVER (PARTITION BY d.device_id ORDER BY d.expires_at DESC, d.id DESC) AS rank
            FROM bitwarden_device_sessions d
            JOIN personal_vaults v ON v.id = d.vault_id
            JOIN accounts a ON a.id = v.owner_id AND a.active = 1 AND a.security_revision = d.security_revision
            WHERE v.owner_id = ${session.subjectId} AND d.expires_at > ${now}
          )
          SELECT id, name, "createdAt" FROM active_devices
          WHERE rank = 1 ORDER BY "createdAt" DESC, id
        `;
        return yield* HttpServerResponse.schemaJson(BitwardenDeviceList)(
          devices,
          { headers: privateHeaders },
        );
      }).pipe(Effect.catchTag("AuthenticationRequired", authRequired)),
    ),
    HttpRouter.add(
      "DELETE",
      `${bitwardenDevicesPath}/:id`,
      http
        .protect(
          Effect.gen(function* () {
            const session = yield* requireSession;
            const { id } = yield* HttpRouter.params;
            if (!isDeviceId(id))
              return yield* jsonError(400, "Invalid device ID");
            const now = yield* Clock.currentTimeMillis;
            const sql = yield* SqlClient.SqlClient;
            // Remove all token generations and grants for this installation.
            yield* sql`
              DELETE FROM bitwarden_device_sessions
              WHERE device_id = ${id} AND vault_id IN (
                SELECT v.id FROM personal_vaults v
                JOIN accounts a ON a.id = v.owner_id AND a.active = 1
                JOIN oneapp_auth_sessions s ON s.subject_id = a.id AND s.security_revision = a.security_revision
                WHERE a.id = ${session.subjectId} AND a.security_revision = ${session.securityRevision}
                  AND s.session_id = ${session.sessionId}
                  AND s.expires_at > ${now} AND s.absolute_expires_at > ${now}
              )
            `;
            return HttpServerResponse.empty({
              status: 204,
              headers: privateHeaders,
            });
          }),
        )
        .pipe(
          Effect.catchTags({
            AuthenticationRequired: authRequired,
            HookDenied: () => jsonError(403, "Request not allowed"),
          }),
        ),
    ),
  );
