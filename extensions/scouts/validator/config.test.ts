import { describe, expect, it } from "bun:test";

import { prepareScoutTools } from "../execute.ts";
import { VALIDATOR_CONFIG } from "./config.ts";

describe("VALIDATOR_CONFIG", () => {
  it("uses read and bash without edit/write tools", () => {
    const prepared = prepareScoutTools(VALIDATOR_CONFIG, process.cwd());

    expect(prepared.builtinTools).toEqual(["read", "bash"]);
    expect(prepared.customTools).toEqual([]);
  });
});
