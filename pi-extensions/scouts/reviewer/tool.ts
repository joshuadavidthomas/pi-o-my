import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { ScoutCall, ScoutResult } from "../render.ts";
import { trackScoutToolCall } from "../state.ts";
import type { ScoutDetails } from "../types.ts";
import { ModelParam, validateQuery } from "../validate.ts";
import { normalizeReviewLenses, runReview, type ReviewContext, type ReviewMode } from "./run.ts";

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
      Type.String({ enum: ["hickey", "lowy", "grug", "correctness", "security", "testing", "ux", "maintainability"] }),
      {
        description: "Review lenses to apply. Defaults to [\"hickey\", \"lowy\", \"grug\"]. Hickey, Lowy, and Grug dispatch to reviewer-local lens prompts; other lenses are ignored by this scout.",
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

function reviewMode(value: unknown): ReviewMode {
  return value === "strict" ? "strict" : "notes";
}

function reviewContext(value: unknown): ReviewContext {
  return value === "none" || value === "brief" || value === "transcript" ? value : "brief";
}

export const REVIEWER_TOOL: ToolDefinition<typeof ReviewerParams, ScoutDetails> = {
  name: "reviewer",
  label: "Reviewer",
  description:
    "Adversarial artifact review scout. Use after a concrete artifact exists — diff, plan, design sketch, file/module, or session brief — to judge it through isolated Hickey, Lowy, and Grug lens passes. Reviewer is for judging artifacts; use finder for locating code and oracle for understanding code before judging it.",
  parameters: ReviewerParams,

  async execute(toolCallId, params, signal, _onUpdate, ctx) {
    const error = validateQuery(params);
    if (error) return error;

    const finishTracking = trackScoutToolCall(toolCallId);
    try {
      const values = params as Record<string, unknown>;
      const review = await runReview({
        ctx,
        signal,
        lenses: normalizeReviewLenses(values.lenses),
        query: String(values.query ?? "").trim(),
        artifact: typeof values.artifact === "string" ? values.artifact.trim() : "",
        artifactType: String(values.artifactType ?? "unspecified").trim(),
        context: reviewContext(values.context),
        mode: reviewMode(values.mode),
        contextText: typeof values.contextText === "string" ? values.contextText.trim() : "",
        repoConfig: typeof values.repoConfig === "string" ? values.repoConfig.trim() : "",
        model: values.model,
      });

      return {
        content: [{ type: "text", text: review.output }],
        details: review.details,
        isError: review.isError,
      };
    } finally {
      finishTracking();
    }
  },

  renderCall(args, theme, context) {
    const lenses = Array.isArray((args as Record<string, unknown>).lenses)
      ? ((args as Record<string, unknown>).lenses as unknown[]).filter((lens): lens is string => typeof lens === "string")
      : [];
    const titleSuffix = lenses.length === 1 ? lenses[0] : undefined;
    return new ScoutCall("reviewer", { theme, executionStarted: context.executionStarted, titleSuffix });
  },

  renderResult(result, options, theme, context) {
    const lenses = Array.isArray((context.args as Record<string, unknown>).lenses)
      ? ((context.args as Record<string, unknown>).lenses as unknown[]).filter((lens): lens is string => typeof lens === "string")
      : [];
    const titleSuffix = lenses.length === 1 ? lenses[0] : undefined;
    const component = context.lastComponent instanceof ScoutResult
      ? context.lastComponent
      : new ScoutResult(result, options, theme, "reviewer", titleSuffix);
    component.update(result, options, theme, context.invalidate);
    return component;
  },
};
