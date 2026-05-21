import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { ParsedArgs } from "./args.ts";
import type { ReviewArtifactType, ReviewContext } from "./run.ts";

export type CollectedArtifact = {
  subject: string;
  subjectLabel: string;
};

async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

async function gitRefExists(cwd: string, ref: string): Promise<boolean> {
  return await tryGit(cwd, ["rev-parse", "--verify", "--quiet", ref]) !== undefined;
}

async function defaultDiffBase(cwd: string): Promise<string> {
  const upstream = (await tryGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]))?.trim();
  if (upstream) return upstream;

  for (const candidate of ["main", "master"]) {
    if (await gitRefExists(cwd, candidate)) return candidate;
  }

  throw new Error("Could not determine a diff base. Pass /review diff --base <ref>.");
}

export async function optionalRepoConfig(cwd: string): Promise<string> {
  const candidates = [join(cwd, ".pi", "review.md"), join(cwd, ".review-lenses.md")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const content = await readFile(candidate, "utf8");
      return `Repo-specific review config from ${candidate}:\n\n${content}`;
    }
  }
  return "";
}

export function defaultContextFor(subcommand: string): ReviewContext {
  if (subcommand === "design" || subcommand === "plan") return "brief";
  return "none";
}

export function artifactTypeFor(subcommand: string): ReviewArtifactType {
  if (subcommand === "repo") return "repository";
  if (subcommand === "diff" || subcommand === "staged") return "diff";
  if (subcommand === "plan") return "plan";
  if (subcommand === "design") return "design";
  if (subcommand === "file") return "file";
  if (subcommand === "boundary") return "module";
  return "other";
}

export async function collectArtifact(cwd: string, parsed: ParsedArgs): Promise<CollectedArtifact> {
  if (parsed.subcommand === "repo") {
    const [head, status, files] = await Promise.all([
      git(cwd, ["rev-parse", "--short", "HEAD"]),
      git(cwd, ["status", "--short", "--untracked-files=all"]),
      git(cwd, ["ls-files"]),
    ]);
    return {
      subject: `Review the current repository at ${cwd}. Use tools to inspect the files relevant to each finding.\n\nHEAD: ${head.trim()}\n\nWorking tree status:\n${status.trim() || "clean"}\n\nTracked files:\n${files.trim()}`,
      subjectLabel: "current repository",
    };
  }

  if (parsed.subcommand === "design" || parsed.subcommand === "plan") {
    const text = parsed.rest.join(" ").trim();
    if (!text) throw new Error(`Usage: /review ${parsed.subcommand} <text-or-path>`);
    const possiblePath = resolve(cwd, text);
    if (existsSync(possiblePath)) return { subject: await readFile(possiblePath, "utf8"), subjectLabel: text };
    return { subject: text, subjectLabel: "inline text" };
  }

  if (parsed.subcommand === "diff") {
    const base = parsed.base ?? parsed.rest[0] ?? await defaultDiffBase(cwd);
    const range = base.includes("...") || base.includes("..") ? base : `${base}...HEAD`;
    return { subject: await git(cwd, ["diff", range]), subjectLabel: `git diff ${range}` };
  }

  if (parsed.subcommand === "staged") return { subject: await git(cwd, ["diff", "--cached"]), subjectLabel: "git diff --cached" };

  if (parsed.subcommand === "file") {
    const file = parsed.rest[0];
    if (!file) throw new Error("Usage: /review file <path>");
    return { subject: await readFile(resolve(cwd, file), "utf8"), subjectLabel: file };
  }

  if (parsed.subcommand === "boundary") {
    const text = parsed.rest.join(" ").trim();
    if (!text) throw new Error("Usage: /review boundary <description-or-path>");
    const possiblePath = resolve(cwd, text);
    if (existsSync(possiblePath)) {
      const pathStat = await stat(possiblePath);
      if (pathStat.isDirectory()) {
        const repoPath = relative(cwd, possiblePath) || ".";
        const [files, status] = await Promise.all([
          git(cwd, ["ls-files", "--", repoPath]),
          git(cwd, ["status", "--short", "--untracked-files=all", "--", repoPath]),
        ]);
        return {
          subject: `Review the boundary at ${text}. It is a directory, so inspect the listed files with tools before making claims.\n\nWorking tree status in boundary:\n${status.trim() || "clean"}\n\nTracked files in boundary:\n${files.trim() || "(no tracked files)"}`,
          subjectLabel: text,
        };
      }
      return { subject: await readFile(possiblePath, "utf8"), subjectLabel: text };
    }
    return { subject: text, subjectLabel: "inline boundary description" };
  }

  throw new Error(`Unknown review kind: ${parsed.subcommand}`);
}
