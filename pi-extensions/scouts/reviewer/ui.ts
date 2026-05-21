import { getMarkdownTheme, ToolExecutionComponent, type ExtensionCommandContext, type MessageRenderOptions, type Theme } from "@mariozechner/pi-coding-agent";
import { Container, Key, Markdown, matchesKey, Spacer, TUI, type Component, type Terminal } from "@mariozechner/pi-tui";

import type { ScoutDetails } from "../types.ts";
import type { ReviewLens } from "./config.ts";
import type { ReviewScoutResult } from "./run.ts";
import { REVIEWER_TOOL } from "./tool.ts";

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

const stubTerminal: Terminal = {
  start() {},
  stop() {},
  async drainInput() {},
  write() {},
  get columns() {
    return process.stdout.columns ?? 120;
  },
  get rows() {
    return process.stdout.rows ?? 40;
  },
  get kittyProtocolActive() {
    return false;
  },
  moveBy() {},
  hideCursor() {},
  showCursor() {},
  clearLine() {},
  clearFromCursor() {},
  clearScreen() {},
  setTitle() {},
  setProgress() {},
};
const stubTui = new TUI(stubTerminal);

class StripLeadingSpacer implements Component {
  constructor(private readonly inner: Component) {}

  invalidate(): void {
    this.inner.invalidate();
  }

  render(width: number): string[] {
    const lines = this.inner.render(width);
    return lines[0] === "" ? lines.slice(1) : lines;
  }
}

function reviewerToolArgs(lens: ReviewLens, result: ScoutRenderResult): Record<string, unknown> {
  const run = result.details.runs[0];
  return {
    query: run?.query ?? `Review with the ${lens} lens`,
    lens,
  };
}

function updateReviewerToolComponent(
  component: ToolExecutionComponent,
  lens: ReviewLens,
  result: ScoutRenderResult,
  expanded: boolean,
): void {
  component.updateArgs(reviewerToolArgs(lens, result));
  component.setExpanded(expanded);
  component.updateResult(
    {
      content: result.content,
      details: result.details,
      isError: result.isError,
    },
    result.details.status === "running",
  );
}

function createReviewerToolComponent(
  lens: ReviewLens,
  result: ScoutRenderResult,
  tui: TUI,
  cwd: string,
  expanded: boolean,
): ToolExecutionComponent {
  const component = new ToolExecutionComponent(
    "reviewer",
    `review-${lens}`,
    reviewerToolArgs(lens, result),
    { showImages: false },
    REVIEWER_TOOL,
    tui,
    cwd,
  );
  component.markExecutionStarted();
  component.setArgsComplete();
  updateReviewerToolComponent(component, lens, result, expanded);
  return component;
}

function reviewerToolComponent(
  lens: ReviewLens,
  result: ScoutRenderResult,
  tui: TUI,
  cwd: string,
  expanded: boolean,
): Component {
  return new StripLeadingSpacer(createReviewerToolComponent(lens, result, tui, cwd, expanded));
}

class LiveReviewToolComponent extends StripLeadingSpacer {
  private readonly toolComponent: ToolExecutionComponent;

  constructor(
    private readonly lens: ReviewLens,
    result: ScoutRenderResult,
    tui: TUI,
    cwd: string,
    expanded: boolean,
  ) {
    const toolComponent = createReviewerToolComponent(lens, result, tui, cwd, expanded);
    super(toolComponent);
    this.toolComponent = toolComponent;
  }

  update(result: ScoutRenderResult, expanded: boolean): void {
    updateReviewerToolComponent(this.toolComponent, this.lens, result, expanded);
  }
}

export class LiveReviewWidget extends Container {
  private readonly tools = new Map<ReviewLens, LiveReviewToolComponent>();

  update(results: ReviewLensResult[], expanded: boolean, tui: TUI, cwd: string): void {
    const nextLenses = new Set<ReviewLens>();
    this.clear();

    for (let index = 0; index < results.length; index += 1) {
      const item = results[index]!;
      nextLenses.add(item.lens);

      let component = this.tools.get(item.lens);
      if (!component) {
        component = new LiveReviewToolComponent(item.lens, item.result, tui, cwd, expanded);
        this.tools.set(item.lens, component);
      } else {
        component.update(item.result, expanded);
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

  ctx.ui.setWidget("review", (tui) => {
    liveWidgetRef.current ??= new LiveReviewWidget();
    liveWidgetRef.current.update(results, expanded, tui, ctx.cwd);
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
  constructor(details: ReviewMessageDetails | undefined, content: string, options: MessageRenderOptions, _theme: Theme) {
    super();

    if (!details?.results?.length) {
      this.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
      return;
    }

    for (let index = 0; index < details.results.length; index += 1) {
      const item = details.results[index]!;
      if (index > 0) this.addChild(new Spacer(1));
      const component = reviewerToolComponent(item.lens, item.result, stubTui, details.cwd, options.expanded);
      this.addChild(component);
    }
  }
}
