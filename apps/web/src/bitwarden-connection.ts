export const bitwardenAuthorizePath = "/identity/connect/authorize";
export const bitwardenTokenPath = "/identity/connect/token";
export const bitwardenConnectorPath = "/sso-connector.html";
export const bitwardenSignInQuery = "connectBitwarden";

const ssoFragment = "#/sso?";

export const authorizationFromFragment = (url: URL) => {
  if (url.pathname !== "/" || !url.hash.startsWith(ssoFragment)) return null;
  const input = new URLSearchParams(url.hash.slice(ssoFragment.length));
  const params = new URLSearchParams({
    client_id: input.get("clientId") ?? "",
    redirect_uri: input.get("redirectUri") ?? "",
    state: input.get("state") ?? "",
    code_challenge: input.get("codeChallenge") ?? "",
    code_challenge_method: "S256",
    response_type: "code",
    scope: "api offline_access",
  });
  return `${bitwardenAuthorizePath}?${params}`;
};

export const bitwardenSignInUrl = (requestUrl: URL) => {
  const handoff = new URL("/", requestUrl.origin);
  handoff.searchParams.set(bitwardenSignInQuery, "1");
  const params = new URLSearchParams({
    clientId: requestUrl.searchParams.get("client_id") ?? "",
    redirectUri: requestUrl.searchParams.get("redirect_uri") ?? "",
    state: requestUrl.searchParams.get("state") ?? "",
    codeChallenge: requestUrl.searchParams.get("code_challenge") ?? "",
  });
  handoff.hash = `${ssoFragment.slice(1)}${params}`;
  return handoff;
};
