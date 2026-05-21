// TUI rendering for scout tool calls and results.
//
// Uses persistent component trees so scout rows behave more like Pi's built-in
// tool renderers: stable header lines, localized body updates, and reusable
// child components instead of rebuilding cached string arrays on each update.

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getMarkdownTheme, keyHint, type Theme, type ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import { cleanToolResult, formatToolCallParts, shorten } from "./display.ts";
import { hasActiveScoutToolCalls, isParallelScoutMode } from "./state.ts";
import type { DisplayItem, ScoutDetails } from "./types.ts";

type ScoutStatus = ScoutDetails["status"];
type ScoutRunDetails = ScoutDetails["runs"][number];
type ScoutToolResult = AgentToolResult<ScoutDetails>;

const SCOUT_STATUS_ICONS = {
  done: { color: "success", symbol: "✓" },
  error: { color: "error", symbol: "✗" },
  aborted: { color: "warning", symbol: "◼" },
  running: { color: "warning", symbol: "…" },
} as const satisfies Record<ScoutStatus, { color: string; symbol: string }>;

function scoutStatusIcon(theme: Theme, status: ScoutStatus): string {
  const icon = SCOUT_STATUS_ICONS[status];
  return theme.fg(icon.color, icon.symbol);
}

function getResultText(result: { content?: Array<{ type?: string; text?: string }> } | undefined): string {
  const text = result?.content?.find((item) => item?.type === "text" && typeof item.text === "string");
  return text?.text ?? "(no output)";
}

function getScoutDetails(result: ScoutToolResult): ScoutDetails | undefined {
  return result.details;
}

const RUNNING_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const RUNNING_SPINNER_INTERVAL_MS = 80;
const COLLAPSED_SUMMARY_PREVIEW_LINES = 6;
const PARALLEL_COLLAPSED_TOOL_PREVIEW = 3;
const PARALLEL_COLLAPSED_SUMMARY_PREVIEW_LINES = 1;

function getRunningSpinner(theme: Theme, frameIndex = Math.floor(Date.now() / RUNNING_SPINNER_INTERVAL_MS)): string {
  const frame = RUNNING_SPINNER_FRAMES[frameIndex % RUNNING_SPINNER_FRAMES.length] ?? RUNNING_SPINNER_FRAMES[0]!;
  return theme.fg("warning", frame);
}

function truncateVisible(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;

  const ellipsis = "…";
  const textWidth = Math.max(0, maxWidth - visibleWidth(ellipsis));
  let result = "";
  for (const char of text) {
    if (visibleWidth(result + char) > textWidth) break;
    result += char;
  }
  return result + ellipsis;
}

function getRunningStatusLabel(run: ScoutRunDetails, hasToolCalls: boolean): string {
  if (run.activityPhase === "writing_summary") {
    return "writing summary";
  }

  if (run.activityPhase === "calling_tools" || hasToolCalls) {
    return "calling tools";
  }

  return "thinking";
}

class RawText implements Component {
  private text = "";

  setText(text: string): void {
    this.text = text;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.text.trim()) return [];
    return this.text.split("\n").map((line) => visibleWidth(line) > width
      ? truncateToWidth(line, width)
      : line);
  }
}

const runningStatusComponents = new Set<WeakRef<RunningStatusText>>();
let runningStatusTicker: ReturnType<typeof setInterval> | undefined;

function startRunningStatusTicker(): void {
  if (runningStatusTicker) return;

  runningStatusTicker = setInterval(() => {
    let hasActiveComponent = false;
    for (const ref of [...runningStatusComponents]) {
      const component = ref.deref();
      if (!component || !component.isRunning()) {
        runningStatusComponents.delete(ref);
        continue;
      }

      hasActiveComponent = true;
      component.tick();
    }

    if (!hasActiveComponent && runningStatusTicker) {
      clearInterval(runningStatusTicker);
      runningStatusTicker = undefined;
    }
  }, RUNNING_SPINNER_INTERVAL_MS);
}

class RunningStatusText extends Text {
  private theme?: Theme;
  private run?: ScoutRunDetails;
  private hasToolCalls = false;
  private suffix?: string;
  private requestRender?: () => void;
  private tickerRef?: WeakRef<RunningStatusText>;
  private running = false;

  constructor() {
    super("", 0, 0);
  }

  update(run: ScoutRunDetails, hasToolCalls: boolean, theme: Theme, requestRender?: () => void, suffix?: string): void {
    this.run = run;
    this.hasToolCalls = hasToolCalls;
    this.theme = theme;
    this.requestRender = requestRender;
    this.suffix = suffix;
    this.running = true;
    this.updateDisplay();
    this.syncTicker();
  }

  override invalidate(): void {
    super.invalidate();
    this.updateDisplay();
  }

  stop(): void {
    this.running = false;
    this.requestRender = undefined;
    if (this.tickerRef) {
      runningStatusComponents.delete(this.tickerRef);
      this.tickerRef = undefined;
    }
  }

  isRunning(): boolean {
    return this.running && this.requestRender !== undefined;
  }

  tick(): void {
    this.updateDisplay();
    this.requestRender?.();
  }

  private syncTicker(): void {
    if (!this.requestRender) {
      this.stop();
      return;
    }

    if (!this.tickerRef) {
      this.tickerRef = new WeakRef(this);
      runningStatusComponents.add(this.tickerRef);
    }
    startRunningStatusTicker();
  }

  private updateDisplay(): void {
    if (!this.run || !this.theme) return;
    const status = `${getRunningSpinner(this.theme)} ${this.theme.fg("dim", getRunningStatusLabel(this.run, this.hasToolCalls))}`;
    const suffix = this.suffix ? ` ${this.theme.fg("dim", "•")} ${this.suffix}` : "";
    this.setText(`${status}${suffix}`);
  }
}

class ScoutToolRowComponent extends Container {
  private titleText = new Text("", 0, 0);
  private detailText = new RawText();
  private bottomSpacer = new Spacer(1);
  private showingDetails = false;
  private itemIcon = "";
  private label = "";
  private summary = "";
  private theme?: Theme;

  constructor() {
    super();
    this.addChild(this.titleText);
  }

  update(item: Extract<DisplayItem, { type: "tool" }>, showResultDetails: boolean, theme: Theme): void {
    const { label, summary } = formatToolCallParts(item.name, item.args);

    let itemStatus: ScoutStatus = "running";
    if (item.isError) {
      itemStatus = "error";
    } else if (item.result && !item.isPartial) {
      itemStatus = "done";
    }

    this.itemIcon = item.nestedScout ? "" : scoutStatusIcon(theme, itemStatus);
    this.label = item.nestedScout ? "" : label;
    this.summary = item.nestedScout ? "" : summary;
    this.theme = theme;

    const nestedScout = item.nestedScout ? formatNestedScout(item, item.nestedScout, theme) : "";
    const cleaned = showResultDetails && item.result
      ? cleanToolResult(item.result)
      : "";

    if (cleaned || nestedScout) {
      this.detailText.setText([
        nestedScout,
        cleaned ? theme.fg("dim", cleaned) : "",
      ].filter(Boolean).join("\n"));
      if (!this.showingDetails) {
        this.addChild(this.detailText);
        if (!nestedScout) this.addChild(this.bottomSpacer);
        this.showingDetails = true;
      } else if (nestedScout) {
        this.removeChild(this.bottomSpacer);
      } else if (!this.children.includes(this.bottomSpacer)) {
        this.addChild(this.bottomSpacer);
      }
      return;
    }

    if (this.showingDetails) {
      this.removeChild(this.detailText);
      this.removeChild(this.bottomSpacer);
      this.showingDetails = false;
    }
  }

  override render(width: number): string[] {
    if (this.theme) {
      const prefix = this.label ? `${this.itemIcon} ${this.theme.fg("toolTitle", this.label)}` : "";
      const separator = prefix && this.summary ? " " : "";
      const availableSummaryWidth = width - visibleWidth(prefix) - visibleWidth(separator);
      const summary = truncateVisible(this.summary, availableSummaryWidth);
      this.titleText.setText(prefix || summary ? `${prefix}${separator}${this.theme.fg("dim", summary)}` : "");
    }
    return super.render(width);
  }
}

function formatNestedScout(parentTool: Extract<DisplayItem, { type: "tool" }>, details: ScoutDetails, theme: Theme): string {
  const run = details.runs[0];
  if (!run) return "";

  const model = details.subagentProvider && details.subagentModelId
    ? `${details.subagentProvider}/${details.subagentModelId}`
    : "unknown model";
  const status = run.status ?? details.status;
  const { label, summary } = formatToolCallParts(parentTool.name, parentTool.args);
  const lines = [`↳ ${theme.fg("toolTitle", label)} ${theme.fg("dim", model)}`];
  if (summary) lines.push(`  ${theme.fg("dim", truncateVisible(summary, 88))}`);

  const toolStartIndex = lines.length;
  const tools = run.displayItems.filter((item): item is Extract<DisplayItem, { type: "tool" }> => item.type === "tool");
  const visibleTools = tools.slice(-3);
  for (const tool of visibleTools) {
    const { label, summary } = formatToolCallParts(tool.name, tool.args);
    const icon = scoutStatusIcon(theme, tool.isError ? "error" : tool.result && !tool.isPartial ? "done" : "running");
    lines.push(`  ${icon} ${theme.fg("toolTitle", label)}${summary ? ` ${theme.fg("dim", truncateVisible(summary, 72))}` : ""}`);
  }
  if (tools.length > visibleTools.length) {
    lines.splice(toolStartIndex, 0, `  … ${tools.length - visibleTools.length} earlier tool calls`);
  }

  return lines.join("\n");
}

class ScoutToolListComponent extends Container {
  private rows = new Map<string, ScoutToolRowComponent>();

  update(items: Array<Extract<DisplayItem, { type: "tool" }>>, expanded: boolean, theme: Theme): void {
    const nextKeys: string[] = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!;
      const key = item.toolCallId ?? `${index}:${item.name}:${JSON.stringify(item.args)}`;
      let row = this.rows.get(key);
      if (!row) {
        row = new ScoutToolRowComponent();
        this.rows.set(key, row);
      }
      row.update(item, expanded, theme);
      nextKeys.push(key);
    }

    for (const key of [...this.rows.keys()]) {
      if (!nextKeys.includes(key)) {
        this.rows.delete(key);
      }
    }

    this.clear();
    for (const key of nextKeys) {
      const row = this.rows.get(key);
      if (row) this.addChild(row);
    }
  }
}

function stripLeadingSummaryHeading(text: string): string {
  return text
    .trim()
    .replace(/^(?:#{1,6}[ \t]*)?Summary(?:[ \t]*\[[^\r\n]*\])?[ \t]*\r?\n(?:[ \t]*\r?\n)*/i, "");
}

function compactPreviewLines(text: string, maxLines: number): string {
  return text.split("\n").slice(0, maxLines).join("\n");
}

function firstPromptLine(prompt: string): string {
  const lines = prompt.split(/\r?\n/);
  const firstLine = lines[0]?.trim() ?? "";
  const hasMore = lines.slice(1).some((line) => line.trim().length > 0);
  if (!hasMore || !firstLine) return firstLine;
  if (firstLine.endsWith("…") || firstLine.endsWith("...")) {
    return firstLine.replace(/\.\.\.$/, "…");
  }
  return firstLine.replace(/[.!?;:]?$/, "…");
}

class ScoutTextBlockComponent extends Container {
  update(
    item: Extract<DisplayItem, { type: "text" }>,
    isFinalText: boolean,
    expanded: boolean,
    theme: Theme,
    collapsedPreviewLines = 18,
  ): void {
    this.clear();

    const text = isFinalText
      ? stripLeadingSummaryHeading(item.text)
      : item.text.trim();
    if (!text) return;

    if (!isFinalText) {
      const firstLine = text.split("\n")[0]!;
      this.addChild(new Text(theme.fg("dim", shorten(firstLine, 120)), 0, 0));
      return;
    }

    const mdTheme = getMarkdownTheme();
    if (expanded) {
      this.addChild(new Markdown(text, 0, 0, mdTheme));
      return;
    }

    const preview = compactPreviewLines(text, collapsedPreviewLines);
    this.addChild(new Markdown(preview, 0, 0, mdTheme));
  }
}

class ScoutTextListComponent extends Container {
  private blocks: ScoutTextBlockComponent[] = [];

  update(
    items: Array<Extract<DisplayItem, { type: "text" }>>,
    expanded: boolean,
    theme: Theme,
    collapsedPreviewLines = 18,
  ): void {
    while (this.blocks.length < items.length) {
      this.blocks.push(new ScoutTextBlockComponent());
    }
    if (this.blocks.length > items.length) {
      this.blocks.length = items.length;
    }

    this.clear();
    const lastIndex = items.length - 1;
    for (let index = 0; index < items.length; index++) {
      const block = this.blocks[index]!;
      block.update(items[index]!, index === lastIndex, expanded, theme, collapsedPreviewLines);
      this.addChild(block);
    }
  }
}

function formatScoutStats(run: ScoutRunDetails, theme: Theme): string {
  const toolCount = run.displayItems.filter((item) => item.type === "tool").length;
  const elapsed = formatElapsed(run.startedAt, run.endedAt, run.status === "running");
  return theme.fg(
    "dim",
    `${elapsed} • ${run.turns} turns • ${toolCount} tool${toolCount === 1 ? "" : "s"}`,
  );
}

function getScoutStatusLabel(status: ScoutStatus, run: ScoutRunDetails, hasToolCalls: boolean): string {
  if (status === "running") return getRunningStatusLabel(run, hasToolCalls);
  return status;
}

class ScoutResultStatusComponent extends Container {
  private runningStatusText = new RunningStatusText();
  private lineText = new Text("", 0, 0);

  update(details: ScoutDetails, status: ScoutStatus, run: ScoutRunDetails, theme: Theme, requestRender?: () => void): void {
    const stats = formatScoutStats(run, theme);
    const toolCount = run.displayItems.filter((item) => item.type === "tool").length;
    const hasToolCalls = toolCount > 0;
    const statusLabel = theme.fg("dim", getScoutStatusLabel(status, run, hasToolCalls));

    this.clear();
    if (status === "running") {
      this.runningStatusText.update(run, hasToolCalls, theme, requestRender, stats);
      this.addChild(this.runningStatusText);
      return;
    }

    this.runningStatusText.stop();
    this.lineText.setText(`${scoutStatusIcon(theme, status)} ${statusLabel} ${theme.fg("dim", "•")} ${stats}`);
    this.addChild(this.lineText);
  }

  stop(): void {
    this.runningStatusText.stop();
  }
}

class ScoutResultBodyComponent extends Container {
  private topSpacer = new Spacer(1);
  private hiddenCountText = new Text("", 0, 0);
  private sectionLabelText = new Text("", 0, 0);
  private summarySpacer = new Spacer(1);
  private summaryLabelText = new Text("", 0, 0);
  private expandHintText = new Text("", 0, 0);
  private errorText = new Text("", 0, 0);
  private toolList = new ScoutToolListComponent();
  private textList = new ScoutTextListComponent();

  update(status: ScoutStatus, run: ScoutRunDetails, expanded: boolean, theme: Theme, summaryPath?: string): void {
    this.clear();

    const toolItems = run.displayItems.filter((item): item is Extract<DisplayItem, { type: "tool" }> => item.type === "tool");
    const textItems = run.displayItems.filter((item): item is Extract<DisplayItem, { type: "text" }> => item.type === "text" && !!item.text.trim());
    const parallelCompact = isParallelScoutMode();
    // TODO: Consider allowing expanded in-flight scouts by freezing volatile
    // status rendering (static icon/no elapsed-time ticks) while expanded. Full
    // detail plus an animated offscreen line can still trip Pi TUI's
    // above-viewport full redraw fallback.
    const canExpand = status !== "running" && !hasActiveScoutToolCalls();
    const showExpanded = expanded && canExpand;
    let hasCondensedDetails = false;

    if (status === "running") {
      if (toolItems.length > 0) {
        this.addChild(this.topSpacer);
        this.sectionLabelText.setText(theme.fg("dim", "Tool calls"));
        this.addChild(this.sectionLabelText);
        const maxRunningTools = showExpanded ? toolItems.length : parallelCompact ? PARALLEL_COLLAPSED_TOOL_PREVIEW : 5;
        const hiddenCount = Math.max(0, toolItems.length - maxRunningTools);
        if (hiddenCount > 0) {
          this.hiddenCountText.setText(theme.fg("dim", `… ${hiddenCount} earlier tool call${hiddenCount > 1 ? "s" : ""}`));
          this.addChild(this.hiddenCountText);
          hasCondensedDetails = true;
        }
        this.toolList.update(toolItems.slice(-maxRunningTools), showExpanded, theme);
        this.addChild(this.toolList);
        if (!showExpanded) hasCondensedDetails = true;
      }
      return;
    }

    if (status === "error" && run.error) {
      this.errorText.setText(theme.fg("error", `Error: ${run.error}`));
      this.addChild(this.topSpacer);
      this.addChild(this.errorText);
      return;
    }

    if (toolItems.length > 0) {
      this.addChild(this.topSpacer);
      this.sectionLabelText.setText(theme.fg("dim", "Tool calls"));
      this.addChild(this.sectionLabelText);
      if (showExpanded) {
        this.toolList.update(toolItems, showExpanded, theme);
      } else {
        const maxCollapsedTools = parallelCompact ? PARALLEL_COLLAPSED_TOOL_PREVIEW : 5;
        const hiddenCount = Math.max(0, toolItems.length - maxCollapsedTools);
        if (hiddenCount > 0) {
          this.hiddenCountText.setText(theme.fg("dim", `… ${hiddenCount} earlier tool call${hiddenCount > 1 ? "s" : ""}`));
          this.addChild(this.hiddenCountText);
          hasCondensedDetails = true;
        }
        this.toolList.update(toolItems.slice(-maxCollapsedTools), showExpanded, theme);
        hasCondensedDetails = true;
      }
      this.addChild(this.toolList);
    }

    if (textItems.length > 0) {
      if (toolItems.length > 0) {
        this.addChild(this.summarySpacer);
      } else {
        this.addChild(this.topSpacer);
      }
      const summaryLabel = summaryPath ? `Summary [saved to: ${summaryPath}]` : "Summary";
      this.summaryLabelText.setText(theme.fg("dim", summaryLabel));
      this.addChild(this.summaryLabelText);
      const visibleTextItems = showExpanded ? textItems : textItems.slice(-1);
      const collapsedPreviewLines = parallelCompact
        ? PARALLEL_COLLAPSED_SUMMARY_PREVIEW_LINES
        : COLLAPSED_SUMMARY_PREVIEW_LINES;
      this.textList.update(
        visibleTextItems,
        showExpanded,
        theme,
        showExpanded ? 18 : collapsedPreviewLines,
      );
      this.addChild(this.textList);
      if (!showExpanded && (textItems.length > visibleTextItems.length || textItems.some((item) => stripLeadingSummaryHeading(item.text).split("\n").length > collapsedPreviewLines))) {
        hasCondensedDetails = true;
      }
    }

    if (hasCondensedDetails && canExpand) {
      this.expandHintText.setText(theme.fg("dim", keyHint("app.tools.expand", "to expand details")));
      this.addChild(this.expandHintText);
    }
  }
}

class ScoutDetailsComponent extends Container {
  private titleText = new Text("", 0, 0);
  private promptText = new Text("", 0, 0);
  private body = new ScoutResultBodyComponent();
  private statusLine = new ScoutResultStatusComponent();

  constructor(
    private readonly scoutName: string,
    private readonly titleSuffix?: string,
  ) {
    super();
    this.addChild(this.titleText);
    this.addChild(this.promptText);
    this.addChild(this.body);
    this.addChild(this.statusLine);
  }

  stop(): void {
    this.statusLine.stop();
  }

  update(
    details: ScoutDetails,
    status: ScoutStatus,
    run: ScoutRunDetails,
    options: ToolRenderResultOptions,
    theme: Theme,
    requestRender?: () => void,
  ): void {
    const model = `${details.subagentProvider ?? "?"}/${details.subagentModelId ?? "?"}`;
    const prompt = run.query.trim();
    const promptText = this.titleSuffix
      ? ""
      : options.expanded && !hasActiveScoutToolCalls()
        ? prompt
        : firstPromptLine(prompt);
    const title = this.titleSuffix
      ? `${theme.fg("toolTitle", theme.bold(this.scoutName))} ${theme.fg("dim", this.titleSuffix)}\n${theme.fg("muted", model)}`
      : `${theme.fg("toolTitle", theme.bold(this.scoutName))} ${theme.fg("muted", model)}`;

    this.titleText.setText(title);
    this.promptText.setText(theme.fg("muted", promptText));
    this.body.update(status, run, options.expanded, theme, details.summaryPath);
    this.statusLine.update(details, status, run, theme, requestRender);

    this.clear();
    this.addChild(this.titleText);
    if (promptText) this.addChild(this.promptText);
    this.addChild(this.body);
    this.addChild(this.statusLine);
  }
}

export class ScoutResult extends Container {
  private fallback = new Text("", 0, 0);
  private detailsComponent: ScoutDetailsComponent;
  private showingFallback = false;

  constructor(
    private result: ScoutToolResult,
    private options: ToolRenderResultOptions,
    private theme: Theme,
    scoutName = "scout",
    titleSuffix?: string,
  ) {
    super();
    this.detailsComponent = new ScoutDetailsComponent(scoutName, titleSuffix);
    this.addChild(this.detailsComponent);
    this.update(result, options, theme);
  }

  update(result: ScoutToolResult, options: ToolRenderResultOptions, theme: Theme, invalidate?: () => void): void {
    this.result = result;
    this.options = options;
    this.theme = theme;
    const details = getScoutDetails(this.result);
    const status = details?.status;
    const run = details?.runs?.[0];

    if (!details || !status || !run) {
      this.detailsComponent.stop();
      this.fallback.setText(getResultText(this.result));
      if (!this.showingFallback) {
        this.clear();
        this.addChild(this.fallback);
        this.showingFallback = true;
      }
      return;
    }

    this.detailsComponent.update(details, status, run, this.options, this.theme, invalidate);
    if (this.showingFallback) {
      this.clear();
      this.addChild(this.detailsComponent);
      this.showingFallback = false;
    }
  }

  override invalidate(): void {
    super.invalidate();
  }
}

type ScoutCallOptions = {
  theme: Theme;
  executionStarted?: boolean;
  titleSuffix?: string;
};

export class ScoutCall implements Component {
  constructor(
    private readonly scoutName: string,
    private readonly options: ScoutCallOptions,
  ) { }

  invalidate(): void { }

  render(width: number): string[] {
    const { theme, executionStarted, titleSuffix } = this.options;
    if (executionStarted) return [];

    const titleParts = [theme.fg("toolTitle", theme.bold(this.scoutName))];
    if (titleSuffix) titleParts.push(theme.fg("dim", titleSuffix));

    return new Text(titleParts.join(" "), 0, 0).render(width);
  }
}

function formatElapsed(startedAt: number, endedAt: number | undefined, isLive: boolean): string {
  if (!isLive && endedAt === undefined) return "";
  return formatDuration((endedAt ?? Date.now()) - startedAt);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}
