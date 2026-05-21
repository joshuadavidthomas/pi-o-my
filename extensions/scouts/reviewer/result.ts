import { executeScout } from "../execute.ts";

type ReviewScoutResult = Awaited<ReturnType<typeof executeScout>>;

function primaryText(result: ReviewScoutResult): string {
  return result.content?.find((item) => item.type === "text")?.text?.trim() ?? "";
}

function summaryText(result: ReviewScoutResult): string {
  return result.details.runs[0]?.summaryText?.trim() ?? "";
}

function isUsableText(text: string): boolean {
  return text !== "" && text !== "(no output)" && text !== "(searching...)";
}

function outputText(result: ReviewScoutResult): string {
  if (result.details.status === "running") return "";

  const primary = primaryText(result);
  if (isUsableText(primary)) return primary;

  const summary = summaryText(result);
  return isUsableText(summary) ? summary : "";
}

export function hasResultText(result: ReviewScoutResult): boolean {
  return result.details.status !== "running" && outputText(result) !== "";
}

export function resultText(result: ReviewScoutResult): string {
  const text = outputText(result);
  if (text) return text;

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
