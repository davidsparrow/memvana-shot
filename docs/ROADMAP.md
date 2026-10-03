# Roadmap

Memvana Shot is built in public in small, shippable steps. Screenshots only: it
is deliberately not a general photo manager.

## V0: Proof of intelligence (folder input)

- [x] Ingest PNG/JPEG/HEIC screenshots from any folder, recursively
- [x] On-device OCR, Vision labels, thumbnails, and visual fingerprints (Apple Vision)
- [x] Local SQLite library with stable IDs, capture dates, and device metadata
- [x] Incremental rescans: only new or changed files are processed; renamed files keep their identity
- [ ] Claude-written understanding for each screenshot: description, *likely reason saved*, entities, topics
- [ ] Natural-language search across OCR and AI understanding
- [ ] Open the original screenshot

## V0.5: Persistent screenshot engine

- [ ] Categories that Claude proposes and you can rename, merge, create, or remove
- [ ] Persistent corrections that outweigh AI guesses (suggested, confirmed, assigned, rejected)
- [ ] Vector retrieval combined with keyword search
- [ ] Related screenshots (semantic and visual similarity)
- [ ] Library statistics and slash commands (`status`, `scan`, `categories`, `rebuild-index`)

## V0.8: Native Photos connection

- [ ] Small macOS PhotoKit bridge app that asks for Photos permission once
- [ ] Reads the Screenshots smart album, including iPhone screenshots synced through iCloud Photos
- [ ] Detects new, changed, and deleted screenshots, with no manual exporting

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
