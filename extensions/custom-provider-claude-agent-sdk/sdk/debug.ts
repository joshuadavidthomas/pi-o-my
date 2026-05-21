import { appendFileSync } from "node:fs";

type DebugData = Record<string, unknown> | (() => Record<string, unknown>);

export function debug(message: string, data?: DebugData) {
  if (!process.env.PI_CLAUDE_AGENT_SDK_DEBUG) return;
  const resolved = typeof data === "function" ? data() : data;
  const suffix = resolved ? ` ${JSON.stringify(resolved)}` : "";
  const line = `[${new Date().toISOString()}] ${message}${suffix}\n`;
  try {
    appendFileSync("/tmp/pi-claude-agent-sdk-provider.log", line);
  } catch {
    // Ignore debug logging failures.
  }
}
