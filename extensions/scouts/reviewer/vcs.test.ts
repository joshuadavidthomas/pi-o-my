import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "bun:test";

import { gitAdapter, vcsFor } from "./vcs.ts";

async function git(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
        return;
      }
      resolvePromise();
    });
  });
}

describe("review vcs selection", () => {
  it("prefers jj when a .jj directory exists in the repo ancestry", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-vcs-"));
    try {
      await mkdir(join(root, ".jj"));
      await mkdir(join(root, "nested"));

      expect(vcsFor(join(root, "nested")).name).toBe("jj");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat untracked-only git worktrees as clean", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-vcs-"));
    try {
      await git(root, ["init"]);
      await git(root, ["config", "user.email", "review@example.test"]);
      await git(root, ["config", "user.name", "Review Test"]);
      await writeFile(join(root, "tracked.txt"), "initial\n");
      await git(root, ["add", "tracked.txt"]);
      await git(root, ["commit", "-m", "initial"]);
      await writeFile(join(root, "new-file.txt"), "new\n");

      const artifact = await gitAdapter.defaultReviewDiff(root);

      expect(artifact.subjectLabel).toBe("git diff HEAD plus untracked file list");
      expect(artifact.subject).toContain("Untracked files present");
      expect(artifact.subject).toContain("new-file.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
