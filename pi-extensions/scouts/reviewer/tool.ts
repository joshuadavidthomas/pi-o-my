import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { ScoutCall, ScoutResult } from "../render.ts";
import { trackScoutToolCall } from "../state.ts";
import type { ScoutDetails } from "../types.ts";
import { makeErrorResult, ModelParam, validateQuery } from "../validate.ts";
import { isReviewLens, REVIEW_LENSES, type ReviewLens } from "./config.ts";
import { REVIEW_ARTIFACT_TYPES, runReviewLens, type ReviewArtifactType, type ReviewContext, type ReviewMode } from "./run.ts";

export const ReviewerParams = Type.Object({
  query: Type.String({
    description: [
      "Write a complete review brief for the Reviewer scout.",
      "Include what artifact is being reviewed, the constraints, and what kind of output is useful.",
      "Reviewer is for judging a concrete artifact, not open-ended exploration. Use finder/oracle first if you do not yet know what to review.",
      "Good: 'Review this diff for Muratori semantic compression and actual work visibility. Strict mode. Focus on premature abstraction, hidden work, and performance/debuggability visibility.'",
      "Bad: 'look around and tell me what to improve'",
    ].join("\n"),
  }),
  lens: Type.String({
    enum: [...REVIEW_LENSES],
    description: "Single review lens to run. For multiple independent lenses, issue multiple reviewer tool calls in the same assistant turn, one per lens.",
  }),
  artifact: Type.Optional(
    Type.String({
      description: "Optional artifact text to review directly: a diff, plan doc, design sketch, session brief, or file contents. If omitted, the reviewer may use read-only tools based on the query.",
    }),
  ),
  artifactType: Type.Optional(
    Type.String({
      enum: [...REVIEW_ARTIFACT_TYPES],
      description: "Type of artifact being reviewed. Helps the reviewer choose evidence rules and scope.",
    }),
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
      description: "Optional repo-specific review rules, lens catalog additions, or decomposition/volatility notes.",
    }),
  ),
  model: ModelParam,
});

function reviewMode(value: unknown): ReviewMode {
  return value === "strict" ? "strict" : "notes";
}

function reviewContext(value: unknown): ReviewContext {
  return value === "none" || value === "brief" || value === "transcript" ? value : "brief";
}

function reviewArtifactType(value: unknown): ReviewArtifactType | undefined {
  if (value === undefined) return "other";
  return typeof value === "string" && (REVIEW_ARTIFACT_TYPES as readonly string[]).includes(value)
    ? value as ReviewArtifactType
    : undefined;
}

function reviewLens(value: unknown): ReviewLens | undefined {
  return isReviewLens(value) ? value : undefined;
}

export const REVIEWER_TOOL: ToolDefinition<typeof ReviewerParams, ScoutDetails> = {
  name: "reviewer",
  label: "Reviewer",
  description:
    "Adversarial artifact review scout. Use after a concrete artifact exists — diff, plan, design sketch, file/module, or session brief — to judge it through one isolated reviewer lens. For multi-lens reviews, call reviewer multiple times in the same assistant turn, one call per lens. Use finder for locating code and oracle for understanding code before judging it.",
  promptGuidelines: [
    `The reviewer tool runs exactly one lens per call. For multiple independent lenses, emit one reviewer tool call per lens with lens set to one of: ${REVIEW_LENSES.join(", ")}. Do not pass arrays of lenses.`,
  ],
  parameters: ReviewerParams,

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const error = validateQuery(params);
    if (error) return error;

    const finishTracking = trackScoutToolCall(toolCallId);
    try {
      const values = params as Record<string, unknown>;
      const query = String(values.query ?? "").trim();
      const lens = reviewLens(values.lens);
      if (!lens) {
        return makeErrorResult(`Unsupported reviewer lens: ${String(values.lens)}. Supported lenses: ${REVIEW_LENSES.join(", ")}.`, query);
      }
      const artifactType = reviewArtifactType(values.artifactType);
      if (!artifactType) {
        return makeErrorResult(`Unsupported reviewer artifactType: ${String(values.artifactType)}. Supported artifact types: ${REVIEW_ARTIFACT_TYPES.join(", ")}.`, query);
      }

      const review = await runReviewLens({
        ctx,
        signal,
        lens,
        query,
        artifact: typeof values.artifact === "string" ? values.artifact.trim() : "",
        artifactType,
        context: reviewContext(values.context),
        mode: reviewMode(values.mode),
        contextText: typeof values.contextText === "string" ? values.contextText.trim() : "",
        repoConfig: typeof values.repoConfig === "string" ? values.repoConfig.trim() : "",
        model: values.model,
        onUpdate: (update) => onUpdate?.({ content: update.content, details: update.details }),
      });

      return {
        content: [{ type: "text", text: review.output }],
        details: review.result.details,
        isError: review.result.isError,
      };
    } finally {
      finishTracking();
    }
  },

  renderCall(args, theme, context) {
    const titleSuffix = reviewLens((args as Record<string, unknown>).lens);
    return new ScoutCall("reviewer", { theme, executionStarted: context.executionStarted, titleSuffix });
  },

  renderResult(result, options, theme, context) {
    const titleSuffix = reviewLens((context.args as Record<string, unknown>).lens);
    const component = context.lastComponent instanceof ScoutResult
      ? context.lastComponent
      : new ScoutResult(result, options, theme, "reviewer", titleSuffix);
    component.update(result, options, theme, context.invalidate);
    return component;
  },
};
