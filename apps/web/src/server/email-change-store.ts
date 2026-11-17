import { D1Client } from "@effect/sql-d1/D1Client";
import { Effect } from "effect";

type Session = {
  readonly subjectId: string;
  readonly sessionId: string;
  readonly securityRevision: string;
};

const emailChangeLifetimeMillis = 5 * 60 * 1000;
const maxFailures = 5;

export const saveEmailChange = Effect.fnUntraced(function* (
  session: Session,
  input: { id: string; email: string; digest: string },
) {
  const sql = yield* D1Client;
  const [saved] = yield* sql<{ id: string }>`
    INSERT INTO account_email_changes
      (subject_id, id, session_id, security_revision, new_email, digest, expires_at, failed_attempts)
    SELECT a.id, ${input.id}, ${session.sessionId}, a.security_revision, ${input.email},
      ${input.digest}, CAST(unixepoch('subsec') * 1000 AS INTEGER) + ${emailChangeLifetimeMillis}, 0
    FROM accounts a
    WHERE a.id = ${session.subjectId} AND a.active = 1
      AND a.security_revision = ${session.securityRevision}
      AND NOT EXISTS (
        SELECT 1 FROM oneapp_auth_identifiers WHERE namespace = 'email' AND value = ${input.email}
      )
    ON CONFLICT (subject_id) DO UPDATE SET
      id = excluded.id, session_id = excluded.session_id, security_revision = excluded.security_revision,
      new_email = excluded.new_email, digest = excluded.digest, expires_at = excluded.expires_at,
      failed_attempts = 0
    RETURNING id
  `;
  return saved !== undefined;
});

export const discardEmailChange = Effect.fnUntraced(function* (
  subjectId: string,
  id: string,
) {
  const sql = yield* D1Client;
  yield* sql`DELETE FROM account_email_changes WHERE subject_id = ${subjectId} AND id = ${id}`;
});

export const commitEmailChange = Effect.fnUntraced(function* (
  session: Session,
  input: { id: string; oldEmail: string; digest: string },
) {
  const sql = yield* D1Client;
  const now = sql`CAST(unixepoch('subsec') * 1000 AS INTEGER)`;
  const change = sql`
    subject_id = ${session.subjectId} AND id = ${input.id}
    AND session_id = ${session.sessionId} AND security_revision = ${session.securityRevision}
    AND expires_at > ${now} AND failed_attempts < ${maxFailures}
  `;
  const newRevision = crypto.randomUUID();
  const switched = sql`
    SELECT value FROM oneapp_auth_identifiers
    WHERE subject_id = ${session.subjectId} AND namespace = 'email' AND revision = ${newRevision}
  `;

  // D1 runs the batch in one transaction. The unique revision links the
  // subsequent writes to this exact successful address update.
  const [, updated] = yield* sql.batch([
    sql`
      UPDATE account_email_changes SET failed_attempts = failed_attempts + 1
      WHERE ${change} AND digest <> ${input.digest}
    `,
    sql<{ email: string }>`
      UPDATE oneapp_auth_identifiers
      SET value = (SELECT new_email FROM account_email_changes WHERE ${change}),
        verified_at = ${now}, revision = ${newRevision}
      WHERE subject_id = ${session.subjectId} AND namespace = 'email'
        AND value = ${input.oldEmail} AND active = 1
        AND EXISTS (
          SELECT 1 FROM accounts
          WHERE id = ${session.subjectId} AND active = 1 AND security_revision = ${session.securityRevision}
        )
        AND EXISTS (
          SELECT 1 FROM oneapp_auth_sessions
          WHERE session_id = ${session.sessionId} AND subject_id = ${session.subjectId}
            AND security_revision = ${session.securityRevision}
            AND expires_at > ${now} AND absolute_expires_at > ${now}
        )
        AND EXISTS (
          SELECT 1 FROM account_email_changes pending
          WHERE ${change} AND digest = ${input.digest}
            AND NOT EXISTS (
              SELECT 1 FROM oneapp_auth_identifiers existing
              WHERE existing.namespace = 'email' AND existing.value = pending.new_email
            )
        )
      RETURNING value AS email
    `,
    sql`
      UPDATE oneapp_auth_emailCredentials SET identifier_value = (${switched})
      WHERE subject_id = ${session.subjectId} AND identifier_namespace = 'email'
        AND identifier_value = ${input.oldEmail} AND active = 1 AND EXISTS (${switched})
    `,
    sql`
      UPDATE accounts SET security_revision = ${newRevision}
      WHERE id = ${session.subjectId} AND EXISTS (${switched})
    `,
    sql`
      DELETE FROM account_email_changes WHERE subject_id = ${session.subjectId}
        AND id = ${input.id} AND EXISTS (${switched})
    `,
  ]);
  return updated[0]?.email;
});
