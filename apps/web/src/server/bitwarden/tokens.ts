import { Base64Url } from "effect/encoding";

export const bitwardenClients = ["browser", "desktop"] as const;
export type BitwardenClient = (typeof bitwardenClients)[number];
export const bitwardenScope = "api offline_access";
export const accessLifetimeSeconds = 360;
export const deviceLifetimeMillis = 30 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();
export const randomSecret = () =>
  Base64Url.encode(crypto.getRandomValues(new Uint8Array(32)));
export type GrantIdentity = {
  clientId: BitwardenClient;
  id: string;
  vaultId: string;
  deviceId: string;
  email: string;
  emailVerified: number;
  generation: number;
  issuedAt: number;
};

const jwtPart = (value: unknown) =>
  Base64Url.encode(encoder.encode(JSON.stringify(value)));
const importHmac = (material: Uint8Array<ArrayBuffer> | ArrayBuffer) =>
  crypto.subtle.importKey(
    "raw",
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
const sign = (key: CryptoKey, value: string) =>
  crypto.subtle.sign("HMAC", key, encoder.encode(value));

export const issueGrant = async (
  origin: string,
  rootSecret: string,
  identity: GrantIdentity,
) => {
  const root = await importHmac(encoder.encode(rootSecret));
  const jwt = await importHmac(await sign(root, "oneapp/bitwarden/jwt/v1"));
  const expiry = identity.issuedAt + accessLifetimeSeconds;
  const unsigned = `${jwtPart({ alg: "HS256", typ: "JWT" })}.${jwtPart({
    sub: identity.vaultId,
    iss: `${origin}/identity`,
    aud: "api",
    iat: identity.issuedAt,
    nbf: identity.issuedAt,
    exp: expiry,
    jti: `${identity.id}:${identity.generation}`,
    name: identity.email,
    email: identity.email,
    email_verified: identity.emailVerified === 1,
    premium: false,
    device: identity.deviceId,
    client_id: identity.clientId,
    scope: bitwardenScope.split(" "),
    amr: ["Application", "external"],
  })}`;
  const signature = Base64Url.encode(new Uint8Array(await sign(jwt, unsigned)));
  const refresh = await sign(
    root,
    `oneapp/bitwarden/refresh/v1:${identity.id}:${identity.generation}`,
  );
  return {
    access_token: `${unsigned}.${signature}`,
    refresh_token: Base64Url.encode(new Uint8Array(refresh)),
    expires_in: accessLifetimeSeconds,
    token_type: "Bearer",
    scope: bitwardenScope,
  };
};
