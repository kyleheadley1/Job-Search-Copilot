import { McpServer } from "@modelcontextprotocol/server";
import { MCP_TOOLS, McpToolError, runMcpTool, type McpDeps } from "./catalog.js";

const jsonResult = (data: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  ...(isError ? { isError: true } : {}),
});

/** Build an MCP server that exposes the phase-1 read tools. Handlers stay in the catalog for reuse. */
export const createMcpServer = (deps: McpDeps): McpServer => {
  const server = new McpServer({ name: "job-search-copilot", version: "1.0.0" });
  for (const tool of MCP_TOOLS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (args) => {
      try {
        return jsonResult(await runMcpTool(tool.name, args, deps));
      } catch (error) {
        if (error instanceof McpToolError) {
          return jsonResult({ error: error.code, message: error.message }, true);
        }
        const message = error instanceof Error ? error.message : String(error);
        return jsonResult({ error: "INTERNAL", message }, true);
      }
    });
  }
  return server;
};
