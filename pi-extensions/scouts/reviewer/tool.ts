import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

import { executeScout } from "../execute.ts";
import { ScoutCall, ScoutResult } from "../render.ts";
import { trackScoutToolCall } from "../state.ts";
import type { ScoutDetails } from "../types.ts";
import { validateQuery } from "../validate.ts";
import { buildReviewerConfig, ReviewerParams } from "./config.ts";

export const REVIEWER_TOOL: ToolDefinition<typeof ReviewerParams, ScoutDetails> = {
  name: "reviewer",
  label: "Reviewer",
  description:
    "Adversarial artifact review scout. Use after a concrete artifact exists — diff, plan, design sketch, file/module, or session brief — to judge it through review lenses such as Hickey structural simplicity and Lowy volatility-based decomposition. Reviewer is isolated from the main session, requires evidence for findings, and returns actions. For locating code use finder; for understanding how code works before judging it use oracle. Usually omit the optional `model` parameter unless the user explicitly asked for a specific model/provider.",
  parameters: ReviewerParams,

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const error = validateQuery(params);
    if (error) return error;
    const config = buildReviewerConfig();
    const finishTracking = trackScoutToolCall(toolCallId);
    try {
      return await executeScout(config, params as Record<string, unknown>, signal, onUpdate, ctx);
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
