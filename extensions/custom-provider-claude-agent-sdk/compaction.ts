/**
 * Custom compaction for Claude Agent SDK sessions.
 *
 * The built-in compactor summarizes with the session model. For SDK models
 * that means subscription/OAuth traffic carrying a "summarize this transcript
 * of an AI assistant" request, which trips Anthropic's anti-distillation
 * classifier ("reverse engineering or duplicating model outputs") on newer
 * models. Route summarization to an API-key model instead, reusing pi's
 * built-in compaction pipeline (split turns, previous-summary merging).
 */

import type { Model } from "@earendil-works/pi-ai";
import { compact, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { debug } from "./sdk/debug.js";

// Tried in order; first with a registered model, resolvable auth, and a
// context window that fits the session wins. opencode's gpt-5.5 (1.05M)
// covers [1m] sessions that outgrow the 272k windows.
const SUMMARIZER_CANDIDATES = [
  { provider: "openai-codex", id: "gpt-5.5" },
  { provider: "openai", id: "gpt-5.5" },
  { provider: "opencode", id: "gpt-5.5" },
] as const;

const SUMMARIZER_THINKING_LEVEL = "low";

interface ResolvedSummarizer {
  model: Model<any>;
  apiKey: string | undefined;
  headers: Record<string, string> | undefined;
}

async function selectSummarizer(
  modelRegistry: ExtensionContext["modelRegistry"],
  tokensBefore: number,
): Promise<ResolvedSummarizer | undefined> {
  for (const candidate of SUMMARIZER_CANDIDATES) {
    const model = modelRegistry.find(candidate.provider, candidate.id);
    if (!model) continue;
    // tokensBefore overestimates summarizer input (kept-recent messages are
    // excluded from the summarization request), so this check is conservative.
    if (model.contextWindow > 0 && tokensBefore >= model.contextWindow) {
      debug("compaction:candidate-too-small", { model: candidate.id, tokensBefore, contextWindow: model.contextWindow });
      continue;
    }
    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      debug("compaction:candidate-no-auth", { model: candidate.id });
      continue;
    }
    return { model, apiKey: auth.apiKey, headers: auth.headers };
  }
  return undefined;
}

export function registerCompaction(pi: ExtensionAPI, providerId: string) {
  pi.on("session_before_compact", async (event, ctx) => {
    if (ctx.model?.provider !== providerId) return;

    const summarizer = await selectSummarizer(ctx.modelRegistry, event.preparation.tokensBefore);
    if (!summarizer) {
      debug("compaction:no-summarizer-available", { tokensBefore: event.preparation.tokensBefore });
      return;
    }

    debug("compaction:custom-summarizer", {
      model: `${summarizer.model.provider}/${summarizer.model.id}`,
      tokensBefore: event.preparation.tokensBefore,
      isSplitTurn: event.preparation.isSplitTurn,
      hasPreviousSummary: Boolean(event.preparation.previousSummary),
    });

    try {
      const compaction = await compact(
        event.preparation,
        summarizer.model,
        summarizer.apiKey,
        summarizer.headers,
        event.customInstructions,
        event.signal,
        SUMMARIZER_THINKING_LEVEL,
      );
      return { compaction };
    } catch (error) {
      debug("compaction:custom-summarizer-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      // Fall through to built-in compaction on the session model.
      return;
    }
  });
}
