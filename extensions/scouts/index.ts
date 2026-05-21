// Scouts extension — registers finder, librarian, oracle, specialist, and reviewer tools.
//
// Finder and librarian originally vendored from pi-finder v1.2.2 and
// pi-librarian v1.1.2, consolidated into a single extension with shared
// infrastructure.
//
// Original authors: Anton Kuzmenko
// pi-finder: https://github.com/default-anton/pi-finder
// pi-librarian: https://github.com/default-anton/pi-librarian

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { FINDER_TOOL } from "./finder/tool.ts";
import { LIBRARIAN_TOOL } from "./librarian/tool.ts";
import { ORACLE_TOOL } from "./oracle/tool.ts";
import { registerReviewCommand } from "./reviewer/command.ts";
import { REVIEWER_TOOL } from "./reviewer/tool.ts";
import { SPECIALIST_TOOL } from "./specialist/tool.ts";

export default function scoutsExtension(pi: ExtensionAPI) {
  pi.registerTool(FINDER_TOOL);
  pi.registerTool(LIBRARIAN_TOOL);
  pi.registerTool(ORACLE_TOOL);
  pi.registerTool(SPECIALIST_TOOL);
  pi.registerTool(REVIEWER_TOOL);
  registerReviewCommand(pi);
}
