import { Type } from "typebox";

import { createReadTool } from "@earendil-works/pi-coding-agent";

import { SCOUT_MODEL_TARGETS } from "../models.ts";
import type { ScoutConfig } from "../types.ts";
import { buildOracleSystemPrompt, buildOracleUserPrompt } from "./prompt.ts";
import { createReadOnlyBashTool } from "../tools/read-only-bash.ts";

export const OracleParams = Type.Object({
  query: Type.String({
    description: [
      "Describe what to analyze in the codebase.",
      "Include: specific goal, relevant files/components if known, what kind of analysis (trace data flow, explain architecture, find patterns, review implementation).",
      "Oracle reads code deeply and reasons about it. Use for questions that need understanding, not just location.",
      "Examples:",
      "- 'Trace the request lifecycle through the auth middleware in src/auth/. How does token validation work?'",
      "- 'Analyze the caching strategy in pkg/cache/. What are the eviction policies and edge cases?'",
      "- 'Find all implementations of the Repository pattern and show how they handle errors.'",
    ].join("\n"),
  }),
});

// Base config without tools — tools need cwd at runtime
const ORACLE_BASE_CONFIG: Omit<ScoutConfig, "createTools"> = {
  name: "oracle",
  modelTargets: SCOUT_MODEL_TARGETS.oracle,
  buildSystemPrompt: buildOracleSystemPrompt,
  buildUserPrompt: buildOracleUserPrompt,
};

// Build the full oracle config with tools scoped to cwd
export function buildOracleConfig(): ScoutConfig {
  return {
    ...ORACLE_BASE_CONFIG,
    createTools: (cwd) => [
      createReadOnlyBashTool(cwd),
      createReadTool(cwd),
    ],
  };
}
