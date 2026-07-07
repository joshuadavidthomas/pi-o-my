import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import {
  disposeSuspendedRun,
  generateRunId,
  getSuspendedRun,
  listSuspendedRuns,
  suspendRun,
  takeRunForResume,
  type SuspendedRunInput,
} from "./runs.ts";
import type { ScoutDetails } from "./types.ts";

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
    displayItems: [{ type: "text", text: "partial" }],
    activityText: "working",
    summaryText: "Timed out",
    startedAt: Date.now() - 1_000,
    endedAt: Date.now(),
  };
}

function suspendedRun(overrides: Partial<SuspendedRunInput> = {}): SuspendedRunInput {
  const runId = overrides.runId ?? generateRunId("tst");
  return {
    runId,
    session: createMockSession(),
    configName: "agent:implementation",
    toolName: "agent",
    isMutatingWorker: true,
    modelInfo: "provider/model",
    runDetails: runDetails(runId),
    suspendReason: "timeout",
    timeoutMs: 10_000,
    ...overrides,
  };
}

beforeEach(cleanupSuspendedRuns);
afterEach(cleanupSuspendedRuns);

describe("suspended scout runs", () => {
  it("generates unique short run ids with the requested prefix", () => {
    const ids = new Set<string>();

    for (let i = 0; i < 200; i++) {
      const runId = generateRunId("agt");
      expect(runId).toMatch(/^agt-[a-f0-9]{6}$/);
      ids.add(runId);
    }

    expect(ids.size).toBe(200);
  });

  it("suspends and takes a run for resume", () => {
    const input = suspendedRun();
    const entry = suspendRun(input);

    expect(getSuspendedRun(entry.runId)?.runId).toBe(entry.runId);

    const taken = takeRunForResume(entry.runId);
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;

    expect(taken.entry).toBe(entry);
    expect(taken.entry.session).toBe(input.session);
    expect((taken.entry.session as MockSession).disposed).toBe(false);
    expect(takeRunForResume(entry.runId)).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found for missing runs", () => {
    expect(takeRunForResume("missing-run")).toEqual({ ok: false, reason: "not_found" });
  });

  it("expires runs lazily on take and disposes their sessions", () => {
    const session = createMockSession();
    const entry = suspendRun(suspendedRun({
      session,
      suspendedAt: Date.now() - 31 * 60 * 1000,
    }));

    expect(takeRunForResume(entry.runId)).toEqual({ ok: false, reason: "expired" });
    expect(session.disposed).toBe(true);
    expect(takeRunForResume(entry.runId)).toEqual({ ok: false, reason: "not_found" });
  });

  it("evicts the least recently used run when the suspended run cap is exceeded", () => {
    const entries = Array.from({ length: 5 }, () => suspendRun(suspendedRun()));
    const firstSession = entries[0]!.session as MockSession;
    const secondSession = entries[1]!.session as MockSession;

    expect(getSuspendedRun(entries[0]!.runId)?.runId).toBe(entries[0]!.runId);
    const newest = suspendRun(suspendedRun());

    expect(firstSession.disposed).toBe(false);
    expect(secondSession.disposed).toBe(true);
    expect(getSuspendedRun(entries[0]!.runId)?.runId).toBe(entries[0]!.runId);
    expect(getSuspendedRun(entries[1]!.runId)).toBeUndefined();
    expect(getSuspendedRun(newest.runId)?.runId).toBe(newest.runId);
    expect(listSuspendedRuns()).toHaveLength(5);
  });
});
