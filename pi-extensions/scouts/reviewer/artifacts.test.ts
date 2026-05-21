import { describe, expect, it } from "bun:test";

import { parseArgs } from "./args.ts";
import { collectArtifact } from "./artifacts.ts";
import type { VcsAdapter } from "./vcs.ts";

function fakeVcs(overrides: Partial<VcsAdapter>): VcsAdapter {
  return {
    name: "git",
    defaultReviewDiff: async () => ({ subject: "default diff", subjectLabel: "default" }),
    diffFromBase: async (cwd, base) => ({ subject: `base diff ${base}`, subjectLabel: `base ${base}` }),
    stagedDiff: async () => ({ subject: "staged diff", subjectLabel: "staged" }),
    status: async () => "",
    trackedFiles: async () => "",
    ...overrides,
  };
}

describe("review artifact collection", () => {
  it("collects current changes for bare review", async () => {
    const parsed = parseArgs("");
    const artifact = await collectArtifact(process.cwd(), parsed, {
      vcs: fakeVcs({
        defaultReviewDiff: async () => ({ subject: "worktree diff", subjectLabel: "git diff HEAD" }),
      }),
    });

    expect(artifact).toEqual({ subject: "worktree diff", subjectLabel: "git diff HEAD" });
  });

  it("delegates clean fallback decisions to the VCS adapter", async () => {
    const parsed = parseArgs("");
    const artifact = await collectArtifact(process.cwd(), parsed, {
      vcs: fakeVcs({
        defaultReviewDiff: async () => ({ subject: "last commit diff", subjectLabel: "git diff HEAD~1..HEAD" }),
      }),
    });

    expect(artifact).toEqual({ subject: "last commit diff", subjectLabel: "git diff HEAD~1..HEAD" });
  });

  it("rejects flag-first positional targets instead of silently reviewing the repo", async () => {
    const parsed = parseArgs("--strict README.md");

    await expect(collectArtifact(process.cwd(), parsed)).rejects.toThrow("/review does not accept a positional target without a review kind: README.md");
  });

  it("suggests file or boundary review when a repo target looks like a path", async () => {
    const parsed = parseArgs("repo README.md");

    await expect(collectArtifact(process.cwd(), parsed)).rejects.toThrow("/review file README.md");
  });
});
