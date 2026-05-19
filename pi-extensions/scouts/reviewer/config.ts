import { Type } from "typebox";

import { createReadTool } from "@mariozechner/pi-coding-agent";

import { ORACLE_FAMILY_PARTNERS } from "../models.ts";
import type { ScoutConfig } from "../types.ts";
import { ModelParam } from "../validate.ts";
import { buildReviewerSystemPrompt, buildReviewerUserPrompt } from "./prompt.ts";
import { createReadOnlyBashTool } from "../oracle/tools/read-only-bash.ts";

export const ReviewerParams = Type.Object({
  query: Type.String({
    description: [
      "Write a complete review brief for the Reviewer scout.",
      "Include what artifact is being reviewed, desired lenses, constraints, and what kind of output is useful.",
      "Reviewer is for judging a concrete artifact, not open-ended exploration. Use finder/oracle first if you do not yet know what to review.",
      "Good: 'Review this diff for Hickey structural simplicity and Lowy volatility boundaries. Strict mode. Focus on changed files and surrounding module context.'",
      "Bad: 'look around and tell me what to improve'",
    ].join("\n"),
  }),
  artifact: Type.Optional(
    Type.String({
      description: "Optional artifact text to review directly: a diff, plan doc, design sketch, session brief, or file contents. If omitted, the reviewer may use read-only tools based on the query.",
    }),
  ),
  artifactType: Type.Optional(
    Type.String({
      enum: ["diff", "plan", "design", "file", "module", "session", "brief", "other"],
      description: "Type of artifact being reviewed. Helps the reviewer choose evidence rules and scope.",
    }),
  ),
  lenses: Type.Optional(
    Type.Array(
      Type.String({ enum: ["hickey", "lowy", "correctness", "security", "testing", "ux", "maintainability"] }),
      {
        description: "Review lenses to apply. Defaults to [\"hickey\", \"lowy\"].",
        maxItems: 8,
      },
    ),
  ),
  mode: Type.Optional(
    Type.String({
      enum: ["notes", "strict"],
      description: "Review disposition mode. notes separates must-fix from advisory findings. strict requires every real finding to become Fix now or No-op.",
      default: "notes",
    }),
  ),
  context: Type.Optional(
    Type.String({
      enum: ["none", "brief", "transcript"],
      description: "How much surrounding session context the caller included. Defaults to brief. Context is background, not proof.",
      default: "brief",
    }),
  ),
  contextText: Type.Optional(
    Type.String({
      description: "Optional session/design context supplied by the caller. Prefer a concise brief over raw transcript unless the discussion history matters.",
    }),
  ),
  repoConfig: Type.Optional(
    Type.String({
      description: "Optional repo-specific review rules, Hickey catalog additions, or Lowy volatility map.",
    }),
  ),
  model: ModelParam,
});

const REVIEWER_BASE_CONFIG: Omit<ScoutConfig, "createTools"> = {
  name: "reviewer",
  maxTurns: 14,
  workload: "deep",
  diversityPartners: ORACLE_FAMILY_PARTNERS,
  buildSystemPrompt: buildReviewerSystemPrompt,
  buildUserPrompt: buildReviewerUserPrompt,
};

export function buildReviewerConfig(): ScoutConfig {
  return {
    ...REVIEWER_BASE_CONFIG,
    createTools: (cwd) => [
      createReadOnlyBashTool(cwd),
      createReadTool(cwd),
    ],
  };
}
