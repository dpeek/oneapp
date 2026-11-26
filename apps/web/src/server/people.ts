import { ByteSize, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { WorkerEnv } from "../../../../alchemy.run.ts";
import {
  normalizePersonEmail,
  ContactKind,
  DeleteContactInput,
  DeletedContact,
  peopleApiPath,
  PeopleList,
  Person,
  PersonDraft,
  PersonEmail,
  PersonId,
  PersonLookup,
  profilePhotoLimit,
  restoreContactPath,
  selfProfilePath,
} from "../people-contract.ts";
import { jsonError, privateHeaders } from "./api-response.ts";
import { AppAuth, ownerId, type authHttp } from "./auth.ts";
import {
  deleteContact,
  listPeople,
  managedPersonAddresses,
  matchPeople,
  readProfile,
  readSelfProfile,
  restoreContact,
  writeProfile,
} from "./people-store.ts";

import { senderIconDomain } from "./mail-sender.ts";
import { normalizeCompanyDomain } from "../company-domains.ts";
import { notifyInbox } from "./inbox.ts";
import {
  defaultMailboxId,
  ensureDefaultMailbox,
  mailDatabase,
} from "./mailbox.ts";

type PeopleEnv = Pick<
  WorkerEnv,
  | "DB"
  | "PROFILE_PHOTOS"
  | "INBOX_EMAIL_ADDRESS"
  | "INBOX_EMAIL_FROM"
  | "MAILBOX_ALIASES"
  | "INBOX_UPDATES"
>;

const isId = Schema.is(PersonId);
const queryByEmail = HttpServerRequest.schemaSearchParams(
  Schema.Struct({
    email: Schema.optionalKey(PersonEmail),
    kind: Schema.optionalKey(ContactKind),
  }),
);
const requireOwner = Effect.gen(function* () {
  const auth = yield* AppAuth;
  return (yield* auth.requireSession).subjectId === ownerId;
});
const routeErrors = {
  AuthenticationRequired: () => jsonError(401, "Sign in required"),
  UnknownError: () => jsonError(503, "Contacts are temporarily unavailable."),
};
const notFound = () => jsonError(404, "Contact not found");
const writeErrors = {
  ...routeErrors,
  HookDenied: () => jsonError(403, "Request not allowed"),
};
const isAssignmentConflict = (error: unknown) =>
  error instanceof Error &&
  (error.message.includes("UNIQUE constraint failed: person_addresses.email") ||
    error.message.includes("UNIQUE constraint failed: company_domains.domain"));

const readPhotoBytes = (photo: string) => {
  try {
    const bytes = Uint8Array.fromBase64(photo);
    const size = bytes.byteLength;
    return size >= 5 &&
      size <= profilePhotoLimit &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff &&
      bytes[size - 2] === 0xff &&
      bytes[size - 1] === 0xd9
      ? bytes
      : null;
  } catch {
    return null;
  }
};

const removePhotoIfUnused = async (env: PeopleEnv, id: string, key: string) => {
  try {
    const used = await env.DB.prepare(
      `SELECT photo FROM people WHERE id = ?1 AND photo = ?2
       UNION ALL
       SELECT photo FROM contact_deletions WHERE id = ?1 AND photo = ?2 LIMIT 1`,
    )
      .bind(id, key)
      .first();
    if (!used) await env.PROFILE_PHOTOS.delete(key);
  } catch {
    console.warn("Could not clean up a profile photo");
  }
};

export const collectDeletedContacts = async (
  env: Pick<PeopleEnv, "DB" | "PROFILE_PHOTOS">,
  now = Date.now(),
) => {
  const { results } = await env.DB.prepare(
    `UPDATE contact_deletions SET expires_at = 0
     WHERE id IN (
       SELECT id FROM contact_deletions WHERE expires_at <= ? ORDER BY expires_at LIMIT 100
     ) RETURNING receipt, photo`,
  )
    .bind(now)
    .all<{ receipt: string; photo: string | null }>();
  for (const { receipt, photo } of results) {
    try {
      if (photo) await env.PROFILE_PHOTOS.delete(photo);
      await env.DB.prepare("DELETE FROM contact_deletions WHERE receipt = ?")
        .bind(receipt)
        .run();
    } catch {
      console.warn("Could not clean up a deleted contact");
    }
  }
};

const savePerson = async (
  env: PeopleEnv,
  id: string | null,
  input: typeof PersonDraft.Type,
  defer: (work: Promise<unknown>) => void,
) => {
  const managed = await managedPersonAddresses(env.DB, env.INBOX_EMAIL_ADDRESS);
  const current = id ? await readProfile(env.DB, id, managed) : null;
  if (id && !current) return { status: "missing" } as const;
  if (input.revision !== current?.revision) return { status: "stale" } as const;
  const addresses = [...new Set(input.addresses.map(normalizePersonEmail))];
  const kind = input.kind ?? current?.kind ?? "person";
  const domains =
    kind === "company"
      ? [
          ...new Set(
            (input.domains ?? current?.domains ?? []).map(
              normalizeCompanyDomain,
            ),
          ),
        ]
      : [];
  if (
    (current?.self && kind !== "person") ||
    (kind === "person" && input.domains?.length)
  )
    return { status: "kind" } as const;
  if (kind === "company" && !input.name.trim())
    return { status: "name" } as const;
  if (!current?.self && addresses.some((email) => managed.includes(email)))
    return { status: "conflict" } as const;
  if (
    !current?.self &&
    addresses.length === 0 &&
    (kind !== "company" || domains.length === 0)
  )
    return { status: "address" } as const;

  const noiseChanges = (input.noiseChanges ?? []).map(({ address, noise }) => ({
    address: normalizePersonEmail(address),
    noise,
  }));
  if (
    noiseChanges.some(
      ({ address }) =>
        !addresses.includes(address) || managed.includes(address),
    ) ||
    new Set(noiseChanges.map(({ address }) => address)).size !==
      noiseChanges.length
  )
    return { status: "noise-address" } as const;
  const mailbox = noiseChanges.length
    ? mailDatabase(env.DB, defaultMailboxId)
    : null;
  if (mailbox)
    await ensureDefaultMailbox(
      env.DB,
      env.INBOX_EMAIL_ADDRESS,
      env.INBOX_EMAIL_FROM,
      env.MAILBOX_ALIASES,
    );

  const owner = current?.id ?? crypto.randomUUID();
  const bytes = input.photo ? readPhotoBytes(input.photo) : null;
  if (input.photo && !bytes) return { status: "photo" } as const;
  const uploaded = bytes ? crypto.randomUUID() : null;
  const photo = input.photo === undefined ? (current?.photo ?? null) : uploaded;
  try {
    if (bytes && uploaded)
      await env.PROFILE_PHOTOS.put(uploaded, bytes, {
        httpMetadata: { contentType: "image/jpeg" },
      });
    const revision = await writeProfile(
      env.DB,
      owner,
      current?.revision,
      input.name,
      addresses,
      photo,
      kind,
      domains,
      mailbox
        ? {
            mailboxId: mailbox.mailboxId,
            on: noiseChanges
              .filter(({ noise }) => noise)
              .map(({ address }) => address),
            off: noiseChanges
              .filter(({ noise }) => !noise)
              .map(({ address }) => address),
          }
        : undefined,
    );
    if (!revision) {
      if (uploaded) defer(removePhotoIfUnused(env, owner, uploaded));
      return { status: "stale" } as const;
    }
    if (current?.photo && current.photo !== photo)
      defer(removePhotoIfUnused(env, owner, current.photo));
    const managedAddresses = current?.self ? managed : [];
    return {
      status: "ok",
      profile: {
        id: owner,
        name: input.name,
        ...(kind === "company"
          ? {
              kind,
              domains,
              iconDomain:
                domains[0] ??
                (addresses[0]
                  ? senderIconDomain([...addresses].sort()[0]!)
                  : null),
            }
          : {}),
        photo,
        revision,
        self: current?.self ?? false,
        addresses: addresses
          .filter((email) => !managedAddresses.includes(email))
          .sort(),
        managedAddresses,
      },
    } as const;
  } catch (error) {
    if (uploaded) defer(removePhotoIfUnused(env, owner, uploaded));
    if (isAssignmentConflict(error)) return { status: "conflict" } as const;
    throw error;
  }
};

export const peopleRoutes = (
  http: ReturnType<typeof authHttp>,
  env: PeopleEnv,
  defer: (work: Promise<unknown>) => void,
) => {
  const managed = () => managedPersonAddresses(env.DB, env.INBOX_EMAIL_ADDRESS);
  const notifyContactChange = () =>
    defer(notifyInbox({ ...env, DB: mailDatabase(env.DB, defaultMailboxId) }));

  const save = (existing: boolean) =>
    Effect.gen(function* () {
      if (!(yield* requireOwner)) return yield* jsonError(403, "Access denied");
      return yield* http.protect(
        Effect.gen(function* () {
          const { id } = yield* HttpRouter.params;
          if (existing && !isId(id)) return yield* notFound();
          const body = yield* HttpServerRequest.schemaBodyJson(PersonDraft, {
            onExcessProperty: "error",
          }).pipe(
            Effect.provideService(
              HttpServerRequest.MaxBodySize,
              ByteSize.kibibytes(512),
            ),
            Effect.option,
          );
          if (body._tag === "None")
            return yield* jsonError(
              400,
              "Enter a valid contact name, email addresses, domains, and image.",
            );
          const result = yield* Effect.tryPromise(() =>
            savePerson(env, existing ? (id ?? null) : null, body.value, defer),
          );
          switch (result.status) {
            case "ok":
              notifyContactChange();
              return yield* HttpServerResponse.schemaJson(Person)(
                result.profile,
                { status: existing ? 200 : 201, headers: privateHeaders },
              );
            case "missing":
              return yield* notFound();
            case "stale":
              return yield* jsonError(
                409,
                "This profile has changed. Reopen it and try again.",
              );
            case "conflict":
              return yield* jsonError(
                409,
                "An email address or domain is already linked to another contact.",
              );
            case "address":
              return yield* jsonError(
                400,
                "Add an email address, or a domain for a company.",
              );
            case "noise-address":
              return yield* jsonError(
                400,
                "Choose Noise for an email address on this contact.",
              );
            case "kind":
              return yield* jsonError(
                400,
                "Your own profile must remain a person; domains belong to companies.",
              );
            case "name":
              return yield* jsonError(400, "Enter a company name.");
            case "photo":
              return yield* jsonError(400, "Choose a valid profile image.");
          }
        }),
      );
    }).pipe(Effect.catchTags(writeErrors));

  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      selfProfilePath,
      Effect.gen(function* () {
        if (!(yield* requireOwner))
          return yield* jsonError(403, "Access denied");
        const profile = yield* Effect.tryPromise(async () =>
          readSelfProfile(env.DB, await managed()),
        );
        return yield* HttpServerResponse.schemaJson(Person)(profile, {
          headers: privateHeaders,
        });
      }).pipe(Effect.catchTags(routeErrors)),
    ),
    HttpRouter.add(
      "GET",
      peopleApiPath,
      Effect.gen(function* () {
        if (!(yield* requireOwner))
          return yield* jsonError(403, "Access denied");
        const query = yield* queryByEmail.pipe(Effect.option);
        if (query._tag === "None")
          return yield* jsonError(400, "Enter a valid email address.");
        const { email } = query.value;
        const addresses = yield* Effect.tryPromise(managed);
        if (email === undefined) {
          const people = yield* Effect.tryPromise(() =>
            listPeople(env.DB, addresses),
          );
          return yield* HttpServerResponse.schemaJson(PeopleList)(
            {
              people: query.value.kind
                ? people.filter(
                    (person) => (person.kind ?? "person") === query.value.kind,
                  )
                : people,
            },
            { headers: privateHeaders },
          );
        }
        const person = yield* Effect.tryPromise(async () => {
          const [match] = await matchPeople(env.DB, [email], addresses);
          return match ? readProfile(env.DB, match.person.id, addresses) : null;
        });
        return yield* HttpServerResponse.schemaJson(PersonLookup)(
          { person },
          {
            headers: privateHeaders,
          },
        );
      }).pipe(Effect.catchTags(routeErrors)),
    ),
    HttpRouter.add("POST", peopleApiPath, save(false)),
    HttpRouter.add("PUT", `${peopleApiPath}/:id`, save(true)),
    HttpRouter.add(
      "DELETE",
      `${peopleApiPath}/:id`,
      Effect.gen(function* () {
        if (!(yield* requireOwner))
          return yield* jsonError(403, "Access denied");
        return yield* http.protect(
          Effect.gen(function* () {
            const { id } = yield* HttpRouter.params;
            if (!isId(id)) return yield* notFound();
            const body = yield* HttpServerRequest.schemaBodyJson(
              DeleteContactInput,
              { onExcessProperty: "error" },
            ).pipe(
              Effect.provideService(
                HttpServerRequest.MaxBodySize,
                ByteSize.kibibytes(1),
              ),
              Effect.option,
            );
            if (body._tag === "None")
              return yield* jsonError(400, "Reopen the contact and try again.");
            const result = yield* Effect.tryPromise(() =>
              deleteContact(env.DB, id, body.value.revision),
            );
            switch (result.status) {
              case "missing":
                return yield* notFound();
              case "protected":
                return yield* jsonError(
                  403,
                  "Your own profile cannot be deleted.",
                );
              case "stale":
                return yield* jsonError(
                  409,
                  "This contact has changed. Review it and try again.",
                );
              case "ok":
                notifyContactChange();
                return yield* HttpServerResponse.schemaJson(DeletedContact)(
                  { receipt: result.receipt },
                  { headers: privateHeaders },
                );
            }
          }),
        );
      }).pipe(Effect.catchTags(writeErrors)),
    ),
    HttpRouter.add(
      "POST",
      restoreContactPath(":receipt"),
      Effect.gen(function* () {
        if (!(yield* requireOwner))
          return yield* jsonError(403, "Access denied");
        return yield* http.protect(
          Effect.gen(function* () {
            const { receipt } = yield* HttpRouter.params;
            if (!isId(receipt)) return yield* notFound();
            const person = yield* Effect.tryPromise(async () => {
              try {
                const id = await restoreContact(env.DB, receipt);
                return id ? await readProfile(env.DB, id, []) : null;
              } catch (error) {
                if (isAssignmentConflict(error)) return "conflict" as const;
                throw error;
              }
            });
            if (person === "conflict")
              return yield* jsonError(
                409,
                "An email address or domain is already linked to another contact.",
              );
            if (!person)
              return yield* jsonError(
                404,
                "This contact is no longer available to restore.",
              );
            notifyContactChange();
            return yield* HttpServerResponse.schemaJson(Person)(person, {
              headers: privateHeaders,
            });
          }),
        );
      }).pipe(Effect.catchTags(writeErrors)),
    ),
    HttpRouter.add(
      "GET",
      `${peopleApiPath}/:id/photo/:key`,
      Effect.gen(function* () {
        if (!(yield* requireOwner))
          return yield* jsonError(403, "Access denied");
        const { id, key } = yield* HttpRouter.params;
        if (!isId(id) || !isId(key)) return yield* notFound();
        const image = yield* Effect.tryPromise(async () => {
          const row = await env.DB.prepare(
            "SELECT photo FROM people WHERE id = ?",
          )
            .bind(id)
            .first<{ photo: string | null }>();
          return row?.photo === key ? env.PROFILE_PHOTOS.get(key) : null;
        });
        if (!image) return yield* notFound();
        return HttpServerResponse.fromWeb(
          new Response(image.body, {
            headers: {
              ...privateHeaders,
              "content-type": "image/jpeg",
              "x-content-type-options": "nosniff",
            },
          }),
        );
      }).pipe(Effect.catchTags(routeErrors)),
    ),
  );
};
