import { Type } from "typebox";

import { createReadTool } from "@mariozechner/pi-coding-agent";

import { ORACLE_FAMILY_PARTNERS } from "../models.ts";
import type { ScoutConfig } from "../types.ts";
import { ModelParam } from "../validate.ts";
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
  model: ModelParam,
});

// Base config without tools — tools need cwd at runtime
const ORACLE_BASE_CONFIG: Omit<ScoutConfig, "createTools"> = {
  name: "oracle",
  maxTurns: 12,
  workload: "deep",
  diversityPartners: ORACLE_FAMILY_PARTNERS,
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
