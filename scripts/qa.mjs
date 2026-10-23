// End-to-end QA: Memvana Shot as a user meets it, in Claude Code with the plugin loaded.
// docs/QA.md explains both parts and what each case checks.
//
//   node scripts/qa.mjs auto     Part 1: drives headless Claude Code turns against a throwaway
//                                library of the test screenshots, then checks the library itself.
//   node scripts/qa.mjs guided   Part 2: sets up a throwaway library and opens Claude Code for you
//                                to work through the checklist in docs/QA.md.
//   node scripts/qa.mjs scale    Part 3: the first run on a large synthetic library (4,281
//                                screenshots): blocks of 500, checking in, and stopping partway.
//   node scripts/qa.mjs clean    Deletes the throwaway libraries (--all deletes the model too).
//
// Everything lives in /tmp/memvana-qa (MEMVANA_QA_DIR moves it). The real library is never
// opened, and part 1 never connects Photos, opens windows or downloads the model.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "mcp", "dist", "cli.mjs");
const APP = join(ROOT, "bin", "Memvana Shot.app");
const SESSION_START = join(ROOT, "mcp", "dist", "session-start.mjs");
const FIXTURES = join(ROOT, "mcp", "test", "fixtures", "library");
const BASE = process.env.MEMVANA_QA_DIR || "/tmp/memvana-qa";
const MODELS = join(BASE, "models"); // shared by both parts and kept by `clean`, so it downloads once
const REAL_HOME = join(homedir(), "Library", "Application Support", "Memvana Shot");
const TOOL = "mcp__plugin_memvana-shot_memvana-shot__";
// Part 1 can't call these: they ask macOS for Photos access, open windows, or download 330 MB.
const BLOCKED = ["connect_photos", "open_screenshot", "setup_semantic_search"];

// The test screenshots in mcp/test/fixtures/library (made by scripts/make-fixtures.swift).
const RECEIPT = "receipt.jpg";
const CHIPS = "Screenshot 2025-08-03 at 4.15.22 PM.png";
const PICKLEBALL = "window-shadow.png";
const CODE = "code/IMG_2041.PNG";
const BLANK = "nothing-here.png";
const FIXTURE_COUNT = 5;
// A date given to the wrong screenshot (a fixture named, then another's date close behind).
const MISDATED = [
  /(receipt|pour.?over)[^\n]{0,40}\baug/i, // the receipt is from February 2025
  /(chip|tortilla)[^\n]{0,40}\bfeb/i, // the chip bag is from August 2025
  /(pickleball|swift|PHAsset)[^\n]{0,40}\b2025\b/i, // these are dated by file time, so never 2025
];

const USAGE = `usage: node scripts/qa.mjs <auto|guided|clean> [options]

  auto [--model M] [--dev]        part 1: automated Claude Code checks (default model: sonnet)
  guided [--images DIR] [--keep] [--model M] [--dev]
                                  part 2: open Claude Code on a throwaway library, for docs/QA.md
  scale [--model M] [--dev]       part 3: first run on 4,281 synthetic screenshots (about $5)
  clean [--all]                   delete the QA libraries (--all: the model and test images too)

  --dev     use local builds (native/.build) instead of the shipped bin/Memvana Shot.app
  --images  screenshots to copy into the guided test folder (default: the test fixtures)
  --keep    reopen the guided library from last time instead of starting fresh
`;

const { positionals, values: opts } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string" },
    images: { type: "string" },
    dev: { type: "boolean" },
    all: { type: "boolean" },
    keep: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Claude Code's CLI: CLAUDE_BIN, `claude` on PATH, or the newest copy bundled with the VS Code extension. */
function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const onPath = spawnSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout.trim();
  if (onPath) return onPath;
  const extensions = join(homedir(), ".vscode", "extensions");
  const bundled = (existsSync(extensions) ? readdirSync(extensions) : [])
    .filter((name) => name.startsWith("anthropic.claude-code-"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => join(extensions, name, "resources", "native-binary", "claude"))
    .filter((path) => existsSync(path));
  if (bundled.length) return bundled.at(-1);
  fail("Couldn't find Claude Code's CLI. Install Claude Code, or set CLAUDE_BIN to the claude binary.");
}

/** The environment for Claude Code and the CLI: a throwaway library, and the shipped app unless --dev. */
function qaEnv(home) {
  const env = { ...process.env, MEMVANA_SHOT_HOME: home, MEMVANA_SHOT_MODELS: MODELS };
  if (!opts.dev) {
    env.MEMVANA_SHOT_APP = APP;
    env.MEMVANA_SHOT_HELPER = join(APP, "Contents", "MacOS", "shot-helper");
  }
  return env;
}

function copyScreenshots(from, to) {
  if (!existsSync(from)) fail(`No such folder: ${from}`);
  cpSync(from, to, { recursive: true, preserveTimestamps: true, filter: (path) => !basename(path).startsWith(".") });
}

/** The real library's files, to prove part 1 left them alone. */
function realLibraryFingerprint() {
  return ["library.db", "library.db-wal"]
    .map((name) => {
      try {
        const stat = statSync(join(REAL_HOME, name));
        return `${name}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${name}:none`;
      }
    })
    .join(" ");
}

// ---------------------------------------------------------------------------------------------
// Part 1

const PASS = "✓";
const WARN = "!";
const FAILED = "✗";

/** A check: failing a soft one is a warning (a style the Skill asks for), not a broken rule. */
function expect(ok, text, soft = false) {
  return { mark: ok ? PASS : soft ? WARN : FAILED, text };
}

const datesHonest = (text) => expect(!MISDATED.some((pattern) => pattern.test(text)), "gave no screenshot another one's date");

function parseToolResult(content) {
  const text = typeof content === "string" ? content : content?.find?.((block) => block.type === "text")?.text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Reads a stream-json transcript: every tool call (the subagents' too) and the final reply. */
function parseTurn(stdout, code, stderr) {
  const calls = [];
  const byId = new Map();
  let result;
  let init;
  for (const line of stdout.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "result") result = event;
    if (event.type === "system" && event.subtype === "init") init = event;
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const block of content) {
      if (event.type === "assistant" && block.type === "tool_use") {
        const call = { name: block.name.replace(TOOL, ""), input: block.input ?? {}, result: undefined, isError: false };
        calls.push(call);
        byId.set(block.id, call);
      } else if (event.type === "user" && block.type === "tool_result" && byId.has(block.tool_use_id)) {
        const call = byId.get(block.tool_use_id);
        call.isError = Boolean(block.is_error);
        call.result = parseToolResult(block.content);
      }
    }
  }
  const failed = code !== 0 || !result || result.is_error;
  return {
    calls,
    text: result?.result ?? "",
    cost: result?.total_cost_usd ?? 0,
    sessionId: result?.session_id ?? init?.session_id,
    error: failed ? result?.result || stderr.trim() || `claude exited with code ${code}` : undefined,
    called: (name, match = () => true) => calls.some((call) => call.name === name && match(call.input)),
    all: (name) => calls.filter((call) => call.name === name),
    last: (name) => calls.findLast((call) => call.name === name),
  };
}

/**
 * One headless Claude Code turn, continuing the run's conversation. With
 * `killAfter` (seconds) the turn is stopped then, as when the user presses Esc.
 */
async function claudeTurn(run, prompt, minutes, killAfter) {
  const args = [
    "-p",
    prompt,
    "--plugin-dir",
    ROOT,
    "--model",
    run.model,
    "--permission-mode",
    "default",
    "--allowedTools",
    `${TOOL}*`,
    "Agent",
    "Task",
    "--disallowedTools",
    ...BLOCKED.map((name) => TOOL + name),
    "--max-budget-usd",
    String(run.budget ?? 3),
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (run.sessionId) args.push("--resume", run.sessionId);
  const child = spawn(run.claude, args, { cwd: run.cwd, env: qaEnv(run.home), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill(), killAfter ? killAfter * 1000 : minutes * 60_000);
  const code = await new Promise((done) => child.on("close", done));
  clearTimeout(timer);
  run.turns += 1;
  writeFileSync(join(run.dir, `turn-${String(run.turns).padStart(2, "0")}.jsonl`), stdout);
  const turn = parseTurn(stdout, code, stderr);
  if (turn.sessionId) run.sessionId = turn.sessionId;
  // A resumed session reports its running total, so this turn's cost is the difference.
  const total = Math.max(run.cost, turn.cost);
  turn.cost = total - run.cost;
  run.cost = total;
  return turn;
}

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Reads the QA library through the CLI, the same code the MCP server runs. */
function libraryReader(home) {
  const cli = (...args) =>
    JSON.parse(
      execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], {
        env: qaEnv(home),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  let ids;
  const id = (file) => {
    ids ??= new Map(cli("list", "--limit", "100").map((shot) => [shot.file, shot.id]));
    return ids.get(file);
  };
  const get = (file) => cli("get", id(file));
  return {
    status: () => cli("status"),
    extracted: () => cli("list", "--status", "extracted", "--limit", "100"),
    stats: () => cli("stats"),
    search: (query) => cli("search", query),
    tags: () => cli("tags"),
    id,
    get,
    tag: (file, name) => get(file).tags.find((tag) => tag.name === name),
  };
}

function partOneCases(shots, home, lib) {
  return [
    {
      id: "A1",
      title: "First run asks before scanning anything",
      prompt: "Set up Memvana Shot on my screenshots and tell me what I've been saving.",
      verify: (t) => [
        expect(t.called("get_status"), "checked get_status first"),
        expect(!t.called("scan_screenshots"), "didn't scan before the user picked a source"),
        expect(!t.called("save_analyses"), "didn't analyze anything"),
        expect(lib.status().sources.length === 0, "the library still has no sources"),
      ],
    },
    {
      id: "A2",
      title: "Scans the folder the user picks, then asks before analyzing",
      prompt: `Use this folder: ${shots}. Leave Photos out for now.`,
      verify: (t) => {
        const status = lib.status();
        return [
          expect(t.called("scan_screenshots", (input) => samePath(input.folder, shots)), "scanned that folder"),
          expect(
            status.sources.length === 1 && status.sources[0].kind === "folder",
            "one folder source, and no Photos",
          ),
          expect(
            status.counts.total === FIXTURE_COUNT && status.counts.pending === 0,
            `found and extracted all ${FIXTURE_COUNT} screenshots on-device`,
          ),
          expect([RECEIPT, CHIPS, PICKLEBALL, CODE, BLANK].every(lib.id), "listed every test screenshot"),
          expect(!t.called("save_analyses"), "asked before analyzing, even with only a few"),
          datesHonest(t.text),
        ];
      },
    },
    {
      id: "A3",
      title: "Analyzes on a yes and gives an overview",
      prompt: "Yes, analyze all of them.",
      minutes: 12,
      verify: (t) => [
        expect(lib.status().counts.analyzed === FIXTURE_COUNT, `all ${FIXTURE_COUNT} screenshots analyzed`),
        expect(
          t.calls.some((call) => /screenshot-analyst/.test(call.input.subagent_type ?? "")),
          "used the screenshot-analyst subagent",
          true,
        ),
        expect(t.called("get_library_stats"), "based the overview on get_library_stats", true),
        datesHonest(t.text),
        expect(!t.called("create_tags"), "didn't create tags without a yes"),
      ],
    },
    {
      id: "A4",
      title: "Search expands the user's words and finds the right screenshot",
      prompt: "Find the screenshot of that snack bag I saved.",
      verify: (t) => [
        expect(t.called("search_screenshots"), "searched"),
        expect(t.called("search_screenshots", (input) => input.also?.length > 0), "added expansion terms", true),
        expect(
          t.all("search_screenshots").some((call) => call.result?.results?.[0]?.file === CHIPS),
          "the chip bag ranked first",
        ),
        expect(/chip|tortilla/i.test(t.text), "the answer names the chip bag"),
      ],
    },
    {
      id: "A5",
      title: "Turns a time phrase into dates",
      prompt: "What did I screenshot in February 2025?",
      verify: (t) => [
        expect(
          t.calls.some((call) => /^2025-0[12]/.test(call.input.after ?? "") || /^2025-0[23]/.test(call.input.before ?? "")),
          "filtered by a February 2025 date range",
        ),
        expect(/pour.?over|receipt|order/i.test(t.text), "found the February receipt"),
        expect(!/tortilla|pickleball/i.test(t.text), "left out screenshots from other months", true),
      ],
    },
    {
      id: "A6",
      title: "Related screenshots",
      prompt: "Show me screenshots related to that receipt.",
      verify: (t) => {
        const call = t.last("get_related_screenshots");
        return [
          expect(call?.input.id === lib.id(RECEIPT), "asked for screenshots related to the receipt"),
          expect(call && !call.isError && Array.isArray(call.result?.results), "got them without an error"),
        ];
      },
    },
    {
      id: "A7",
      title: "Tag ideas start from the user's own folders, and nothing is created without a yes",
      prompt: "What tags would you suggest for organizing these?",
      verify: (t) => [
        expect(lib.stats().groups.some((group) => group.kind === "folder" && group.name === "code"), "the code folder is a group"),
        expect(/\bcode\b/i.test(t.text), "offers the code folder as a tag", true),
        expect(!t.called("create_tags") && !t.called("tag_screenshots"), "created and applied no tags"),
        expect(lib.tags().length === 0, "the library still has no tags"),
      ],
    },
    {
      id: "A8",
      title: "Creates the tag the user asks for and applies it",
      prompt: "Make a tag called Kitchen, for cooking and kitchen gear, and put the pour-over receipt in it.",
      verify: () => [
        expect(lib.tags().some((tag) => tag.name === "Kitchen"), "the Kitchen tag exists"),
        expect(["added", "confirmed"].includes(lib.tag(RECEIPT, "Kitchen")?.state), "the receipt carries it"),
      ],
    },
    {
      id: "A9",
      title: "Removing a tag records a rejection",
      prompt: "Actually, take the Kitchen tag off the receipt.",
      verify: () => [
        expect(lib.tag(RECEIPT, "Kitchen")?.state === "rejected", "rejected on the receipt, so it isn't suggested again"),
        expect(lib.tags().some((tag) => tag.name === "Kitchen"), "the tag itself still exists"),
      ],
    },
    {
      id: "A10",
      title: "The user's note is saved and searchable",
      prompt: "Add a note to the receipt: ask about a refund.",
      verify: () => [
        expect(/refund/i.test(lib.get(RECEIPT).user_edits?.notes ?? ""), "the note is saved on the receipt"),
        expect(lib.search("refund").results[0]?.file === RECEIPT, 'searching "refund" finds the receipt first'),
      ],
    },
    {
      id: "A11",
      title: "Hiding a screenshot",
      prompt: "Hide the blank screenshot. I don't want it in results.",
      verify: () => [
        expect(lib.get(BLANK).ignored === true, "the blank screenshot is hidden"),
        expect(lib.status().counts.ignored === 1, "nothing else is hidden"),
      ],
    },
    {
      id: "A12",
      title: "/memvana-shot:scan notices a deleted file and a Finder tag",
      setup: () => {
        rmSync(join(shots, PICKLEBALL));
        const plist =
          '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array><string>QA Finder</string></array></plist>';
        execFileSync("xattr", ["-w", "com.apple.metadata:_kMDItemUserTags", plist, join(shots, CODE)]);
      },
      prompt: "/memvana-shot:scan",
      verify: (t) => {
        const status = lib.status();
        const finder = lib.tag(CODE, "QA Finder");
        return [
          expect(t.called("scan_screenshots"), "rescanned"),
          expect(
            status.counts.missing === 1 && status.counts.total === FIXTURE_COUNT,
            "the deleted file is marked missing, not removed",
          ),
          expect(finder?.state === "added" && finder?.source === "finder", "the Finder tag was imported"),
          expect(!t.called("save_analyses"), "didn't analyze without asking"),
        ];
      },
    },
    {
      id: "A13",
      title: "/memvana-shot:tags",
      prompt: "/memvana-shot:tags",
      verify: (t) => [
        expect(t.called("list_tags"), "listed tags"),
        expect(/QA Finder/.test(t.text) && /Kitchen/.test(t.text), "shows both Kitchen and the Finder tag"),
      ],
    },
    {
      id: "A14",
      title: "/memvana-shot:rebuild-index",
      prompt: "/memvana-shot:rebuild-index",
      verify: (t) => [
        expect(t.called("rebuild_index") && !t.last("rebuild_index").isError, "rebuilt the index"),
        expect(lib.search("pour over").results[0]?.file === RECEIPT, "search still works afterwards"),
      ],
    },
    {
      id: "A15",
      title: "/memvana-shot:status",
      prompt: "/memvana-shot:status",
      verify: (t) => [
        expect(t.called("get_status") && t.called("get_library_stats"), "read status and library stats"),
        expect(/missing/i.test(t.text), "mentions the missing screenshot", true),
      ],
    },
    {
      id: "A16",
      title: "The session-start catch-up prepares a new screenshot, and Claude mentions it",
      setup: async () => {
        copyFileSync(join(shots, RECEIPT), join(shots, "receipt again.jpg"));
        const startSession = () =>
          spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", SESSION_START], {
            env: { ...qaEnv(home), CLAUDE_PLUGIN_ROOT: ROOT },
            encoding: "utf8",
          });
        const hook = startSession();
        const prepared = () => lib.extracted().some((shot) => shot.file === "receipt again.jpg");
        // A catch-up still running from an earlier turn makes this one stand down, so try again.
        const found = (await waitFor(prepared, 30)) || (startSession(), await waitFor(prepared, 60));
        return [
          expect(hook.status === 0 && hook.stdout === "", "the hook exits at once, with nothing to say yet"),
          expect(found, "the detached catch-up found and prepared the new screenshot"),
          expect(lib.status().new_screenshots_waiting === 1, "it counts as new, and nothing was analyzed"),
        ];
      },
      prompt: "Anything new in my screenshots since last time?",
      verify: (t) => [
        expect(/\b(1|one)\b[^.\n]*\bnew\b|\bnew\b[^.\n]*\b(1|one)\b/i.test(t.text), "tells the user about the 1 new screenshot"),
        expect(!t.called("save_analyses"), "doesn't analyze it without a yes"),
      ],
    },
    {
      id: "A17",
      title: "Repeated interests are honest about a small library",
      prompt: "What subjects do I keep coming back to?",
      verify: (t) => [
        expect(t.called("get_interests"), "looked for repeated interests"),
        expect(/\b(only|too few|small|not enough|handful)\b/i.test(t.text), "says a few screenshots are too few for patterns", true),
        expect(!t.called("create_tags") && !t.called("tag_interest"), "created no tags"),
      ],
    },
  ];
}

/** Waits up to `seconds` for `ready` to hold, checking every second. */
async function waitFor(ready, seconds) {
  for (let i = 0; i < seconds; i++) {
    if (ready()) return true;
    await new Promise((done) => setTimeout(done, 1000));
  }
  return ready();
}

/**
 * Runs an automated part: preflight, then one Claude Code turn per case with
 * its checks, then the safety checks, and writes the report.
 */
async function automated({ title, dir, budget = 3, makeCases }) {
  rmSync(dir, { recursive: true, force: true });
  const run = {
    dir,
    home: join(dir, "home"),
    cwd: join(dir, "cwd"),
    claude: findClaude(),
    model: opts.model ?? "sonnet",
    budget,
    sessionId: undefined,
    turns: 0,
    cost: 0,
  };
  for (const path of [run.home, run.cwd, MODELS]) mkdirSync(path, { recursive: true });
  const lib = libraryReader(run.home);
  const cases = makeCases(run, lib);
  const realBefore = realLibraryFingerprint();
  const started = Date.now();
  const report = [];
  const counts = { [PASS]: 0, [WARN]: 0, [FAILED]: 0 };
  const say = (line = "") => {
    console.log(line);
    report.push(line);
  };
  const record = (checks) => {
    for (const check of checks) {
      counts[check.mark] += 1;
      say(`   ${check.mark} ${check.text}`);
    }
    return checks.some((check) => check.mark !== PASS);
  };

  say(`Memvana Shot QA, ${title}`);
  say(`  QA library  ${run.home}`);
  say(`  Claude      ${run.claude} (${run.model})`);
  say(`  App         ${opts.dev ? "local builds (--dev)" : relative(ROOT, APP)}`);
  say();

  say("P   Preflight");
  const [major, minor] = process.versions.node.split(".").map(Number);
  const status = lib.status();
  const swiftVersion = readFileSync(join(ROOT, "native", "Sources", "shot-helper", "main.swift"), "utf8").match(
    /^let helperVersion = "(.*)"$/m,
  )[1];
  const preflight = [
    expect(major > 22 || (major === 22 && minor >= 13), `Node ${process.versions.node} (needs 22.13 or later)`),
    expect(spawnSync(run.claude, ["plugin", "validate", "--strict", ROOT]).status === 0, "the plugin validates (--strict)"),
    expect(
      status.helper.available && status.helper.version === swiftVersion,
      `the helper is ${status.helper.version}, from ${relative(ROOT, status.helper.path ?? "")}`,
    ),
  ];
  if (!opts.dev) {
    const app = spawnSync(join(ROOT, "scripts", "check-app.sh"), { encoding: "utf8" });
    preflight.push(expect(app.status === 0, (app.stdout || app.stderr).trim().replace(/^✓ /, "")));
  }
  if (record(preflight)) fail("\nPreflight failed, so QA stopped before using Claude.");

  const replies = [];
  for (const test of cases) {
    const setupChecks = (await test.setup?.()) ?? [];
    const turnStarted = Date.now();
    const turn = await claudeTurn(run, test.prompt, test.minutes ?? 5, test.killAfter);
    say();
    say(`${test.id.padEnd(4)}${test.title}  (${Math.round((Date.now() - turnStarted) / 1000)} s, $${turn.cost.toFixed(2)})`);
    say(`    You: ${test.prompt}${test.killAfter ? ` (stopped after ${test.killAfter} s)` : ""}`);
    let checks;
    try {
      // A turn stopped on purpose ends without a result.
      checks = turn.error && !test.killAfter ? [expect(false, `Claude Code failed: ${turn.error.slice(0, 300)}`)] : test.verify(turn);
      checks = [...setupChecks, ...checks];
    } catch (err) {
      checks = [expect(false, `the check itself failed: ${err.message}`)];
    }
    if (record(checks)) say(`     Claude: ${turn.text.slice(0, 500).replace(/\s*\n\s*/g, " ")}`);
    replies.push(`### ${test.id} ${test.title}\n\n**You:** ${test.prompt}\n\n**Claude:**\n\n${turn.text}\n`);
  }

  say();
  say("Z   Safety");
  record([
    expect(lib.status().photos.connected === false, "Photos was never connected"),
    expect(realLibraryFingerprint() === realBefore, "your real library wasn't touched"),
  ]);

  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  say();
  const warnings = `${counts[WARN]} warning${counts[WARN] === 1 ? "" : "s"}`;
  say(`${counts[PASS]} passed, ${warnings}, ${counts[FAILED]} failed in ${minutes} min, $${run.cost.toFixed(2)} of Claude usage.`);
  writeFileSync(join(dir, "report.md"), `${report.join("\n")}\n\n## Claude's replies\n\n${replies.join("\n")}`);
  console.log(`Report with Claude's full replies: ${join(dir, "report.md")}`);
  console.log(`Transcripts: ${join(dir, "turn-*.jsonl")}`);
  process.exit(counts[FAILED] ? 1 : 0);
}

async function auto() {
  await automated({
    title: "part 1 (automated)",
    dir: join(BASE, "auto"),
    makeCases: (run, lib) => {
      const shots = join(run.dir, "Screenshots");
      copyScreenshots(FIXTURES, shots);
      return partOneCases(shots, run.home, lib);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Part 3

/** The spec's example library size. The images are synthetic: colored cards of random words. */
const SCALE_COUNT = 4281;

/** Claude asking whether to go on, in any of the ways it phrases that. */
const CHECK_IN =
  /keep going|continue|carry on|go (on|further)|how far|next (block|500)|another 500|waiting for your (answer|go-ahead|ok)|\bmore\b[^.\n]*\?/i;

function scaleCases(shots, lib) {
  let before;
  const snapshot = () => {
    before = lib.status();
    return [];
  };
  const analysts = (t) => t.calls.some((call) => /screenshot-analyst/.test(call.input.subagent_type ?? ""));
  const blocks = (t) => t.all("scan_screenshots").map((call) => call.input.ready_for_analysis).filter(Boolean);
  return [
    {
      id: "S1",
      title: `First run on ${SCALE_COUNT.toLocaleString("en-US")} screenshots prepares 250 and asks how many to analyze`,
      prompt: `Set up Memvana Shot on my screenshots in ${shots}. Leave Photos out for now.`,
      minutes: 8,
      verify: (t) => {
        const status = lib.status();
        return [
          expect(t.called("scan_screenshots", (input) => samePath(input.folder, shots)), "scanned that folder"),
          expect(status.counts.total === SCALE_COUNT, `found all ${SCALE_COUNT}`),
          expect(
            status.counts.extracted === 250 && status.backlog === SCALE_COUNT - 250,
            `prepared the newest 250 and left ${SCALE_COUNT - 250} alone`,
          ),
          expect(!t.called("save_analyses"), "asked before analyzing"),
          expect(/4,?281/.test(t.text), "says how many it found"),
          expect(/\b250\b/.test(t.text) && /1,?000/.test(t.text) && /\b(all|every)/i.test(t.text), "offers 250, 1,000 and everything"),
          expect(/minute|hour/i.test(t.text), "says roughly how long each takes", true),
          expect(/\$\s?\d/.test(t.text), "says roughly what each costs", true),
        ];
      },
    },
    {
      id: "S2",
      title: "Everything: prepares a block of 500, analyzes it, then checks in",
      // Without this, Claude rightly asks whether synthetic cards are worth analyzing at all.
      prompt: "Analyze everything. (These are synthetic test screenshots, so their odd content is expected: carry on as you would with real ones.)",
      minutes: 25,
      verify: (t) => {
        const status = lib.status();
        const sizes = blocks(t);
        return [
          expect(sizes.length > 0 && sizes.every((n) => n <= 500), `prepared blocks of up to 500 (${sizes.join(", ") || "none"})`),
          expect(analysts(t), "used the screenshot-analyst subagents", true),
          expect(status.counts.analyzed >= 400 && status.counts.analyzed <= 560, `analyzed one block (${status.counts.analyzed})`),
          expect(status.counts.extracted + status.counts.analyzed <= 560, "prepared no more than that block"),
          expect(CHECK_IN.test(t.text), "checks in before the next block"),
        ];
      },
    },
    {
      id: "S3",
      title: "Stopping after a block leaves the rest alone",
      setup: snapshot,
      prompt: "Let's stop there for now.",
      verify: (t) => {
        const status = lib.status();
        return [
          expect(!t.called("get_analysis_batch") && !t.called("save_analyses"), "analyzed nothing more"),
          expect(blocks(t).length === 0, "prepared nothing more"),
          expect(status.counts.analyzed === before.counts.analyzed, "the analyzed count didn't change"),
        ];
      },
    },
    {
      id: "S4",
      title: "/memvana-shot:scan doesn't start on the backlog",
      setup: snapshot,
      prompt: "/memvana-shot:scan",
      verify: (t) => {
        const status = lib.status();
        return [
          expect(t.called("scan_screenshots"), "rescanned"),
          expect(status.backlog === before.backlog, `the ${before.backlog} older screenshots weren't prepared`),
          expect(!t.called("save_analyses"), "analyzed nothing"),
          expect(/older|not (yet )?(been )?analy[sz]ed|haven't been analy|backlog/i.test(t.text), "mentions the older screenshots", true),
        ];
      },
    },
    {
      id: "S5",
      title: "Stopping in the middle of a block keeps what was saved",
      setup: snapshot,
      prompt: "Okay, analyze another 500.",
      killAfter: 120, // as if the user pressed Esc
      verify: () => {
        const status = lib.status();
        const added = status.counts.analyzed - before.counts.analyzed;
        return [
          expect(added > 0, `analyses saved before the stop are kept (${added})`),
          expect(added < 500, "the block was cut short"),
        ];
      },
    },
    {
      id: "S6",
      title: "After the stop, Claude knows where things stand",
      prompt: "I stopped you there. How far did we get?",
      verify: (t) => {
        const analyzed = lib.status().counts.analyzed;
        return [
          expect(t.called("get_status"), "checked the current counts"),
          expect(
            t.text.includes(analyzed.toLocaleString("en-US")) || t.text.includes(String(analyzed)),
            `gives the analyzed count (${analyzed})`,
          ),
          expect(!t.called("save_analyses") && blocks(t).length === 0, "didn't carry on without being asked"),
        ];
      },
    },
  ];
}

async function scale() {
  const images = join(BASE, `images-${SCALE_COUNT}`);
  if (!existsSync(images)) {
    console.log(`Generating ${SCALE_COUNT} synthetic screenshots in ${images} (about 20 seconds)…`);
    execFileSync("swift", [join(ROOT, "scripts", "make-scale-library.swift"), images, String(SCALE_COUNT)], { stdio: "inherit" });
  }
  await automated({
    title: "part 3 (a large library)",
    dir: join(BASE, "scale"),
    budget: 15,
    makeCases: (_run, lib) => scaleCases(images, lib),
  });
}

// ---------------------------------------------------------------------------------------------
// Part 2

async function guided() {
  const dir = join(BASE, "guided");
  const shots = join(dir, "Screenshots");
  const home = join(dir, "home");
  const cwd = join(dir, "cwd");
  const reopen = opts.keep && existsSync(home);
  if (!reopen) {
    rmSync(dir, { recursive: true, force: true });
    for (const path of [home, cwd, MODELS]) mkdirSync(path, { recursive: true });
    copyScreenshots(opts.images ? resolve(opts.images) : FIXTURES, shots);
  }
  const claude = findClaude();

  console.log(`Memvana Shot QA, part 2 (guided)

  Test folder   ${shots}
  QA library    ${home}${reopen ? " (reopened)" : ""}
                (throwaway: your real library isn't used)
  Checklist     docs/QA.md, part 2. Start with G1.

Starting Claude Code with the plugin loaded. Type /exit when you're done.
`);
  // Claude Code reads Ctrl+C itself, so this script must outlive it.
  process.on("SIGINT", () => {});
  const child = spawn(claude, ["--plugin-dir", ROOT, ...(opts.model ? ["--model", opts.model] : [])], {
    cwd,
    env: qaEnv(home),
    stdio: "inherit",
  });
  await new Promise((done) => child.on("close", done));

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question("\nDelete the QA library and test folder now? [Y/n] ")).trim().toLowerCase();
  prompt.close();
  if (answer === "" || answer.startsWith("y")) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`Deleted ${dir}.`);
  } else {
    console.log(`Kept ${dir}. Run \`npm run qa:clean\` to delete it later.`);
  }
}

function clean() {
  const targets = opts.all ? [BASE] : ["auto", "guided", "scale"].map((part) => join(BASE, part));
  for (const path of targets) rmSync(path, { recursive: true, force: true });
  console.log(`Deleted ${targets.join(", ")}.`);
  if (!opts.all) console.log(`Kept the model and the part 3 test images in ${BASE} (--all deletes them).`);
}

if (process.platform !== "darwin") fail("Memvana Shot runs on macOS only.");
const commands = { auto, guided, scale, clean };
const command = Object.hasOwn(commands, positionals[0] ?? "") ? commands[positionals[0]] : undefined;
if (!command || opts.help) {
  process.stdout.write(USAGE);
  process.exit(command ? 0 : 1);
}
await command();
