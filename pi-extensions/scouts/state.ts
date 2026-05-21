// Shared state helpers for scout execution and result shaping.

import type { ScoutDetails } from "./types.ts";

type ScoutStatus = ScoutDetails["status"];
type ScoutRunDetails = ScoutDetails["runs"][number];

const SCOUT_PARALLEL_IDLE_DELAY_MS = 2_000;
const activeScoutToolCalls = new Set<string>();
let parallelScoutMode = false;
let nextSyntheticScoutToolCallId = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

export function trackScoutToolCall(toolCallId: string | undefined): () => void {
  const id = toolCallId || `synthetic-${++nextSyntheticScoutToolCallId}`;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  activeScoutToolCalls.add(id);
  if (activeScoutToolCalls.size > 1) {
    parallelScoutMode = true;
  }
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;

    // Keep parallel mode alive long enough for Pi to render the final tool
    // result after execute() resolves. ToolExecutionComponent receives that
    // result after the tool promise settles, so clearing synchronously here
    // would make the final render miss the overlap that just occurred.
    setTimeout(() => {
      activeScoutToolCalls.delete(id);
      if (activeScoutToolCalls.size === 0) {
        idleTimer = setTimeout(() => {
          if (activeScoutToolCalls.size === 0) {
            parallelScoutMode = false;
          }
          idleTimer = undefined;
        }, SCOUT_PARALLEL_IDLE_DELAY_MS);
      }
    }, 0);
  };
}

export function isParallelScoutMode(): boolean {
  return parallelScoutMode || activeScoutToolCalls.size > 1;
}

export function hasActiveScoutToolCalls(): boolean {
  return activeScoutToolCalls.size > 0;
}

export function createInitialRun(query: string): ScoutRunDetails {
  return {
    status: "running",
    query,
    turns: 0,
    displayItems: [],
    activityPhase: "thinking",
    startedAt: Date.now(),
  };
}

export function createRunningScoutDetails(query: string): ScoutDetails {
  return {
    mode: "single",
    status: "running",
    runs: [createInitialRun(query)],
  };
}

export function createErrorScoutDetails(query: string, error: string): ScoutDetails {
  const run = createInitialRun(query);
  run.status = "error";
  run.error = error;
  run.summaryText = error;
  run.endedAt = Date.now();

  return {
    mode: "single",
    status: "error",
    runs: [run],
  };
}

export function computeOverallStatus(runs: ScoutRunDetails[]): ScoutStatus {
  if (runs.some((run) => run.status === "running")) return "running";
  if (runs.some((run) => run.status === "error")) return "error";
  if (runs.length > 0 && runs.every((run) => run.status === "aborted")) return "aborted";
  return "done";
}
