import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { getMarkdownTheme, ToolExecutionComponent, type ExtensionAPI, type ExtensionCommandContext, type MessageRenderOptions, type Theme } from "@mariozechner/pi-coding-agent";
import { Container, Key, Markdown, matchesKey, Spacer, TUI, type Component, type Terminal } from "@mariozechner/pi-tui";

import type { ScoutDetails } from "../types.ts";
import { isReviewLens, REVIEW_LENSES, type ReviewLens } from "./config.ts";
import { runReview, selectReviewLenses, type ReviewArtifactType, type ReviewContext, type ReviewLensSelection, type ReviewMode, type ReviewScoutResult } from "./run.ts";
import { REVIEWER_TOOL } from "./tool.ts";

type ReviewLensResult = {
  lens: ReviewLens;
  result: ReviewScoutResult;
};

type ReviewMessageDetails = {
  cwd: string;
  results: ReviewLensResult[];
};

type ScoutRenderResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ScoutDetails;
  isError: boolean;
};

type ReviewFollowup = "synthesize" | "fix" | "none";

type ParsedArgs = {
  subcommand: string;
  rest: string[];
  base?: string;
  strict: boolean;
  lens: ReviewLensSelection;
  context?: ReviewContext;
  followup: ReviewFollowup;
};

const REVIEW_SUBCOMMANDS = ["repo", "design", "plan", "diff", "staged", "file", "boundary"] as const;

function isReviewSubcommand(value: string): boolean {
  return REVIEW_SUBCOMMANDS.includes(value as (typeof REVIEW_SUBCOMMANDS)[number]);
}

function lensFromFlag(flag: string): ReviewLens | undefined {
  if (!flag.startsWith("--")) return undefined;
  const lens = flag.slice(2);
  return isReviewLens(lens) ? lens : undefined;
}

function lensFlagList(): string {
  return REVIEW_LENSES.map((lens) => `--${lens}`).join("|");
}

function requireFlagValue(words: string[], index: number, flag: string): string {
  const value = words[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.\n\n${shortUsage()}`);
  }
  return value;
}

function parseContextValue(value: string): ReviewContext {
  if (value === "none" || value === "brief" || value === "transcript") return value;
  throw new Error(`Invalid --context value: ${value}. Expected none, brief, or transcript.\n\n${shortUsage()}`);
}

function shellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  if (current) words.push(current);
  return words;
}

function parseArgs(args: string): ParsedArgs {
  const words = shellWords(args.trim());
  const subcommand = words[0]?.startsWith("--") ? "repo" : words.shift() ?? "repo";
  const rest: string[] = [];
  let base: string | undefined;
  let strict = false;
  let lens: ReviewLensSelection = "all";
  let context: ReviewContext | undefined;
  let followup: ReviewFollowup = "synthesize";

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === "--strict") {
      strict = true;
      continue;
    }
    if (word === "--notes") {
      strict = false;
      continue;
    }
    const flagLens = lensFromFlag(word);
    if (flagLens) {
      lens = flagLens;
      continue;
    }
    if (word === "--both" || word === "--all") {
      lens = "all";
      continue;
    }
    if (word === "--fix") {
      followup = "fix";
      continue;
    }
    if (word === "--no-followup" || word === "--no-synthesize") {
      followup = "none";
      continue;
    }
    if (word === "--base") {
      base = requireFlagValue(words, i, "--base");
      i += 1;
      continue;
    }
    if (word === "--context") {
      context = parseContextValue(requireFlagValue(words, i, "--context"));
      i += 1;
      continue;
    }
    rest.push(word);
  }

  return { subcommand, rest, base, strict, lens, context, followup };
}

async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

async function optionalRepoConfig(cwd: string): Promise<string> {
  const candidates = [join(cwd, ".pi", "review.md"), join(cwd, ".review-lenses.md")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const content = await readFile(candidate, "utf8");
      return `Repo-specific review config from ${candidate}:\n\n${content}`;
    }
  }
  return "";
}

function defaultContextFor(subcommand: string): ReviewContext {
  if (subcommand === "design" || subcommand === "plan") return "brief";
  return "none";
}

function artifactTypeFor(subcommand: string): ReviewArtifactType {
  if (subcommand === "repo") return "repository";
  if (subcommand === "diff" || subcommand === "staged") return "diff";
  if (subcommand === "plan") return "plan";
  if (subcommand === "design") return "design";
  if (subcommand === "file") return "file";
  if (subcommand === "boundary") return "module";
  return "other";
}

function shortUsage(): string {
  return `Usage:
/review [repo]
/review design <sketch>
/review plan <plan-or-path>
/review diff [base] [--strict] [${lensFlagList()}]
/review staged
/review file <path>
/review boundary <path-or-description>`;
}

function invalidInvocationText(cwd: string, parsed: ParsedArgs): string {
  const given = [parsed.subcommand, ...parsed.rest].join(" ").trim();
  const possiblePath = resolve(cwd, given);
  const suggestion = existsSync(possiblePath)
    ? `\n\nThat looks like a path. Choose what kind of artifact it is, for example:\n/review plan ${given}\n/review file ${given}`
    : "";

  return `Unknown review kind: ${parsed.subcommand}\n\n/review needs a kind before the target: repo, design, plan, diff, staged, file, or boundary.${suggestion}\n\n${shortUsage()}`;
}

function helpText(): string {
  return `Structural review runs reviewer-local Hickey, Lowy, and Grug lenses as isolated scouts.

Hickey asks: is this structurally simple?

Lowy asks: do the boundaries contain change?

Grug asks: does this make the next change smaller in brain?

How to use it:
- Current repository: /review or /review repo
- Early idea: /review design <sketch>
- Before implementation: /review plan <plan-or-path>
- After implementation: /review diff [base]
- Local work only: /review staged
- Focused audit: /review file <path> or /review boundary <path-or-description>

Modes:
- default: all three lenses, notes mode
- --strict: tell the lenses to use Fix now / No-op dispositions
- ${REVIEW_LENSES.map((lens) => `--${lens}`).join(" / ")}: run only one lens
- --context none|brief|transcript: describe how much context is included; diff/file default to none, design/plan default to brief
- --base <base>: choose the diff base
- default follow-up: ask the main agent to synthesize reviewer findings after all selected passes
- --fix: ask the main agent to address accepted findings after synthesis
- --no-followup: only display reviewer outputs

Examples:
/review
/review repo --grug
/review design Add a plugin system with per-plugin config and lifecycle hooks
/review plan docs/agents/plugin-system/plan.md
/review diff --base main --strict
/review staged --hickey
/review file src/auth/session.ts
/review boundary src/billing --lowy
/review diff --grug`;
}

async function collectArtifact(cwd: string, parsed: ParsedArgs): Promise<{ subject: string; subjectLabel: string }> {
  if (parsed.subcommand === "repo") {
    const [head, status, files] = await Promise.all([
      git(cwd, ["rev-parse", "--short", "HEAD"]),
      git(cwd, ["status", "--short", "--untracked-files=all"]),
      git(cwd, ["ls-files"]),
    ]);
    return {
      subject: `Review the current repository at ${cwd}. Use tools to inspect the files relevant to each finding.\n\nHEAD: ${head.trim()}\n\nWorking tree status:\n${status.trim() || "clean"}\n\nTracked files:\n${files.trim()}`,
      subjectLabel: "current repository",
    };
  }

  if (parsed.subcommand === "design" || parsed.subcommand === "plan") {
    const text = parsed.rest.join(" ").trim();
    if (!text) throw new Error(`Usage: /review ${parsed.subcommand} <text-or-path>`);
    const possiblePath = resolve(cwd, text);
    if (existsSync(possiblePath)) return { subject: await readFile(possiblePath, "utf8"), subjectLabel: text };
    return { subject: text, subjectLabel: "inline text" };
  }

  if (parsed.subcommand === "diff") {
    const base = parsed.base ?? parsed.rest[0] ?? "origin/HEAD";
    const range = base.includes("...") || base.includes("..") ? base : `${base}...HEAD`;
    return { subject: await git(cwd, ["diff", range]), subjectLabel: `git diff ${range}` };
  }

  if (parsed.subcommand === "staged") return { subject: await git(cwd, ["diff", "--cached"]), subjectLabel: "git diff --cached" };

  if (parsed.subcommand === "file") {
    const file = parsed.rest[0];
    if (!file) throw new Error("Usage: /review file <path>");
    return { subject: await readFile(resolve(cwd, file), "utf8"), subjectLabel: file };
  }

  if (parsed.subcommand === "boundary") {
    const text = parsed.rest.join(" ").trim();
    if (!text) throw new Error("Usage: /review boundary <description-or-path>");
    const possiblePath = resolve(cwd, text);
    if (existsSync(possiblePath)) {
      const pathStat = await stat(possiblePath);
      if (pathStat.isDirectory()) {
        const repoPath = relative(cwd, possiblePath) || ".";
        const files = await git(cwd, ["ls-files", "--", repoPath]);
        return {
          subject: `Review the boundary at ${text}. It is a directory, so inspect the listed files with tools before making claims.\n\nTracked files in boundary:\n${files.trim() || "(no tracked files)"}`,
          subjectLabel: text,
        };
      }
      return { subject: await readFile(possiblePath, "utf8"), subjectLabel: text };
    }
    return { subject: text, subjectLabel: "inline boundary description" };
  }

  throw new Error(invalidInvocationText(cwd, parsed));
}

function lensListLabel(lenses: ReviewLens[]): string {
  return lenses.map((lens) => lens[0]!.toUpperCase() + lens.slice(1)).join(", ");
}

function followupPrompt(parsed: ParsedArgs, lenses: ReviewLens[], subjectLabel: string, hasReviewOutput: boolean): string | undefined {
  if (parsed.followup === "none" || !hasReviewOutput) return undefined;

  if (parsed.followup === "fix") {
    return `Address the review findings above for ${subjectLabel}.
First synthesize the ${lensListLabel(lenses)} passes: identify overlaps, conflicts, accepted findings, rejected findings, and why.
Then implement only the accepted fixes. Do not split the difference between conflicting recommendations; choose the reasoning that holds up.
Keep scope to the reviewed artifact unless a finding requires a directly related change.`;
  }

  return `Synthesize the review findings above for ${subjectLabel}. Do not implement yet.
Treat ${lensListLabel(lenses)} as independent reviewers. Identify overlaps, conflicts, which findings to accept or reject, and the next action.
When the passes disagree, do not split the difference; pick the reasoning that holds up or reject both.`;
}

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
    lenses: [lens],
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

class LiveReviewWidget extends Container {
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

function setLiveReviewWidget(
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

function clearLiveReviewWidget(ctx: ExtensionCommandContext): void {
  if (ctx.hasUI) ctx.ui.setWidget("review", undefined);
}

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

function installReviewInputHandler(
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

class ReviewResultComponent extends Container {
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

export function registerReviewCommand(pi: ExtensionAPI) {
  pi.registerMessageRenderer<ReviewMessageDetails>("review-result", (message, options, theme) => {
    return new ReviewResultComponent(message.details, String(message.content ?? ""), options, theme);
  });

  pi.registerCommand("review", {
    description: "Gather an artifact and run the hickey/lowy/grug reviewer lenses in isolated scouts",
    getArgumentCompletions: (prefix) => {
      const items = ["repo", "design", "plan", "diff", "staged", "file", "boundary", "help"];
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

        ctx.ui.setStatus("review", "reviewing…");
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
              isError: false,
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
        ctx.ui.setStatus("review", "");
      }
    },
  });
}
