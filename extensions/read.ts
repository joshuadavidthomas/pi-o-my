/**
 * Read Tool Override
 *
 * Overrides the built-in read tool to handle directories gracefully.
 * When called on a directory, returns an `ls -la` listing and a hint
 * instead of erroring with EISDIR. All other behavior delegates to
 * the built-in implementation.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";

function expandPath(filePath: string): string {
  const normalized = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/")) return homedir() + normalized.slice(1);
  return normalized;
}

function resolvePath(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export default function (pi: ExtensionAPI) {
  const builtinRead = createReadTool(process.cwd());

  pi.registerTool({
    ...builtinRead,
    async execute(
      toolCallId: string,
      params: { path: string; offset?: number; limit?: number },
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: ExtensionContext,
    ) {
      const absolutePath = resolvePath(params.path, ctx.cwd);

      try {
        const stats = await stat(absolutePath);
        if (stats.isDirectory()) {
          let listing: string;
          try {
            listing = execSync(`ls -la ${JSON.stringify(absolutePath)}`, {
              encoding: "utf-8",
              timeout: 5000,
              stdio: ["pipe", "pipe", "pipe"],
            }).trim();
          } catch {
            listing = "(failed to list directory)";
          }

          const text = [
            listing,
            "",
            `Hint: "${params.path}" is a directory, not a file. Use bash tools (ls, find, etc.) for directories.`,
          ].join("\n");

          return {
            content: [{ type: "text" as const, text }],
            details: {},
          };
        }
      } catch {
        // stat failed — let the built-in read handle it (file not found, etc.)
      }

      return builtinRead.execute(toolCallId, params, signal, onUpdate) as any;
    },
  });
}
