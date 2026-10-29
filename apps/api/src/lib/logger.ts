type Meta = Record<string, unknown>;

const log = (level: "INFO" | "WARN" | "ERROR", message: string, meta?: Meta): void => {
  const payload = {
    level,
    message,
    meta,
    timestamp: new Date().toISOString(),
  };
  // Intentionally plain JSON lines for production-friendly parsing.
  // MCP stdio uses stdout as JSON-RPC; keep those logs on stderr.
  const line = JSON.stringify(payload);
  if (process.env.MCP_STDIO === "1") {
    console.error(line);
    return;
  }
  console.log(line);
};

export const logger = {
  info: (message: string, meta?: Meta) => log("INFO", message, meta),
  warn: (message: string, meta?: Meta) => log("WARN", message, meta),
  error: (message: string, meta?: Meta) => log("ERROR", message, meta),
};
