import { describe, expect, it } from "bun:test";

import { parseArgs } from "./args.ts";

describe("review command args", () => {
  it("defaults to repo with all lenses in notes mode", () => {
    expect(parseArgs("")).toMatchObject({
      subcommand: "repo",
      rest: [],
      strict: false,
      lens: "all",
      followup: "synthesize",
    });
  });

  it("parses diff options and the Beck lens flag", () => {
    expect(parseArgs("diff --base main --strict --beck")).toMatchObject({
      subcommand: "diff",
      base: "main",
      strict: true,
      lens: "beck",
    });
  });

  it("keeps quoted design text together", () => {
    expect(parseArgs('design "Add plugin hooks" --context brief')).toMatchObject({
      subcommand: "design",
      rest: ["Add plugin hooks"],
      context: "brief",
    });
  });

  it("rejects missing flag values", () => {
    expect(() => parseArgs("diff --base")).toThrow("--base requires a value");
  });

  it("rejects invalid context values", () => {
    expect(() => parseArgs("plan docs/plan.md --context lots")).toThrow("Invalid --context value");
  });
});
