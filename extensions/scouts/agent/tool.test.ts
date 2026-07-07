import { afterEach, describe, expect, it } from "bun:test";

import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { prepareScoutTools } from "../execute.ts";
import { disposeSuspendedRun, generateRunId, listSuspendedRuns, suspendRun, takeRunForResume, type SuspendedRunInput } from "../runs.ts";
import type { ScoutDetails } from "../types.ts";
import type { AgentDefinition } from "./definitions.ts";
import { AGENT_TOOL, AgentParams, buildAgentScoutConfig, executeAgentToolCall } from "./tool.ts";

function definitions(...defs: AgentDefinition[]): Map<string, AgentDefinition> {
  return new Map(defs.map((definition) => [definition.name, definition]));
}

const baseParams = {
  name: "docs-check",
  task: "Check the docs.",
};

type ScoutRunDetails = ScoutDetails["runs"][number];
type MockSession = AgentSession & { disposed: boolean };

const scoutResult = {
  content: [{ type: "text" as const, text: "done" }],
  details: {
    mode: "single" as const,
    status: "done" as const,
    runs: [{
      runId: "agt-test",
      status: "done" as const,
      query: "Check the docs.",
      turns: 1,
      displayItems: [],
      summaryText: "done",
      startedAt: Date.now(),
      endedAt: Date.now(),
    }],
  },
  isError: false,
};

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
  const runId = overrides.runId ?? generateRunId("agt");
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

afterEach(cleanupSuspendedRuns);

describe("AgentParams", () => {
  it("renders subagent_type labels without a type prefix", () => {
    const theme = {
      bold: (text: string) => text,
      fg: (_color: string, text: string) => text,
    };

    const rendered = AGENT_TOOL.renderCall?.(
      { name: "docs-check", subagent_type: "finder" },
      theme as any,
      { executionStarted: false } as any,
    )?.render(80);

    expect(rendered?.map((line) => line.trimEnd())).toEqual(["agent finder"]);
  });

  it("registers the expected top-level schema shape", () => {
    expect(AgentParams.required).toBeUndefined();
    expect(Object.keys(AgentParams.properties)).toEqual([
      "name",
      "task",
      "subagent_type",
      "role",
      "skills",
      "tools",
      "effort",
      "model",
      "mutation",
      "resume",
    ]);
    expect((AgentParams.properties.mutation as any).properties.isolation.enum).toEqual(["shared"]);
    expect((AgentParams.properties.effort as any).enum).toEqual(["quick", "standard", "thorough"]);
  });

  it("documents shipped subagent_type values in the tool description", () => {
    expect(AGENT_TOOL.description).toContain("Shipped subagent_type values:");
    expect(AGENT_TOOL.description).toContain("- finder: Read-only workspace scout");
    expect(AGENT_TOOL.description).toContain("- reviewer-hickey: Judges structural simplicity");
  });
});

describe("buildAgentScoutConfig", () => {
  it("layers definition body, definition skills, call-site skills, role, then the agent frame", () => {
    const result = buildAgentScoutConfig({
      ...baseParams,
      subagent_type: "preset",
      skills: ["call-skill"],
      role: "ROLE LAYER",
    }, {
      definitions: definitions({
        name: "preset",
        description: "Preset definition",
        skills: ["definition-skill"],
        systemPrompt: "DEFINITION BODY",
        sourcePath: "preset.md",
      }),
      skills: [
        { name: "definition-skill", content: "DEFINITION SKILL BODY", baseDir: "/skills/definition" },
        { name: "call-skill", content: "CALL SKILL BODY" },
      ],
    });

    expect("config" in result).toBe(true);
    if (!("config" in result)) return;

    const systemPrompt = result.config.buildSystemPrompt(600_000);
    expect(systemPrompt.indexOf("DEFINITION BODY")).toBeLessThan(systemPrompt.indexOf("## Skill: definition-skill"));
    expect(systemPrompt.indexOf("## Skill: definition-skill")).toBeLessThan(systemPrompt.indexOf("## Skill: call-skill"));
    expect(systemPrompt.indexOf("## Skill: call-skill")).toBeLessThan(systemPrompt.indexOf("ROLE LAYER"));
    expect(systemPrompt.indexOf("ROLE LAYER")).toBeLessThan(systemPrompt.indexOf("You are an agent subtask"));
    expect(systemPrompt).toContain("Skill base directory: /skills/definition");
    expect(result.config.buildUserPrompt({})).toBe("Check the docs.");
    expect(result.skillNames).toEqual(["definition-skill", "call-skill"]);
  });

  it("uses call-site model over definition model and unions definition/call-site tools", () => {
    const result = buildAgentScoutConfig({
      ...baseParams,
      subagent_type: "researcher",
      tools: ["web_fetch"],
      model: "opus",
    }, {
      definitions: definitions({
        name: "researcher",
        description: "Research",
        tools: ["github_search"],
        model: "sonnet",
        systemPrompt: "Research prompt",
        sourcePath: "researcher.md",
      }),
    });

    expect("config" in result).toBe(true);
    if (!("config" in result)) return;

    expect(result.config.configuredModel).toBe("claude-opus-4-8");
    expect(result.toolNames).toEqual(["github_search", "web_fetch"]);
  });

  it("uses definition model when call-site model is absent", () => {
    const result = buildAgentScoutConfig({
      ...baseParams,
      subagent_type: "researcher",
    }, {
      definitions: definitions({
        name: "researcher",
        model: "sonnet",
        systemPrompt: "Research prompt",
        sourcePath: "researcher.md",
      }),
    });

    expect("config" in result).toBe(true);
    if ("config" in result) expect(result.config.configuredModel).toBe("claude-sonnet-5");
  });

  it("defaults to the base read+bash pool without edit/write when mutation is absent", () => {
    const result = buildAgentScoutConfig(baseParams, { definitions: definitions() });

    expect("config" in result).toBe(true);
    if (!("config" in result)) return;

    expect(result.toolNames).toEqual(["read", "bash"]);
    const prepared = prepareScoutTools(result.config, process.cwd());
    expect(prepared.builtinTools).toEqual(["read"]);
    expect(prepared.customTools.map((tool) => tool.name)).toEqual(["bash"]);
    expect([...prepared.builtinTools, ...prepared.customTools.map((tool) => tool.name)]).not.toContain("edit");
    expect([...prepared.builtinTools, ...prepared.customTools.map((tool) => tool.name)]).not.toContain("write");
  });

  it("adds edit/write only when shared mutation is present and flows mutation params into the user prompt", () => {
    const result = buildAgentScoutConfig({
      ...baseParams,
      effort: "thorough",
      mutation: {
        isolation: "shared",
        allowedPaths: ["src/one.ts", "src/two.ts"],
        verificationCommands: ["bun test"],
      },
    }, { definitions: definitions() });

    expect("config" in result).toBe(true);
    if (!("config" in result)) return;

    expect(result.toolNames).toEqual(["read", "bash", "edit", "write"]);
    expect(result.mutationIsolation).toBe("shared");
    const prepared = prepareScoutTools(result.config, process.cwd());
    expect(prepared.builtinTools).toEqual(["read", "bash", "edit", "write"]);
    expect(prepared.customTools).toEqual([]);

    const userPrompt = result.config.buildUserPrompt({});
    expect(userPrompt).toContain("Implementation effort: thorough");
    expect(userPrompt).toContain("- src/one.ts\n- src/two.ts");
    expect(userPrompt).toContain("- bun test");
    expect(result.config.buildSystemPrompt(600_000)).toContain("You are a bounded implementation subagent");
  });

  it("returns an error for unknown subagent_type with available names and descriptions", () => {
    const result = buildAgentScoutConfig({
      ...baseParams,
      subagent_type: "missing",
    }, {
      definitions: definitions(
        { name: "finder", description: "Find files", systemPrompt: "Find", sourcePath: "finder.md" },
        { name: "reviewer", description: "Review code", systemPrompt: "Review", sourcePath: "reviewer.md" },
      ),
    });

    expect(result).toEqual({
      error: "Unknown subagent_type: missing. Available subagent_type values:\n- finder: Find files\n- reviewer: Review code",
    });
  });

  it("rejects unsupported mutation isolation values", () => {
    const result = buildAgentScoutConfig({
      ...baseParams,
      mutation: { isolation: "workspace" },
    }, { definitions: definitions() });

    expect(result).toEqual({ error: "Invalid mutation.isolation: expected shared." });
  });
});

describe("executeAgentToolCall", () => {
  it("accepts resume-only params and resumes without requiring name or task", async () => {
    let resumeRunId: string | undefined;
    const runners = {
      executeScout: async () => scoutResult,
      resumeScout: async (runId: string) => {
        resumeRunId = runId;
        return scoutResult;
      },
      loadDefinitions: () => ({ definitions: definitions(), diagnostics: [] }),
      loadSkills: async () => [],
    };

    const result = await executeAgentToolCall("agent-resume", { resume: "agt-suspended" }, undefined, undefined, { cwd: process.cwd() } as ExtensionContext, runners);

    expect(result.isError).toBe(false);
    expect(resumeRunId).toBe("agt-suspended");
  });

  it("rejects missing task when resume is absent", async () => {
    const runners = {
      executeScout: async () => scoutResult,
      resumeScout: async () => scoutResult,
      loadDefinitions: () => ({ definitions: definitions(), diagnostics: [] }),
      loadSkills: async () => [],
    };

    await expect(executeAgentToolCall("agent-invalid", { name: "missing-task" }, undefined, undefined, { cwd: process.cwd() } as ExtensionContext, runners))
      .rejects.toThrow("Missing required parameter: task");
  });

  it("rejects unknown subagent_type as a thrown tool error", async () => {
    const runners = {
      executeScout: async () => scoutResult,
      resumeScout: async () => scoutResult,
      loadDefinitions: () => ({
        definitions: definitions(
          { name: "finder", description: "Find files", systemPrompt: "Find", sourcePath: "finder.md" },
          { name: "reviewer", description: "Review code", systemPrompt: "Review", sourcePath: "reviewer.md" },
        ),
        diagnostics: [],
      }),
      loadSkills: async () => [],
    };

    await expect(executeAgentToolCall(
      "agent-unknown",
      { ...baseParams, subagent_type: "missing" },
      undefined,
      undefined,
      { cwd: process.cwd() } as ExtensionContext,
      runners,
    )).rejects.toThrow("Unknown subagent_type: missing. Available subagent_type values:\n- finder: Find files\n- reviewer: Review code");
  });

  it("reuses the shared mutation lock and fails fast when busy", async () => {
    let resolveFirst!: (value: typeof scoutResult) => void;
    const firstRun = new Promise<typeof scoutResult>((resolve) => {
      resolveFirst = resolve;
    });
    let executeCalls = 0;
    const runners = {
      executeScout: async () => {
        executeCalls += 1;
        return firstRun;
      },
      resumeScout: async () => scoutResult,
      loadDefinitions: () => ({ definitions: definitions(), diagnostics: [] }),
      loadSkills: async () => [],
    };

    const params = {
      ...baseParams,
      mutation: { isolation: "shared" },
    };

    const active = executeAgentToolCall("agent-1", params, undefined, undefined, { cwd: process.cwd() } as ExtensionContext, runners);
    await expect(executeAgentToolCall("agent-2", params, undefined, undefined, { cwd: process.cwd() } as ExtensionContext, runners))
      .rejects.toThrow("A shared-checkout mutating agent is already running");
    expect(executeCalls).toBe(1);

    resolveFirst(scoutResult);
    await active;
  });

  it("blocks resuming a mutating suspended run while another shared mutation is active", async () => {
    const suspended = suspendRun(suspendedRun());
    let resolveFirst!: (value: typeof scoutResult) => void;
    let resumeCalls = 0;
    let activeStarted!: () => void;
    const firstRun = new Promise<typeof scoutResult>((resolve) => {
      resolveFirst = resolve;
    });
    const activeStartedPromise = new Promise<void>((resolve) => {
      activeStarted = resolve;
    });
    const runners = {
      executeScout: async () => {
        activeStarted();
        return firstRun;
      },
      resumeScout: async () => {
        resumeCalls += 1;
        return scoutResult;
      },
      loadDefinitions: () => ({ definitions: definitions(), diagnostics: [] }),
      loadSkills: async () => [],
    };

    const activeRun = executeAgentToolCall(
      "active-agent",
      { ...baseParams, mutation: { isolation: "shared" } },
      undefined,
      undefined,
      { cwd: process.cwd() } as ExtensionContext,
      runners,
    );
    await activeStartedPromise;

    await expect(executeAgentToolCall(
      "resume-agent",
      { resume: suspended.runId },
      undefined,
      undefined,
      { cwd: process.cwd() } as ExtensionContext,
      runners,
    )).rejects.toThrow("A shared-checkout mutating agent is already running");
    expect(resumeCalls).toBe(0);

    const taken = takeRunForResume(suspended.runId);
    expect(taken.ok).toBe(true);
    if (taken.ok) taken.entry.session.dispose();

    resolveFirst(scoutResult);
    await activeRun;
  });
});
