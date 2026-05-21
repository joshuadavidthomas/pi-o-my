import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { executeScout } from "../execute.ts";
import { ScoutCall, ScoutResult } from "../render.ts";
import { computeOverallStatus, trackScoutToolCall } from "../state.ts";
import type { ScoutDetails } from "../types.ts";
import { ModelParam, validateQuery } from "../validate.ts";
import { buildReviewerConfig, type ReviewLens } from "./config.ts";
import { resultText } from "./result.ts";

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
        description: "Review lenses to apply. Defaults to [\"hickey\", \"lowy\", \"grug\"]. Hickey, Lowy, and Grug dispatch to dedicated skills; other lenses are ignored by this scout.",
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

function requestedLenses(params: Record<string, unknown>): ReviewLens[] {
  const raw = Array.isArray(params.lenses) ? params.lenses : [];
  const lenses = raw.filter((lens): lens is ReviewLens => lens === "hickey" || lens === "lowy" || lens === "grug");
  return lenses.length > 0 ? [...new Set(lenses)] : ["hickey", "lowy", "grug"];
}

function taskFor(lens: ReviewLens, params: Record<string, unknown>): string {
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

function buildConfig(lens: ReviewLens, model?: unknown) {
  const config = buildReviewerConfig(lens);
  if (typeof model === "string" && model.trim()) {
    return { ...config, configuredModel: model.trim(), workload: undefined };
  }
  return config;
}

type LensExecution = {
  lens: ReviewLens;
  result: Awaited<ReturnType<typeof executeScout>>;
  output: string;
};

function aggregateReviewerDetails(query: string, executions: LensExecution[]): ScoutDetails {
  const sourceRuns = executions.map((execution) => execution.result.details.runs[0]).filter((run): run is ScoutDetails["runs"][number] => run !== undefined);
  const status = computeOverallStatus(sourceRuns);
  const now = Date.now();
  const startedAt = sourceRuns.length > 0 ? Math.min(...sourceRuns.map((run) => run.startedAt)) : now;
  const endedTimes = sourceRuns.map((run) => run.endedAt).filter((time): time is number => time !== undefined);
  const endedAt = status === "running" || endedTimes.length === 0 ? undefined : Math.max(...endedTimes);
  const provider = sameValue(executions.map((execution) => execution.result.details.subagentProvider));
  const modelId = sameValue(executions.map((execution) => execution.result.details.subagentModelId));
  const summaryText = executions.map((execution) => `# ${execution.lens}\n\n${execution.output}`).join("\n\n");

  return {
    mode: "single",
    status,
    subagentProvider: provider,
    subagentModelId: modelId,
    runs: [{
      status,
      query,
      turns: sourceRuns.reduce((sum, run) => sum + run.turns, 0),
      displayItems: [
        ...executions.map((execution) => ({
          type: "tool" as const,
          name: "reviewer",
          args: {
            query: execution.result.details.runs[0]?.query ?? `${execution.lens} review`,
            lenses: [execution.lens],
          },
          toolCallId: `reviewer-${execution.lens}`,
          result: execution.output,
          isError: execution.result.isError,
          nestedScout: execution.result.details,
        })),
        { type: "text" as const, text: summaryText },
      ],
      summaryText,
      startedAt,
      endedAt,
    }],
  };
}

function sameValue(values: Array<string | undefined>): string | undefined {
  const present = values.filter((value): value is string => value !== undefined);
  if (present.length === 0) return undefined;
  return present.every((value) => value === present[0]) ? present[0] : undefined;
}

export const REVIEWER_TOOL: ToolDefinition<typeof ReviewerParams, ScoutDetails> = {
  name: "reviewer",
  label: "Reviewer",
  description:
    "Adversarial artifact review scout. Use after a concrete artifact exists — diff, plan, design sketch, file/module, or session brief — to judge it through isolated Hickey, Lowy, and Grug skill passes. Reviewer is for judging artifacts; use finder for locating code and oracle for understanding code before judging it.",
  parameters: ReviewerParams,

  async execute(toolCallId, params, signal, _onUpdate, ctx) {
    const error = validateQuery(params);
    if (error) return error;

    const finishTracking = trackScoutToolCall(toolCallId);
    try {
      const executions: LensExecution[] = [];
      const query = String((params as Record<string, unknown>).query ?? "").trim();

      for (const lens of requestedLenses(params as Record<string, unknown>)) {
        const config = buildConfig(lens, (params as Record<string, unknown>).model);

        const result = await executeScout(
          config,
          {
            query: `Reviewer ${lens}: ${query}`,
            task: taskFor(lens, params as Record<string, unknown>),
          },
          signal,
          undefined,
          ctx,
        );
        executions.push({ lens, result, output: resultText(result) });
      }

      const output = executions.map((execution) => `# ${execution.lens}\n\n${execution.output}`).join("\n\n");
      return {
        content: [{ type: "text", text: output }],
        details: aggregateReviewerDetails(query, executions),
        isError: executions.some((execution) => execution.result.isError),
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
