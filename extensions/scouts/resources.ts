import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  DefaultResourceLoader,
  getAgentDir,
  type LoadExtensionsResult,
  type ResourceLoader,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

type ResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type ScoutResourceLoaderOptions = Omit<ResourceLoaderOptions, "cwd" | "agentDir" | "noExtensions" | "noPromptTemplates" | "noThemes"> & {
  cwd: string;
  agentDir?: string;
  allowExtensions?: boolean;
};

function resolveClaudeAgentSdkExtensionPath(agentDir: string): string | undefined {
  const candidate = resolve(agentDir, "extensions/custom-provider-claude-agent-sdk");
  return existsSync(candidate) ? candidate : undefined;
}

function withOnlyExtensions(
  base: DefaultResourceLoader,
  cwd: string,
  extensionPath: string,
  extensions: LoadExtensionsResult,
): ResourceLoader {
  return {
    getExtensions: () => extensions,
    getSkills: () => base.getSkills(),
    getPrompts: () => base.getPrompts(),
    getThemes: () => base.getThemes(),
    getAgentsFiles: () => base.getAgentsFiles(),
    getSystemPrompt: () => base.getSystemPrompt(),
    getAppendSystemPrompt: () => base.getAppendSystemPrompt(),
    extendResources: (paths) => base.extendResources(paths),
    reload: async () => {
      await base.reload();
      extensions = await loadExtensions([extensionPath], cwd);
    },
  };
}

export async function createScoutResourceLoader(
  options: ScoutResourceLoaderOptions,
): Promise<ResourceLoader> {
  const { agentDir = getAgentDir(), allowExtensions = false, ...rest } = options;
  const baseResourceLoader = new DefaultResourceLoader({
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    ...rest,
    agentDir,
  });
  await baseResourceLoader.reload();

  if (!allowExtensions) {
    return baseResourceLoader;
  }

  const claudeAgentSdkExtensionPath = resolveClaudeAgentSdkExtensionPath(agentDir);
  if (!claudeAgentSdkExtensionPath) {
    return baseResourceLoader;
  }

  const extensions = await loadExtensions([claudeAgentSdkExtensionPath], options.cwd);
  return withOnlyExtensions(baseResourceLoader, options.cwd, claudeAgentSdkExtensionPath, extensions);
}

export async function loadScoutSkills(cwd: string): Promise<Skill[]> {
  const resourceLoader = await createScoutResourceLoader({ cwd });
  return resourceLoader.getSkills().skills;
}
