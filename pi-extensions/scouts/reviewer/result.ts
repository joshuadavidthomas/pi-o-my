import { executeScout } from "../execute.ts";

type ReviewScoutResult = Awaited<ReturnType<typeof executeScout>>;

export function hasResultText(result: ReviewScoutResult): boolean {
  const text = result.content?.find((item) => item.type === "text")?.text?.trim();
  return !!text && !text.endsWith("(no output)");
}

export function resultText(result: ReviewScoutResult): string {
  const text = result.content?.find((item) => item.type === "text")?.text?.trim();
  if (hasResultText(result)) return text!;

  const run = result.details.runs[0];
  const model = result.details.subagentProvider && result.details.subagentModelId
    ? `${result.details.subagentProvider}/${result.details.subagentModelId}`
    : "unknown model";
  const status = run?.status ?? result.details.status;
  const turns = run?.turns ?? 0;
  const toolCount = run?.displayItems.filter((item) => item.type === "tool").length ?? 0;
  const error = run?.error ? ` Error: ${run.error}` : "";
  const saved = result.details.summaryPath ? ` Saved summary: ${result.details.summaryPath}` : "";
  return `(review scout returned no text; status=${status}, turns=${turns}, tools=${toolCount}, model=${model}.${error}${saved})`;
}
