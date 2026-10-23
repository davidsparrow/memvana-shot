# Memvana Shot

**Understand, organize, and search the screenshots you've been hoarding.**

Memvana Shot is a free, local-first Claude plugin for macOS. It gives Claude a
persistent understanding of your screenshot library: what each screenshot
contains, why you probably saved it, and which other screenshots relate to it.
You can then ask in plain language:

- "Find the screenshot of that weird copper-colored interface."
- "What have I been researching about pickleball equipment?"
- "What subjects do I keep coming back to?"

> **Status: early build, on the way to V1.0.** Screenshots from your Photos
> library (including iPhone screenshots synced through iCloud Photos) and from
> folders, on-device extraction, Claude-written understanding, keyword and
> semantic search, related screenshots, tags (including Finder tags and your
> Photos albums), your own edits, and a quiet catch-up when each Claude
> session starts work today. The guided public release comes next. See
> [docs/ROADMAP.md](docs/ROADMAP.md).

## How it works

```
Claude ── Memvana Shot plugin ──┬── Skill             (how Claude should think about screenshots)
                                ├── screenshot-analyst (subagent that analyzes screenshots in batches)
                                ├── MCP server        (tools: scan, analyze, search, related, tags, stats…)
                                ├── slash commands    (/memvana-shot:status, :scan, :tags, :rebuild-index)
                                ├── session hook      (prepares new screenshots quietly when a session starts)
                                ├── Memvana Shot.app  (Swift, signed: Photos access, Apple Vision OCR, thumbnails)
                                └── embedder          (optional: EmbeddingGemma, on-device, for search by meaning)
                                          │
                              Local SQLite library on your Mac
```

1. **Scan.** Memvana Shot finds new or changed screenshots in the Screenshots
   album in Photos and in any folders you add, and extracts their text, labels
   and a thumbnail on-device. Each new Claude session does this quietly for
   screenshots taken since last time.
2. **Understand.** Claude looks at each screenshot and records what it shows,
   *why you probably saved it*, its topics, and search keywords for things
   the text doesn't say (colors, styles, synonyms).
3. **Ask.** Search is full-text with stemming across all of that, including
   descriptive file and folder names and your Photos album names. Claude expands your words with related
   terms, so "packaging inspiration" finds a chip bag that never uses the word
   "packaging". Turn on semantic search and it also matches by meaning: "music
   legend" finds a photo of Jimi Hendrix, in any of 100+ languages.
4. **Connect.** Ask for screenshots related to one and Memvana Shot explains
   each link: a similar subject, a look-alike or near-duplicate image, shared
   tags or names, the same album, or captures made minutes apart.
5. **Organize.** Tags are your own top-level groups. Claude proposes a starter
   set and suggests tags per screenshot. If you already sort screenshots into
   Photos albums or folders, it offers those as tags first. You confirm, add
   or remove them by asking, and tags you set in Finder are imported
   automatically. Your choices always win over Claude's suggestions.
6. **Correct.** Tell Claude what a screenshot really is ("that's the supplier
   I picked"). Your notes and edits override the AI's description, rank high
   in search, and survive re-analysis.

- **Local-first.** No account and no Memvana Shot server. Your index lives in
  `~/Library/Application Support/Memvana Shot/`.
- **Photos access is read-only and screenshots-only.** A small helper app,
  "Memvana Shot" (signed and notarized by Apple), asks macOS for Photos
  permission once. It reads only the Screenshots album (and the names of your
  own albums that hold them), skips hidden screenshots, and never changes or
  deletes anything. You can turn it off any time in System Settings >
  Privacy & Security > Photos.
- **The session-start catch-up is quiet and local.** When a Claude session
  starts, Memvana Shot looks for new screenshots and prepares them on your
  Mac, at low priority. It never analyzes them without asking, never asks for
  Photos access, leaves alone the older screenshots you chose not to process,
  and does nothing at all until you've set Memvana Shot up.
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
- Semantic search only: an Apple Silicon Mac (ONNX Runtime ships no Intel
  macOS build). On Intel Macs, keyword search and related screenshots work
  without it.

Nothing needs building: the plugin ships the helper app ready to run.

## Try it

In Claude Code with the plugin loaded:

> Set up Memvana Shot on my screenshots and tell me what I've been saving.

Claude offers your Photos library (macOS asks you once to allow access) and
your screenshot folder, scans what you pick, offers to analyze the newest 250,
and then gives you an overview of your recurring subjects. After that, ask
anything:

> Find the screenshot of that tortilla chip bag with the yellow label.
> What have I been screenshotting since June?
> Show me screenshots related to that one.
> Tag those three as Kitchen remodel, and add a note to the first one: "ask about lead time".

Maintenance commands are there if you want them: `/memvana-shot:status`,
`/memvana-shot:scan [folder | photos]`, `/memvana-shot:tags` and
`/memvana-shot:rebuild-index`.

## Development

```sh
npm install
npm run build          # builds the Swift helper and bundles the MCP server
npm run build:app      # builds "Memvana Shot.app" for this Mac (needed for Photos)
npm test
npm run qa             # end-to-end checks in real Claude Code sessions (docs/QA.md)
npm run qa:guided      # the hands-on checklist: Photos, System Settings, Preview, Finder
npm run scale-test     # times a synthetic library of 10,000 screenshots

# try the pipeline without Claude:
node mcp/dist/cli.mjs scan ~/Desktop
node mcp/dist/cli.mjs photos connect      # asks for Photos access, then scans Photos
node mcp/dist/cli.mjs status
node mcp/dist/cli.mjs search "order receipt"
node mcp/dist/cli.mjs tags
node mcp/dist/cli.mjs semantic setup   # optional: download the embedding model
node mcp/dist/cli.mjs related <id>

# run the real-model tests once the model is installed:
MEMVANA_SHOT_MODELS="$HOME/Library/Application Support/Memvana Shot/models" npm test
```

Local builds run ahead of the shipped app in `bin/`. A build signed with a
Developer ID uses the real bundle ID, so it shares the Photos permission; an
ad hoc build uses a separate `.dev` ID. To ship a new helper,
`npm run release:app` builds it for Apple Silicon and Intel, signs it with your
Developer ID, notarizes and staples it, and replaces `bin/Memvana Shot.app`
(it needs a `notarytool` keychain profile named `memvana-shot-notary`).

To load the plugin into Claude Code from a local checkout:

```sh
claude --plugin-dir /path/to/memvana-shot
```

## License

MIT. Third-party components and their licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
