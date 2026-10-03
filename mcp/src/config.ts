import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  /** Directory holding the library database and thumbnails. */
  home: string;
  /** Root of the plugin checkout (where native/ and bin/ live). */
  pluginRoot: string;
  /** Explicit helper binary path; otherwise resolved under pluginRoot. */
  helperPath?: string;
}

/** Built-in defaults, overridable with MEMVANA_SHOT_HOME / MEMVANA_SHOT_HELPER. */
export function defaultConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    home: env.MEMVANA_SHOT_HOME
      ? expandHome(env.MEMVANA_SHOT_HOME)
      : join(homedir(), "Library", "Application Support", "Memvana Shot"),
    pluginRoot: env.CLAUDE_PLUGIN_ROOT || defaultPluginRoot(),
    helperPath: env.MEMVANA_SHOT_HELPER ? expandHome(env.MEMVANA_SHOT_HELPER) : undefined,
  };
}

// Both mcp/src/*.ts and the bundled mcp/dist/*.mjs sit two levels below the root.
function defaultPluginRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function dbPath(config: Config): string {
  return join(config.home, "library.db");
}

export function thumbsDir(config: Config): string {
  return join(config.home, "thumbs");
}

/** Where shot-helper may live, in priority order. */
export function helperCandidates(config: Config): string[] {
  if (config.helperPath) return [config.helperPath];
  return [
    join(config.pluginRoot, "bin", "shot-helper"),
    join(config.pluginRoot, "native", ".build", "release", "shot-helper"),
  ];
}

export function resolveHelper(config: Config): string | undefined {
  return helperCandidates(config).find((p) => existsSync(p));
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}
