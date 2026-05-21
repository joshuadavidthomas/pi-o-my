import { describe, expect, it } from "bun:test";

import { parseArgs } from "./args.ts";
import { collectArtifact } from "./artifacts.ts";

describe("review artifact collection", () => {
  it("rejects flag-first positional targets instead of silently reviewing the repo", async () => {
    const parsed = parseArgs("--strict README.md");

    await expect(collectArtifact(process.cwd(), parsed)).rejects.toThrow("/review repo does not accept a positional target: README.md");
  });

  it("suggests file or boundary review when a repo target looks like a path", async () => {
    const parsed = parseArgs("repo README.md");

    await expect(collectArtifact(process.cwd(), parsed)).rejects.toThrow("/review file README.md");
  });
});
