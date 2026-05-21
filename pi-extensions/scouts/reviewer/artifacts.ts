import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { ParsedArgs } from "./args.ts";
import type { ReviewArtifactType, ReviewContext } from "./run.ts";
import { vcsFor, type VcsAdapter } from "./vcs.ts";

export type CollectedArtifact = {
  subject: string;
  subjectLabel: string;
};

export type ArtifactDeps = {
  vcs?: VcsAdapter;
};

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

function invalidRepoTargetText(cwd: string, parsed: ParsedArgs): string {
  const target = parsed.rest.join(" ").trim();
  const possiblePath = resolve(cwd, target);
  const suggestion = target && existsSync(possiblePath)
    ? ` Use /review file ${target} or /review boundary ${target} instead.`
    : "";
  return `/review repo does not accept a positional target: ${target}.${suggestion}`;
}

export async function collectArtifact(cwd: string, parsed: ParsedArgs, deps: ArtifactDeps = {}): Promise<CollectedArtifact> {
  const vcs = deps.vcs ?? vcsFor(cwd);

  if (parsed.subcommand === "repo") {
    if (parsed.rest.length > 0) throw new Error(invalidRepoTargetText(cwd, parsed));

    const [status, files] = await Promise.all([
      vcs.status(cwd),
      vcs.trackedFiles(cwd),
    ]);
    return {
      subject: `Review the current ${vcs.name} repository at ${cwd}. Use tools to inspect the files relevant to each finding.\n\nWorking tree status:\n${status.trim() || "clean"}\n\nTracked files:\n${files.trim()}`,
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
    if (!parsed.explicitSubcommand && parsed.rest.length > 0) {
      throw new Error(`/review does not accept a positional target without a review kind: ${parsed.rest.join(" ")}. Use /review file <path>, /review boundary <path>, or /review diff <base>.`);
    }

    const base = parsed.base ?? parsed.rest[0];
    return base ? vcs.diffFromBase(cwd, base) : vcs.defaultReviewDiff(cwd);
  }

  if (parsed.subcommand === "staged") return vcs.stagedDiff(cwd);

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
          vcs.trackedFiles(cwd, repoPath),
          vcs.status(cwd, repoPath),
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
