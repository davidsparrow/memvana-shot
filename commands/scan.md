---
description: Scan screenshot folders for new or changed screenshots (or register a new folder)
argument-hint: "[folder]"
allowed-tools: mcp__plugin_memvana-shot_memvana-shot__get_status, mcp__plugin_memvana-shot_memvana-shot__scan_screenshots
---

Scan for new and changed screenshots with Memvana Shot.

Folder argument: "$ARGUMENTS"

- If a folder was given, call `scan_screenshots` with `folder` set to it. If
  that folder isn't registered yet, this registers it.
- If no folder was given, call `scan_screenshots` with no arguments to rescan
  the registered folders. If there are none, call `get_status`, offer its
  `suggested_folders`, and ask which one to use. Never scan a folder the user
  hasn't confirmed.
- If `remaining_pending` is above 0, scan again until it's 0 or you've done
  four scans, then say how many are left.

Report the result in one or two lines: how many screenshots were found, new,
changed, missing, and any Finder tags imported. If new screenshots are waiting
for analysis, offer to analyze them (use the `screenshot-analyst` agent when
it's available). Don't analyze without asking.
