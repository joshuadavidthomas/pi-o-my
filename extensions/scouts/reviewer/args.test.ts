import { describe, expect, it } from "bun:test";

import { parseArgs } from "./args.ts";

describe("review command args", () => {
  it("defaults bare review to diff with all lenses in notes mode", () => {
    expect(parseArgs("")).toMatchObject({
      subcommand: "diff",
      rest: [],
      strict: false,
      lens: "all",
      followup: "synthesize",
    });
  });

  it("defaults flag-only review to diff", () => {
    expect(parseArgs("--strict")).toMatchObject({ subcommand: "diff", explicitSubcommand: false, strict: true });
    expect(parseArgs("--grug")).toMatchObject({ subcommand: "diff", explicitSubcommand: false, lens: "grug" });
  });

  it("parses diff options and a lens flag", () => {
    expect(parseArgs("diff --base main --strict --feathers")).toMatchObject({
      subcommand: "diff",
      base: "main",
      strict: true,
      lens: "feathers",
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
