import type { CallToolResult } from "@modelcontextprotocol/server";
import { Schema } from "effect";

export const pageFields = {
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
};

export const standardSchema = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
) => Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(schema));

export const result = (
  structuredContent: Record<string, unknown>,
): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  structuredContent,
});

export const toolFailure = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export const runTool = async (
  failure: string,
  run: () => Promise<CallToolResult>,
) => {
  try {
    return await run();
  } catch {
    return toolFailure(failure);
  }
};
