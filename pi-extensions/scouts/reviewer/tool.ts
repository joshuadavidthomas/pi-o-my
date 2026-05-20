import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { executeScout } from "../execute.ts";
import { ScoutCall, ScoutResult } from "../render.ts";
import { trackScoutToolCall } from "../state.ts";
import { buildSpecialistConfig, type SpecialistTool } from "../specialist/config.ts";
import type { ScoutDetails } from "../types.ts";
import { ModelParam, makeErrorResult, validateQuery } from "../validate.ts";

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
        description: "Review lenses to apply. Defaults to [\"hickey\", \"lowy\"]. Only hickey and lowy currently dispatch to dedicated skills; other lenses are ignored by this scout.",
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

function requestedLenses(params: Record<string, unknown>): Array<"hickey" | "lowy"> {
  const raw = Array.isArray(params.lenses) ? params.lenses : [];
  const lenses = raw.filter((lens): lens is "hickey" | "lowy" => lens === "hickey" || lens === "lowy");
  return lenses.length > 0 ? [...new Set(lenses)] : ["hickey", "lowy"];
}

function taskFor(lens: "hickey" | "lowy", params: Record<string, unknown>): string {
  const query = String(params.query ?? "").trim();
  const artifact = typeof params.artifact === "string" ? params.artifact.trim() : "";
  const artifactType = String(params.artifactType ?? "unspecified").trim();
  const mode = String(params.mode ?? "notes").trim();
  const context = String(params.context ?? "brief").trim();
  const contextText = typeof params.contextText === "string" ? params.contextText.trim() : "";
  const repoConfig = typeof params.repoConfig === "string" ? params.repoConfig.trim() : "";
  const disposition = mode === "strict"
    ? "Use strict disposition: every real finding must be Fix in this PR / Fix now or No-op. No defer."
    : "Use notes disposition: separate must-fix findings from advisory notes.";

  return [
    query,
    "",
    `Artifact type: ${artifactType}`,
    `Context mode: ${context}`,
    disposition,
    contextText ? `\nContext:\n${contextText}` : "",
    repoConfig ? `\nRepo-specific review config:\n${repoConfig}` : "",
    artifact ? `\nArtifact:\n${artifact}` : "",
  ].join("\n");
}

function resultText(result: Awaited<ReturnType<typeof executeScout>>): string {
  return result.content?.find((item) => item.type === "text")?.text ?? "(no review output)";
}

async function buildConfig(lens: "hickey" | "lowy", cwd: string, model?: unknown) {
  const config = await buildSpecialistConfig(lens, cwd, {
    configName: `reviewer:${lens}`,
    tools: ["read", "bash"] satisfies SpecialistTool[],
  });
  if ("error" in config) return config;
  if (typeof model === "string" && model.trim()) {
    return { ...config, configuredModel: model.trim(), workload: undefined };
  }
  return config;
}

export const REVIEWER_TOOL: ToolDefinition<typeof ReviewerParams, ScoutDetails> = {
  name: "reviewer",
  label: "Reviewer",
  description:
    "Adversarial artifact review scout. Use after a concrete artifact exists — diff, plan, design sketch, file/module, or session brief — to judge it through isolated Hickey and Lowy skill passes. Reviewer is for judging artifacts; use finder for locating code and oracle for understanding code before judging it.",
  parameters: ReviewerParams,

  async execute(toolCallId, params, signal, _onUpdate, ctx) {
    const error = validateQuery(params);
    if (error) return error;

    const finishTracking = trackScoutToolCall(toolCallId);
    try {
      const outputs = [] as string[];
      let details: ScoutDetails | undefined;

      for (const lens of requestedLenses(params as Record<string, unknown>)) {
        const config = await buildConfig(lens, ctx.cwd, (params as Record<string, unknown>).model);
        if ("error" in config) return makeErrorResult(config.error, String((params as Record<string, unknown>).query ?? ""));

        const result = await executeScout(
          config,
          { task: taskFor(lens, params as Record<string, unknown>) },
          signal,
          undefined,
          ctx,
        );
        details ??= result.details;
        outputs.push(`# ${lens}\n\n${resultText(result)}`);
      }

      return {
        content: [{ type: "text", text: outputs.join("\n\n") }],
        details: details!,
        isError: false,
      };
    } finally {
      finishTracking();
    }
  },

  renderCall(_args, theme, context) {
    return new ScoutCall("reviewer", { theme, executionStarted: context.executionStarted });
  },

  renderResult(result, options, theme, context) {
    const component = context.lastComponent instanceof ScoutResult
      ? context.lastComponent
      : new ScoutResult(result, options, theme, "reviewer");
    component.update(result, options, theme, context.invalidate);
    return component;
  },
};
