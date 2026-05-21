// Shared types for scout subagents.

import type { ThinkingLevel } from "@mariozechner/pi-ai";

import type { ScoutWorkload } from "./models.ts";

type ScoutStatus = "running" | "done" | "error" | "aborted";
type ScoutActivityPhase = "thinking" | "calling_tools" | "writing_summary";

// Scout-local timeline projection derived from pi message/tool-result types.
export type DisplayItem =
  | { type: "tool"; name: string; args: Record<string, unknown>; isError?: boolean; isPartial?: boolean; toolCallId?: string; result?: string; nestedScout?: ScoutDetails }
  | { type: "text"; text: string };

interface ScoutRunDetails {
  status: ScoutStatus;
  query: string;
  turns: number;
  displayItems: DisplayItem[];
  activityPhase?: ScoutActivityPhase;
  activityText?: string;
  summaryText?: string;
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

export interface ScoutConfig {
  name: string;
  maxTurns: number;
  /** Optional fixed model for this scout config. Used before workload resolution. */
  configuredModel?: string;
  /** Optional scout workload. Drives provider-preserving profile selection when no explicit model override is set. */
  workload?: ScoutWorkload;
  /** Optional family→partner map for cross-family diversity. When set and no
   *  explicit/configured override applies, the scout tries a partner-family
   *  model before falling back to the in-family workload resolution. */
  diversityPartners?: Record<string, string[]>;
  /** Default thinking level. Overrides the selected model's default when set. */
  defaultThinkingLevel?: ThinkingLevel;
  buildSystemPrompt: (maxTurns: number) => string;
  buildUserPrompt: (params: Record<string, unknown>) => string;
  /**
   * Override the default tool set. If provided, replaces the defaults entirely.
   * Built-in tools (name matches allTools) go to `tools`, others go to `customTools`.
   */
  createTools?: (cwd: string, ctx?: import("@mariozechner/pi-coding-agent").ExtensionContext) => any[];
}
