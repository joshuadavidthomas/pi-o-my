// Scouts extension — registers the dynamic agent tool plus scout commands.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AGENT_TOOL } from "./agent/tool.ts";
import { registerReviewCommand } from "./reviewer/command.ts";

export default function scoutsExtension(pi: ExtensionAPI) {
  pi.registerTool(AGENT_TOOL);
  registerReviewCommand(pi);
}
