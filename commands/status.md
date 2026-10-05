---
description: Memvana Shot library status — folders, what's analyzed, tags, semantic search, next steps
allowed-tools: mcp__plugin_memvana-shot_memvana-shot__get_status, mcp__plugin_memvana-shot_memvana-shot__get_library_stats
---

Call `get_status`, then `get_library_stats`, and give the user a short status
report about their Memvana Shot library:

- Folders being watched, and when each was last scanned.
- Screenshot counts: total, analyzed, waiting for analysis, missing or with errors.
- Tags: how many, and the largest few with counts.
- Semantic search: ready (how many indexed, how many waiting), not set up, or downloading.
- The two or three most useful next steps from `next_steps`, phrased as offers
  ("Want me to analyze the 40 new screenshots?").

Keep it to a few lines. Don't list individual screenshots. If semantic search
isn't set up, mention it once with its download size and license, and set it
up only if the user agrees.
