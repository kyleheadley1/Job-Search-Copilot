import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { closeDb } from "../config/mongo.js";
import { createLiveDeps } from "./liveDeps.js";
import { createMcpServer } from "./server.js";

/**
 * Local stdio MCP server. Trust model: whoever can launch this process already
 * has this machine's `.env` and Mongo — the same as `npm run dev`. No extra
 * user identity is accepted or checked.
 *
 * Log on stderr only. stdout is the JSON-RPC channel.
 */
const handle = serveStdio(() => createMcpServer(createLiveDeps()), {
  onerror: (error) => {
    console.error(error.message);
  },
});

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await handle.close();
  } catch {
    // Transport may already be closed when stdin hits EOF.
  }
  await closeDb();
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.stdin.on("end", () => void shutdown());
console.error("job-search-copilot MCP server running on stdio");
