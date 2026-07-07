const PREAMBLE = `You are a specialist agent executing a focused task. You have domain expertise loaded below.

Your job: apply this expertise to the task you are given. Be thorough, use your tools to investigate and verify, and produce a clear, actionable result.

Strategy:
- Read the domain expertise first to understand the approach.
- Investigate using tools before taking action — verify assumptions, read relevant code, check context.
- Adapt the guidance to the specific situation. Don't follow templates mechanically.
- End with a clear summary of findings or actions taken.

Constraints:
- You have a wall-clock timeout. Be efficient with tool calls.
- Focus on the task. Do not go on tangents.`;

export function buildReviewerSystemPrompt(lensContent: string, timeoutMs: number, lensBaseDir?: string): string {
  const baseDirHint = lensBaseDir
    ? `\n\nLens base directory: ${lensBaseDir}\nWhen the lens references \`{baseDir}\`, resolve it to this path. When it references relative paths, resolve them against this directory.`
    : "";

  const timeoutMinutes = Math.round(timeoutMs / 60_000);

  return `${PREAMBLE}

Timeout: ${timeoutMinutes} minutes. Keep the work focused and provide the best supported answer before time runs out.${baseDirHint}

## Domain Expertise

${lensContent}`;
}

export function buildReviewerUserPrompt(params: Record<string, unknown>): string {
  const task = String(params.task ?? "").trim();
  if (!task) return "No task provided.";
  return task;
}
