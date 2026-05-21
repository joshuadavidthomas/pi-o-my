/**
 * Beans extension for pi
 *
 * Injects Beans CLI context into the system prompt and re-attaches it after
 * session compaction so the model always has current task context.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { access } from "node:fs/promises";

const BEANS_CONFIG = ".beans.yml";

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const loadBeansContext = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<string | undefined> => {
  try {
    const configPath = path.join(ctx.cwd, BEANS_CONFIG);
    const hasConfig = await fileExists(configPath);
    if (!hasConfig) return undefined;

    const hasBeans = await pi.exec("which", ["beans"], { cwd: ctx.cwd });
    if (hasBeans.code !== 0) return undefined;

    const result = await pi.exec("beans", ["prime"], { cwd: ctx.cwd });
    if (result.code !== 0) return undefined;

    const output = result.stdout.trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
};

export default function (pi: ExtensionAPI) {
  let beansContext: string | undefined;
  let lastCompactionId: string | undefined;
  let refreshGeneration = 0;

  const refreshBeansContext = async (ctx: ExtensionContext, generation: number) => {
    const nextContext = await loadBeansContext(pi, ctx);
    if (generation === refreshGeneration) {
      beansContext = nextContext;
    }
  };

  pi.on("session_start", (_event, ctx) => {
    beansContext = undefined;
    const generation = ++refreshGeneration;
    void refreshBeansContext(ctx, generation);
  });

  pi.on("before_agent_start", async (event) => {
    if (!beansContext) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${beansContext}` };
  });

  pi.on("session_compact", async (event) => {
    if (!beansContext) return;
    if (event.compactionEntry.id === lastCompactionId) return;
    lastCompactionId = event.compactionEntry.id;

    pi.sendMessage(
      {
        customType: "beans-context",
        content: beansContext,
        display: false,
        details: { source: "compaction" },
      },
      { deliverAs: "nextTurn" },
    );
  });
}
