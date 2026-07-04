import { describe, expect, it } from "bun:test";

import { prepareScoutTools } from "../execute.ts";
import { WORKER_CONFIG } from "./config.ts";

describe("WORKER_CONFIG", () => {
  it("uses read, bash, edit, and write tools", () => {
    const prepared = prepareScoutTools(WORKER_CONFIG, process.cwd());

    expect(prepared.builtinTools).toEqual(["read", "bash", "edit", "write"]);
    expect(prepared.customTools).toEqual([]);
  });
});
