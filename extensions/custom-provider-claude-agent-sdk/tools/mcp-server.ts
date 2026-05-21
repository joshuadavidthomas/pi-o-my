import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { debug } from "../sdk/debug.js";
import { MCP_SERVER_NAME } from "./names.js";

type PiMcpToolHandler = (toolName: string) => Promise<CallToolResult>;

export function buildPiMcpServer(tools: PiTool[] | undefined, handler: PiMcpToolHandler) {
  const piTools = tools ?? [];
  if (piTools.length === 0) {
    debug("mcp:build", { skipped: "no-pi-tools" });
    return undefined;
  }

  const mcpTools = new Map(piTools.map((tool) => [tool.name, {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as McpTool["inputSchema"],
  }]));
  debug("mcp:build", {
    toolCount: mcpTools.size,
    sample: [...mcpTools.values()].slice(0, 3).map((t) => ({
      name: t.name,
      hasSchema: Boolean(t.inputSchema),
      schemaKeys: t.inputSchema ? Object.keys(t.inputSchema) : [],
    })),
  });
  const server = new McpServer({ name: MCP_SERVER_NAME, version: "1.0.0" });

  server.server.registerCapabilities({ tools: {} });

  server.server.setRequestHandler(ListToolsRequestSchema, () => {
    debug("mcp:listTools", { toolCount: mcpTools.size });
    return { tools: [...mcpTools.values()] };
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const argsKeys = request.params.arguments ? Object.keys(request.params.arguments) : [];
    debug("mcp:callTool", {
      name: request.params.name,
      argsKeys,
      argsBytes: JSON.stringify(request.params.arguments ?? {}).length,
      argsPreview: JSON.stringify(request.params.arguments ?? {}).slice(0, 400),
    });
    const tool = mcpTools.get(request.params.name);
    if (!tool) {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
    }

    return handler(tool.name);
  });

  return {
    type: "sdk" as const,
    name: MCP_SERVER_NAME,
    instance: server,
  };
}
