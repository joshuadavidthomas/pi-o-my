import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { REVIEW_SUBCOMMANDS, helpText, invalidInvocationText, isReviewSubcommand, parseArgs, type ParsedArgs } from "./args.ts";
import { artifactTypeFor, collectArtifact, defaultContextFor, optionalRepoConfig } from "./artifacts.ts";
import type { ReviewLens } from "./config.ts";
import { followupPrompt } from "./followup.ts";
import { runReview, selectReviewLenses, type ReviewMode } from "./run.ts";
import { clearLiveReviewWidget, installReviewInputHandler, setLiveReviewWidget, ReviewResultComponent, type LiveReviewWidget, type ReviewLensResult, type ReviewMessageDetails, type ScoutRenderResult } from "./ui.ts";

function abortSignalAny(signals: Array<AbortSignal | undefined>): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const abort = () => controller.abort();

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const signal of activeSignals) {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}

export function registerReviewCommand(pi: ExtensionAPI) {
  pi.registerMessageRenderer<ReviewMessageDetails>("review-result", (message, options, theme) => {
    return new ReviewResultComponent(message.details, String(message.content ?? ""), options, theme);
  });

  pi.registerCommand("review", {
    description: "Gather an artifact and run the hickey/lowy/grug reviewer lenses in isolated scouts",
    getArgumentCompletions: (prefix) => {
      const items = [...REVIEW_SUBCOMMANDS, "help"];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      let parsed: ParsedArgs;
      try {
        parsed = parseArgs(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      if (parsed.subcommand === "help") {
        ctx.ui.notify(helpText(), "info");
        return;
      }

      if (!isReviewSubcommand(parsed.subcommand)) {
        ctx.ui.notify(invalidInvocationText(ctx.cwd, parsed), "error");
        return;
      }

      const reviewAbortController = new AbortController();
      const { signal: reviewSignal, cleanup: cleanupReviewSignal } = abortSignalAny([ctx.signal, reviewAbortController.signal]);
      let liveExpanded = false;
      let republishLiveResults = () => {};
      const uninstallInputHandler = installReviewInputHandler(ctx, reviewAbortController, () => {
        liveExpanded = !liveExpanded;
        republishLiveResults();
      });

      try {
        const { subject, subjectLabel } = await collectArtifact(ctx.cwd, parsed);
        if (!subject.trim()) {
          ctx.ui.notify(`No content found for ${subjectLabel}.`, "warning");
          return;
        }

        const mode: ReviewMode = parsed.strict ? "strict" : "notes";
        const context = parsed.context ?? defaultContextFor(parsed.subcommand);
        const repoConfig = await optionalRepoConfig(ctx.cwd);
        const lenses = selectReviewLenses(parsed.lens);

        const liveResults = new Map<ReviewLens, ScoutRenderResult>();
        const liveWidgetRef: { current?: LiveReviewWidget } = {};
        const publishLiveResults = () => {
          setLiveReviewWidget(ctx, lenses
            .map((lens) => {
              const result = liveResults.get(lens);
              return result ? { lens, result } : undefined;
            })
            .filter((item): item is ReviewLensResult => item !== undefined), liveExpanded, liveWidgetRef);
        };
        republishLiveResults = publishLiveResults;

        const review = await runReview({
          ctx,
          signal: reviewSignal,
          lenses,
          query: `Review ${subjectLabel}.`,
          artifactSource: `/review ${parsed.subcommand}`,
          artifactType: artifactTypeFor(parsed.subcommand),
          context,
          mode,
          repoConfig,
          artifact: subject,
          onUpdate: (lens, update) => {
            liveResults.set(lens, {
              content: update.content,
              details: update.details,
              isError: update.details.status === "error",
            });
            publishLiveResults();
          },
        });

        liveWidgetRef.current = undefined;
        clearLiveReviewWidget(ctx);
        for (const execution of review.executions) {
          const output = `# ${execution.lens}\n\n${execution.output}`;
          pi.sendMessage({
            customType: "review-result",
            content: output,
            display: true,
            details: { cwd: ctx.cwd, results: [{ lens: execution.lens, result: execution.result }] } satisfies ReviewMessageDetails,
          });
        }

        const prompt = reviewSignal.aborted ? undefined : followupPrompt(parsed, lenses, subjectLabel, review.hasText);
        if (prompt) {
          pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        cleanupReviewSignal();
        uninstallInputHandler();
        clearLiveReviewWidget(ctx);
      }
    },
  });
}
