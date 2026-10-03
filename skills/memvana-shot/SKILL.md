---
name: memvana-shot
description: Use whenever the user asks about their screenshots. That includes finding one they saved ("that screenshot of…", "the one with the weird chair"), asking what they've been screenshotting, saving or researching, organizing or summarizing their screenshot library, or setting up or updating Memvana Shot. Works through the memvana-shot MCP tools.
---

# Memvana Shot

Memvana Shot gives you a persistent, local understanding of the user's
screenshot library. Screenshots carry an implied intent ("I saved this because
something in it mattered"), and your job is to recover it: what each screenshot
shows, why it was probably saved, and what else relates to it.

The library lives on the user's Mac. OCR, thumbnails and the search index are
produced on-device. You add the understanding.

## Tools

| Tool | Use it to |
|---|---|
| `get_status` | Check setup, see counts and get suggested next steps. Start here when unsure. |
| `scan_screenshots` | Register a folder (`folder`) or rescan known folders. Runs on-device extraction in batches (`extract_limit`, default 250). |
| `get_analysis_batch` / `save_analyses` | Look at screenshots and record what they are and why they were saved. |
| `search_screenshots` | Find screenshots: `query` holds the user's words, `also` holds your expansion terms. Supports date and content-type filters. |
| `get_library_stats` | See what the user has been saving: topics, content types, apps, captures per month. |
| `get_screenshot` | Get the full record and the thumbnail for one screenshot. |
| `open_screenshot` | Open the original in Preview, or reveal it in Finder. |
| `list_screenshots` | Browse by date or pipeline status. |

## First run

1. Call `get_status`. If `helper.available` is false, tell the user to run the
   build command in `helper.fix`, then stop.
2. If there are no sources, offer the `suggested_folders`. macOS saves
   screenshots to the Desktop by default. iPhone screenshots can be exported or
   AirDropped into a folder for now; a direct Photos connection is coming.
   **Ask which folder to use. Never scan a folder the user hasn't confirmed.**
3. Call `scan_screenshots({ folder })` and report the result in one line ("Found
   1,204 screenshots; prepared the newest 250").
4. Ask how many to analyze. Recommend starting with the newest 250, with 1,000
   and everything as the other options. Analysis uses their Claude usage, so a
   small first batch pays off quickly.
5. Analyze them (next section).
6. Call `get_library_stats` and give the payoff, written as a short overview,
   not a data dump:
   > I analyzed 250 screenshots. Recurring subjects: product and design
   > inspiration (47), AI and development (42), food (24)… I also noticed 11
   > screenshots about pickleball equipment spread over four months.

   Group related topics into 5–8 human-sized themes with counts. Add one or two
   specific, slightly surprising observations, then offer a few searches to try.

## Analyzing screenshots

**If the `screenshot-analyst` agent is available (Claude Code, Cowork), use it.**
Each agent analyzes up to about 48 screenshots in its own context, so dozens of
images don't fill this conversation. For N screenshots awaiting analysis, start
ceil(N / 48) agents, at most 4 running in parallel. Batches are leased, so
parallel agents never overlap. Give each agent its budget ("Analyze up to 48
screenshots"). Between rounds, give the user a one-line progress update.

**Otherwise, analyze inline.** Loop `get_analysis_batch` (limit 6) → look at
every image → `save_analyses` with one entry per id. Follow the guide included
with the first batch, and pass `include_guide: false` after that. Report
progress every few batches, not per screenshot.

If `scan_screenshots` reported `remaining_pending`, scan again first so the
newest screenshots get extracted. When the user corrects a description ("no,
that's my kitchen remodel"), take a second look with
`get_analysis_batch({ ids: [id] })` and save the corrected analysis.

## Searching

1. **Expand the query.** Put the user's key words in `query`, and 5–15 terms
   in `also`: synonyms, broader and narrower concepts, likely visual
   descriptors, and likely apps or brands. Example: "that weird copper-colored
   interface" becomes `query: "copper interface"` with
   `also: ["bronze", "orange", "metallic", "app screen", "dashboard", "UI design"]`.
2. **Turn time phrases into dates.** Use `after` and `before`, working from
   today's date: "last spring" means after 2026-03, before 2026-06; "in
   February" means the most recent February.
3. **Check before answering.** Read each hit's `short_description` and
   `likely_reason_saved`. If the top results don't clearly fit, search again
   with a different expansion. For visual queries (colors, layouts, objects),
   pass `include_images: 3` and look before you claim a match.
4. **Answer like a person who remembers.** Give the best match first, with
   its date, a one-line description and why it fits. Then add a few alternates
   if they're plausible, and offer to open the original. Keep ids in mind for
   follow-ups, but don't recite them unless asked.
5. **Be honest about coverage.** If `unanalyzed_in_library` > 0, say that
   those screenshots were matched only on their text, and offer to analyze
   them. If nothing fits, say so and suggest other wording. Never invent a
   screenshot.

## "What have I been saving?"

Use `get_library_stats`. Add a date range for "lately" or "this month", and
compare two ranges for "what's changed". Then run one or two searches to ground
each theme in concrete examples. Talk about patterns and counts ("17 screenshots
of dehydrated foods since June"), not lists of files.

## Privacy

- Explain the model when asked. The index stays on the Mac and OCR runs
  on-device. Images are sent to Claude only when it analyzes them or looks at
  them for a search. There's no Memvana Shot account or server.
- Never repeat secrets: passwords, verification codes, card or account numbers,
  ID numbers.
- Results with `sensitive: true` get a generic description ("a bank statement
  from March"). Ask before showing details, and leave them out of broad
  summaries.
- Memvana Shot never deletes, moves or edits the user's files.

## Scope

Memvana Shot handles screenshots, not general photo management. If asked about
family photos, videos, or editing and deleting images, explain that it's
deliberately focused on screenshots.
