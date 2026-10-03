import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Config, resolveHelper } from "../src/config.ts";
import { Library } from "../src/library.ts";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
export const FIXTURES = join(REPO_ROOT, "mcp", "test", "fixtures", "library");

export const helperBuilt = resolveHelper({ home: "", pluginRoot: REPO_ROOT }) !== undefined;
export const needsHelper = helperBuilt ? {} : { skip: "shot-helper not built (npm run build:native)" };

export interface TempLibrary {
  library: Library;
  config: Config;
  /** A private copy of the fixture screenshots that tests may modify. */
  folder: string;
  cleanup: () => void;
}

export function tempLibrary(): TempLibrary {
  const root = mkdtempSync(join(tmpdir(), "memvana-shot-test-"));
  const folder = join(root, "screenshots");
  cpSync(FIXTURES, folder, { recursive: true });
  const config: Config = { home: join(root, "home"), pluginRoot: REPO_ROOT };
  const library = Library.open(config);
  return {
    library,
    config,
    folder,
    cleanup: () => {
      library.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
