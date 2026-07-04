// Scout session lifecycle — execute a scout subagent from config to result.
//
// Handles session creation, model resolution with fallback, abort propagation,
// timeout enforcement, event tracking, and final result construction.

import { randomBytes } from "node:crypto";
import events from "node:events";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  SessionManager,
  createAgentSession,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

import { extractDisplayItems, extractToolResultText, getAssistantText, getLastAssistantText, MAX_DISPLAY_ITEMS, scoutDetailsFromUnknown } from "./display.ts";
import { defaultModelTargetsForScout, formatModelTarget, parseModelTarget, resolveFirstAvailableModelTarget, type ScoutModelTarget } from "./models.ts";
import { loadScoutUserConfig, ScoutUserConfigError } from "./user-config.ts";
import { createScoutResourceLoader } from "./resources.ts";
import { computeOverallStatus, createInitialRun } from "./state.ts";
import { DEFAULT_SCOUT_TIMEOUT_MS, type ScoutConfig, type ScoutDetails } from "./types.ts";

type ScoutRunDetails = ScoutDetails["runs"][number];

// EventTarget max listeners management for nested sessions
const DEFAULT_EVENTTARGET_MAX_LISTENERS = 100;
const EVENTTARGET_MAX_LISTENERS_STATE_KEY = Symbol.for("pi.eventTargetMaxListenersState");
type BuiltinToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
const BUILTIN_TOOL_NAMES = new Set<BuiltinToolName>(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const SINGLE_SCOUT_UPDATE_INTERVAL_MS = 150;

function getTempFilePath(scoutName: string): string {
  const id = randomBytes(8).toString("hex");
  const safeName = scoutName.replace(/[^a-z0-9_-]/gi, "-").toLowerCase() || "scout";
  return join(tmpdir(), `pi-${safeName}-${id}.log`);
}

function saveSummary(scoutName: string, output: string): string | undefined {
  const summaryPath = getTempFilePath(scoutName);
  try {
    writeFileSync(summaryPath, output, "utf8");
    return summaryPath;
  } catch {
    return undefined;
  }
}

function appendSummaryNotice(output: string, summaryPath: string | undefined): string {
  if (!summaryPath) return output;

  const notice = `[saved to: ${summaryPath}]`;
  const summaryHeadingPattern = /^(#{1,6}[ \t]*)?Summary[ \t]*$/im;
  if (summaryHeadingPattern.test(output)) {
    return output.replace(summaryHeadingPattern, (_match, hashes = "") => `${hashes}Summary ${notice}`);
  }

  return `Summary ${notice}\n${output}`;
}

function formatDuration(ms: number): string {
  const minutes = ms / 60_000;
  if (Number.isInteger(minutes)) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${Math.round(ms / 1000)} seconds`;
}

type EventTargetMaxListenersState = { depth: number; savedDefault?: number };
type ScoutExecutionResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ScoutDetails;
  isError: boolean;
};
type ScoutUpdate = Pick<ScoutExecutionResult, "content" | "details">;
type ScoutWorkflowPhase = "planning" | "running" | "aborting" | "finished";
type ScoutRunPlan = {
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
};
type AbortableSession = Pick<AgentSession, "abort">;

function shouldLoadScoutExtensions(provider: string | undefined): boolean {
  return provider?.toLowerCase() === "claude-agent-sdk";
}

function getEventTargetMaxListenersState(): EventTargetMaxListenersState {
  const g = globalThis as typeof globalThis & {
    [EVENTTARGET_MAX_LISTENERS_STATE_KEY]?: EventTargetMaxListenersState;
  };
  if (!g[EVENTTARGET_MAX_LISTENERS_STATE_KEY]) {
    g[EVENTTARGET_MAX_LISTENERS_STATE_KEY] = { depth: 0 };
  }
  return g[EVENTTARGET_MAX_LISTENERS_STATE_KEY];
}

export function bumpDefaultEventTargetMaxListeners(): () => void {
  const state = getEventTargetMaxListenersState();
  const raw = process.env.PI_EVENTTARGET_MAX_LISTENERS ?? process.env.PI_ABORT_MAX_LISTENERS;
  const desired = raw !== undefined ? Number(raw) : DEFAULT_EVENTTARGET_MAX_LISTENERS;
  if (!Number.isFinite(desired) || desired < 0) return () => {};

  if (state.depth === 0) state.savedDefault = events.defaultMaxListeners;
  state.depth += 1;
  if (events.defaultMaxListeners < desired) events.setMaxListeners(desired);

  return () => {
    state.depth = Math.max(0, state.depth - 1);
    if (state.depth !== 0) return;
    if (state.savedDefault === undefined) return;
    events.setMaxListeners(state.savedDefault);
    state.savedDefault = undefined;
  };
}

export const SCOUT_CUSTOM_TOOL_MARKER = "__scoutCustomTool";

export function prepareScoutTools(config: ScoutConfig, cwd: string, ctx?: ExtensionContext): {
  builtinTools: BuiltinToolName[];
  customTools: ToolDefinition[];
} {
  const allTools = config.createTools
    ? config.createTools(cwd, ctx)
    : [{ name: "read" }, { name: "bash" }];

  const builtinTools = allTools
    .filter((tool: any): tool is { name: BuiltinToolName } => BUILTIN_TOOL_NAMES.has(tool.name) && tool[SCOUT_CUSTOM_TOOL_MARKER] !== true)
    .map((tool) => tool.name);
  const customTools = allTools
    .filter((tool: any) => !BUILTIN_TOOL_NAMES.has(tool.name) || tool[SCOUT_CUSTOM_TOOL_MARKER] === true)
    .map(toToolDefinition);

  return { builtinTools, customTools };
}

function toToolDefinition(tool: any): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
    parameters: tool.parameters,
    prepareArguments: tool.prepareArguments,
    executionMode: tool.executionMode,
    execute: (toolCallId, params, signal, onUpdate) =>
      tool.execute(toolCallId, params, signal, onUpdate),
  };
}

class ScoutWorkflow {
  private readonly timeoutMs: number;
  private readonly query: string;
  private readonly userPrompt: string;
  private readonly systemPrompt: string;
  private readonly runPlans: ScoutRunPlan[];
  private readonly activeSessions = new Set<AbortableSession>();
  private readonly runs: ScoutRunDetails[];
  private readonly planningError?: string;

  private phase: ScoutWorkflowPhase = "planning";
  private startedRunCount = 0;
  private currentModel?: Model<Api>;
  private abortRequested = false;
  private abortSignalListener?: () => void;
  private abortReason = "Aborted";
  private lastUpdateAt = 0;

  constructor(
    private readonly config: ScoutConfig,
    private readonly params: Record<string, unknown>,
    private readonly signal: AbortSignal | undefined,
    private readonly onUpdate: ((update: ScoutUpdate) => void) | undefined,
    private readonly ctx: ExtensionContext,
  ) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_SCOUT_TIMEOUT_MS;
    this.query = String(params.query ?? "");
    this.userPrompt = config.buildUserPrompt(params);
    this.systemPrompt = config.buildSystemPrompt(this.timeoutMs);
    this.runs = [createInitialRun(this.query)];

    let resolvedRunPlan: ScoutRunPlan | null = null;
    let requestedTargets: ScoutModelTarget[] = [];

    try {
      const scoutName = config.name.split(":", 1)[0] ?? config.name;
      const userConfig = loadScoutUserConfig(ctx.cwd);
      const configuredTarget = parseModelTarget(config.configuredModel);
      requestedTargets = [
        ...(configuredTarget ? [configuredTarget] : []),
        ...(userConfig.modelTargetsByScout[scoutName as keyof typeof userConfig.modelTargetsByScout]
          ?? config.modelTargets
          ?? defaultModelTargetsForScout(config.name)),
      ];
    } catch (error) {
      if (error instanceof ScoutUserConfigError) {
        this.planningError = error.message;
        this.runPlans = [];
        return;
      }
      throw error;
    }

    const targetMatch = resolveFirstAvailableModelTarget(ctx.modelRegistry, ctx.model, requestedTargets);
    if (targetMatch) {
      resolvedRunPlan = {
        model: targetMatch.model,
        thinkingLevel: config.thinkingLevelForParams?.(params) ?? config.defaultThinkingLevel ?? targetMatch.thinkingLevel,
      };
    }

    if (!resolvedRunPlan) {
      const available = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);
      const requested = requestedTargets.length > 0
        ? requestedTargets.map(formatModelTarget).join(", ")
        : "the current scout model selection";
      this.planningError = `No compatible model found for requested scout target(s): ${requested}. Available: ${available.length ? available.join(", ") : "none (configure credentials via /login or auth.json)"}`;
      this.runPlans = [];
      return;
    }

    this.runPlans = [resolvedRunPlan];
    this.currentModel = resolvedRunPlan.model;
  }

  async run(): Promise<ScoutExecutionResult> {
    if (this.planningError) {
      return this.buildPlanningErrorResult();
    }

    if (this.signal?.aborted) {
      const run = this.currentRun();
      this.phase = "aborting";
      this.abortRequested = true;
      this.markRunAborted(run);
      this.publishUpdate(true);
      this.phase = "finished";
      return this.buildResult();
    }

    this.phase = "running";
    const detachAbortHandling = this.attachAbortHandling();
    const detachTimeout = this.attachTimeout();
    try {
      for (const runPlan of this.runPlans) {
        const shouldContinue = await this.runPlannedRun(runPlan);
        if (!shouldContinue) break;
      }

      this.phase = "finished";
      return this.buildResult();
    } finally {
      detachTimeout();
      detachAbortHandling();
    }
  }

  private buildPlanningErrorResult(): ScoutExecutionResult {
    const run = this.currentRun();
    run.status = "error";
    run.error = this.planningError;
    run.summaryText = this.planningError;
    run.endedAt = Date.now();

    const summaryPath = saveSummary(this.config.name, this.planningError!);

    return {
      content: [{ type: "text", text: appendSummaryNotice(this.planningError!, summaryPath) }],
      details: { mode: "single", status: "error", summaryPath, runs: this.runs } satisfies ScoutDetails,
      isError: true,
    };
  }

  private startRun(runPlan: ScoutRunPlan): ScoutRunDetails {
    const run = this.startedRunCount === 0
      ? this.currentRun()
      : createInitialRun(this.query);

    if (this.startedRunCount > 0) {
      this.runs.unshift(run);
    }

    this.startedRunCount += 1;
    this.currentModel = runPlan.model;
    run.status = "running";
    run.turns = 0;
    run.displayItems = [];
    run.activityPhase = "thinking";
    run.activityText = undefined;
    run.summaryText = undefined;
    run.error = undefined;
    run.startedAt = Date.now();
    run.endedAt = undefined;
    this.publishUpdate(true);
    return run;
  }

  private currentRun(): ScoutRunDetails {
    return this.runs[0]!;
  }

  private publishUpdate(force = false): void {
    const run = this.currentRun();
    if (!run || !this.currentModel) return;

    const now = Date.now();
    if (!force && now - this.lastUpdateAt < SINGLE_SCOUT_UPDATE_INTERVAL_MS) {
      return;
    }
    this.lastUpdateAt = now;

    const status = computeOverallStatus(this.runs);
    const text = run.summaryText ?? (status === "running" ? "(searching...)" : "(no output)");
    this.onUpdate?.({
      content: [{ type: "text", text }],
      details: {
        mode: "single",
        status,
        subagentProvider: this.currentModel.provider,
        subagentModelId: this.currentModel.id,
        runs: this.runs,
      } satisfies ScoutDetails,
    });
  }

  private attachAbortHandling(): () => void {
    if (!this.signal) return () => {};

    this.abortSignalListener = () => {
      void this.abort("Aborted");
    };
    this.signal.addEventListener("abort", this.abortSignalListener);

    return () => {
      if (!this.signal || !this.abortSignalListener) return;
      this.signal.removeEventListener("abort", this.abortSignalListener);
      this.abortSignalListener = undefined;
    };
  }

  private attachTimeout(): () => void {
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) return () => {};

    const timeout = setTimeout(() => {
      void this.abort(`Timed out after ${formatDuration(this.timeoutMs)}`);
    }, this.timeoutMs);
    timeout.unref?.();

    return () => clearTimeout(timeout);
  }

  private async abort(reason = "Aborted"): Promise<void> {
    if (this.abortRequested) return;
    this.abortRequested = true;
    this.abortReason = reason;
    this.phase = "aborting";

    const run = this.currentRun();
    if (run) {
      this.markRunAborted(run);
      this.publishUpdate(true);
    }

    await Promise.allSettled([...this.activeSessions].map((session) => session.abort()));
  }

  private wasAborted(): boolean {
    return this.abortRequested || !!this.signal?.aborted;
  }

  private markRunAborted(run: ScoutRunDetails): void {
    if (run.status !== "running") return;
    run.status = "aborted";
    run.summaryText = run.summaryText ?? this.abortReason;
    run.endedAt = Date.now();
  }

  private async runPlannedRun(runPlan: ScoutRunPlan): Promise<boolean> {
    const run = this.startRun(runPlan);

    let scoutSession: AgentSession | undefined;
    let stopObservingSession: (() => void) | undefined;

    try {
      const resourceLoader = await this.createResourceLoader(runPlan);
      const { session } = await this.createSession(runPlan, resourceLoader);
      scoutSession = session;
      this.activeSessions.add(scoutSession as AbortableSession);
      stopObservingSession = this.observeSession(run, scoutSession);

      await scoutSession.prompt(this.userPrompt, { expandPromptTemplates: false });
      this.completeSuccessfulRun(run, scoutSession);
      return false;
    } catch (error) {
      const message = this.wasAborted() ? this.abortReason : error instanceof Error ? error.message : String(error);
      this.completeFailedRun(run, message);
      return !this.wasAborted() && this.hasAnotherRunAfter(runPlan);
    } finally {
      if (scoutSession) this.activeSessions.delete(scoutSession as AbortableSession);
      stopObservingSession?.();
      scoutSession?.dispose();
    }
  }

  private hasAnotherRunAfter(runPlan: ScoutRunPlan): boolean {
    const index = this.runPlans.indexOf(runPlan);
    return index >= 0 && index < this.runPlans.length - 1;
  }

  private createResourceLoader(runPlan: ScoutRunPlan): Promise<ResourceLoader> {
    return createScoutResourceLoader({
      cwd: this.ctx.cwd,
      noSkills: true,
      allowExtensions: shouldLoadScoutExtensions(runPlan.model.provider),
      extensionFactories: [],
      systemPromptOverride: () => this.systemPrompt,
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
    });
  }

  private async createSession(
    runPlan: ScoutRunPlan,
    resourceLoader: ResourceLoader,
  ): Promise<{ session: AgentSession }> {
    const { builtinTools, customTools } = prepareScoutTools(this.config, this.ctx.cwd, this.ctx);
    const activeToolNames = [...builtinTools, ...customTools.map((tool) => tool.name)];
    return createAgentSession({
      cwd: this.ctx.cwd,
      modelRegistry: this.ctx.modelRegistry,
      resourceLoader,
      sessionManager: SessionManager.inMemory(this.ctx.cwd),
      model: runPlan.model,
      thinkingLevel: runPlan.thinkingLevel,
      tools: activeToolNames,
      customTools,
    });
  }

  private observeSession(run: ScoutRunDetails, session: AgentSession): () => void {
    return session.subscribe((event: AgentSessionEvent) => {
      switch (event.type) {
        case "turn_end": {
          run.turns += 1;
          const items = extractDisplayItems(session.state.messages);
          run.displayItems = items.length > MAX_DISPLAY_ITEMS
            ? items.slice(items.length - MAX_DISPLAY_ITEMS)
            : items;
          if (event.toolResults.length > 0) {
            run.activityPhase = "thinking";
            run.activityText = undefined;
          }
          this.publishUpdate();
          break;
        }
        case "message_update": {
          if (event.message.role !== "assistant") break;

          if (event.assistantMessageEvent.type.startsWith("thinking")) {
            run.activityPhase = "thinking";
            run.activityText = undefined;
            this.publishUpdate();
            break;
          }

          if (event.assistantMessageEvent.type.startsWith("toolcall")) {
            run.activityPhase = "calling_tools";
            run.activityText = undefined;
            this.publishUpdate();
            break;
          }

          if (event.assistantMessageEvent.type.startsWith("text")) {
            run.activityPhase = "writing_summary";
            const text = getAssistantText(event.message).trim();
            if (text) run.activityText = text;
            this.publishUpdate();
          }
          break;
        }
        case "message_end": {
          if (event.message.role !== "assistant") break;
          const text = getAssistantText(event.message).trim();
          if (text) {
            run.activityPhase = "writing_summary";
            run.activityText = text;
            this.publishUpdate();
          }
          break;
        }
        case "tool_execution_start": {
          run.activityPhase = "calling_tools";
          run.activityText = undefined;
          run.displayItems.push({
            type: "tool",
            name: event.toolName,
            args: event.args ?? {},
            toolCallId: event.toolCallId,
          });
          if (run.displayItems.length > MAX_DISPLAY_ITEMS) {
            run.displayItems.splice(0, run.displayItems.length - MAX_DISPLAY_ITEMS);
          }
          this.publishUpdate();
          break;
        }
        case "tool_execution_update": {
          run.activityPhase = "calling_tools";
          run.activityText = undefined;
          for (let i = run.displayItems.length - 1; i >= 0; i--) {
            const item = run.displayItems[i];
            if (item.type === "tool" && item.toolCallId === event.toolCallId) {
              const text = extractToolResultText(event.partialResult);
              if (text) item.result = text;
              item.isPartial = true;
              const nestedScout = scoutDetailsFromUnknown(event.partialResult?.details);
              if (nestedScout) item.nestedScout = nestedScout;
              break;
            }
          }
          this.publishUpdate();
          break;
        }
        case "tool_execution_end": {
          run.activityPhase = "calling_tools";
          run.activityText = undefined;
          for (let i = run.displayItems.length - 1; i >= 0; i--) {
            const item = run.displayItems[i];
            if (item.type === "tool" && item.toolCallId === event.toolCallId) {
              if (event.isError) item.isError = true;
              item.isPartial = false;
              const text = extractToolResultText(event.result);
              if (text) item.result = text;
              const nestedScout = scoutDetailsFromUnknown(event.result?.details);
              if (nestedScout) item.nestedScout = nestedScout;
              break;
            }
          }
          this.publishUpdate();
          break;
        }
      }
    });
  }

  private completeSuccessfulRun(run: ScoutRunDetails, session: AgentSession): void {
    run.displayItems = extractDisplayItems(session.state.messages);
    run.activityPhase = undefined;
    run.activityText = undefined;
    if (this.wasAborted()) {
      run.summaryText = this.abortReason;
      run.status = "aborted";
    } else {
      run.summaryText = getLastAssistantText(session.state.messages).trim() || "(no output)";
      run.status = "done";
    }
    run.endedAt = Date.now();
    this.publishUpdate(true);
  }

  private completeFailedRun(run: ScoutRunDetails, message: string): void {
    run.activityPhase = undefined;
    run.activityText = undefined;
    run.status = this.wasAborted() ? "aborted" : "error";
    run.error = this.wasAborted() ? undefined : message;
    run.summaryText = message;
    run.endedAt = Date.now();
    this.publishUpdate(true);
  }

  private buildResult(): ScoutExecutionResult {
    const run = this.currentRun();
    const status = computeOverallStatus(this.runs);
    const output = run.summaryText ?? "(no output)";
    const summaryPath = saveSummary(this.config.name, output);

    return {
      content: [{ type: "text", text: appendSummaryNotice(output, summaryPath) }],
      details: {
        mode: "single",
        status,
        runs: this.runs,
        subagentProvider: this.currentModel?.provider,
        subagentModelId: this.currentModel?.id,
        summaryPath,
      } satisfies ScoutDetails,
      isError: status === "error",
    };
  }
}

// Execute a scout subagent session
export async function executeScout(
  config: ScoutConfig,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: ((update: ScoutUpdate) => void) | undefined,
  ctx: ExtensionContext,
): Promise<ScoutExecutionResult> {
  const restoreMaxListeners = bumpDefaultEventTargetMaxListeners();
  try {
    return await new ScoutWorkflow(config, params, signal, onUpdate, ctx).run();
  } finally {
    restoreMaxListeners();
  }
}
