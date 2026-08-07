import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { resolveAgentToolPool } from "./tool-pool.ts";

export interface AgentDefinition {
  name: string;
  description?: string;
  tools?: string[];
  allowsMutation?: boolean;
  model?: string;
  skills?: string[];
  systemPrompt: string;
  sourcePath: string;
}

export interface LoadedAgentDefinitions {
  definitions: Map<string, AgentDefinition>;
  diagnostics: string[];
}

export interface LoadAgentDefinitionsOptions {
  shippedDefinitionsDir?: string;
  homeDir?: string;
  projectDefinitionsDir?: string;
}

type Frontmatter = Record<string, unknown>;

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));
export const SHIPPED_AGENT_DEFINITIONS_DIR = join(AGENT_DIR, "definitions");

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMarkdownDefinition(sourcePath: string, content: string): { frontmatter: Frontmatter; body: string } {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };

  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (!match) {
    throw new Error("missing closing frontmatter delimiter");
  }

  const parsed = parseYaml(match[1] ?? "") ?? {};
  if (!isObject(parsed)) {
    throw new Error("frontmatter must be a YAML object");
  }

  return { frontmatter: parsed, body: match[2] ?? "" };
}

function filenameFallbackName(path: string): string {
  return basename(path, extname(path));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseStringList(value: unknown, fieldName: string): { values?: string[]; diagnostics: string[] } {
  const diagnostics: string[] = [];

  if (value === undefined) return { diagnostics };

  if (typeof value === "string") {
    const values = value.split(",").map((part) => part.trim()).filter(Boolean);
    return { values, diagnostics };
  }

  if (Array.isArray(value)) {
    const values: string[] = [];
    value.forEach((item, index) => {
      if (typeof item === "string") {
        const trimmed = item.trim();
        if (trimmed) values.push(trimmed);
        return;
      }
      diagnostics.push(`${fieldName}[${index}] is not a string. Ignoring.`);
    });
    return { values, diagnostics };
  }

  diagnostics.push(`${fieldName} must be a CSV string or YAML list. Ignoring.`);
  return { diagnostics };
}

function parseAgentDefinitionFile(sourcePath: string): { definition?: AgentDefinition; diagnostics: string[] } {
  const diagnostics: string[] = [];
  let content: string;

  try {
    content = readFileSync(sourcePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { diagnostics: [`Skipped agent definition ${sourcePath}: failed to read file: ${message}`] };
  }

  let parsed: { frontmatter: Frontmatter; body: string };
  try {
    parsed = parseMarkdownDefinition(sourcePath, content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { diagnostics: [`Skipped agent definition ${sourcePath}: malformed frontmatter: ${message}`] };
  }

  const name = optionalString(parsed.frontmatter.name) ?? filenameFallbackName(sourcePath);
  const description = optionalString(parsed.frontmatter.description);
  const model = optionalString(parsed.frontmatter.model);
  const normalizedModel = model?.toLowerCase() === "inherit" ? undefined : model;

  const tools = parseStringList(parsed.frontmatter.tools, "tools");
  diagnostics.push(...tools.diagnostics.map((message) => `${sourcePath}: ${message}`));

  const skills = parseStringList(parsed.frontmatter.skills, "skills");
  diagnostics.push(...skills.diagnostics.map((message) => `${sourcePath}: ${message}`));

  const mutatingTools = new Set<string>(
    (tools.values ?? [])
      .map((tool) => tool.toLowerCase())
      .filter((tool) => tool === "edit" || tool === "write"),
  );
  const allowsMutation = mutatingTools.has("edit") && mutatingTools.has("write");
  const nonMutatingTools = tools.values?.filter((tool) => !mutatingTools.has(tool.toLowerCase()));
  const toolResolution = nonMutatingTools ? resolveAgentToolPool(nonMutatingTools) : undefined;
  if (toolResolution) {
    diagnostics.push(...toolResolution.warnings.map((message) => `${sourcePath}: ${message}`));
  }

  return {
    definition: {
      name,
      ...(description ? { description } : {}),
      ...(toolResolution ? { tools: toolResolution.toolNames } : {}),
      ...(allowsMutation ? { allowsMutation: true } : {}),
      ...(normalizedModel ? { model: normalizedModel } : {}),
      ...(skills.values ? { skills: skills.values } : {}),
      systemPrompt: parsed.body.trim(),
      sourcePath,
    },
    diagnostics,
  };
}

function definitionFilesIn(dir: string, diagnostics: string[]): string[] {
  if (!existsSync(dir)) return [];

  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(dir, entry.name))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(`Skipped agent definitions dir ${dir}: failed to read directory: ${message}`);
    return [];
  }
}

function definitionDirs(cwd: string, options: LoadAgentDefinitionsOptions): string[] {
  const homeDir = options.homeDir ?? homedir();
  return [
    options.shippedDefinitionsDir ?? SHIPPED_AGENT_DEFINITIONS_DIR,
    join(homeDir, ".pi", "agent", "agents"),
    options.projectDefinitionsDir ?? join(resolve(cwd), ".pi", "agents"),
  ];
}

export function loadAgentDefinitions(cwd: string, options: LoadAgentDefinitionsOptions = {}): LoadedAgentDefinitions {
  const diagnostics: string[] = [];
  const definitions = new Map<string, AgentDefinition>();

  for (const dir of definitionDirs(cwd, options)) {
    for (const file of definitionFilesIn(dir, diagnostics)) {
      const loaded = parseAgentDefinitionFile(file);
      diagnostics.push(...loaded.diagnostics);
      if (loaded.definition) definitions.set(loaded.definition.name, loaded.definition);
    }
  }

  return { definitions, diagnostics };
}
