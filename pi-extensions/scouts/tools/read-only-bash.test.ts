import { describe, expect, it } from "bun:test";

import { isReadOnlyCommand } from "./read-only-bash.ts";

function expectAllowed(command: string): void {
  expect(isReadOnlyCommand(command), command).toEqual({ ok: true });
}

function expectBlocked(command: string): void {
  expect(isReadOnlyCommand(command).ok, command).toBe(false);
}

describe("read-only bash validation", () => {
  it("allows safe git inspection commands", () => {
    expectAllowed("git diff main...HEAD");
    expectAllowed("git status --short --untracked-files=all");
    expectAllowed("git ls-files -- pi-extensions");
    expectAllowed("git rev-parse --short HEAD");
    expectAllowed("git show HEAD:README.md");
    expectAllowed("git log --oneline -5");
    expectAllowed("git --no-pager diff --cached | head");
  });

  it("blocks mutating or unknown git commands", () => {
    expectBlocked("git add README.md");
    expectBlocked("git commit -m nope");
    expectBlocked("git reset --hard HEAD");
    expectBlocked("git checkout main");
    expectBlocked("git clean -fd");
    expectBlocked("git stash");
    expectBlocked("git merge main");
    expectBlocked("git rebase main");
    expectBlocked("git pull");
    expectBlocked("git push");
    expectBlocked("git restore README.md");
    expectBlocked("git switch main");
    expectBlocked("git branch -D old");
    expectBlocked("git fetch origin");
    expectBlocked("git -c core.pager=cat log");
  });

  it("blocks git read commands with write options", () => {
    expectBlocked("git diff --output=/tmp/diff.txt main...HEAD");
    expectBlocked("git show --ext-diff HEAD");
  });

  it("blocks shell helpers with command execution features", () => {
    expectBlocked("awk 'BEGIN { system(\"date\") }'");
    expectBlocked("find . -maxdepth 1");
  });
});
