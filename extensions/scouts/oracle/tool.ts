import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { executeScout } from "../execute.ts";
import { ScoutCall, ScoutResult } from "../render.ts";
import { trackScoutToolCall } from "../state.ts";
import type { ScoutDetails } from "../types.ts";
import { validateQuery } from "../validate.ts";
import { buildOracleConfig, OracleParams } from "./config.ts";

export const ORACLE_TOOL: ToolDefinition<typeof OracleParams, ScoutDetails> = {
  name: "oracle",
  label: "Oracle",
  description:
    "Deep code analysis scout. Use when you need to understand HOW code works — trace data flow, analyze architecture, find patterns, or get implementation details with precise file:line references. Oracle reads code deeply and reasons about it. For finding WHERE code is, use finder instead. Read-only and safe to run in parallel — when investigations are independent, issue multiple scout calls in the same assistant turn.",
  parameters: OracleParams,

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const error = validateQuery(params);
    if (error) return error;
    const config = buildOracleConfig();
    const finishTracking = trackScoutToolCall(toolCallId);
    try {
      return await executeScout(config, params as Record<string, unknown>, signal, onUpdate, ctx);
    } finally {
      finishTracking();
    }
  },

  renderCall(_args, theme, context) {
    return new ScoutCall("oracle", { theme, executionStarted: context.executionStarted });
  },

  renderResult(result, options, theme, context) {
    const component = context.lastComponent instanceof ScoutResult
      ? context.lastComponent
      : new ScoutResult(result, options, theme, "oracle");
    component.update(result, options, theme, context.invalidate);
    return component;
  },
};
