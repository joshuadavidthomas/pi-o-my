// Shared parameter schemas and validation helpers.

import { createErrorScoutDetails } from "./state.ts";

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
