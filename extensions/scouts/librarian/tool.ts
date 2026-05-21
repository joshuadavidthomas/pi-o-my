import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { executeScout } from "../execute.ts";
import { ScoutCall, ScoutResult } from "../render.ts";
import { trackScoutToolCall } from "../state.ts";
import type { ScoutDetails } from "../types.ts";
import { validateQuery } from "../validate.ts";
import { LIBRARIAN_CONFIG, LibrarianParams } from "./config.ts";

export const LIBRARIAN_TOOL: ToolDefinition<typeof LibrarianParams, ScoutDetails> = {
  name: "librarian",
  label: "Librarian",
  description:
    "External research scout for coding and personal-assistant tasks. Use when the answer lives outside the local workspace — in GitHub repos, web documentation, or both. Librarian can search GitHub code, read repo files, search the web, and fetch page content. Use for API research, finding implementations in other repos, reading docs, or any question requiring external sources. Pass a complete research brief in `query`, not just search keywords: include the question, context, constraints, known sources, and desired evidence/final answer. Usually omit the optional `model` parameter unless the user explicitly asked for a specific model/provider.",
  parameters: LibrarianParams,

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const error = validateQuery(params);
    if (error) return error;
    const finishTracking = trackScoutToolCall(toolCallId);
    try {
      return await executeScout(LIBRARIAN_CONFIG, params as Record<string, unknown>, signal, onUpdate, ctx);
    } finally {
      finishTracking();
    }
  },

  renderCall(_args, theme, context) {
    return new ScoutCall("librarian", { theme, executionStarted: context.executionStarted });
  },

  renderResult(result, options, theme, context) {
    const component = context.lastComponent instanceof ScoutResult
      ? context.lastComponent
      : new ScoutResult(result, options, theme, "librarian");
    component.update(result, options, theme, context.invalidate);
    return component;
  },
};
