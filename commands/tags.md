---
description: List your Memvana Shot tags with counts, and pending suggestions to review
allowed-tools: mcp__plugin_memvana-shot_memvana-shot__list_tags
---

Call `list_tags` and show the user their tags as a compact table: name, how
many screenshots carry it (split into theirs and Claude's pending
suggestions), and the one-line description.

Then offer the useful next actions in one line, for example: review or
confirm pending suggestions for a tag, rename or merge tags that overlap, or
propose starter tags if there are none. Don't change any tag until the user
says so.

If the user added words after the command ("$ARGUMENTS"), treat them as a
request about their tags (for example "merge Recipes into Food") and handle it
with the tag tools after confirming.
