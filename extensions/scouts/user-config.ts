import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import { VALID_SCOUT_NAMES, VALID_THINKING_LEVELS, type ScoutModelTarget, type ScoutName } from "./models.ts";

export class ScoutUserConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoutUserConfigError";
  }
}

export interface ScoutUserConfig {
  modelTargetsByScout: Partial<Record<ScoutName, ScoutModelTarget[]>>;
  sources: string[];
}

function stripJsonc(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    const next = input[i + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      } else if (char === "\n" || char === "\r") {
        output += char;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    output += char;
  }

  return output.replace(/,\s*([}\]])/g, "$1");
}

function parseJsoncFile(path: string): unknown {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ScoutUserConfigError(`Failed to read scout config ${path}: ${message}`);
  }

  try {
    return JSON.parse(stripJsonc(content));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ScoutUserConfigError(`Malformed JSONC in scout config ${path}: ${message}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateThinkingLevel(value: unknown, path: string): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(VALID_THINKING_LEVELS as readonly string[]).includes(value)) {
    throw new ScoutUserConfigError(`Invalid thinkingLevel at ${path}: expected one of ${VALID_THINKING_LEVELS.join(", ")}.`);
  }
  return value as ThinkingLevel;
}

function validateConfig(path: string, raw: unknown): Partial<Record<ScoutName, ScoutModelTarget[]>> {
  if (!isObject(raw)) {
    throw new ScoutUserConfigError(`Invalid scout config ${path}: top-level value must be an object.`);
  }

  if (raw.scouts === undefined) return {};
  if (!isObject(raw.scouts)) {
    throw new ScoutUserConfigError(`Invalid scout config ${path}: "scouts" must be an object.`);
  }

  const result: Partial<Record<ScoutName, ScoutModelTarget[]>> = {};
  for (const [scoutName, scoutConfig] of Object.entries(raw.scouts)) {
    if (!(VALID_SCOUT_NAMES as readonly string[]).includes(scoutName)) {
      throw new ScoutUserConfigError(`Invalid scout config ${path}: unknown scout "${scoutName}".`);
    }
    if (!isObject(scoutConfig)) {
      throw new ScoutUserConfigError(`Invalid scout config ${path}: scouts.${scoutName} must be an object.`);
    }
    if (!Array.isArray(scoutConfig.models) || scoutConfig.models.length === 0) {
      throw new ScoutUserConfigError(`Invalid scout config ${path}: scouts.${scoutName}.models must be a non-empty array.`);
    }

    result[scoutName as ScoutName] = scoutConfig.models.map((entry, index) => {
      const entryPath = `scouts.${scoutName}.models[${index}]`;
      if (!isObject(entry)) {
        throw new ScoutUserConfigError(`Invalid scout config ${path}: ${entryPath} must be an object.`);
      }
      if (typeof entry.model !== "string" || !entry.model.trim()) {
        throw new ScoutUserConfigError(`Invalid scout config ${path}: ${entryPath}.model must be a non-empty string.`);
      }
      return {
        model: entry.model.trim(),
        thinkingLevel: validateThinkingLevel(entry.thinkingLevel, `${entryPath}.thinkingLevel`),
      };
    });
  }

  return result;
}

function ancestorConfigPaths(cwd: string): string[] {
  const start = resolve(cwd);
  const root = parse(start).root;
  const dirs: string[] = [];

  let current = start;
  while (true) {
    dirs.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs.reverse().map((dir) => join(dir, ".pi", "scouts.jsonc"));
}

export function loadScoutUserConfig(cwd: string, homeDir = homedir()): ScoutUserConfig {
  const paths = [join(homeDir, ".pi", "agent", "scouts.jsonc"), ...ancestorConfigPaths(cwd)]
    .filter((path) => existsSync(path));

  const modelTargetsByScout: Partial<Record<ScoutName, ScoutModelTarget[]>> = {};
  for (const path of paths) {
    const validated = validateConfig(path, parseJsoncFile(path));
    Object.assign(modelTargetsByScout, validated);
  }

  return { modelTargetsByScout, sources: paths };
}
