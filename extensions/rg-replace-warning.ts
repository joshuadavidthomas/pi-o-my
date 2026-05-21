/**
 * Warns when `rg` is called with `-r` (which means `--replace`, not recursive).
 *
 * A common mistake from grep muscle memory: `rg -rn "pattern"` silently
 * replaces every match with the letter "n" instead of searching recursively
 * with line numbers. `rg` is already recursive and shows line numbers by
 * default — no flags needed.
 *
 * This extension watches bash tool results and prepends a warning when it
 * detects `-r` in short flags to `rg`. The command still runs (it *could*
 * be intentional), but the warning nudges the LLM to re-run without `-r`.
 */

import { isBashToolResult } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WARNING = [
  "⚠️ WARNING: This command uses `rg -r` which means `--replace`, not recursive.",
  "`rg` is already recursive and shows line numbers by default.",
  "The output above likely has substitutions applied — matches were replaced, not displayed.",
  "If you meant to search, re-run without the `-r` flag.",
].join("\n");

function hasRgReplaceFlag(command: string): boolean {
  const segments = command.split(/[|;&]+/);
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/);
    const rgIndex = tokens.findIndex((t) => t === "rg" || t.endsWith("/rg"));
    if (rgIndex === -1) continue;

    for (let i = rgIndex + 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === "--") break;
      if (token.startsWith("--")) continue;
      if (/^-[a-zA-Z]*r[a-zA-Z]*$/.test(token)) {
        return true;
      }
    }
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event) => {
    if (!isBashToolResult(event)) return;

    const command = event.input?.command;
    if (typeof command !== "string" || !hasRgReplaceFlag(command)) return;

    return {
      content: [{ type: "text" as const, text: WARNING }, ...(event.content ?? [])],
    };
  });
}
