// Shared parameter schemas and validation helpers.

import { Type } from "typebox";

import { createErrorScoutDetails } from "./state.ts";

// Shared parameter: model override — used by all scout tools
export const ModelParam = Type.Optional(
  Type.String({
    description: [
      "Advanced model override. Usually omit this.",
      "Only set it when the user explicitly requested a specific model/provider, or when a prior scout attempt failed and you need a deliberate retry.",
      "If omitted, the scout preserves the current session provider when possible and chooses the configured model for that scout's workload.",
      "Examples: 'openai/gpt-5.4', 'anthropic/claude-opus-4-6', 'gemini-3.1-pro'.",
    ].join("\n"),
  }),
);

// Build a standardized error result
export function makeErrorResult(text: string, query = "") {
  return {
    content: [{ type: "text" as const, text }],
    details: createErrorScoutDetails(query, text),
    isError: true as const,
  };
}

// Validate that `query` is a non-empty string, return error result or null
export function validateQuery(params: unknown): ReturnType<typeof makeErrorResult> | null {
  const rawQuery = typeof params === "object" && params !== null
    ? (params as { query?: unknown }).query
    : undefined;
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (!query) {
    return makeErrorResult("Invalid parameters: expected `query` to be a non-empty string.", query);
  }
  return null;
}
