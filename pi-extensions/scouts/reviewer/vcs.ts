import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type VcsArtifact = { subject: string; subjectLabel: string };

export type VcsAdapter = {
  name: "git" | "jj";
  defaultReviewDiff(cwd: string): Promise<VcsArtifact>;
  diffFromBase(cwd: string, base: string): Promise<VcsArtifact>;
  stagedDiff(cwd: string): Promise<VcsArtifact>;
  status(cwd: string, path?: string): Promise<string>;
  trackedFiles(cwd: string, path?: string): Promise<string>;
};

async function execVcs(command: string, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

function untrackedSection(status: string): string {
  const files = status
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3));

  if (files.length === 0) return "";
  return `\n\nUntracked files present and not included in git diff output:\n${files.map((file) => `- ${file}`).join("\n")}`;
}

export const gitAdapter: VcsAdapter = {
  name: "git",
  async defaultReviewDiff(cwd) {
    const status = await execVcs("git", cwd, ["status", "--short", "--untracked-files=all"]);
    if (!status.trim()) {
      return { subject: await execVcs("git", cwd, ["diff", "HEAD~1..HEAD"]), subjectLabel: "git diff HEAD~1..HEAD" };
    }

    const diff = await execVcs("git", cwd, ["diff", "HEAD"]);
    return { subject: `${diff}${untrackedSection(status)}`, subjectLabel: "git diff HEAD plus untracked file list" };
  },
  async diffFromBase(cwd, base) {
    const range = base.includes("...") || base.includes("..") ? base : `${base}...HEAD`;
    return { subject: await execVcs("git", cwd, ["diff", range]), subjectLabel: `git diff ${range}` };
  },
  async stagedDiff(cwd) {
    return { subject: await execVcs("git", cwd, ["diff", "--cached"]), subjectLabel: "git diff --cached" };
  },
  status: (cwd, path) => path ? execVcs("git", cwd, ["status", "--short", "--untracked-files=all", "--", path]) : execVcs("git", cwd, ["status", "--short", "--untracked-files=all"]),
  trackedFiles: (cwd, path) => path ? execVcs("git", cwd, ["ls-files", "--", path]) : execVcs("git", cwd, ["ls-files"]),
};

export const jjAdapter: VcsAdapter = {
  name: "jj",
  async defaultReviewDiff(cwd) {
    const current = await execVcs("jj", cwd, ["diff", "--from", "@-", "--to", "@"]);
    if (current.trim()) return { subject: current, subjectLabel: "jj diff --from @- --to @" };
    return { subject: await execVcs("jj", cwd, ["diff", "--from", "@--", "--to", "@-"]), subjectLabel: "jj diff --from @-- --to @-" };
  },
  async diffFromBase(cwd, base) {
    return { subject: await execVcs("jj", cwd, ["diff", "--from", base, "--to", "@"]), subjectLabel: `jj diff --from ${base} --to @` };
  },
  async stagedDiff(cwd) {
    return { subject: await execVcs("jj", cwd, ["diff", "--from", "@-", "--to", "@"]), subjectLabel: "jj diff --from @- --to @" };
  },
  status: (cwd) => execVcs("jj", cwd, ["status"]),
  trackedFiles: async () => "jj repositories do not expose a git-style tracked file list here; use tools to inspect relevant files.",
};

function hasJjDir(start: string): boolean {
  let current = start;
  while (true) {
    if (existsSync(join(current, ".jj"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function vcsFor(cwd: string): VcsAdapter {
  return hasJjDir(cwd) ? jjAdapter : gitAdapter;
}
