// Entry point for the MCP server (stdio). Bundled to mcp/dist/server.mjs.
import { assertNodeVersion } from "../node-version.ts";

assertNodeVersion();
const { runServer } = await import("../server.ts");
runServer().catch((err) => {
  console.error("memvana-shot: fatal:", err);
  process.exit(1);
});
