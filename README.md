# Memvana Shot

**Understand, organize, and search the screenshots you've been hoarding.**

Memvana Shot is a free, local-first Claude plugin for macOS. It gives Claude a
persistent understanding of your screenshot library: what each screenshot
contains, why you probably saved it, and which other screenshots relate to it.
You can then ask in plain language:

- "Find the screenshot of that weird copper-colored interface."
- "What have I been researching about pickleball equipment?"
- "What subjects do I keep coming back to?"

> **Status: early build (V0.5).** Folder ingestion, on-device extraction,
> Claude-written understanding, keyword and semantic search, related
> screenshots, tags (including Finder tags) and your own edits work today.
> The native Photos connection comes next. See [docs/ROADMAP.md](docs/ROADMAP.md).

## How it works

```
Claude ── Memvana Shot plugin ──┬── Skill             (how Claude should think about screenshots)
                                ├── screenshot-analyst (subagent that analyzes screenshots in batches)
                                ├── MCP server        (tools: scan, analyze, search, related, tags, stats…)
                                ├── slash commands    (/memvana-shot:status, :scan, :tags, :rebuild-index)
                                ├── shot-helper       (Swift: Apple Vision OCR, thumbnails, visual fingerprints)
                                └── embedder          (optional: EmbeddingGemma, on-device, for search by meaning)
                                          │
                              Local SQLite library on your Mac
```

1. **Scan.** Memvana Shot finds new or changed screenshots in your folder and
   extracts their text, labels and a thumbnail on-device.
2. **Understand.** Claude looks at each screenshot and records what it shows,
   *why you probably saved it*, its topics, and search keywords for things
   the text doesn't say (colors, styles, synonyms).
3. **Ask.** Search is full-text with stemming across all of that, including
   descriptive file and folder names. Claude expands your words with related
   terms, so "packaging inspiration" finds a chip bag that never uses the word
   "packaging". Turn on semantic search and it also matches by meaning: "music
   legend" finds a photo of Jimi Hendrix, in any of 100+ languages.
4. **Connect.** Ask for screenshots related to one and Memvana Shot explains
   each link: a similar subject, a look-alike or near-duplicate image, shared
   tags or names, or captures made minutes apart.
5. **Organize.** Tags are your own top-level groups. Claude proposes a starter
   set and suggests tags per screenshot. You confirm, add or remove them by
   asking, and tags you set in Finder are imported automatically. Your
   choices always win over Claude's suggestions.
6. **Correct.** Tell Claude what a screenshot really is ("that's the supplier
   I picked"). Your notes and edits override the AI's description, rank high
   in search, and survive re-analysis.

- **Local-first.** No account and no Memvana Shot server. Your index lives in
  `~/Library/Application Support/Memvana Shot/`.
- **OCR runs on-device** through Apple's Vision framework.
- **Claude writes the understanding** (descriptions, likely reason saved,
  topics) during your normal Claude session, so you don't need an API key.
- **Semantic search is optional and on-device.** Claude asks before setting
  it up. It's a one-time download of about 330 MB (about 260 MB on disk):
  Google's [EmbeddingGemma](https://ai.google.dev/gemma/docs/embeddinggemma)
  model and ONNX Runtime, each file checked against a pinned hash. The model is
  covered by the [Gemma Terms of Use](https://ai.google.dev/gemma/terms); see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). It runs in a separate
  process that exits when idle, so it uses no memory between searches.

## Requirements

- macOS 14 or later (Apple Silicon or Intel)
- Node.js 22.13 or later
- Xcode Command Line Tools (`xcode-select --install`), used to build the Swift helper
- Semantic search only: an Apple Silicon Mac (ONNX Runtime ships no Intel
  macOS build). On Intel Macs, keyword search and related screenshots work
  without it.

## Try it

In Claude Code with the plugin loaded:

> My screenshots are in ~/Desktop/Screenshots. Set up Memvana Shot and tell me
> what I've been saving.

Claude scans the folder, offers to analyze the newest 250, and then gives you
an overview of your recurring subjects. After that, ask anything:

> Find the screenshot of that tortilla chip bag with the yellow label.
> What have I been screenshotting since June?
> Show me screenshots related to that one.
> Tag those three as Kitchen remodel, and add a note to the first one: "ask about lead time".

Maintenance commands are there if you want them: `/memvana-shot:status`,
`/memvana-shot:scan [folder]`, `/memvana-shot:tags` and
`/memvana-shot:rebuild-index`.

## Development

```sh
npm install
npm run build          # builds the Swift helper and bundles the MCP server
npm test

# try the pipeline without Claude:
node mcp/dist/cli.mjs scan ~/Desktop
node mcp/dist/cli.mjs status
node mcp/dist/cli.mjs search "order receipt"
node mcp/dist/cli.mjs tags
node mcp/dist/cli.mjs semantic setup   # optional: download the embedding model
node mcp/dist/cli.mjs related <id>

# run the real-model tests once the model is installed:
MEMVANA_SHOT_MODELS="$HOME/Library/Application Support/Memvana Shot/models" npm test
```

To load the plugin into Claude Code from a local checkout:

```sh
claude --plugin-dir /path/to/memvana-shot
```

## License

MIT. Third-party components and their licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
