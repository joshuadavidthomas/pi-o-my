// Shared types for scout subagents.

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type { ScoutModelTarget } from "./models.ts";

type ScoutStatus = "running" | "done" | "error" | "aborted";
type ScoutActivityPhase = "thinking" | "calling_tools" | "writing_summary";

// Scout-local timeline projection derived from pi message/tool-result types.
export type DisplayItem =
  | { type: "tool"; name: string; args: Record<string, unknown>; isError?: boolean; isPartial?: boolean; toolCallId?: string; result?: string; nestedScout?: ScoutDetails }
  | { type: "text"; text: string };

interface ScoutRunDetails {
  runId: string;
  status: ScoutStatus;
  query: string;
  turns: number;
  displayItems: DisplayItem[];
  activityPhase?: ScoutActivityPhase;
  activityText?: string;
  summaryText?: string;
  moreTimeRequested?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface ScoutDetails {
  mode: "single";
  status: ScoutStatus;
  subagentProvider?: string;
  subagentModelId?: string;
  summaryPath?: string;
  runs: ScoutRunDetails[];
}

export const DEFAULT_SCOUT_TIMEOUT_MS = 10 * 60 * 1000;

export interface ScoutConfig {
  name: string;
  /** Wall-clock timeout in milliseconds. Defaults to 10 minutes. */
  timeoutMs?: number;
  /** True for the mutating worker so suspended runs can reacquire the worker lock later. */
  isMutatingWorker?: boolean;
  /** Optional dynamic thinking level. Used for scout-specific effort knobs. */
  thinkingLevelForParams?: (params: Record<string, unknown>) => ThinkingLevel | undefined;
  /** Optional fixed model for this scout config. Tried before configured/default target lists. */
  configuredModel?: string;
  /** Ordered scout model targets. The first available target wins. */
  modelTargets?: ScoutModelTarget[];
  /** Default thinking level. Overrides the selected model's default when set. */
  defaultThinkingLevel?: ThinkingLevel;
  buildSystemPrompt: (timeoutMs: number) => string;
  buildUserPrompt: (params: Record<string, unknown>) => string;
  /**
   * Override the default tool set. If provided, replaces the defaults entirely.
   * Tool wrappers can mark themselves as scout custom tools to keep their
   * execute path even when their names match built-ins.
   */
  createTools?: (cwd: string, ctx?: import("@earendil-works/pi-coding-agent").ExtensionContext) => any[];
}
