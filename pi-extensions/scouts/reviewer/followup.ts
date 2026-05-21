import type { ReviewLens } from "./config.ts";
import type { ParsedArgs } from "./args.ts";

function lensListLabel(lenses: ReviewLens[]): string {
  return lenses.map((lens) => lens[0]!.toUpperCase() + lens.slice(1)).join(", ");
}

export function followupPrompt(parsed: ParsedArgs, lenses: ReviewLens[], subjectLabel: string, hasReviewOutput: boolean): string | undefined {
  if (parsed.followup === "none" || !hasReviewOutput) return undefined;

  if (parsed.followup === "fix") {
    return `Address the review findings above for ${subjectLabel}.
First synthesize the ${lensListLabel(lenses)} passes: identify overlaps, conflicts, accepted findings, rejected findings, and why.
Then implement only the accepted fixes. Do not split the difference between conflicting recommendations; choose the reasoning that holds up.
Keep scope to the reviewed artifact unless a finding requires a directly related change.`;
  }

  return `Synthesize the review findings above for ${subjectLabel}. Do not implement yet.
Treat ${lensListLabel(lenses)} as independent reviewers. Identify overlaps, conflicts, which findings to accept or reject, and the next action.
When the passes disagree, do not split the difference; pick the reasoning that holds up or reject both.`;
}
