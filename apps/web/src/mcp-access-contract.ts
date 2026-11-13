import { Schema } from "effect";

export const mcpLoginPath = "/connect/mcp";
export const mcpLoginQuery = "connect-mcp";
export const mcpAuthorizePath = "/oauth/mcp/authorize";
export const mcpGrantsPath = "/api/mcp-grants";

export const McpGrantId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u),
);
export const McpGrant = Schema.Struct({
  id: McpGrantId,
  clientId: Schema.String,
  expiresAt: Schema.Int,
});
export const McpGrantList = Schema.Array(McpGrant);
