import { describe, expect, it } from "bun:test";

import { prepareScoutTools } from "./execute.ts";
import { createReadOnlyBashTool } from "./tools/read-only-bash.ts";
import type { ScoutConfig } from "./types.ts";

function configWithTools(createTools: ScoutConfig["createTools"]): ScoutConfig {
  return {
    name: "test-scout",
    maxTurns: 1,
    buildSystemPrompt: () => "system",
    buildUserPrompt: () => "user",
    createTools,
  };
}

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
