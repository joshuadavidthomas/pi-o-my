import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import { describe, expect, it } from "bun:test";

import { loadAgentDefinitions, SHIPPED_AGENT_DEFINITIONS_DIR } from "./definitions.ts";
import { SHIPPED_AGENT_DEFINITION_SUMMARIES } from "./tool.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-scout-agent-def-test-"));
}

function writeAgent(dir: string, filename: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, content, "utf8");
  return path;
}

function loadWithDirs(cwd: string, shippedDefinitionsDir: string, homeDir: string) {
  return loadAgentDefinitions(cwd, { shippedDefinitionsDir, homeDir });
}

describe("loadAgentDefinitions", () => {
  it("keeps the hand-maintained shipped definition summary list in sync with shipped files", () => {
    const shippedNames = readdirSync(SHIPPED_AGENT_DEFINITIONS_DIR)
      .filter((name) => name.endsWith(".md"))
      .map((name) => basename(name, extname(name)))
      .sort((a, b) => a.localeCompare(b));
    const summaryNames: string[] = SHIPPED_AGENT_DEFINITION_SUMMARIES
      .map((definition) => definition.name)
      .sort((a, b) => a.localeCompare(b));

    expect(summaryNames).toEqual(shippedNames);
  });

  it("loads every shipped definition without diagnostics", () => {
    const home = tempDir();
    const project = tempDir();
    const result = loadAgentDefinitions(project, {
      shippedDefinitionsDir: SHIPPED_AGENT_DEFINITIONS_DIR,
      homeDir: home,
      projectDefinitionsDir: join(project, ".pi", "agents"),
    });

    const shippedFiles = readdirSync(SHIPPED_AGENT_DEFINITIONS_DIR)
      .filter((name) => name.endsWith(".md"))
      .sort((a, b) => a.localeCompare(b));

    expect(result.diagnostics).toEqual([]);
    expect(result.definitions.size).toBe(shippedFiles.length);

    for (const filename of shippedFiles) {
      const expectedName = basename(filename, extname(filename));
      const definition = result.definitions.get(expectedName);
      expect(definition?.name).toBe(expectedName);
      expect(definition?.description).toBeTruthy();
      expect(definition?.systemPrompt).toBeTruthy();
    }
  });

  it("loads CSV and YAML-list tools through tool-pool normalization", () => {
    const shipped = tempDir();
    const home = tempDir();
    const project = tempDir();
    const projectAgents = join(project, ".pi", "agents");

    writeAgent(projectAgents, "csv.md", `---
name: csv-agent
tools: read, WebSearch, web_fetch
---
CSV body
`);
    writeAgent(projectAgents, "list.md", `---
name: list-agent
tools:
  - Bash
  - github_search
  - WebFetch
---
List body
`);

    const result = loadWithDirs(project, shipped, home);

    expect(result.definitions.get("csv-agent")?.tools).toEqual(["read", "web_search", "web_fetch"]);
    expect(result.definitions.get("list-agent")?.tools).toEqual(["bash", "github_search", "web_fetch"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("falls back to the filename for name and ignores unknown frontmatter fields", () => {
    const shipped = tempDir();
    const home = tempDir();
    const project = tempDir();
    const sourcePath = writeAgent(join(project, ".pi", "agents"), "fallback-name.md", `---
description: Route to this agent.
color: purple
permissionMode: acceptEdits
model: sonnet
skills: pdf-processing, docs
---
Prompt body.
`);

    const result = loadWithDirs(project, shipped, home);
    const definition = result.definitions.get("fallback-name");

    expect(definition).toEqual({
      name: "fallback-name",
      description: "Route to this agent.",
      model: "sonnet",
      skills: ["pdf-processing", "docs"],
      systemPrompt: "Prompt body.",
      sourcePath,
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("records Edit and Write as mutation capability while resolving non-mutating tools", () => {
    const shipped = tempDir();
    const home = tempDir();
    const project = tempDir();
    const sourcePath = writeAgent(join(project, ".pi", "agents"), "tools.md", `---
name: tool-agent
tools: Read, Grep, Edit, Write, WebFetch
---
Body
`);

    const result = loadWithDirs(project, shipped, home);

    expect(result.definitions.get("tool-agent")?.tools).toEqual(["read", "web_fetch"]);
    expect(result.definitions.get("tool-agent")?.allowsMutation).toBe(true);
    expect(result.diagnostics).toEqual([
      `${sourcePath}: Tool "Grep" is not in the scouts agent tool pool. Ignoring.`,
    ]);
  });

  it("skips malformed files with a diagnostic", () => {
    const shipped = tempDir();
    const home = tempDir();
    const project = tempDir();
    const sourcePath = writeAgent(join(project, ".pi", "agents"), "bad.md", `---
name: [
---
Bad body
`);

    const result = loadWithDirs(project, shipped, home);

    expect(result.definitions.has("bad")).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toContain(`Skipped agent definition ${sourcePath}: malformed frontmatter:`);
  });

  it("applies precedence so project definitions beat user definitions which beat shipped definitions", () => {
    const shipped = tempDir();
    const home = tempDir();
    const project = tempDir();

    writeAgent(shipped, "same.md", `---
name: same
description: shipped
---
Shipped body
`);
    writeAgent(join(home, ".pi", "agent", "agents"), "same.md", `---
name: same
description: user
---
User body
`);
    const projectPath = writeAgent(join(project, ".pi", "agents"), "same.md", `---
name: same
description: project
---
Project body
`);

    const result = loadWithDirs(project, shipped, home);

    expect(result.definitions.get("same")).toEqual({
      name: "same",
      description: "project",
      systemPrompt: "Project body",
      sourcePath: projectPath,
    });
  });
});
