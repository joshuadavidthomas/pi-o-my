import { describe, expect, it } from "bun:test";

import { buildImplementationSystemPrompt, buildImplementationUserPrompt, implementationThinkingLevel } from "./implementation.ts";

describe("agent implementation prompt helpers", () => {
  it("sets the thinking level by effort", () => {
    expect(implementationThinkingLevel("quick")).toBe("low");
    expect(implementationThinkingLevel(undefined)).toBe("medium");
    expect(implementationThinkingLevel("standard")).toBe("medium");
    expect(implementationThinkingLevel("thorough")).toBe("high");
  });

  it("renders bounded implementation system and user prompts", () => {
    const systemPrompt = buildImplementationSystemPrompt(600_000);
    expect(systemPrompt).toContain("You are a bounded implementation subagent");
    expect(systemPrompt).toContain("edit: modify existing files");
    expect(systemPrompt).toContain("Timeout: 10 minutes");

    const userPrompt = buildImplementationUserPrompt({
      task: "Make the change.",
      effort: "quick",
      allowedPaths: ["extensions/scouts"],
      verificationCommands: ["bun test extensions/scouts/"],
    });
    expect(userPrompt).toContain("Implementation effort: quick");
    expect(userPrompt).toContain("Make the change.");
    expect(userPrompt).toContain("- extensions/scouts");
    expect(userPrompt).toContain("- bun test extensions/scouts/");
  });
});
