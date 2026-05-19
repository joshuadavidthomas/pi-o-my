import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { REVIEWER_TOOL } from "./tool.ts";

type Lens = "both" | "hickey" | "lowy";
type ReviewContext = "none" | "brief" | "transcript";

type ParsedArgs = {
  subcommand: string;
  rest: string[];
  base?: string;
  strict: boolean;
  lens: Lens;
  context?: ReviewContext;
};

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

function parseArgs(args: string): ParsedArgs {
  const words = shellWords(args.trim());
  const subcommand = words.shift() ?? "help";
  const rest: string[] = [];
  let base: string | undefined;
  let strict = false;
  let lens: Lens = "both";
  let context: ReviewContext | undefined;

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
    if (word === "--hickey") {
      lens = "hickey";
      continue;
    }
    if (word === "--lowy") {
      lens = "lowy";
      continue;
    }
    if (word === "--both") {
      lens = "both";
      continue;
    }
    if (word === "--base") {
      base = words[i + 1];
      i += 1;
      continue;
    }
    if (word === "--context") {
      const value = words[i + 1];
      if (value === "none" || value === "brief" || value === "transcript") {
        context = value;
      }
      i += 1;
      continue;
    }
    rest.push(word);
  }

  return { subcommand, rest, base, strict, lens, context };
}

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

async function optionalRepoConfig(cwd: string): Promise<string> {
  const candidates = [join(cwd, ".pi", "review.md"), join(cwd, ".review-lenses.md")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const content = await readFile(candidate, "utf8");
      return `Repo-specific review config from ${candidate}:\n\n${content}`;
    }
  }
  return "";
}

function lensesFor(lens: Lens): string[] {
  if (lens === "hickey") return ["hickey"];
  if (lens === "lowy") return ["lowy"];
  return ["hickey", "lowy"];
}

function defaultContextFor(subcommand: string): ReviewContext {
  if (subcommand === "design" || subcommand === "plan" || subcommand === "session") return "brief";
  return "none";
}

function artifactTypeFor(subcommand: string): string {
  if (subcommand === "diff" || subcommand === "staged") return "diff";
  if (subcommand === "plan") return "plan";
  if (subcommand === "design") return "design";
  if (subcommand === "file") return "file";
  if (subcommand === "boundary") return "module";
  if (subcommand === "session") return "session";
  return "other";
}

function helpText(): string {
  return `Structural review runs isolated reviewer scouts over a sketch, plan, file, or diff.

Hickey asks: is this structurally simple? It looks for complected concerns, fragmented concepts, duplicated abstractions, hidden invariants, and accidental complexity.

Lowy asks: do the boundaries contain change? It looks for modules split by related functionality instead of volatility, unstable interfaces, duplicated receptacles, and change blast radius.

How to use it:
- Early idea: /review design <sketch>
- Before implementation: /review plan <plan-or-path>
- After implementation: /review diff [base]
- Local work only: /review staged
- Focused audit: /review file <path> or /review boundary <path-or-description>

How it runs:
/review gathers the artifact and calls the reviewer tool directly from the extension command. It does not ask the main agent to call a tool, and reviewer deliberation stays out of the main session.

Modes:
- default: both lenses, notes mode
- --strict: every real finding must be fixed now or marked No-op
- --hickey / --lowy: run only one lens
- --context none|brief|transcript: describe how much context is included; diff/file default to none, design/plan default to brief
- --base <base>: choose the diff base

Examples:
/review design Add a plugin system with per-plugin config and lifecycle hooks
/review plan docs/agents/plugin-system/plan.md
/review diff --base main --strict
/review staged --hickey
/review file src/auth/session.ts
/review boundary src/billing --lowy`;
}

function getResultText(result: Awaited<ReturnType<typeof REVIEWER_TOOL.execute>>): string {
  return result.content?.find((item) => item.type === "text")?.text ?? "(no review output)";
}

async function collectArtifact(cwd: string, parsed: ParsedArgs): Promise<{ subject: string; subjectLabel: string }> {
  if (parsed.subcommand === "design" || parsed.subcommand === "plan") {
    const text = parsed.rest.join(" ").trim();
    if (!text) throw new Error(`Usage: /review ${parsed.subcommand} <text-or-path>`);
    const possiblePath = resolve(cwd, text);
    if (existsSync(possiblePath)) {
      return { subject: await readFile(possiblePath, "utf8"), subjectLabel: text };
    }
    return { subject: text, subjectLabel: "inline text" };
  }

  if (parsed.subcommand === "diff") {
    const base = parsed.base ?? parsed.rest[0] ?? "origin/HEAD";
    const range = base.includes("...") || base.includes("..") ? base : `${base}...HEAD`;
    return { subject: await git(cwd, ["diff", range]), subjectLabel: `git diff ${range}` };
  }

  if (parsed.subcommand === "staged") {
    return { subject: await git(cwd, ["diff", "--cached"]), subjectLabel: "git diff --cached" };
  }

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
      return { subject: await readFile(possiblePath, "utf8"), subjectLabel: text };
    }
    return { subject: text, subjectLabel: "inline boundary description" };
  }

  throw new Error(helpText());
}

export function registerReviewCommand(pi: ExtensionAPI) {
  pi.registerCommand("review", {
    description: "Gather an artifact and run the isolated reviewer scout directly",
    getArgumentCompletions: (prefix) => {
      const items = ["design", "plan", "diff", "staged", "file", "boundary", "help"];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      if (parsed.subcommand === "help") {
        ctx.ui.notify(helpText(), "info");
        return;
      }

      try {
        const { subject, subjectLabel } = await collectArtifact(ctx.cwd, parsed);
        if (!subject.trim()) {
          ctx.ui.notify(`No content found for ${subjectLabel}.`, "warning");
          return;
        }

        ctx.ui.setStatus("review", "reviewing…");
        const mode = parsed.strict ? "strict" : "notes";
        const lenses = lensesFor(parsed.lens);
        const query = [
          `Review ${subjectLabel}.`,
          `Artifact source: /review ${parsed.subcommand}.`,
          `Apply ${lenses.join(" and ")} lens${lenses.length === 1 ? "" : "es"}.`,
          mode === "strict"
            ? "Use strict mode: every real finding must be Fix now or No-op."
            : "Use notes mode: separate Must fix from Advisory notes.",
          "Return evidence-backed findings, synthesis, and concrete actions.",
        ].join(" ");

        const result = await REVIEWER_TOOL.execute(
          `review-command-${Date.now()}`,
          {
            query,
            artifactType: artifactTypeFor(parsed.subcommand),
            artifact: subject,
            lenses,
            mode,
            context: parsed.context ?? defaultContextFor(parsed.subcommand),
            repoConfig: await optionalRepoConfig(ctx.cwd),
          },
          ctx.signal,
          undefined,
          ctx,
        );

        const text = getResultText(result);
        pi.sendMessage({
          customType: "review-result",
          content: text,
          display: true,
        });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        ctx.ui.setStatus("review", "");
      }
    },
  });
}
