import { ByteSize, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { WorkerEnv } from "../../../../alchemy.run.ts";
import {
  normalizePersonEmail,
  peopleApiPath,
  Person,
  PersonDraft,
  PersonEmail,
  PersonId,
  PersonLookup,
  profilePhotoLimit,
  selfProfilePath,
} from "../people-contract.ts";
import { jsonError, privateHeaders } from "./api-response.ts";
import { AppAuth, ownerId, type authHttp } from "./auth.ts";
import {
  managedPersonAddresses,
  matchPeople,
  readProfile,
  readSelfProfile,
  writeProfile,
} from "./people-store.ts";

type PeopleEnv = Pick<
  WorkerEnv,
  "DB" | "PROFILE_PHOTOS" | "INBOX_EMAIL_ADDRESS"
>;

const isId = Schema.is(PersonId);
const queryByEmail = HttpServerRequest.schemaSearchParams(
  Schema.Struct({ email: PersonEmail }),
);
const requireOwner = Effect.gen(function* () {
  const auth = yield* AppAuth;
  return (yield* auth.requireSession).subjectId === ownerId;
});
const routeErrors = {
  AuthenticationRequired: () => jsonError(401, "Sign in required"),
  UnknownError: () => jsonError(503, "People are temporarily unavailable."),
};
const notFound = () => jsonError(404, "Person not found");

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
    const row = await env.DB.prepare("SELECT photo FROM people WHERE id = ?")
      .bind(id)
      .first<{ photo: string | null }>();
    if (row?.photo !== key) await env.PROFILE_PHOTOS.delete(key);
  } catch {
    console.warn("Could not clean up a profile photo");
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
  if (!current?.self && addresses.some((email) => managed.includes(email)))
    return { status: "conflict" } as const;
  if (!current?.self && addresses.length === 0)
    return { status: "address" } as const;

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
    if (
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed: person_addresses.email")
    )
      return { status: "conflict" } as const;
    throw error;
  }
};

export const peopleRoutes = (
  http: ReturnType<typeof authHttp>,
  env: PeopleEnv,
  defer: (work: Promise<unknown>) => void,
) => {
  const managed = () => managedPersonAddresses(env.DB, env.INBOX_EMAIL_ADDRESS);

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
              "Enter a valid name, email addresses, and photo.",
            );
          const result = yield* Effect.tryPromise(() =>
            savePerson(env, existing ? (id ?? null) : null, body.value, defer),
          );
          switch (result.status) {
            case "ok":
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
                "An email address is already linked to another person.",
              );
            case "address":
              return yield* jsonError(400, "Add at least one email address.");
            case "photo":
              return yield* jsonError(400, "Choose a valid profile photo.");
          }
        }),
      );
    }).pipe(
      Effect.catchTags({
        ...routeErrors,
        HookDenied: () => jsonError(403, "Request not allowed"),
      }),
    );

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
        const person = yield* Effect.tryPromise(async () => {
          const addresses = await managed();
          const [match] = await matchPeople(
            env.DB,
            [query.value.email],
            addresses,
          );
          return match ? readProfile(env.DB, match.person.id, addresses) : null;
        });
        return yield* HttpServerResponse.schemaJson(PersonLookup)(
          { person },
          { headers: privateHeaders },
        );
      }).pipe(Effect.catchTags(routeErrors)),
    ),
    HttpRouter.add("POST", peopleApiPath, save(false)),
    HttpRouter.add("PUT", `${peopleApiPath}/:id`, save(true)),
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
