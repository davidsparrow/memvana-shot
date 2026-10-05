// Command-line access to the same library the MCP server uses.
// Bundled to mcp/dist/cli.mjs.
import { parseArgs } from "node:util";
import { assertNodeVersion } from "../node-version.ts";

assertNodeVersion();
const { Library, STATUSES } = await import("../library.ts");

const USAGE = `usage: memvana-shot <command> [options]

  status                         library location, helper, folders, counts
  scan [folder] [--limit N]      discover new/changed screenshots and extract up to N (default 250)
  list [--status S] [--limit N]  recent screenshots (S: ${STATUSES.join("|")})
  get <id>                       one screenshot's full record
  search <query> [--also a,b] [--type T] [--after D] [--before D] [--limit N]
  stats [--after D] [--before D] what you've been screenshotting
  open <id> [--reveal]           open the original (or reveal it in Finder)

  tags                           list tags with counts
  tag <id> <tag...>              add tags to a screenshot
  untag <id> <tag...>            remove tags (and stop them being suggested again)
  rename-tag <old> <new>         rename a tag (merges if <new> exists)
  delete-tag <name>              delete a tag everywhere
  edit <id> [--title T] [--description D] [--reason R] [--note N]
            [--add-keyword K,..] [--remove-keyword K,..] [--ignore|--unignore]
                                 your own details; "" reverts a field to Claude's
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: "string" },
    status: { type: "string" },
    also: { type: "string" },
    type: { type: "string" },
    after: { type: "string" },
    before: { type: "string" },
    reveal: { type: "boolean" },
    title: { type: "string" },
    description: { type: "string" },
    reason: { type: "string" },
    note: { type: "string" },
    "add-keyword": { type: "string" },
    "remove-keyword": { type: "string" },
    ignore: { type: "boolean" },
    unignore: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
const [command, arg] = positionals;
if (!command || values.help) {
  process.stdout.write(USAGE);
  process.exit(command ? 0 : 1);
}

const library = Library.open();
const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
const limit = values.limit === undefined ? undefined : Number(values.limit);

try {
  switch (command) {
    case "status":
      print(await library.status());
      break;
    case "scan":
      print(
        await library.scan({
          folder: arg,
          extractLimit: limit,
          onProgress: (done, total) => process.stderr.write(`\rextracting ${done}/${total}`),
        }),
      );
      process.stderr.write("\n");
      break;
    case "list": {
      const status = values.status as (typeof STATUSES)[number] | undefined;
      if (status && !STATUSES.includes(status)) throw new Error(`unknown status ${status}`);
      print(library.list({ status, limit }));
      break;
    }
    case "get": {
      if (!arg) throw new Error("get needs an id");
      const detail = library.get(arg);
      if (!detail) throw new Error(`no screenshot with id ${arg}`);
      print(detail);
      break;
    }
    case "search":
      print(
        library.search({
          query: positionals.slice(1).join(" "),
          also: values.also?.split(",").map((s) => s.trim()).filter(Boolean),
          contentType: values.type,
          after: values.after,
          before: values.before,
          limit,
        }),
      );
      break;
    case "stats":
      print(library.stats({ after: values.after, before: values.before }));
      break;
    case "open":
      if (!arg) throw new Error("open needs an id");
      print(await library.open(arg, values.reveal === true));
      break;
    case "tags":
      print(library.listTags());
      break;
    case "tag":
    case "untag": {
      const names = positionals.slice(2);
      if (!arg || !names.length) throw new Error(`${command} needs an id and at least one tag`);
      print(library.tagScreenshots([arg], command === "tag" ? { add: names } : { remove: names }));
      break;
    }
    case "rename-tag":
      if (!arg || !positionals[2]) throw new Error("rename-tag needs <old> <new>");
      print(library.editTag(arg, { renameTo: positionals[2] }));
      break;
    case "delete-tag":
      if (!arg) throw new Error("delete-tag needs a tag name");
      print(library.editTag(arg, { delete: true }));
      break;
    case "edit": {
      if (!arg) throw new Error("edit needs an id");
      const list = (v?: string) => v?.split(",").map((s) => s.trim()).filter(Boolean);
      print(
        library.edit(arg, {
          short_description: values.title,
          detailed_description: values.description,
          likely_reason_saved: values.reason,
          notes: values.note,
          add_keywords: list(values["add-keyword"]),
          remove_keywords: list(values["remove-keyword"]),
          ignored: values.ignore ? true : values.unignore ? false : undefined,
        })?.details,
      );
      break;
    }
    default:
      process.stderr.write(USAGE);
      process.exitCode = 1;
  }
} catch (err) {
  process.stderr.write(`memvana-shot: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  library.close();
}
