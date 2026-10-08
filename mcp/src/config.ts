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
  /** Explicit "Memvana Shot.app" (the Photos bridge); otherwise resolved under pluginRoot. */
  appPath?: string;
  /** Where the semantic-search model and runtime are downloaded (default: home/models). */
  modelsDir?: string;
}

/** Built-in defaults, overridable with MEMVANA_SHOT_HOME / _HELPER / _APP / _MODELS. */
export function defaultConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    home: env.MEMVANA_SHOT_HOME
      ? expandHome(env.MEMVANA_SHOT_HOME)
      : join(homedir(), "Library", "Application Support", "Memvana Shot"),
    pluginRoot: env.CLAUDE_PLUGIN_ROOT || defaultPluginRoot(),
    helperPath: env.MEMVANA_SHOT_HELPER ? expandHome(env.MEMVANA_SHOT_HELPER) : undefined,
    appPath: env.MEMVANA_SHOT_APP ? expandHome(env.MEMVANA_SHOT_APP) : undefined,
    modelsDir: env.MEMVANA_SHOT_MODELS ? expandHome(env.MEMVANA_SHOT_MODELS) : undefined,
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

export function modelsDir(config: Config): string {
  return config.modelsDir ?? join(config.home, "models");
}

export const APP_NAME = "Memvana Shot.app";

/**
 * Where the signed app may live, in priority order: a local build
 * (scripts/build-app.sh) first, so changes to the Swift code are what runs,
 * then the notarized copy shipped in bin/.
 */
export function appCandidates(config: Config): string[] {
  if (config.appPath) return [config.appPath];
  return [join(config.pluginRoot, "native", ".build", "app", APP_NAME), join(config.pluginRoot, "bin", APP_NAME)];
}

export function resolveApp(config: Config): string | undefined {
  return appCandidates(config).find((p) => existsSync(join(p, "Contents", "MacOS", "shot-helper")));
}

/**
 * Where shot-helper may live, in priority order: a `swift build` from source,
 * then the executable inside the app (which also runs fine on its own).
 */
export function helperCandidates(config: Config): string[] {
  if (config.helperPath) return [config.helperPath];
  return [
    join(config.pluginRoot, "native", ".build", "release", "shot-helper"),
    ...appCandidates(config).map((app) => join(app, "Contents", "MacOS", "shot-helper")),
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
