import { describe, expect, it } from "bun:test";

import { prepareScoutTools } from "../execute.ts";
import { WORKER_CONFIG, workerThinkingLevel } from "./config.ts";

describe("WORKER_CONFIG", () => {
  it("uses read, bash, edit, and write tools", () => {
    const prepared = prepareScoutTools(WORKER_CONFIG, process.cwd());

    expect(prepared.builtinTools).toEqual(["read", "bash", "edit", "write"]);
    expect(prepared.customTools).toEqual([]);
    expect(WORKER_CONFIG.modelTargets?.length).toBeGreaterThan(0);
    expect(WORKER_CONFIG.timeoutMs).toBeUndefined();
  });

  it("sets the thinking level by effort", () => {
    expect(workerThinkingLevel("quick")).toBe("low");
    expect(workerThinkingLevel(undefined)).toBe("medium");
    expect(workerThinkingLevel("standard")).toBe("medium");
    expect(workerThinkingLevel("thorough")).toBe("high");
  });
});
