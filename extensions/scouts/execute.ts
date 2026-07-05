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

import { extractDisplayItems, extractToolResultText, formatToolCallParts, getAssistantText, getLastAssistantText, MAX_DISPLAY_ITEMS, scoutDetailsFromUnknown, shorten } from "./display.ts";
import { defaultModelTargetsForScout, formatModelTarget, parseModelTarget, resolveFirstAvailableModelTarget, type ScoutModelTarget } from "./models.ts";
import { loadScoutUserConfig, ScoutUserConfigError } from "./user-config.ts";
import { createScoutResourceLoader } from "./resources.ts";
import { generateRunId, getSuspendedRun, suspendRun, takeRunForResume, type SuspendedRunEntry, type SuspendReason, type TakeSuspendedRunFailureReason } from "./runs.ts";
import { computeOverallStatus, createErrorScoutDetails, createInitialRun } from "./state.ts";
import { DEFAULT_SCOUT_TIMEOUT_MS, type ScoutConfig, type ScoutDetails } from "./types.ts";

type ScoutRunDetails = ScoutDetails["runs"][number];
type ScoutDisplayToolItem = Extract<ScoutRunDetails["displayItems"][number], { type: "tool" }>;

// EventTarget max listeners management for nested sessions
const DEFAULT_EVENTTARGET_MAX_LISTENERS = 100;
const EVENTTARGET_MAX_LISTENERS_STATE_KEY = Symbol.for("pi.eventTargetMaxListenersState");
type BuiltinToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
const BUILTIN_TOOL_NAMES = new Set<BuiltinToolName>(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const SINGLE_SCOUT_UPDATE_INTERVAL_MS = 150;
const WRAP_UP_WARNING_BEFORE_TIMEOUT_MS = 90_000;
const WRAP_UP_WARNING_MIN_TIMEOUT_MS = 3 * 60_000;
const WRAP_UP_WARNING_MESSAGE = "[scout time budget] About 90 seconds remain before this run is stopped. If you can finish, stop new work and write your final answer now. If substantial work legitimately remains, write a summary of progress so far and end it with a final line exactly of the form: MORE TIME NEEDED: <one line describing what remains>. The caller can then grant more time and resume this run.";

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

const RUN_ID_PREFIX_BY_TOOL_NAME: Record<string, string> = {
  worker: "wkr",
  finder: "fnd",
  oracle: "orc",
  librarian: "lib",
  specialist: "spc",
  reviewer: "rev",
};

function scoutToolName(configName: string): string {
  return configName.split(":", 1)[0] || configName;
}

function runIdPrefixForConfig(configName: string): string {
  const toolName = scoutToolName(configName);
  const explicitPrefix = RUN_ID_PREFIX_BY_TOOL_NAME[toolName];
  if (explicitPrefix) return explicitPrefix;

  const consonants = toolName.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/[aeiou]/g, "");
  return consonants.slice(0, 3) || "sct";
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
type ActiveSession = Pick<AgentSession, "abort" | "steer">;

export function extractMoreTimeRequest(summaryText: string): string | undefined {
  const lines = summaryText.split("\n");
  let lastLine: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line) {
      lastLine = line;
      break;
    }
  }
  if (!lastLine) return undefined;
  const match = /^MORE TIME NEEDED:\s*(.+)$/.exec(lastLine);
  return match?.[1]?.trim() || undefined;
}

type ResultSuspensionInfo = Pick<SuspendedRunEntry, "runId" | "toolName" | "suspendReason" | "expiresAt">;

const LAST_ACTIVITY_MAX_CHARS = 1_500;
const TOOL_SUMMARY_MAX_CHARS = 200;
const MORE_TIME_MAX_CHARS = 500;

export function buildScoutResultOutput(run: ScoutRunDetails, suspension?: ResultSuspensionInfo): string {
  const output = run.summaryText ?? "(no output)";

  if (run.status === "aborted" && suspension?.suspendReason === "timeout") {
    return buildTimeoutResultOutput(run, suspension);
  }

  if (run.status === "done" && run.moreTimeRequested) {
    return appendMoreTimeRequest(output, run.moreTimeRequested, suspension?.suspendReason === "more_time_requested" ? suspension : undefined);
  }

  return output;
}

function buildTimeoutResultOutput(run: ScoutRunDetails, suspension: ResultSuspensionInfo): string {
  const parts = [
    `Timed out after ${formatElapsedRunTime(run)} (${formatTurnCount(run.turns)}). ${formatResumeAffordance(suspension)}`,
  ];

  const activityText = run.activityText?.trim();
  if (activityText) {
    parts.push(`Last activity:\n${shorten(activityText, LAST_ACTIVITY_MAX_CHARS)}`);
  }

  const tools = summarizeToolsUsed(run.displayItems);
  if (tools) parts.push(`Tools used: ${tools}`);

  return parts.join("\n\n");
}

function appendMoreTimeRequest(output: string, moreTimeRequested: string, suspension: ResultSuspensionInfo | undefined): string {
  const lines = [
    "---",
    `Scout requested more time. Remaining work: ${shorten(oneLine(moreTimeRequested), MORE_TIME_MAX_CHARS)}`,
  ];
  if (suspension) lines.push(formatMoreTimeResumeLine(suspension));
  return `${output}\n\n${lines.join("\n")}`;
}

function formatResumeAffordance(suspension: ResultSuspensionInfo): string {
  if (isWorkerSuspension(suspension)) {
    return `Session suspended and resumable until ${formatExpiration(suspension.expiresAt)}: ${formatResumeInstruction(suspension)}`;
  }

  return formatSuspensionNotice(suspension);
}

function formatMoreTimeResumeLine(suspension: ResultSuspensionInfo): string {
  if (isWorkerSuspension(suspension)) {
    return `Resumable until ${formatExpiration(suspension.expiresAt)}: ${formatResumeInstruction(suspension)}`;
  }

  return formatSuspensionNotice(suspension);
}

function formatResumeInstruction(suspension: ResultSuspensionInfo): string {
  return `call worker({ resume: "${suspension.runId}" }) with an optional follow-up query.`;
}

function formatSuspensionNotice(suspension: ResultSuspensionInfo): string {
  return `Session suspended (runId ${suspension.runId}, expires ${formatExpiration(suspension.expiresAt)}).`;
}

function isWorkerSuspension(suspension: ResultSuspensionInfo): boolean {
  return suspension.toolName === "worker";
}

function summarizeToolsUsed(displayItems: ScoutRunDetails["displayItems"]): string | undefined {
  const toolItems = displayItems.filter((item): item is ScoutDisplayToolItem => item.type === "tool");
  if (toolItems.length === 0) return undefined;

  const counts = new Map<string, number>();
  for (const item of toolItems) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  }

  const tally = [...counts].map(([name, count]) => `${name} x${count}`).join(", ");
  const lastTool = toolItems[toolItems.length - 1]!;
  return `${tally} (last: ${formatToolItemSummary(lastTool)})`;
}

function formatToolItemSummary(item: ScoutDisplayToolItem): string {
  const parts = formatToolCallParts(item.name, item.args);
  const summary = oneLine(parts.summary);
  return shorten(summary ? `${parts.label} ${summary}` : parts.label, TOOL_SUMMARY_MAX_CHARS);
}

function formatTurnCount(turns: number): string {
  return `${turns} ${turns === 1 ? "turn" : "turns"}`;
}

function formatElapsedRunTime(run: ScoutRunDetails): string {
  const endedAt = run.endedAt ?? Date.now();
  const elapsedMs = Math.max(0, endedAt - run.startedAt);
  if (elapsedMs >= 60_000) return `${Math.max(1, Math.round(elapsedMs / 60_000))}m`;
  return `${Math.max(1, Math.round(elapsedMs / 1_000))}s`;
}

function formatExpiration(expiresAt: number): string {
  return new Date(expiresAt).toISOString();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function selectResumeFollowUpPrompt(followUp: unknown): string {
  const text = typeof followUp === "string" ? followUp.trim() : "";
  return text || "Continue where you left off. Your time budget has been refreshed.";
}

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

function disposeSessionSafely(session: AgentSession): void {
  try {
    session.dispose();
  } catch {
  }
}

function buildNotResumableResult(runId: string, reason: TakeSuspendedRunFailureReason): ScoutExecutionResult {
  const text = `Run ${runId} is not resumable (${reason}). Dispatch a fresh worker with the full task instead.`;
  return {
    content: [{ type: "text", text }],
    details: createErrorScoutDetails(`resume ${runId}`, text),
    isError: true,
  };
}

function parseModelInfo(modelInfo: string): { provider?: string; modelId?: string } {
  const plain = modelInfo.replace(/\s+\([^)]*\)$/, "");
  const slash = plain.indexOf("/");
  if (slash <= 0 || slash === plain.length - 1) return {};
  return { provider: plain.slice(0, slash), modelId: plain.slice(slash + 1) };
}

function cloneScoutRunDetails(run: ScoutRunDetails): ScoutRunDetails {
  return {
    ...run,
    displayItems: structuredClone(run.displayItems),
  };
}

function observeScoutSession(run: ScoutRunDetails, session: AgentSession, publishUpdate: (force?: boolean) => void): () => void {
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
        publishUpdate();
        break;
      }
      case "message_update": {
        if (event.message.role !== "assistant") break;

        if (event.assistantMessageEvent.type.startsWith("thinking")) {
          run.activityPhase = "thinking";
          run.activityText = undefined;
          publishUpdate();
          break;
        }

        if (event.assistantMessageEvent.type.startsWith("toolcall")) {
          run.activityPhase = "calling_tools";
          run.activityText = undefined;
          publishUpdate();
          break;
        }

        if (event.assistantMessageEvent.type.startsWith("text")) {
          run.activityPhase = "writing_summary";
          const text = getAssistantText(event.message).trim();
          if (text) run.activityText = text;
          publishUpdate();
        }
        break;
      }
      case "message_end": {
        if (event.message.role !== "assistant") break;
        const text = getAssistantText(event.message).trim();
        if (text) {
          run.activityPhase = "writing_summary";
          run.activityText = text;
          publishUpdate();
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
        publishUpdate();
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
        publishUpdate();
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
        publishUpdate();
        break;
      }
    }
  });
}

function completeSuccessfulScoutRun(
  run: ScoutRunDetails,
  session: AgentSession,
  wasAborted: boolean,
  timedOut: boolean,
  abortReason: string,
  publishUpdate: (force?: boolean) => void,
): void {
  run.displayItems = extractDisplayItems(session.state.messages);
  run.activityPhase = undefined;
  if (wasAborted) {
    if (!timedOut) run.activityText = undefined;
    run.summaryText = abortReason;
    run.status = "aborted";
  } else {
    run.activityText = undefined;
    run.summaryText = getLastAssistantText(session.state.messages).trim() || "(no output)";
    run.moreTimeRequested = extractMoreTimeRequest(run.summaryText);
    run.status = "done";
  }
  run.endedAt = Date.now();
  publishUpdate(true);
}

function completeFailedScoutRun(
  run: ScoutRunDetails,
  wasAborted: boolean,
  timedOut: boolean,
  message: string,
  publishUpdate: (force?: boolean) => void,
): void {
  run.activityPhase = undefined;
  if (!wasAborted || !timedOut) run.activityText = undefined;
  run.status = wasAborted ? "aborted" : "error";
  run.error = wasAborted ? undefined : message;
  run.summaryText = message;
  run.endedAt = Date.now();
  publishUpdate(true);
}

function suspendReasonForScoutRun(
  run: ScoutRunDetails,
  timedOut: boolean,
  wasAborted: boolean,
  abortReason: string,
  timeoutAbortReason: string | undefined,
): SuspendReason | undefined {
  if (timedOut
    && wasAborted
    && abortReason === timeoutAbortReason
    && run.status === "aborted") {
    return "timeout";
  }

  if (!wasAborted && run.status === "done" && run.moreTimeRequested) {
    return "more_time_requested";
  }

  return undefined;
}

class ResumeScoutWorkflow {
  private readonly run: ScoutRunDetails;
  private readonly timeoutMs: number;
  private readonly activeSessions = new Set<ActiveSession>();
  private readonly modelInfo: { provider?: string; modelId?: string };

  private phase: ScoutWorkflowPhase = "planning";
  private abortRequested = false;
  private abortSignalListener?: () => void;
  private abortReason = "Aborted";
  private timedOut = false;
  private timeoutAbortReason?: string;
  private suspendedEntry?: SuspendedRunEntry;
  private lastUpdateAt = 0;

  constructor(
    private readonly entry: SuspendedRunEntry,
    private readonly followUp: unknown,
    private readonly signal: AbortSignal | undefined,
    private readonly onUpdate: ((update: ScoutUpdate) => void) | undefined,
  ) {
    this.run = cloneScoutRunDetails(entry.runDetails);
    this.timeoutMs = entry.timeoutMs;
    this.modelInfo = parseModelInfo(entry.modelInfo);
  }

  async runResumed(): Promise<ScoutExecutionResult> {
    let sessionFinalized = false;
    try {
      this.prepareRunForResume();

      if (this.signal?.aborted) {
        this.phase = "aborting";
        this.abortRequested = true;
        this.markRunAborted(this.run);
        this.publishUpdate(true);
        disposeSessionSafely(this.entry.session);
        sessionFinalized = true;
        this.phase = "finished";
        return this.buildResult();
      }

      this.phase = "running";
      const detachAbortHandling = this.attachAbortHandling();
      const detachTimeout = this.attachTimeout();
      let stopObservingSession: (() => void) | undefined;

      try {
        this.activeSessions.add(this.entry.session as ActiveSession);
        stopObservingSession = observeScoutSession(this.run, this.entry.session, (force) => this.publishUpdate(force));
        await this.entry.session.prompt(selectResumeFollowUpPrompt(this.followUp), { expandPromptTemplates: false });
        this.completeSuccessfulRun(this.run, this.entry.session);
      } catch (error) {
        const message = this.wasAborted() ? this.abortReason : error instanceof Error ? error.message : String(error);
        this.completeFailedRun(this.run, message);
      } finally {
        this.activeSessions.delete(this.entry.session as ActiveSession);
        stopObservingSession?.();
        detachTimeout();
        detachAbortHandling();

        const suspendReason = this.suspendReasonForRun(this.run);
        if (suspendReason) {
          this.suspendedEntry = suspendRun({
            runId: this.entry.runId,
            session: this.entry.session,
            configName: this.entry.configName,
            toolName: this.entry.toolName,
            isMutatingWorker: this.entry.isMutatingWorker,
            modelInfo: this.entry.modelInfo,
            runDetails: cloneScoutRunDetails(this.run),
            suspendReason,
            timeoutMs: this.timeoutMs,
          });
        } else {
          disposeSessionSafely(this.entry.session);
        }
        sessionFinalized = true;
      }

      this.phase = "finished";
      return this.buildResult();
    } catch (error) {
      if (!sessionFinalized) disposeSessionSafely(this.entry.session);
      throw error;
    }
  }

  private prepareRunForResume(): void {
    this.run.status = "running";
    this.run.activityPhase = "thinking";
    this.run.activityText = undefined;
    this.run.summaryText = undefined;
    this.run.moreTimeRequested = undefined;
    this.run.error = undefined;
    this.run.endedAt = undefined;
    this.publishUpdate(true);
  }

  private publishUpdate(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastUpdateAt < SINGLE_SCOUT_UPDATE_INTERVAL_MS) {
      return;
    }
    this.lastUpdateAt = now;

    const runs = [this.run];
    const status = computeOverallStatus(runs);
    const text = this.run.summaryText ?? (status === "running" ? "(searching...)" : "(no output)");
    this.onUpdate?.({
      content: [{ type: "text", text }],
      details: {
        mode: "single",
        status,
        subagentProvider: this.modelInfo.provider,
        subagentModelId: this.modelInfo.modelId,
        runs,
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

    let wrapUpWarning: ReturnType<typeof setTimeout> | undefined;
    if (this.timeoutMs >= WRAP_UP_WARNING_MIN_TIMEOUT_MS) {
      wrapUpWarning = setTimeout(() => {
        if (this.phase !== "running" || this.abortRequested || this.run.status !== "running") return;
        this.steerActiveSessions(WRAP_UP_WARNING_MESSAGE);
      }, this.timeoutMs - WRAP_UP_WARNING_BEFORE_TIMEOUT_MS);
      wrapUpWarning.unref?.();
    }

    const timeout = setTimeout(() => {
      if (this.abortRequested) return;
      const reason = `Timed out after ${formatDuration(this.timeoutMs)}`;
      this.timedOut = true;
      this.timeoutAbortReason = reason;
      void this.abort(reason);
    }, this.timeoutMs);
    timeout.unref?.();

    return () => {
      if (wrapUpWarning) clearTimeout(wrapUpWarning);
      clearTimeout(timeout);
    };
  }

  private steerActiveSessions(message: string): void {
    for (const session of [...this.activeSessions]) {
      try {
        void session.steer(message).catch(() => {});
      } catch {
      }
    }
  }

  private async abort(reason = "Aborted"): Promise<void> {
    if (this.abortRequested) return;
    this.abortRequested = true;
    this.abortReason = reason;
    this.phase = "aborting";
    this.markRunAborted(this.run);
    this.publishUpdate(true);
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

  private completeSuccessfulRun(run: ScoutRunDetails, session: AgentSession): void {
    completeSuccessfulScoutRun(run, session, this.wasAborted(), this.timedOut, this.abortReason, (force) => this.publishUpdate(force));
  }

  private completeFailedRun(run: ScoutRunDetails, message: string): void {
    completeFailedScoutRun(run, this.wasAborted(), this.timedOut, message, (force) => this.publishUpdate(force));
  }

  private suspendReasonForRun(run: ScoutRunDetails): SuspendReason | undefined {
    return suspendReasonForScoutRun(run, this.timedOut, this.wasAborted(), this.abortReason, this.timeoutAbortReason);
  }

  private buildResult(): ScoutExecutionResult {
    const runs = [this.run];
    const status = computeOverallStatus(runs);
    const suspension = this.suspendedEntry ? getSuspendedRun(this.suspendedEntry.runId) : undefined;
    const output = buildScoutResultOutput(this.run, suspension);
    const summaryPath = saveSummary(this.entry.configName, output);

    return {
      content: [{ type: "text", text: appendSummaryNotice(output, summaryPath) }],
      details: {
        mode: "single",
        status,
        runs,
        subagentProvider: this.modelInfo.provider,
        subagentModelId: this.modelInfo.modelId,
        summaryPath,
      } satisfies ScoutDetails,
      isError: status === "error",
    };
  }
}

class ScoutWorkflow {
  private readonly runId: string;
  private readonly timeoutMs: number;
  private readonly query: string;
  private readonly userPrompt: string;
  private readonly systemPrompt: string;
  private readonly runPlans: ScoutRunPlan[];
  private readonly activeSessions = new Set<ActiveSession>();
  private readonly runs: ScoutRunDetails[];
  private readonly planningError?: string;

  private phase: ScoutWorkflowPhase = "planning";
  private startedRunCount = 0;
  private currentModel?: Model<Api>;
  private abortRequested = false;
  private abortSignalListener?: () => void;
  private abortReason = "Aborted";
  private timedOut = false;
  private timeoutAbortReason?: string;
  private suspendedEntry?: SuspendedRunEntry;
  private lastUpdateAt = 0;

  constructor(
    private readonly config: ScoutConfig,
    private readonly params: Record<string, unknown>,
    private readonly signal: AbortSignal | undefined,
    private readonly onUpdate: ((update: ScoutUpdate) => void) | undefined,
    private readonly ctx: ExtensionContext,
  ) {
    this.runId = generateRunId(runIdPrefixForConfig(config.name));
    this.timeoutMs = config.timeoutMs ?? DEFAULT_SCOUT_TIMEOUT_MS;
    this.query = String(params.query ?? "");
    this.userPrompt = config.buildUserPrompt(params);
    this.systemPrompt = config.buildSystemPrompt(this.timeoutMs);
    this.runs = [createInitialRun(this.query, this.runId)];

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
      : createInitialRun(this.query, this.runId);

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
    run.moreTimeRequested = undefined;
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

    let wrapUpWarning: ReturnType<typeof setTimeout> | undefined;
    if (this.timeoutMs >= WRAP_UP_WARNING_MIN_TIMEOUT_MS) {
      wrapUpWarning = setTimeout(() => {
        if (this.phase !== "running" || this.abortRequested || this.currentRun().status !== "running") return;
        this.steerActiveSessions(WRAP_UP_WARNING_MESSAGE);
      }, this.timeoutMs - WRAP_UP_WARNING_BEFORE_TIMEOUT_MS);
      wrapUpWarning.unref?.();
    }

    const timeout = setTimeout(() => {
      if (this.abortRequested) return;
      const reason = `Timed out after ${formatDuration(this.timeoutMs)}`;
      this.timedOut = true;
      this.timeoutAbortReason = reason;
      void this.abort(reason);
    }, this.timeoutMs);
    timeout.unref?.();

    return () => {
      if (wrapUpWarning) clearTimeout(wrapUpWarning);
      clearTimeout(timeout);
    };
  }

  private steerActiveSessions(message: string): void {
    for (const session of [...this.activeSessions]) {
      try {
        void session.steer(message).catch(() => {});
      } catch {
      }
    }
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
      this.activeSessions.add(scoutSession as ActiveSession);
      stopObservingSession = observeScoutSession(run, scoutSession, (force) => this.publishUpdate(force));

      await scoutSession.prompt(this.userPrompt, { expandPromptTemplates: false });
      this.completeSuccessfulRun(run, scoutSession);
      return false;
    } catch (error) {
      const message = this.wasAborted() ? this.abortReason : error instanceof Error ? error.message : String(error);
      this.completeFailedRun(run, message);
      return !this.wasAborted() && this.hasAnotherRunAfter(runPlan);
    } finally {
      if (scoutSession) this.activeSessions.delete(scoutSession as ActiveSession);
      stopObservingSession?.();
      const suspendReason = this.suspendReasonForRun(run);
      if (scoutSession && suspendReason) {
        this.suspendedEntry = suspendRun({
          runId: this.runId,
          session: scoutSession,
          configName: this.config.name,
          toolName: scoutToolName(this.config.name),
          isMutatingWorker: this.config.isMutatingWorker === true,
          modelInfo: this.formatModelInfo(runPlan),
          runDetails: cloneScoutRunDetails(run),
          suspendReason,
          timeoutMs: this.timeoutMs,
        });
      } else {
        scoutSession?.dispose();
      }
    }
  }

  private suspendReasonForRun(run: ScoutRunDetails): SuspendReason | undefined {
    return suspendReasonForScoutRun(run, this.timedOut, this.wasAborted(), this.abortReason, this.timeoutAbortReason);
  }

  private formatModelInfo(runPlan: ScoutRunPlan): string {
    const modelInfo = `${runPlan.model.provider}/${runPlan.model.id}`;
    return runPlan.thinkingLevel ? `${modelInfo} (${runPlan.thinkingLevel})` : modelInfo;
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

  private completeSuccessfulRun(run: ScoutRunDetails, session: AgentSession): void {
    completeSuccessfulScoutRun(run, session, this.wasAborted(), this.timedOut, this.abortReason, (force) => this.publishUpdate(force));
  }

  private completeFailedRun(run: ScoutRunDetails, message: string): void {
    completeFailedScoutRun(run, this.wasAborted(), this.timedOut, message, (force) => this.publishUpdate(force));
  }

  private buildResult(): ScoutExecutionResult {
    const run = this.currentRun();
    const status = computeOverallStatus(this.runs);
    const suspension = this.suspendedEntry ? getSuspendedRun(this.suspendedEntry.runId) : undefined;
    const output = buildScoutResultOutput(run, suspension);
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

export async function resumeScout(
  runId: string,
  followUp: unknown,
  signal: AbortSignal | undefined,
  onUpdate: ((update: ScoutUpdate) => void) | undefined,
): Promise<ScoutExecutionResult> {
  const taken = takeRunForResume(runId);
  if (!taken.ok) return buildNotResumableResult(runId, taken.reason);

  const restoreMaxListeners = bumpDefaultEventTargetMaxListeners();
  try {
    return await new ResumeScoutWorkflow(taken.entry, followUp, signal, onUpdate).runResumed();
  } finally {
    restoreMaxListeners();
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
