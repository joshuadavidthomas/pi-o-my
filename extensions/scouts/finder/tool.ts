import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { executeScout } from "../execute.ts";
import { ScoutCall, ScoutResult } from "../render.ts";
import { trackScoutToolCall } from "../state.ts";
import type { ScoutDetails } from "../types.ts";
import { validateQuery } from "../validate.ts";
import { FINDER_CONFIG, FinderParams } from "./config.ts";

export const FINDER_TOOL: ToolDefinition<typeof FinderParams, ScoutDetails> = {
  name: "finder",
  label: "Finder",
  description:
    "Read-only workspace scout for coding and personal-assistant tasks. Use when exact file/folder locations are unknown, you'd otherwise do exploratory ls/rg/fd/find/grep/read, or you need targeted evidence from large directories. Finder handles the reconnaissance and returns concise, relevant output: Summary, Locations (path:lineStart-lineEnd), Evidence, and Searched. Read-only and safe to run in parallel — when investigations are independent, issue multiple scout calls in the same assistant turn.",
  parameters: FinderParams,

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const error = validateQuery(params);
    if (error) return error;
    const finishTracking = trackScoutToolCall(toolCallId);
    try {
      return await executeScout(FINDER_CONFIG, params as Record<string, unknown>, signal, onUpdate, ctx);
    } finally {
      finishTracking();
    }
  },

  renderCall(_args, theme, context) {
    return new ScoutCall("finder", { theme, executionStarted: context.executionStarted });
  },

  renderResult(result, options, theme, context) {
    const component = context.lastComponent instanceof ScoutResult
      ? context.lastComponent
      : new ScoutResult(result, options, theme, "finder");
    component.update(result, options, theme, context.invalidate);
    return component;
  },
};
