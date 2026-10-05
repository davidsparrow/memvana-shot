---
description: Rebuild Memvana Shot's search index (keyword, and semantic if it's set up)
allowed-tools: mcp__plugin_memvana-shot_memvana-shot__get_status, mcp__plugin_memvana-shot_memvana-shot__rebuild_index
---

Rebuild Memvana Shot's search index. This is maintenance: nothing the user or
Claude wrote is lost, and it's rarely needed.

1. Call `get_status` to see whether semantic search is set up
   (`semantic_search.state` is "ready").
2. Call `rebuild_index`, with `semantic: true` when semantic search is set up.
3. Report in one or two lines: how many screenshots are in the keyword index,
   and that semantic vectors are being re-made in the background (about a
   minute per thousand screenshots), if that applies.
