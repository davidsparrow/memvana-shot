# Roadmap

Memvana Shot is built in public in small, shippable steps. Screenshots only: it
is deliberately not a general photo manager.

## V0: Proof of intelligence (folder input)

- [x] Ingest PNG/JPEG/HEIC screenshots from any folder, recursively
- [x] On-device OCR, Vision labels, thumbnails, and visual fingerprints (Apple Vision)
- [x] Local SQLite library with stable IDs, capture dates, and device metadata
- [x] Incremental rescans: only new or changed files are processed; renamed files keep their identity
- [x] Claude-written understanding for each screenshot: description, *likely reason saved*, entities, topics, keywords
- [x] Batch analysis by a dedicated subagent, with parallel batches that never overlap
- [x] Natural-language search across OCR and AI understanding, with Claude-driven query expansion
- [x] Library overview: top topics, content types, apps, captures per month
- [x] Open the original screenshot, or reveal it in Finder
- [x] Edited screenshots are re-analyzed automatically

## V0.5: Persistent screenshot engine

- [x] Tags: Claude proposes a starter set and suggests per screenshot; you create, rename, merge, or remove them
- [x] Persistent decisions that outweigh AI guesses (suggested, confirmed, added, rejected)
- [x] Finder tags imported on every scan (writing back to Finder: later, opt-in)
- [x] Your own edits and notes override the AI's details, are searchable, and survive re-analysis
- [x] Descriptive file and folder names used as evidence in analysis and search
- [x] Semantic (vector) retrieval combined with keyword search, using a local embedding model
  (EmbeddingGemma, on-device, downloaded on request)
- [x] Related screenshots (semantic and visual similarity, shared tags and names, capture sessions, near-duplicates)
- [x] Library statistics and slash commands (`status`, `scan`, `tags`, `rebuild-index`)

## V0.8: Native Photos connection

- [x] Small macOS PhotoKit bridge app that asks for Photos permission once
- [x] Reads the Screenshots smart album, including iPhone screenshots synced through iCloud Photos
- [x] Detects new, edited, and deleted screenshots, with no manual exporting
- [x] Signed and notarized universal app that also does the on-device extraction, so nothing needs building

## V1.0: Public release

- [ ] Guided first run ("Found 4,281 screenshots. Analyze recent 250?")
- [ ] Safe batching for large libraries
- [ ] Silent catch-up when a Claude session starts
- [ ] Candidate clusters and repeated interests
- [ ] Privacy explainer and install guide

## Later

- **V1.1: Visual UI inside Claude (MCP App).** Category pills, thumbnail gallery, multi-select, and assign/merge
- **V1.5: "Archaeologist" mode.** On request, finds recurring topics, abandoned interests, and surprising connections

## Guardrails

No account, no cloud copy of your library, no deleting or editing Photos, and
no first-run requirement to index your entire library.
