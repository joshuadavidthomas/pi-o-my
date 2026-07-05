import { afterEach, describe, expect, it } from "bun:test";

import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { disposeSuspendedRun, generateRunId, listSuspendedRuns, suspendRun, takeRunForResume, type SuspendedRunInput } from "../runs.ts";
import type { ScoutDetails } from "../types.ts";
import { executeWorkerToolCall } from "./tool.ts";

type ScoutRunDetails = ScoutDetails["runs"][number];
type MockSession = AgentSession & { disposed: boolean };

function cleanupSuspendedRuns(): void {
  for (const run of listSuspendedRuns()) {
    disposeSuspendedRun(run.runId);
  }
}

function createMockSession(): MockSession {
  return {
    disposed: false,
    dispose() {
      this.disposed = true;
    },
  } as MockSession;
}

function runDetails(runId: string): ScoutRunDetails {
  return {
    runId,
    status: "aborted",
    query: "test query",
    turns: 2,
    displayItems: [],
    summaryText: "Timed out",
    startedAt: Date.now() - 1_000,
    endedAt: Date.now(),
  };
}

function suspendedRun(overrides: Partial<SuspendedRunInput> = {}): SuspendedRunInput {
  const runId = overrides.runId ?? generateRunId("wkr");
  return {
    runId,
    session: createMockSession(),
    configName: "worker",
    toolName: "worker",
    isMutatingWorker: true,
    modelInfo: "provider/model",
    runDetails: runDetails(runId),
    suspendReason: "timeout",
    timeoutMs: 10_000,
    ...overrides,
  };
}

function scoutResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {
      mode: "single" as const,
      status: "done" as const,
      runs: [{
        runId: "wkr-test",
        status: "done" as const,
        query: "query",
        turns: 1,
        displayItems: [],
        summaryText: text,
        startedAt: Date.now(),
        endedAt: Date.now(),
      }],
    },
    isError: false,
  };
}

afterEach(cleanupSuspendedRuns);

describe("executeWorkerToolCall", () => {
  it("blocks resuming a mutating suspended run while another mutating worker is active", async () => {
    const suspended = suspendRun(suspendedRun());
    let resolveFirst!: (value: ReturnType<typeof scoutResult>) => void;
    let resumeCalls = 0;
    const firstRun = new Promise<ReturnType<typeof scoutResult>>((resolve) => {
      resolveFirst = resolve;
    });
    const runners = {
      executeScout: async () => firstRun,
      resumeScout: async () => {
        resumeCalls += 1;
        return scoutResult("resumed");
      },
    };

    const activeRun = executeWorkerToolCall("active-worker", { query: "do work" }, undefined, undefined, {} as ExtensionContext, runners);
    const blocked = await executeWorkerToolCall("resume-worker", { resume: suspended.runId }, undefined, undefined, {} as ExtensionContext, runners);

    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]?.text).toContain("A mutating worker is already running");
    expect(resumeCalls).toBe(0);

    const taken = takeRunForResume(suspended.runId);
    expect(taken.ok).toBe(true);
    if (taken.ok) taken.entry.session.dispose();

    resolveFirst(scoutResult("done"));
    await activeRun;
  });
});
