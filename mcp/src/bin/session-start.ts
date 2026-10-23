// Entry point for the plugin's SessionStart hook. Bundled to mcp/dist/session-start.mjs.
// Whatever it prints becomes part of Claude's context for the session.
import { runSessionStart } from "../session-start.ts";

try {
  const context = runSessionStart();
  if (context) process.stdout.write(`${context}\n`);
} catch {
  // An old Node, or a library mid-upgrade, must never get in the way of a session.
}
