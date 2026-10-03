# Memvana Shot

**Understand, organize, and search the screenshots you've been hoarding.**

Memvana Shot is a free, local-first Claude plugin for macOS. It gives Claude a
persistent understanding of your screenshot library: what each screenshot
contains, why you probably saved it, and which other screenshots relate to it.
You can then ask in plain language:

- "Find the screenshot of that weird copper-colored interface."
- "What have I been researching about pickleball equipment?"
- "What subjects do I keep coming back to?"

> **Status: early build (V0).** Folder ingestion, on-device extraction,
> Claude-written understanding and search work today. Categories,
> corrections and the native Photos connection come next. See
> [docs/ROADMAP.md](docs/ROADMAP.md).

## How it works

```
Claude ── Memvana Shot plugin ──┬── Skill             (how Claude should think about screenshots)
                                ├── screenshot-analyst (subagent that analyzes screenshots in batches)
                                ├── MCP server        (tools: scan, analyze, search, stats, open…)
                                └── shot-helper       (Swift: Apple Vision OCR, thumbnails, visual fingerprints)
                                          │
                              Local SQLite library on your Mac
```

1. **Scan.** Memvana Shot finds new or changed screenshots in your folder and
   extracts their text, labels and a thumbnail on-device.
2. **Understand.** Claude looks at each screenshot and records what it shows,
   *why you probably saved it*, its topics, and search keywords for things
   the text doesn't say (colors, styles, synonyms).
3. **Ask.** Search is full-text with stemming across all of that. Claude
   expands your words with related terms, so "packaging inspiration" finds a
   chip bag that never uses the word "packaging".

- **Local-first.** No account and no Memvana Shot server. Your index lives in
  `~/Library/Application Support/Memvana Shot/`.
- **OCR runs on-device** through Apple's Vision framework.
- **Claude writes the understanding** (descriptions, likely reason saved,
  topics) during your normal Claude session, so you don't need an API key.

## Requirements

- macOS 14 or later (Apple Silicon or Intel)
- Node.js 22.13 or later
- Xcode Command Line Tools (`xcode-select --install`), used to build the Swift helper

## Try it

In Claude Code with the plugin loaded:

> My screenshots are in ~/Desktop/Screenshots. Set up Memvana Shot and tell me
> what I've been saving.

Claude scans the folder, offers to analyze the newest 250, and then gives you
an overview of your recurring subjects. After that, ask anything:

> Find the screenshot of that tortilla chip bag with the yellow label.
> What have I been screenshotting since June?

## Development

```sh
npm install
npm run build          # builds the Swift helper and bundles the MCP server
npm test

# try the pipeline without Claude:
node mcp/dist/cli.mjs scan ~/Desktop
node mcp/dist/cli.mjs status
node mcp/dist/cli.mjs search "order receipt"
```

To load the plugin into Claude Code from a local checkout:

```sh
claude --plugin-dir /path/to/memvana-shot
```

## License

MIT
