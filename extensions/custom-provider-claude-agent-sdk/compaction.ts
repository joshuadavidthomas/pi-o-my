/**
 * Safe summarization for Claude Agent SDK sessions.
 *
 * Pi normally summarizes with the session model. For SDK models, that sends
 * subscription traffic containing old assistant output and asks Claude to
 * summarize it. Anthropic blocks that request as possible output duplication.
 * Route compaction and tree summaries to an authenticated non-Claude model.
 */

import type { Model } from "@earendil-works/pi-ai";
import {
  compact,
  generateBranchSummary,
  type ExtensionAPI,
  type ExtensionContext,
  type GenerateBranchSummaryOptions,
} from "@earendil-works/pi-coding-agent";
import { debug } from "./sdk/debug.js";

// Tried in order; first with a registered model, resolvable auth, and a
// context window that fits the session wins. opencode's gpt-5.6-terra
// covers [1m] sessions that outgrow the direct providers' shorter windows.
const SUMMARIZER_CANDIDATES = [
  { provider: "openai-codex", id: "gpt-5.6-terra" },
  { provider: "openai", id: "gpt-5.6-terra" },
  { provider: "opencode", id: "gpt-5.6-terra" },
] as const;

const SUMMARIZER_THINKING_LEVEL = "low";

interface ResolvedSummarizer {
  model: Model<any>;
  apiKey: string;
  headers: Record<string, string> | undefined;
}

async function selectSummarizer(
  modelRegistry: ExtensionContext["modelRegistry"],
  tokensBefore?: number,
): Promise<ResolvedSummarizer | undefined> {
  for (const candidate of SUMMARIZER_CANDIDATES) {
    const model = modelRegistry.find(candidate.provider, candidate.id);
    if (!model) continue;
    // tokensBefore overestimates summarizer input (kept-recent messages are
    // excluded from the summarization request), so this check is conservative.
    if (tokensBefore !== undefined && model.contextWindow > 0 && tokensBefore >= model.contextWindow) {
      debug("compaction:candidate-too-small", { model: candidate.id, tokensBefore, contextWindow: model.contextWindow });
      continue;
    }
    let auth: Awaited<ReturnType<typeof modelRegistry.getApiKeyAndHeaders>>;
    try {
      auth = await modelRegistry.getApiKeyAndHeaders(model);
    } catch (error) {
      debug("compaction:candidate-auth-failed", {
        model: candidate.id,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!auth.ok || !auth.apiKey) {
      debug("compaction:candidate-no-auth", { model: candidate.id });
      continue;
    }
    return { model, apiKey: auth.apiKey, headers: auth.headers };
  }
  return undefined;
}

export function registerSummarization(pi: ExtensionAPI, providerId: string) {
  pi.on("session_before_compact", async (event, ctx) => {
    if (ctx.model?.provider !== providerId) return;

    const summarizer = await selectSummarizer(ctx.modelRegistry, event.preparation.tokensBefore);
    if (!summarizer) {
      debug("compaction:no-summarizer-available", { tokensBefore: event.preparation.tokensBefore });
      ctx.ui.notify(
        "Compaction was cancelled because no safe summary model is available. Configure an authenticated GPT-5.6 Terra model, then try again.",
        "error",
      );
      return { cancel: true };
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
      ctx.ui.notify(
        "The safe summary model could not compact this session. Compaction was cancelled. Try again before continuing.",
        "error",
      );
      return { cancel: true };
    }
  });

  pi.on("session_before_tree", async (event, ctx) => {
    if (ctx.model?.provider !== providerId) return;
    if (!event.preparation.userWantsSummary || event.preparation.entriesToSummarize.length === 0) return;

    try {
      const summarizer = await selectSummarizer(ctx.modelRegistry);
      if (!summarizer) {
        debug("tree-summary:no-summarizer-available", {});
        ctx.ui.notify(
          "No safe branch-summary model is available. Tree navigation was cancelled. Retry without a summary.",
          "error",
        );
        return { cancel: true };
      }

      debug("tree-summary:custom-summarizer", {
        model: `${summarizer.model.provider}/${summarizer.model.id}`,
        entryCount: event.preparation.entriesToSummarize.length,
      });

      const options: GenerateBranchSummaryOptions = {
        model: summarizer.model,
        apiKey: summarizer.apiKey,
        signal: event.signal,
      };
      if (summarizer.headers !== undefined) options.headers = summarizer.headers;
      if (event.preparation.customInstructions !== undefined) {
        options.customInstructions = event.preparation.customInstructions;
      }
      if (event.preparation.replaceInstructions !== undefined) {
        options.replaceInstructions = event.preparation.replaceInstructions;
      }
      const result = await generateBranchSummary(event.preparation.entriesToSummarize, options);
      if (result.aborted) return { cancel: true };
      if (result.error || !result.summary) {
        throw new Error(result.error ?? "Branch summarizer returned no summary");
      }

      return {
        summary: {
          summary: result.summary,
          details: {
            readFiles: result.readFiles ?? [],
            modifiedFiles: result.modifiedFiles ?? [],
          },
        },
      };
    } catch (error) {
      debug("tree-summary:custom-summarizer-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      ctx.ui.notify(
        "The safe branch-summary model could not summarize this branch. Tree navigation was cancelled. Retry without a summary.",
        "error",
      );
      return { cancel: true };
    }
  });
}
