// What the plugin's SessionStart hook does (hooks/hooks.json runs
// mcp/dist/session-start.mjs). It runs as every Claude session starts, so it
// is quick and never fails a session: it tells Claude what earlier catch-ups
// found, and starts a new catch-up (`cli.mjs catch-up`) in a detached process.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Config, dbPath, defaultConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { newWaitingCount } from "./scanner.ts";

/** The schema version that has the columns read here (sources.initial_scan_at). */
const NEEDS_SCHEMA = 7;

/**
 * Starts the catch-up and returns Claude's context for the session, if
 * there's anything to say. A Mac without a library gets neither: setting
 * Memvana Shot up is the user's choice.
 */
export function runSessionStart(
  config: Config = defaultConfig(),
  start: (cli: string, env: NodeJS.ProcessEnv) => void = startDetached,
): string | undefined {
  const file = dbPath(config);
  if (!existsSync(file) || !process.getBuiltinModule?.("node:sqlite")) return undefined;
  const context = sessionContext(file);
  start(join(config.pluginRoot, "mcp", "dist", "cli.mjs"), { ...process.env, MEMVANA_SHOT_HOME: config.home });
  return context;
}

/** Reads, without migrating or writing, how many new screenshots are waiting for analysis. */
export function sessionContext(file: string): string | undefined {
  const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const db: Db = new sqlite.DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (Number(version?.value ?? 0) < NEEDS_SCHEMA) return undefined; // the catch-up migrates it first
    const n = newWaitingCount(db);
    if (n === 0) return undefined;
    const count = n === 1 ? "1 new screenshot is" : `${n} new screenshots are`;
    return (
      `Memvana Shot: ${count} ready to analyze (found after setup, and prepared on this Mac). ` +
      "If the user brings up their screenshots, mention this once and offer to analyze them. " +
      "Analyze only after they agree."
    );
  } finally {
    db.close();
  }
}

function startDetached(cli: string, env: NodeJS.ProcessEnv): void {
  spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "catch-up"], {
    detached: true,
    stdio: "ignore",
    env,
  }).unref();
}
