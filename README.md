# Memvana Shot

**Understand, organize, and search the screenshots you've been hoarding.**

Memvana Shot is a free, local-first Claude plugin for macOS. It gives Claude a
persistent understanding of your screenshot library: what each screenshot
contains, why you probably saved it, and which other screenshots relate to it.
You can then ask in plain language:

- "Find the screenshot of that weird copper-colored interface."
- "What have I been researching about pickleball equipment?"
- "What subjects do I keep coming back to?"

> **Status: early build (V0).** Folder ingestion and local extraction work
> today. Claude-written understanding, search, categories, and the native
> Photos connection come next. See [docs/ROADMAP.md](docs/ROADMAP.md).

## How it works

```
Claude ── Memvana Shot plugin ──┬── Skill        (how Claude should think about screenshots)
                                ├── MCP server   (tools: scan, search, get, organize…)
                                └── shot-helper  (Swift: Apple Vision OCR, thumbnails, visual fingerprints)
                                          │
                              Local SQLite library on your Mac
```

- **Local-first.** No account and no Memvana Shot server. Your index lives in
  `~/Library/Application Support/Memvana Shot/`.
- **OCR runs on-device** through Apple's Vision framework.
- **Claude writes the understanding** (descriptions, likely reason saved,
  topics) during your normal Claude session, so you don't need an API key.

## Requirements

- macOS 14 or later (Apple Silicon or Intel)
- Node.js 22.13 or later
- Xcode Command Line Tools (`xcode-select --install`), used to build the Swift helper

## Development

```sh
npm install
npm run build          # builds the Swift helper and bundles the MCP server
npm test

# try the pipeline without Claude:
node mcp/dist/cli.mjs scan ~/Desktop
node mcp/dist/cli.mjs status
```

To load the plugin into Claude Code from a local checkout:

```sh
claude --plugin-dir /path/to/memvana-shot
```

## License

MIT
