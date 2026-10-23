---
description: Scan for new or changed screenshots in your folders and Photos (or add a folder, or connect Photos)
argument-hint: "[folder | photos]"
allowed-tools: mcp__plugin_memvana-shot_memvana-shot__get_status, mcp__plugin_memvana-shot_memvana-shot__scan_screenshots, mcp__plugin_memvana-shot_memvana-shot__connect_photos
---

Scan for new and changed screenshots with Memvana Shot.

Argument: "$ARGUMENTS"

- If the argument is a folder, call `scan_screenshots` with `folder` set to it.
  If that folder isn't registered yet, this registers it.
- If the argument is "photos", call `scan_screenshots({ photos: true })`. If
  Photos isn't connected yet, offer to connect it: say macOS will ask once to
  let "Memvana Shot" access Photos (read-only, screenshots only), and call
  `connect_photos` only after the user agrees.
- With no argument, call `scan_screenshots` with no arguments to rescan every
  source (folders and Photos). If there are none, call `get_status` and offer
  Photos (when `photos.available`) and its `suggested_folders`. Never connect
  Photos or scan a folder the user hasn't agreed to.
- If `remaining_pending` is above 0 (lots of new screenshots at once), scan
  again until it's 0 or you've done four scans, then say how many are left.
  Screenshots in `extracting_elsewhere` are already being extracted in the
  background; say so instead of rescanning for them.
- A scan never prepares the `backlog` (older screenshots the user didn't
  choose to analyze at setup). Don't prepare it here; if there is one, mention
  it in a few words ("4,031 older screenshots aren't analyzed yet").
  If the user wants more analyzed, follow the skill's "Analyzing a lot".

Report the result in one or two lines: how many screenshots were found, new,
changed, missing, and any Finder tags imported. If a source is `unavailable`,
say why in plain words (for Photos, how to turn access back on). If new
screenshots are waiting for analysis, offer to analyze them (use the
`screenshot-analyst` agent when it's available). Don't analyze without asking.
