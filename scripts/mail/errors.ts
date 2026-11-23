import { Schema } from "effect";

// Only construct this with our own diagnostics, never server/library messages.
export class MailSampleError extends Error {}

const decodeError = Schema.decodeUnknownOption(
  Schema.Struct({
    code: Schema.optionalKey(Schema.String),
    authenticationFailed: Schema.optionalKey(Schema.Boolean),
    tlsFailed: Schema.optionalKey(Schema.Boolean),
    serverResponseCode: Schema.optionalKey(Schema.String),
  }),
);

// Only return our own messages. IMAP errors can contain the executed command,
// credentials or arbitrary server text, including inside nested error causes.
export const inventoryErrorMessage = (error: unknown) => {
  const decoded = decodeError(error);
  if (decoded._tag === "None")
    return "The IMAP operation failed. Retry the inventory.";
  const value = decoded.value;
  if (
    value.authenticationFailed ||
    value.serverResponseCode === "AUTHENTICATIONFAILED"
  )
    return "iCloud rejected authentication. Check ICLOUD_IMAP_USER is the iCloud mailbox login and ICLOUD_IMAP_PASSWORD is an Apple app-specific password.";
  if (
    value.tlsFailed ||
    [
      "CERT_HAS_EXPIRED",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
    ].includes(value.code ?? "")
  )
    return "The secure connection to iCloud could not be verified. Check the system clock and network TLS configuration.";
  switch (value.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "DNSResolveFailed":
      return "Could not resolve imap.mail.me.com. Check DNS and network access.";
    case "EPERM":
    case "EACCES":
      return "Network access to iCloud was denied by the local environment.";
    case "CONNECT_TIMEOUT":
    case "GREETING_TIMEOUT":
    case "ETIMEOUT":
    case "ETIMEDOUT":
      return "The iCloud IMAP connection timed out. Check access to imap.mail.me.com on port 993.";
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "NoConnection":
    case "EConnectionClosed":
    case "ClosedAfterConnectText":
    case "ClosedAfterConnectTLS":
      return "The iCloud IMAP connection was refused or closed. Check the network and retry.";
    case "ETHROTTLE":
      return "iCloud throttled the connection. Wait before retrying.";
    case "MissingInventoryMetadata":
      return "The server omitted message sizes or flags; totals are partial.";
    default:
      return "The IMAP operation failed. Retry the inventory.";
  }
};
