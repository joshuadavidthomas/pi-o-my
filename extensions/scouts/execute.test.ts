import { describe, expect, it } from "bun:test";

import { buildScoutResultOutput, extractMoreTimeRequest, prepareScoutTools, resumeScout, selectResumeFollowUpPrompt } from "./execute.ts";
import { createReadOnlyBashTool } from "./tools/read-only-bash.ts";
import type { ScoutConfig, ScoutDetails } from "./types.ts";

function configWithTools(createTools: ScoutConfig["createTools"]): ScoutConfig {
  return {
    name: "test-scout",
    buildSystemPrompt: () => "system",
    buildUserPrompt: () => "user",
    createTools,
  };
}

type ScoutRunDetails = ScoutDetails["runs"][number];

function resultRun(overrides: Partial<ScoutRunDetails> = {}): ScoutRunDetails {
  return {
    runId: "wkr-4f2a",
    status: "done",
    query: "do work",
    turns: 0,
    displayItems: [],
    startedAt: 1_000,
    endedAt: 601_000,
    ...overrides,
  };
}

describe("extractMoreTimeRequest", () => {
  it("ignores a marker that is not the final non-empty line", () => {
    const summary = "Progress made.\nMORE TIME NEEDED: finish validation and summarize results\nThanks";

    expect(extractMoreTimeRequest(summary)).toBeUndefined();
  });

  it("extracts a final marker line followed by trailing whitespace", () => {
    const summary = "Progress made.\nMORE TIME NEEDED: finish validation\n\n  ";

    expect(extractMoreTimeRequest(summary)).toBe("finish validation");
  });

  it("extracts a trailing more-time marker line", () => {
    const summary = "Progress made.\n\nMORE TIME NEEDED: inspect the failing test";

    expect(extractMoreTimeRequest(summary)).toBe("inspect the failing test");
  });

  it("ignores non-marker text", () => {
    expect(extractMoreTimeRequest("No more time needed.")).toBeUndefined();
  });
});

describe("selectResumeFollowUpPrompt", () => {
  it("uses the trimmed follow-up when supplied", () => {
    expect(selectResumeFollowUpPrompt("  finish validation  ")).toBe("finish validation");
  });

  it("uses the default resume prompt when no follow-up is supplied", () => {
    expect(selectResumeFollowUpPrompt(undefined)).toBe("Continue where you left off. Your time budget has been refreshed.");
    expect(selectResumeFollowUpPrompt("   ")).toBe("Continue where you left off. Your time budget has been refreshed.");
  });
});

describe("resumeScout", () => {
  it("returns a typed not-resumable result when the run cannot be taken", async () => {
    const result = await resumeScout("wkr-missing", undefined, undefined, undefined);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Run wkr-missing is not resumable (not_found). Dispatch a fresh worker with the full task instead.");
  });
});

describe("buildScoutResultOutput", () => {
  it("builds a suspended timeout result with partial progress and tool usage", () => {
    const output = buildScoutResultOutput(
      resultRun({
        status: "aborted",
        turns: 8,
        activityText: "I updated the parser and am halfway through validation.",
        summaryText: "Timed out after 10 minutes",
        displayItems: [
          { type: "tool", name: "edit", args: { path: "src/parser.ts" } },
          { type: "tool", name: "bash", args: { command: "bun test" } },
          { type: "tool", name: "edit", args: { path: "src/parser.test.ts" } },
        ],
      }),
      {
        runId: "wkr-4f2a",
        toolName: "worker",
        suspendReason: "timeout",
        expiresAt: Date.UTC(2026, 0, 1, 12, 30, 0),
      },
    );

    expect(output).toContain("Timed out after 10m (8 turns). Session suspended and resumable until 2026-01-01T12:30:00.000Z: call worker({ resume: \"wkr-4f2a\" }) with an optional follow-up query.");
    expect(output).toContain("Last activity:\nI updated the parser and am halfway through validation.");
    expect(output).toContain("Tools used: edit x2, bash x1 (last: edit src/parser.test.ts)");
  });

  it("appends a resumable more-time block after a successful summary", () => {
    const output = buildScoutResultOutput(
      resultRun({
        summaryText: "Implemented the parser changes.\nMORE TIME NEEDED: run the browser integration checks",
        moreTimeRequested: "run the browser integration checks",
      }),
      {
        runId: "wkr-4f2a",
        toolName: "worker",
        suspendReason: "more_time_requested",
        expiresAt: Date.UTC(2026, 0, 1, 12, 30, 0),
      },
    );

    expect(output).toBe([
      "Implemented the parser changes.",
      "MORE TIME NEEDED: run the browser integration checks",
      "",
      "---",
      "Scout requested more time. Remaining work: run the browser integration checks",
      "Resumable until 2026-01-01T12:30:00.000Z: call worker({ resume: \"wkr-4f2a\" }) with an optional follow-up query.",
    ].join("\n"));
  });

  it("keeps a timeout result plain when no suspension exists", () => {
    const output = buildScoutResultOutput(resultRun({
      status: "aborted",
      turns: 8,
      activityText: "partial progress",
      summaryText: "Timed out after 10 minutes",
    }));

    expect(output).toBe("Timed out after 10 minutes");
  });

  it("uses a generic suspension notice for non-worker scouts", () => {
    const output = buildScoutResultOutput(
      resultRun({
        runId: "fnd-4f2a",
        status: "aborted",
        turns: 2,
        summaryText: "Timed out after 10 minutes",
      }),
      {
        runId: "fnd-4f2a",
        toolName: "finder",
        suspendReason: "timeout",
        expiresAt: Date.UTC(2026, 0, 1, 12, 30, 0),
      },
    );

    expect(output).toContain("Session suspended (runId fnd-4f2a, expires 2026-01-01T12:30:00.000Z).");
    expect(output).not.toContain("worker({ resume:");
  });
});

describe("prepareScoutTools", () => {
  it("uses built-in read/bash when no custom tool set is provided", () => {
    const prepared = prepareScoutTools(configWithTools(undefined), process.cwd());

    expect(prepared.builtinTools).toEqual(["read", "bash"]);
    expect(prepared.customTools).toEqual([]);
  });

  it("uses ordinary explicit built-in tool names as built-ins", () => {
    const prepared = prepareScoutTools(configWithTools(() => [{ name: "bash" }, { name: "read" }]), process.cwd());

    expect(prepared.builtinTools).toEqual(["bash", "read"]);
    expect(prepared.customTools).toEqual([]);
  });

  it("preserves read-only bash as a custom wrapper even though it is named bash", async () => {
    const prepared = prepareScoutTools(configWithTools((cwd) => [createReadOnlyBashTool(cwd)]), process.cwd());

    expect(prepared.builtinTools).toEqual([]);
    expect(prepared.customTools.map((tool) => tool.name)).toEqual(["bash"]);
    await expect(prepared.customTools[0]!.execute("tool-call", { command: "touch nope" }, undefined, undefined, undefined as never)).rejects.toThrow("Blocked");
  });
});
