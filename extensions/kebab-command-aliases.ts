import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface RegisteredCommand {
  name: string;
  invocationName: string;
  description?: string;
  sourceInfo: unknown;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
  getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | Promise<AutocompleteItem[] | null> | null;
  __kebabAlias?: true;
}

interface ExtensionRunnerConstructor {
  prototype: {
    __kebabAliasPatchState?: PatchState;
    resolveRegisteredCommands: (this: unknown) => RegisteredCommand[];
  };
}

interface ExtensionRunnerModule {
  ExtensionRunner: ExtensionRunnerConstructor;
}

interface AliasEntry {
  subcommand: string;
  original: RegisteredCommand;
}

const KEBAB_COMMAND_RE = /^[a-z][a-z0-9]*-[a-z0-9-]+$/;
const BUILT_IN_INTERACTIVE_COMMANDS = new Set([
  "changelog",
  "clone",
  "compact",
  "copy",
  "export",
  "fork",
  "hotkeys",
  "import",
  "login",
  "logout",
  "model",
  "name",
  "new",
  "quit",
  "reload",
  "resume",
  "scoped-models",
  "session",
  "settings",
  "share",
  "tree",
  "trust",
]);
const PATCH_MARKER = "__kebabAliasPatchState";

// Set when the shim must fall back to pi's original command list.
// The value is shown in the TUI because console output is not visible in normal pi sessions.
let fallbackReason: string | undefined;

interface PatchState {
  originalResolve: (this: unknown) => RegisteredCommand[];
}

function candidateRunnerPaths(): string[] {
  const paths: string[] = [];

  if (process.argv[1]) {
    try {
      const cliPath = realpathSync.native(process.argv[1]);
      const cliDir = dirname(resolve(cliPath));
      paths.push(join(cliDir, "core/extensions/runner.js"));
    } catch {
      // Try the other candidate paths below.
    }
  }

  paths.push(resolve(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js"));

  return paths;
}

async function loadExtensionRunner(): Promise<ExtensionRunnerConstructor> {
  const runnerPath = candidateRunnerPaths().find((candidate) => existsSync(candidate));
  if (!runnerPath) {
    throw new Error("Could not find @earendil-works/pi-coding-agent/dist/core/extensions/runner.js");
  }

  const mod = (await import(pathToFileURL(runnerPath).href)) as ExtensionRunnerModule;
  if (typeof mod.ExtensionRunner?.prototype?.resolveRegisteredCommands !== "function") {
    throw new Error("ExtensionRunner.resolveRegisteredCommands is not available; pi internals likely changed");
  }
  return mod.ExtensionRunner;
}

function splitKebabCommand(commandName: string): { root: string; subcommand: string } | undefined {
  const suffixMatch = commandName.match(/^(.*?)(:\d+)$/);
  const baseName = suffixMatch?.[1] ?? commandName;
  const duplicateSuffix = suffixMatch?.[2] ?? "";

  if (!KEBAB_COMMAND_RE.test(baseName)) return undefined;

  const [root, ...rest] = baseName.split("-");
  if (!root || rest.length === 0) return undefined;
  if (BUILT_IN_INTERACTIVE_COMMANDS.has(root)) return undefined;

  return { root, subcommand: `${rest.join("-")}${duplicateSuffix}` };
}

function completeSubcommands(entries: AliasEntry[], prefix: string): AutocompleteItem[] {
  return entries
    .filter(({ subcommand }) => subcommand.startsWith(prefix))
    .map(({ subcommand, original }) => ({
      value: subcommand,
      label: subcommand,
      description: original.description ? `${original.description} (/${original.invocationName})` : `Alias for /${original.invocationName}`,
    }));
}

async function dispatchSubcommand(entries: AliasEntry[], args: string, ctx: ExtensionCommandContext): Promise<boolean> {
  const trimmed = args.trim();
  const [subcommand = "", ...rest] = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  const match = entries.find((entry) => entry.subcommand === subcommand);

  if (!match) return false;

  await match.original.handler(rest.join(" "), ctx);
  return true;
}

function buildAliasCommand(root: string, entries: AliasEntry[]): RegisteredCommand {
  return {
    name: root,
    invocationName: root,
    description: `Grouped aliases for /${root}-*`,
    sourceInfo: entries[0]!.original.sourceInfo,
    __kebabAlias: true,

    getArgumentCompletions(prefix: string) {
      return completeSubcommands(entries, prefix);
    },

    async handler(args: string, ctx: ExtensionCommandContext) {
      if (await dispatchSubcommand(entries, args, ctx)) return;

      const trimmed = args.trim();
      const [subcommand = ""] = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
      const available = entries.map((entry) => entry.subcommand).join(", ");
      ctx.ui.notify(`Unknown /${root} subcommand "${subcommand}". Available: ${available}`, "warning");
    },
  };
}

function wrapExistingRootCommand(command: RegisteredCommand, entries: AliasEntry[]): RegisteredCommand {
  if (command.__kebabAlias) return command;

  const originalHandler = command.handler;
  const originalCompletions = command.getArgumentCompletions;

  return {
    ...command,
    __kebabAlias: true,

    async getArgumentCompletions(prefix: string) {
      const subcommands = completeSubcommands(entries, prefix);
      const original = await originalCompletions?.(prefix);
      return [...subcommands, ...(original ?? [])];
    },

    async handler(args: string, ctx: ExtensionCommandContext) {
      if (await dispatchSubcommand(entries, args, ctx)) return;
      await originalHandler(args, ctx);
    },
  };
}

function patchCommandResolution(ExtensionRunner: ExtensionRunnerConstructor): void {
  // Cursed bit: pi doesn't expose command delegation, so we patch the internal
  // command resolver and add wrapper commands that call the original handlers.
  const prototype = ExtensionRunner.prototype;
  const state = prototype[PATCH_MARKER] ?? { originalResolve: prototype.resolveRegisteredCommands };
  prototype[PATCH_MARKER] = state;

  prototype.resolveRegisteredCommands = function resolveRegisteredCommandsWithKebabAliases(this: unknown): RegisteredCommand[] {
    const commands = state.originalResolve.call(this);
    if (fallbackReason) return commands;

    try {
      const existingByName = new Map(commands.map((command) => [command.invocationName, command]));
      const grouped = new Map<string, AliasEntry[]>();

      for (const command of commands) {
        if (command.__kebabAlias) continue;

        const split = splitKebabCommand(command.invocationName);
        if (!split) continue;

        const entries = grouped.get(split.root) ?? [];
        entries.push({ subcommand: split.subcommand, original: command });
        grouped.set(split.root, entries);
      }

      const aliases: RegisteredCommand[] = [];
      const wrappedCommands = commands.map((command) => {
        const entries = grouped.get(command.invocationName);
        if (!entries) return command;
        return wrapExistingRootCommand(command, entries);
      });

      for (const [root, entries] of grouped) {
        if (existingByName.has(root)) continue;
        aliases.push(buildAliasCommand(root, entries));
      }

      return [...wrappedCommands, ...aliases];
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : String(error);
      return commands;
    }
  };

  fallbackReason = undefined;
}

function collectHiddenKebabCommands(pi: ExtensionAPI): Set<string> | undefined {
  // pi.getCommands() itself calls the patched resolver. If that triggers
  // fallback, return undefined so autocomplete stays stock and no commands vanish.
  if (fallbackReason) return undefined;

  const hiddenCommands = new Set(
    pi
      .getCommands()
      .filter((command) => command.source === "extension")
      .filter((command) => splitKebabCommand(command.name) !== undefined)
      .map((command) => command.name),
  );

  return fallbackReason ? undefined : hiddenCommands;
}

export default async function kebabCommandAliases(pi: ExtensionAPI) {
  try {
    patchCommandResolution(await loadExtensionRunner());
  } catch (error) {
    fallbackReason = error instanceof Error ? error.message : String(error);
  }

  pi.on("session_start", (_event, ctx) => {
    const hiddenCommands = collectHiddenKebabCommands(pi);
    if (!hiddenCommands) {
      if (fallbackReason) ctx.ui.notify(`kebab-command-aliases disabled; using default commands: ${fallbackReason}`, "warning");
      return;
    }

    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, line, col, options) {
        if (fallbackReason) return current.getSuggestions(lines, line, col, options);

        const suggestions = await current.getSuggestions(lines, line, col, options);
        if (!suggestions) return suggestions;

        return {
          ...suggestions,
          items: suggestions.items.filter((item) => {
            const value = item.value.replace(/^\//, "");
            const label = item.label.replace(/^\//, "");
            return !hiddenCommands.has(value) && !hiddenCommands.has(label);
          }),
        };
      },

      applyCompletion(lines, line, col, item, prefix) {
        return current.applyCompletion(lines, line, col, item, prefix);
      },

      shouldTriggerFileCompletion(lines, line, col) {
        return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
      },
    }));
  });
}
