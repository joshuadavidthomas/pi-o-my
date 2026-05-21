// System and user prompt builders for the specialist scout.
//
// Unlike other scouts, the specialist's system prompt is loaded from a
// SKILL.md file on disk. The preamble orients the agent as an expert
// executing under a turn budget, then the skill content follows.

const PREAMBLE = `You are a specialist agent executing a focused task. You have domain expertise loaded below.

Your job: apply this expertise to the task the user gives you. Be thorough, use your tools to investigate and verify, and produce a clear, actionable result.

Strategy:
- Read the domain expertise first to understand the approach.
- Investigate using tools before taking action — verify assumptions, read relevant code, check context.
- Adapt the guidance to the specific situation. Don't follow templates mechanically.
- End with a clear summary of findings or actions taken.

Constraints:
- You have a limited turn budget. Be efficient with tool calls.
- Focus on the task. Do not go on tangents.`;

export function buildSpecialistSystemPrompt(skillContent: string, maxTurns: number, skillBaseDir?: string): string {
  const baseDirHint = skillBaseDir
    ? `\n\nSkill base directory: ${skillBaseDir}\nWhen the skill references \`{baseDir}\`, resolve it to this path. When it references relative paths, resolve them against this directory.`
    : "";

  return `${PREAMBLE}

Turn budget: ${maxTurns} turns total. Budget ~${Math.ceil(maxTurns * 0.7)} turns for investigation and action, reserve the rest for synthesis. On your final turn, tool use is disabled — provide your answer.${baseDirHint}

## Domain Expertise

${skillContent}`;
}

export function buildSpecialistUserPrompt(params: Record<string, unknown>): string {
  const task = String(params.task ?? "").trim();
  if (!task) return "No task provided.";
  return task;
}
