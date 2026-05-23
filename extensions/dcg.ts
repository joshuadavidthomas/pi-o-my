/**
 * Bash tool override that runs `dcg` in hook mode before execution.
 */

import {
  createBashTool,
  DEFAULT_MAX_BYTES,
  DynamicBorder,
  formatSize,
  keyHint,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  Container,
  type Component,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
// Simple ANSI strip function - removes all ANSI escape sequences
const stripAnsi = (str: string): string =>
  str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

const escapeForSingleQuotes = (value: string) => value.replace(/'/g, "'\"'\"'");

type HookSpecificOutput = {
  permissionDecision?: string;
  permissionDecisionReason?: string;
  allowOnceCode?: string;
  ruleId?: string;
  severity?: string;
};

type HookOutput = {
  hookSpecificOutput?: HookSpecificOutput;
};

type DcgBlockDetails = {
  dcgBlocked: true;
  command: string;
  summary: string;
  fullReason: string;
};

type DcgAllowType = "once" | "session" | "always" | "always-project" | "always-global";

type DcgAllowedDetails = {
  dcgAllowed: true;
  allowType: DcgAllowType;
};

type DcgDecision =
  | "deny"
  | "allowOnce"
  | "allowSession"
  | "allowAlways"
  | "allowAlwaysProject"
  | "allowAlwaysGlobal";

const getDecisionReason = (reason: string | undefined): string => {
  if (!reason) return "Blocked by dcg";
  try {
    const parsed = JSON.parse(reason) as HookOutput;
    const parsedReason = parsed?.hookSpecificOutput?.permissionDecisionReason;
    if (parsedReason) {
      return parsedReason;
    }
  } catch {
    // Not JSON, continue with string parsing.
  }
  const lines = reason.split("\n");
  const reasonLine = lines.find((line) => line.startsWith("Reason:"));
  if (reasonLine) {
    return reasonLine.replace("Reason:", "").trim();
  }
  return lines[0]?.trim() || reason;
};

const severityBadge = (severity: string | undefined, theme: any): string => {
  if (!severity) return "";
  const normalized = severity.toLowerCase();
  const label = `[${severity.toUpperCase()}]`;
  if (normalized === "critical" || normalized === "high") {
    return theme.fg("error", label);
  }
  if (normalized === "medium") {
    return theme.fg("warning", label);
  }
  return theme.fg("muted", label);
};

const extractTextContent = (content: Array<TextContent | ImageContent> | undefined): string =>
  (content ?? [])
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");

const sanitizeBinaryOutput = (value: string): string =>
  Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f) return false;
      if (code >= 0xfff9 && code <= 0xfffb) return false;
      return true;
    })
    .join("");

const getBashOutputText = (content: Array<TextContent | ImageContent> | undefined): string =>
  sanitizeBinaryOutput(stripAnsi(extractTextContent(content))).replace(/\r/g, "");

const BASH_PREVIEW_LINES = 5;
const DCG_DECISION_TIMEOUT_MS = 2 * 60 * 1000;
const DCG_DECISION_TIMEOUT_SECONDS = DCG_DECISION_TIMEOUT_MS / 1000;

const buildBashOutputComponent = (
  output: string,
  options: { expanded?: boolean },
  theme: any,
  details?: { truncation?: { truncated?: boolean; truncatedBy?: "lines" | "bytes"; outputLines?: number; totalLines?: number; maxBytes?: number }; fullOutputPath?: string },
): Component => {
  const container = new Container();
  const trimmedOutput = output.trim();

  if (trimmedOutput) {
    const styledOutput = trimmedOutput
      .split("\n")
      .map((line) => theme.fg("toolOutput", line))
      .join("\n");

    if (options.expanded) {
      container.addChild(new Text(`\n${styledOutput}`, 0, 0));
    } else {
      let cachedWidth: number | undefined;
      let cachedLines: string[] | undefined;
      let cachedSkipped: number | undefined;

      container.addChild({
        render: (width: number) => {
          if (cachedLines === undefined || cachedWidth !== width) {
            const result = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
            cachedLines = result.visualLines;
            cachedSkipped = result.skippedCount;
            cachedWidth = width;
          }
          if (cachedSkipped && cachedSkipped > 0) {
            const hint =
              theme.fg("muted", `... (${cachedSkipped} earlier lines,`) +
              ` ${keyHint("app.tools.expand", "to expand")})`;
            return ["", truncateToWidth(hint, width, "..."), ...(cachedLines ?? [])];
          }
          return ["", ...(cachedLines ?? [])];
        },
        invalidate: () => {
          cachedWidth = undefined;
          cachedLines = undefined;
          cachedSkipped = undefined;
        },
      });
    }
  }

  const truncation = details?.truncation;
  const fullOutputPath = details?.fullOutputPath;
  if (truncation?.truncated || fullOutputPath) {
    const warnings: string[] = [];
    if (fullOutputPath) {
      warnings.push(`Full output: ${fullOutputPath}`);
    }
    if (truncation?.truncated) {
      if (truncation.truncatedBy === "lines") {
        warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
      } else {
        warnings.push(
          `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
        );
      }
    }
    container.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
  }

  return container;
};

class DcgDecisionComponent implements Component {
  private container = new Container();
  private selectList?: SelectList;
  private mode: "decision" | "scope" = "decision";
  private showDetails = false;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private done = false;
  private readonly timeoutHandle: ReturnType<typeof setTimeout>;

  constructor(
    private readonly data: {
      command: string;
      reason: string;
      details: string;
      allowOnceCode?: string;
      ruleId?: string;
      severity?: string;
    },
    private readonly tui: any,
    private readonly theme: any,
    private readonly onDone: (result: DcgDecision | null) => void,
  ) {
    this.timeoutHandle = setTimeout(() => this.finish("deny"), DCG_DECISION_TIMEOUT_MS);
    this.rebuild();
  }

  invalidate(): void {
    this.container.invalidate();
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.rebuild();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.finish("deny");
      return;
    }

    if (data.toLowerCase() === "e") {
      this.showDetails = !this.showDetails;
      this.rebuild();
      this.tui.requestRender();
      return;
    }

    this.selectList?.handleInput(data);
    // Clear render cache so SelectList selection changes are visible
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const lines = this.container.render(width);
    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  private rebuild(): void {
    const previousSelection = this.selectList?.getSelectedItem()?.value;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.container.clear();

    this.container.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
    const title =
      this.theme.fg("accent", this.theme.bold("Destructive command blocked")) +
      (this.data.severity ? ` ${severityBadge(this.data.severity, this.theme)}` : "");
    this.container.addChild(new Text(title, 1, 0));

    const commandLine =
      this.theme.fg("dim", "Command: ") + this.theme.fg("text", this.data.command);
    this.container.addChild(new Text(commandLine, 1, 0));

    const reasonLine =
      this.theme.fg("dim", "Reason: ") + this.theme.fg("text", this.data.reason);
    this.container.addChild(new Text(reasonLine, 1, 0));

    if (this.showDetails) {
      this.container.addChild(new Text(this.theme.fg("muted", this.data.details), 1, 0));
    }

    const toggleText = this.showDetails
      ? "Press e to hide details"
      : "Press e to show details";
    this.container.addChild(new Text(this.theme.fg("dim", toggleText), 1, 0));

    const items = this.mode === "decision" ? this.getDecisionItems() : this.getScopeItems();
    this.selectList = new SelectList(items, Math.min(items.length, 6), {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("warning", text),
    });

    this.selectList.onSelect = (item) => {
      if (item.value === "allowAlways") {
        this.mode = "scope";
        this.rebuild();
        this.tui.requestRender();
        return;
      }

      if (item.value === "back") {
        this.mode = "decision";
        this.rebuild();
        this.tui.requestRender();
        return;
      }

      this.finish(item.value as DcgDecision);
    };
    this.selectList.onCancel = () => this.finish("deny");

    if (previousSelection) {
      const index = items.findIndex((item) => item.value === previousSelection);
      if (index >= 0) {
        this.selectList.setSelectedIndex(index);
      } else {
        this.selectList.setSelectedIndex(0);
      }
    } else {
      this.selectList.setSelectedIndex(0);
    }

    this.container.addChild(this.selectList);
    const hintLine =
      this.mode === "scope"
        ? `↑↓ navigate • enter confirm • esc deny • auto-deny in ${DCG_DECISION_TIMEOUT_SECONDS}s`
        : `↑↓ navigate • enter confirm • esc deny • e details • auto-deny in ${DCG_DECISION_TIMEOUT_SECONDS}s`;
    this.container.addChild(new Text(this.theme.fg("dim", hintLine), 1, 0));
    this.container.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
  }

  private finish(result: DcgDecision | null): void {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timeoutHandle);
    this.onDone(result);
  }

  private getDecisionItems(): SelectItem[] {
    const items: SelectItem[] = [{ value: "deny", label: "Deny (default)", description: "" }];

    if (this.data.allowOnceCode) {
      items.push({ value: "allowOnce", label: "Allow once", description: "" });
    }

    if (this.data.ruleId) {
      items.push({
        value: "allowSession",
        label: "Allow for this session",
        description: "Allow this rule until pi exits",
      });
      items.push({
        value: "allowAlways",
        label: "Allow always…",
        description: "Choose project or global scope",
      });
    }

    return items;
  }

  private getScopeItems(): SelectItem[] {
    return [
      { value: "allowAlwaysProject", label: "Allow always (project)", description: "" },
      { value: "allowAlwaysGlobal", label: "Allow always (global)", description: "" },
      { value: "back", label: "Back", description: "" },
    ];
  }
}

type HookDecision =
  | { action: "allow" }
  | {
    action: "deny";
    reason: string;
    decisionReason: string;
    hookOutput?: HookSpecificOutput;
  };

type HookDecisionContext = {
  hasUI: boolean;
  ui: { notify: (message: string, level: "warning" | "info" | "error") => void };
};

type BlockResult = {
  content: Array<TextContent | ImageContent>;
  details: DcgBlockDetails;
};

type BuildBlockResult = (
  message: string | undefined,
  fallback: string,
  decisionReason?: string,
  contentText?: string,
) => BlockResult;

type RunDcgHook = (command: string, cwd: string) => Promise<string | null>;

type RunHookDecisionParams = {
  command: string;
  cwd: string;
  ctx: HookDecisionContext;
  runDcgHook: RunDcgHook;
  warnOnNonJson: boolean;
  parseHookOutput: (output: string) => HookOutput | null;
};

type FollowUpParams = {
  command: string;
  cwd: string;
  ctx: HookDecisionContext;
  runDcgHook: RunDcgHook;
  parseHookOutput: (output: string) => HookOutput | null;
  runBash: () => Promise<unknown>;
  buildBlockResult: BuildBlockResult;
  fallbackReason: string;
  allowType: DcgAllowType;
};

type ApplyAllowOnceParams = {
  pi: ExtensionAPI;
  ctx: HookDecisionContext & { cwd: string };
  allowOnceCode: string;
  reason: string;
  runBash: () => Promise<unknown>;
  runDcgHook: RunDcgHook;
  parseHookOutput: (output: string) => HookOutput | null;
  buildBlockResult: BuildBlockResult;
  command: string;
  decisionReason: string;
};

type ApplyAllowlistParams = {
  pi: ExtensionAPI;
  ctx: HookDecisionContext & { cwd: string };
  ruleId: string;
  scopeFlag: "--global" | "--project";
  reason: string;
  runBash: () => Promise<unknown>;
  runDcgHook: RunDcgHook;
  parseHookOutput: (output: string) => HookOutput | null;
  buildBlockResult: BuildBlockResult;
  command: string;
  decisionReason: string;
};

const buildBlockDetails = (
  command: string,
  message: string | undefined,
  fallback: string,
  decisionReason?: string,
): DcgBlockDetails => ({
  dcgBlocked: true,
  command,
  summary: decisionReason ?? getDecisionReason(message ?? fallback),
  fullReason: message ?? fallback,
});

const buildBlockResult = (
  command: string,
  message: string | undefined,
  fallback: string,
  decisionReason?: string,
  contentText?: string,
): BlockResult => ({
  content: contentText ? [{ type: "text", text: contentText }] : [],
  details: buildBlockDetails(command, message, fallback, decisionReason),
});

const runHookDecision = async ({
  command,
  cwd,
  ctx,
  runDcgHook,
  warnOnNonJson,
  parseHookOutput,
}: RunHookDecisionParams): Promise<HookDecision> => {
  const output = await runDcgHook(command, cwd);
  if (!output) {
    return { action: "allow" };
  }

  const parsed = parseHookOutput(output);
  if (!parsed) {
    if (warnOnNonJson && ctx.hasUI) {
      ctx.ui.notify("dcg returned non-JSON output; allowing command.", "warning");
    }
    return { action: "allow" };
  }

  const hookOutput = parsed.hookSpecificOutput;
  if (hookOutput?.permissionDecision !== "deny") {
    return { action: "allow" };
  }

  const reason = hookOutput.permissionDecisionReason ?? output;
  return {
    action: "deny",
    reason,
    decisionReason: getDecisionReason(reason),
    hookOutput,
  };
};

const runBashWithAllowType = async (runBash: () => Promise<unknown>, allowType: DcgAllowType) => {
  const bashResult = await runBash() as { content: Array<TextContent | ImageContent>; details?: Record<string, unknown> };
  return {
    ...bashResult,
    details: { ...bashResult.details, dcgAllowed: true, allowType },
  };
};

const followUpOrRun = async ({
  command,
  cwd,
  ctx,
  runDcgHook,
  parseHookOutput,
  runBash,
  buildBlockResult,
  fallbackReason,
  allowType,
}: FollowUpParams) => {
  const followUp = await runHookDecision({
    command,
    cwd,
    ctx,
    runDcgHook,
    warnOnNonJson: false,
    parseHookOutput,
  });
  if (followUp.action === "deny") {
    return buildBlockResult(followUp.reason, fallbackReason, followUp.decisionReason);
  }
  return runBashWithAllowType(runBash, allowType);
};

const applyAllowOnce = async ({
  pi,
  ctx,
  allowOnceCode,
  reason,
  runBash,
  runDcgHook,
  parseHookOutput,
  buildBlockResult,
  command,
  decisionReason,
}: ApplyAllowOnceParams) => {
  const allowOnceResult = await pi.exec("dcg", ["allow-once", "--yes", "--single-use", allowOnceCode], {
    cwd: ctx.cwd,
  });

  if (allowOnceResult.code !== 0) {
    const stderrMessage = allowOnceResult.stderr.trim() || undefined;
    return buildBlockResult(stderrMessage, reason, decisionReason);
  }

  return followUpOrRun({
    command,
    cwd: ctx.cwd,
    ctx,
    runDcgHook,
    parseHookOutput,
    runBash,
    buildBlockResult,
    fallbackReason: reason,
    allowType: "once",
  });
};

const applyAllowlist = async ({
  pi,
  ctx,
  ruleId,
  scopeFlag,
  reason,
  runBash,
  runDcgHook,
  parseHookOutput,
  buildBlockResult,
  command,
  decisionReason,
}: ApplyAllowlistParams) => {
  const allowlistResult = await pi.exec(
    "dcg",
    ["allowlist", "add", ruleId, scopeFlag],
    { cwd: ctx.cwd },
  );

  if (allowlistResult.code !== 0) {
    const stderrMessage = allowlistResult.stderr.trim() || undefined;
    return buildBlockResult(stderrMessage, reason, decisionReason);
  }

  return followUpOrRun({
    command,
    cwd: ctx.cwd,
    ctx,
    runDcgHook,
    parseHookOutput,
    runBash,
    buildBlockResult,
    fallbackReason: reason,
    allowType: scopeFlag === "--global" ? "always-global" : "always-project",
  });
};

export default function (pi: ExtensionAPI) {
  const runDcgHook = async (command: string, cwd: string) => {
    const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command } });
    const escapedPayload = escapeForSingleQuotes(payload);
    const { stdout, stderr } = await pi.exec(
      "bash",
      ["-c", `printf '%s' '${escapedPayload}' | dcg`],
      { cwd },
    );

    const output = stdout.trim() || stderr.trim();
    if (!output) return null;
    return output;
  };

  const parseHookOutput = (output: string): HookOutput | null => {
    let jsonText = output.trim();
    const fencedMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fencedMatch) {
      jsonText = fencedMatch[1].trim();
    }

    const firstBrace = jsonText.indexOf("{");
    const lastBrace = jsonText.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      jsonText = jsonText.slice(firstBrace, lastBrace + 1);
    }

    try {
      return JSON.parse(jsonText) as HookOutput;
    } catch {
      return null;
    }
  };

  const runBashTool = async (
    toolCallId: string,
    params: { command: string; timeout?: number },
    onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    ctx: { cwd: string },
    signal: AbortSignal | undefined,
  ) => {
    const tool = createBashTool(ctx.cwd);
    return tool.execute(toolCallId, params, signal, onUpdate);
  };

  const baseBash = createBashTool(process.cwd());
  const sessionAllowedRuleIds = new Set<string>();

  pi.registerTool({
    ...baseBash,
    renderCall(args, theme) {
      const command = args?.command ?? "";
      const timeout = args?.timeout as number | undefined;
      const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
      const commandText = command || theme.fg("toolOutput", "...");
      const text = theme.fg("toolTitle", theme.bold(`$ ${commandText}`)) + timeoutSuffix;
      return new Text(text, 0, 0);
    },
    renderResult(result, options, theme) {
      const blockDetails = result.details as DcgBlockDetails | undefined;
      const allowDetails = result.details as DcgAllowedDetails | undefined;
      const dcgPrefix = theme.fg("accent", "[dcg]");

      // Handle allowed case
      if (allowDetails?.dcgAllowed) {
        const stateLabelByType: Record<DcgAllowType, string> = {
          once: "allowed (once)",
          session: "allowed (session)",
          always: "allowed",
          "always-project": "allowed",
          "always-global": "allowed",
        };
        const allowState = stateLabelByType[allowDetails.allowType] ?? "allowed";
        const color = allowDetails.allowType === "once" || allowDetails.allowType === "session"
          ? "warning"
          : "success";
        const state = theme.fg(color, allowState);
        const label = theme.bold(`${dcgPrefix} ${state}`);
        const output = getBashOutputText(result.content);
        const container = new Container();
        container.addChild(new Text(label, 0, 0));
        container.addChild(
          buildBashOutputComponent(output, options, theme, result.details as any),
        );
        return container;
      }

      // Handle blocked case
      if (blockDetails?.dcgBlocked) {
        const state = theme.fg("error", "blocked");
        const label = theme.bold(`${dcgPrefix} ${state}`);
        const reason = theme.fg("text", blockDetails.summary);
        if (options.expanded) {
          const full = theme.fg("dim", blockDetails.fullReason);
          return new Text(`${label}: ${reason}\n${full}`, 0, 0);
        }
        const hint = theme.fg("dim", keyHint("app.tools.expand", "to expand"));
        return new Text(`${label}: ${reason}\n${hint}`, 0, 0);
      }

      // Normal bash output (no dcg involvement)
      return buildBashOutputComponent(
        getBashOutputText(result.content),
        options,
        theme,
        result.details as any,
      );
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const command = params.command ?? "";
      const runBash = () => runBashTool(toolCallId, params, onUpdate, ctx, signal);
      const buildResult: BuildBlockResult = (
        message,
        fallback,
        decisionReason,
        contentText,
      ) => buildBlockResult(command, message, fallback, decisionReason, contentText);

      try {
        const initialDecision = await runHookDecision({
          command,
          cwd: ctx.cwd,
          ctx,
          runDcgHook,
          warnOnNonJson: true,
          parseHookOutput,
        });
        if (initialDecision.action === "allow") {
          return runBash();
        }

        const { reason, decisionReason, hookOutput } = initialDecision;
        const blockResult = buildResult(reason, reason, decisionReason);
        const ruleId = hookOutput?.ruleId;

        if (ruleId && sessionAllowedRuleIds.has(ruleId)) {
          return runBashWithAllowType(runBash, "session");
        }

        if (!ctx.hasUI) {
          return buildResult(reason, reason, decisionReason, decisionReason);
        }

        const result = await ctx.ui.custom<DcgDecision | null>((tui, theme, _kb, done) =>
          new DcgDecisionComponent(
            {
              command,
              reason: decisionReason,
              details: reason,
              allowOnceCode: hookOutput?.allowOnceCode,
              ruleId,
              severity: hookOutput?.severity,
            },
            tui,
            theme,
            done,
          ),
        );

        const denyAndBlock = (explicit: boolean) => {
          if (explicit) {
            pi.sendMessage(
              {
                customType: "dcg-user-decision",
                content: "deny",
                display: false,
                details: { command, decision: "deny" },
              },
              { deliverAs: "steer" },
            );
          }
          return blockResult;
        };

        if (!result || result === "deny") {
          return denyAndBlock(result === "deny");
        }

        if (result === "allowOnce") {
          if (!hookOutput?.allowOnceCode) {
            return blockResult;
          }

          return applyAllowOnce({
            pi,
            ctx,
            allowOnceCode: hookOutput.allowOnceCode,
            reason,
            runBash,
            runDcgHook,
            parseHookOutput,
            buildBlockResult: buildResult,
            command,
            decisionReason,
          });
        }

        if (result === "allowSession") {
          if (!ruleId) {
            return blockResult;
          }
          sessionAllowedRuleIds.add(ruleId);
          return runBashWithAllowType(runBash, "session");
        }

        if (!ruleId) {
          return blockResult;
        }

        const scopeFlag = result === "allowAlwaysGlobal" ? "--global" : "--project";
        return applyAllowlist({
          pi,
          ctx,
          ruleId,
          scopeFlag,
          reason,
          runBash,
          runDcgHook,
          parseHookOutput,
          buildBlockResult: buildResult,
          command,
          decisionReason,
        });
      } catch (error) {
        if (ctx.hasUI) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`dcg failed: ${message}`, "warning");
        }
        return buildResult("Blocked by dcg", "Blocked by dcg");
      }
    },
  });
}
