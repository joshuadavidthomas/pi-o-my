import { createReadTool, type ExtensionContext, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { executeScout } from "../../execute.ts";
import { createReadOnlyBashTool } from "../../tools/read-only-bash.ts";
import type { ScoutConfig } from "../../types.ts";

const FACT_CHECK_PROMPT = `# Fact-Check

Audit code for **correctness and rigor**. This is not a style review — it's a logic review. Find places where the code lies to itself.

## 0. Determine Scope

Scope comes from the supplied target:

- branch (default when target is empty) — audit only changes in the current branch/PR. Use git diff main...HEAD or the appropriate base branch to identify changed files and limit all subsequent steps to those files.
- all — audit the whole codebase.
- Anything else — treat the argument as the target itself (a file path, a diff range like origin/main...HEAD, or inline text/output to audit, e.g. when invoked by hickey to audit its own evaluation). Limit the audit to that target.

Do not ask the user questions. This tool runs in a fork and is routinely invoked autonomously.

## What to flag

### 1. Silent error swallowing
- Bare try/except/pass, empty catch {}, || true hiding real failures.
- Errors caught and logged but not propagated when callers depend on failure signals.
- Result/Option/Maybe types silently defaulted without justification.

### 2. Inaccurate fallbacks
- Default values that mask misconfiguration.
- "Sensible defaults" that aren't actually sensible for the failure case.
- Fallback paths that silently degrade correctness.

### 3. Wishful thinking
- Assumptions about input shape/type without validation at system boundaries.
- Code that "can't fail" but actually can (network, filesystem, permissions).
- Race conditions papered over with comments like "this should be fine".

### 4. Logic errors
- Conditions that are always true/false.
- Off-by-one errors, wrong comparison operators.
- Variables shadowed or unused in a way that changes behavior.

### 5. Slow leaks
- Collections that grow without bound, event handlers doing heavy work on every fire without debounce, watchers/listeners registered per-caller instead of shared, buffers sized to the full input when streaming would work.

## Workflow

1. Read the diff (or full files if scoped to whole codebase).
2. For each changed file, read enough surrounding context to understand intent.
3. List every finding with file, line, and a one-line explanation of the risk.
4. For each finding, propose a concrete fix (code snippet or direction).
5. If no issues found, say so — don't invent problems.

## Principles

- **Fail loud over fail silent**: Code should scream when something is wrong, not quietly do the wrong thing.
- **No wishful thinking**: If it can fail, handle the failure explicitly.
- **Fallbacks must be justified**: Every default/fallback needs a reason why that value is correct for the failure case, not just convenient.
- **Precision over coverage**: Better to catch 3 real issues than flag 20 maybes.

## Anti-patterns in YOUR review (strictly banned)

You are an LLM reviewing code. LLMs have a strong bias toward declaring code "acceptable" to avoid conflict. This command exists precisely to counteract that. Follow these rules absolutely:

- **NEVER talk yourself out of a finding.** If you identified a problem, it IS a problem. Do not follow up with "However..." or "Verdict: acceptable tradeoff" or "practically safe." If the code has a bogus fallback, say so and propose a fix. Period.
- **NEVER use "theoretically X but practically Y" to dismiss.** "Theoretically fragile but practically safe" is exactly the kind of wishful thinking this command is supposed to catch. If it's fragile, flag it and fix it.
- **NEVER issue a verdict of "no action needed" on a finding you just described.** If it wasn't worth acting on, you shouldn't have listed it. Every finding you report MUST have a concrete fix.
- **NEVER end with reassurance.** No "the logic is sound", no "the approach correctly targets the root cause", no "no other issues found" unless you genuinely found zero issues. Your job is to find problems, not to make the author feel good.
- **Assume the code is wrong until proven right.** The default posture is skepticism, not charity. You are a prosecutor, not a defense attorney.`;

export const FactCheckParams = Type.Object({
  target: Type.Optional(Type.String({
    description: "Target to fact-check: branch, all, file path, diff range, or label for inline reviewer output.",
  })),
  draft: Type.Optional(Type.String({
    description: "Reviewer draft/evaluation to fact-check when invoked by a reviewer lens.",
  })),
  artifact: Type.Optional(Type.String({
    description: "Optional original artifact text, diff, plan, or code excerpt the draft is based on.",
  })),
});

function factCheckUserPrompt(params: Record<string, unknown>): string {
  const target = String(params.target ?? "branch").trim() || "branch";
  const draft = typeof params.draft === "string" ? params.draft.trim() : "";
  const artifact = typeof params.artifact === "string" ? params.artifact.trim() : "";

  return [
    target,
    draft ? `\nReviewer draft to fact-check:\n${draft}` : "",
    artifact ? `\nOriginal artifact/context:\n${artifact}` : "",
  ].filter(Boolean).join("\n");
}

const factCheckConfig: ScoutConfig = {
  name: "fact-check",
  maxTurns: 10,
  workload: "fast",
  buildSystemPrompt: () => FACT_CHECK_PROMPT,
  buildUserPrompt: factCheckUserPrompt,
  createTools: (cwd) => [createReadTool(cwd), createReadOnlyBashTool(cwd)],
};

export function createFactCheckTool(ctx: ExtensionContext): ToolDefinition<typeof FactCheckParams> {
  return {
    name: "factCheck",
    label: "Fact Check",
    description:
      "Run the fact-check prompt in an isolated scout context. Use inside reviewer lenses to audit your own draft output for correctness, unsupported claims, wishful dismissals, unjustified fallbacks, and missing concrete fixes.",
    parameters: FactCheckParams,

    async execute(_toolCallId, params, signal, onUpdate) {
      const result = await executeScout(
        factCheckConfig,
        params as Record<string, unknown>,
        signal,
        onUpdate,
        ctx,
      );
      return {
        content: result.content,
        details: result.details,
      };
    },
  };
}
