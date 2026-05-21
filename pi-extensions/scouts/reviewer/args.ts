import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { isReviewLens, REVIEW_LENSES, type ReviewLens } from "./config.ts";
import type { ReviewContext, ReviewLensSelection } from "./run.ts";

export type ReviewFollowup = "synthesize" | "fix" | "none";

export type ParsedArgs = {
  subcommand: string;
  rest: string[];
  base?: string;
  strict: boolean;
  lens: ReviewLensSelection;
  context?: ReviewContext;
  followup: ReviewFollowup;
};

export const REVIEW_SUBCOMMANDS = ["repo", "design", "plan", "diff", "staged", "file", "boundary"] as const;

export function isReviewSubcommand(value: string): boolean {
  return REVIEW_SUBCOMMANDS.includes(value as (typeof REVIEW_SUBCOMMANDS)[number]);
}

function lensFromFlag(flag: string): ReviewLens | undefined {
  if (!flag.startsWith("--")) return undefined;
  const lens = flag.slice(2);
  return isReviewLens(lens) ? lens : undefined;
}

function lensFlagList(): string {
  return REVIEW_LENSES.map((lens) => `--${lens}`).join("|");
}

function requireFlagValue(words: string[], index: number, flag: string): string {
  const value = words[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.\n\n${shortUsage()}`);
  }
  return value;
}

function parseContextValue(value: string): ReviewContext {
  if (value === "none" || value === "brief" || value === "transcript") return value;
  throw new Error(`Invalid --context value: ${value}. Expected none, brief, or transcript.\n\n${shortUsage()}`);
}

function shellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  if (current) words.push(current);
  return words;
}

export function parseArgs(args: string): ParsedArgs {
  const words = shellWords(args.trim());
  const subcommand = words[0]?.startsWith("--") ? "repo" : words.shift() ?? "repo";
  const rest: string[] = [];
  let base: string | undefined;
  let strict = false;
  let lens: ReviewLensSelection = "all";
  let context: ReviewContext | undefined;
  let followup: ReviewFollowup = "synthesize";

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === "--strict") {
      strict = true;
      continue;
    }
    if (word === "--notes") {
      strict = false;
      continue;
    }
    const flagLens = lensFromFlag(word);
    if (flagLens) {
      lens = flagLens;
      continue;
    }
    if (word === "--both" || word === "--all") {
      lens = "all";
      continue;
    }
    if (word === "--fix") {
      followup = "fix";
      continue;
    }
    if (word === "--no-followup" || word === "--no-synthesize") {
      followup = "none";
      continue;
    }
    if (word === "--base") {
      base = requireFlagValue(words, i, "--base");
      i += 1;
      continue;
    }
    if (word === "--context") {
      context = parseContextValue(requireFlagValue(words, i, "--context"));
      i += 1;
      continue;
    }
    rest.push(word);
  }

  return { subcommand, rest, base, strict, lens, context, followup };
}

export function shortUsage(): string {
  return `Usage:
/review [repo]
/review design <sketch>
/review plan <plan-or-path>
/review diff [base] [--strict] [${lensFlagList()}]
/review staged
/review file <path>
/review boundary <path-or-description>`;
}

export function invalidInvocationText(cwd: string, parsed: ParsedArgs): string {
  const given = [parsed.subcommand, ...parsed.rest].join(" ").trim();
  const possiblePath = resolve(cwd, given);
  const suggestion = existsSync(possiblePath)
    ? `\n\nThat looks like a path. Choose what kind of artifact it is, for example:\n/review plan ${given}\n/review file ${given}`
    : "";

  return `Unknown review kind: ${parsed.subcommand}\n\n/review needs a kind before the target: repo, design, plan, diff, staged, file, or boundary.${suggestion}\n\n${shortUsage()}`;
}

export function helpText(): string {
  return `Structural review runs reviewer-local Hickey, Lowy, Grug, Beck, Muratori, and Lamport lenses as isolated scouts.

Hickey asks: is this structurally simple?

Lowy asks: do the boundaries contain change?

Grug asks: does this make the next change smaller in brain?

Beck asks: what smallest tidy makes the intended change easy?

Muratori asks: does this keep the actual work visible until real semantics are worth compressing?

Lamport asks: what precise state-machine model preserves the required properties?

How to use it:
- Current repository: /review or /review repo
- Early idea: /review design <sketch>
- Before implementation: /review plan <plan-or-path>
- After implementation: /review diff [base]
- Local work only: /review staged
- Focused audit: /review file <path> or /review boundary <path-or-description>

Modes:
- default: all reviewer lenses, notes mode
- --strict: tell the lenses to use Fix now / No-op dispositions
- ${REVIEW_LENSES.map((lens) => `--${lens}`).join(" / ")}: run only one lens
- --context none|brief|transcript: describe how much context is included; diff/file default to none, design/plan default to brief
- --base <base>: choose the diff base
- default follow-up: ask the main agent to synthesize reviewer findings after all selected passes
- --fix: ask the main agent to address accepted findings after synthesis
- --no-followup: only display reviewer outputs

Examples:
/review
/review repo --grug
/review design Add a plugin system with per-plugin config and lifecycle hooks
/review plan docs/agents/plugin-system/plan.md
/review diff --base main --strict
/review staged --hickey
/review file src/auth/session.ts
/review boundary src/billing --lowy
/review diff --grug
/review diff --muratori
/review plan docs/agents/plugin-system/plan.md --lamport`;
}
