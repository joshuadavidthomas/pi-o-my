import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DefaultResourceLoader,
  getAgentDir,
  type ResourceLoader,
  type Skill,
} from "@earendil-works/pi-coding-agent";

type ResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type ScoutResourceLoaderOptions = Omit<
  ResourceLoaderOptions,
  | "cwd"
  | "agentDir"
  | "noExtensions"
  | "noPromptTemplates"
  | "noThemes"
  | "additionalExtensionPaths"
  | "extensionFactories"
> & {
  cwd: string;
  agentDir?: string;
  allowExtensions?: boolean;
};

export function resolveClaudeAgentSdkExtensionPath(): string | undefined {
  const candidate = resolve(dirname(fileURLToPath(import.meta.url)), "../custom-provider-claude-agent-sdk");
  return existsSync(candidate) ? candidate : undefined;
}

export async function createScoutResourceLoader(
  options: ScoutResourceLoaderOptions,
): Promise<ResourceLoader> {
  const { agentDir = getAgentDir(), allowExtensions = false, ...rest } = options;
  const claudeAgentSdkExtensionPath = allowExtensions
    ? resolveClaudeAgentSdkExtensionPath()
    : undefined;
  if (allowExtensions && !claudeAgentSdkExtensionPath) {
    throw new Error("Claude Agent SDK provider extension was not found beside the Scouts package");
  }

  const resourceLoader = new DefaultResourceLoader({
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    ...rest,
    agentDir,
    extensionFactories: [],
    additionalExtensionPaths: claudeAgentSdkExtensionPath
      ? [claudeAgentSdkExtensionPath]
      : [],
  });
  await resourceLoader.reload();
  return resourceLoader;
}

export async function loadScoutSkills(cwd: string): Promise<Skill[]> {
  const resourceLoader = await createScoutResourceLoader({ cwd });
  return resourceLoader.getSkills().skills;
}
