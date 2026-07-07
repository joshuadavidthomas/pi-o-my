import { getMarkdownTheme, type ExtensionCommandContext, type MessageRenderOptions, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Key, Markdown, matchesKey, Spacer, type Component } from "@earendil-works/pi-tui";

import { ScoutResult } from "../render.ts";
import type { ScoutDetails } from "../types.ts";
import type { ReviewLens } from "./config.ts";
import type { ReviewScoutResult } from "./run.ts";

export type ReviewLensResult = {
  lens: ReviewLens;
  result: ReviewScoutResult;
};

export type ReviewMessageDetails = {
  cwd: string;
  results: ReviewLensResult[];
};

export type ScoutRenderResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ScoutDetails;
  isError: boolean;
};

function renderOptions(expanded: boolean, isPartial: boolean): ToolRenderResultOptions {
  return { expanded, isPartial };
}

class ReviewScoutResultComponent implements Component {
  private readonly component: ScoutResult;

  constructor(
    private readonly lens: ReviewLens,
    result: ScoutRenderResult,
    expanded: boolean,
    theme: Theme,
  ) {
    this.component = new ScoutResult(result, renderOptions(expanded, result.details.status === "running"), theme, "reviewer", lens);
  }

  update(result: ScoutRenderResult, expanded: boolean, theme: Theme): void {
    this.component.update(result, renderOptions(expanded, result.details.status === "running"), theme, () => this.invalidate());
  }

  invalidate(): void {
    this.component.invalidate();
  }

  render(width: number): string[] {
    return this.component.render(width);
  }
}

export class LiveReviewWidget extends Container {
  private readonly tools = new Map<ReviewLens, ReviewScoutResultComponent>();

  update(results: ReviewLensResult[], expanded: boolean, theme: Theme): void {
    const nextLenses = new Set<ReviewLens>();
    this.clear();

    for (let index = 0; index < results.length; index += 1) {
      const item = results[index]!;
      nextLenses.add(item.lens);

      let component = this.tools.get(item.lens);
      if (!component) {
        component = new ReviewScoutResultComponent(item.lens, item.result, expanded, theme);
        this.tools.set(item.lens, component);
      } else {
        component.update(item.result, expanded, theme);
      }

      if (index > 0) this.addChild(new Spacer(1));
      this.addChild(component);
    }

    for (const lens of [...this.tools.keys()]) {
      if (!nextLenses.has(lens)) this.tools.delete(lens);
    }
  }
}

export function setLiveReviewWidget(
  ctx: ExtensionCommandContext,
  results: ReviewLensResult[],
  expanded: boolean,
  liveWidgetRef: { current?: LiveReviewWidget },
): void {
  if (!ctx.hasUI) return;

  ctx.ui.setWidget("review", (_tui, theme) => {
    liveWidgetRef.current ??= new LiveReviewWidget();
    liveWidgetRef.current.update(results, expanded, theme);
    return liveWidgetRef.current;
  });
}

export function clearLiveReviewWidget(ctx: ExtensionCommandContext): void {
  if (ctx.hasUI) ctx.ui.setWidget("review", undefined);
}

export function installReviewInputHandler(
  ctx: ExtensionCommandContext,
  controller: AbortController,
  onToggleExpanded: () => void,
): () => void {
  if (!ctx.hasUI) return () => {};

  return ctx.ui.onTerminalInput((data) => {
    if (matchesKey(data, Key.ctrl("o"))) {
      onToggleExpanded();
      return { consume: true };
    }

    if (!matchesKey(data, Key.escape) && !matchesKey(data, Key.ctrl("c"))) return undefined;
    if (!controller.signal.aborted) {
      controller.abort();
      ctx.ui.notify("Review cancelled", "warning");
    }
    return { consume: true };
  });
}

export class ReviewResultComponent extends Container {
  constructor(details: ReviewMessageDetails | undefined, content: string, options: MessageRenderOptions, theme: Theme) {
    super();

    if (!details?.results?.length) {
      this.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
      return;
    }

    for (let index = 0; index < details.results.length; index += 1) {
      const item = details.results[index]!;
      if (index > 0) this.addChild(new Spacer(1));
      this.addChild(new ScoutResult(item.result, renderOptions(options.expanded, false), theme, "reviewer", item.lens));
    }
  }
}
