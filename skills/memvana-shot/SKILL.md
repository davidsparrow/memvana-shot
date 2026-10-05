---
name: memvana-shot
description: Use whenever the user asks about their screenshots. That includes finding one they saved ("that screenshot of…", "the one with the weird chair"), finding related or similar screenshots, asking what they've been screenshotting, saving or researching, tagging or organizing them, correcting a screenshot's details, or setting up or updating Memvana Shot. Works through the memvana-shot MCP tools.
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
| `search_screenshots` | Find screenshots: `query` holds the user's words, `also` holds your expansion terms. Matches by keywords, and by meaning once semantic search is set up. Supports date, tag and content-type filters. |
| `get_related_screenshots` | "More like this": screenshots related to one, with the reasons (similar subject, looks alike, near-duplicate, shared tags or names, same session). |
| `get_library_stats` | See what the user has been saving: topics, tags, content types, apps, captures per month. |
| `list_tags` / `create_tags` / `edit_tag` | The user's tags: list them, create them (with the user's OK), rename, merge, delete, or settle suggestions in bulk. |
| `tag_screenshots` | Apply the user's tagging decisions: add tags, or remove them (which records a rejection). |
| `get_tagging_batch` / `suggest_tags` | Your own tag suggestions for analyzed screenshots. Text only, so it's cheap. |
| `edit_screenshot` | The user's own edits: title, description, reason saved, notes, keywords, or hiding a screenshot. |
| `get_screenshot` | Get the full record and the thumbnail for one screenshot. |
| `open_screenshot` | Open the original in Preview, or reveal it in Finder. |
| `list_screenshots` | Browse by date or pipeline status. |
| `setup_semantic_search` | One-time download of the local embedding model, after the user agrees. |
| `rebuild_index` | Maintenance: rebuild the keyword index (and meaning vectors). Rarely needed. |

The user can also type `/memvana-shot:status`, `/memvana-shot:scan`,
`/memvana-shot:tags` and `/memvana-shot:rebuild-index`. Natural language works
for everything, so never ask them to use a command.

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
7. **Offer starter tags.** Propose 6–12 tags drawn from those themes and from
   any descriptive folder names, each with a one-line description. On the
   user's OK (and after their edits), `create_tags` with `proposed_by_ai: true`,
   then tag the analyzed screenshots (see Tags). Skip this if Finder tags were
   imported and already cover their needs.
8. **Offer semantic search once** if `get_status` shows
   `semantic_search.state: "not_set_up"` (see Semantic search).

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

## Tags

Tags are the user's own top-level groups ("Recipes", "Kitchen remodel",
"Pickleball project"). Most people will organize by them, so treat the
vocabulary as theirs:

- **Only the user creates, renames, merges or deletes tags.** You can propose
  changes, but you apply them only after a yes.
- **You suggest; the user decides.** `suggest_tags` records suggestions and
  can't override anything the user did. When the user removes a tag,
  `tag_screenshots({ remove })` records a rejection so it won't come back.
- **Keep the record honest.** Your own tag choices always go through
  `suggest_tags`, even when the user pre-approves them. If they approved,
  then confirm them with `edit_tag({ confirm_suggestions: true })`. Use
  `tag_screenshots` only for tags the user picked for specific screenshots.
- **Tagging analyzed screenshots** is text only: loop `get_tagging_batch`, then
  `suggest_tags`, including every id (with an empty list when nothing fits).
  For big backlogs, delegate to `screenshot-analyst` with "Tag up to 300
  screenshots". New analyses pick up tag suggestions automatically once tags
  exist.
- **After creating a tag,** find likely members with `search_screenshots` and
  suggest the tag on the good matches.
- **Reviewing a tag:** search with `tags: [name]`. Results separate `tags`
  (the user's) from `suggested_tags`. Offer "confirm all N suggestions"
  (`edit_tag({ confirm_suggestions: true })`) or go through them.
- **Finder tags** on files in the user's folders are imported on every scan and
  show up as `added` by Finder. Tags removed in Finder are removed here too.

## Editing details

When the user corrects or adds to a screenshot ("that's actually the supplier I
picked", "add a note: ask about MOQ"), use `edit_screenshot`. Edits override
your analysis everywhere, rank high in search, and survive re-analysis. Prefer
`notes` for the user's own context. Use `short_description` /
`likely_reason_saved` overrides when the user says your description is wrong.
`ignored: true` hides a screenshot the user doesn't want in results. Confirm
briefly what changed.

## Semantic search

Keyword search works out of the box. Semantic search adds matching by meaning
("music legend" finds a Jimi Hendrix photo that never says "music") and
sharper related screenshots. It needs a one-time download, so ask first:

> Want me to turn on search by meaning? It's a one-time download of about
> 330 MB: Google's EmbeddingGemma model, which runs on your Mac (nothing is
> uploaded). It's free to use under the Gemma Terms of Use.

Always mention the size, that it runs on their Mac, and the license (Google's
Gemma Terms of Use), in your own words. Link https://ai.google.dev/gemma/terms
if they ask, and call `setup_semantic_search`
only after a yes. It returns at once and downloads in the background; check
`get_status` when convenient and tell the user when it's ready. Existing
screenshots are indexed automatically (about a minute per thousand), and new
or edited ones are kept up to date on their own.

If the user declines, call `setup_semantic_search({ declined: true })` so it
isn't offered again; set it up later only if they ask. If the state is
`unsupported` (Intel Macs), explain that keyword search and related
screenshots still work.

## Searching

1. **Expand the query.** Put the user's key words in `query`, and 5–15 terms
   in `also`: synonyms, broader and narrower concepts, likely visual
   descriptors, and likely apps or brands. Example: "that weird copper-colored
   interface" becomes `query: "copper interface"` with
   `also: ["bronze", "orange", "metallic", "app screen", "dashboard", "UI design"]`.
2. **Turn time phrases into dates.** Use `after` and `before`, working from
   today's date: "last spring" means after 2026-03, before 2026-06; "in
   February" means the most recent February.
   Keep doing this with semantic search on: the expansion drives the keyword
   side, and the `query` alone drives the meaning side, so write `query` as
   the user's natural phrase.
3. **Check before answering.** Read each hit's `short_description` and
   `likely_reason_saved`. `matched_by` says whether a hit matched keywords,
   meaning or both; hits matching both are the most reliable. Meaning
   `similarity` runs low by design: 0.35 to 0.55 is a normal, good match. A
   meaning-only hit near 0.3 is a loose association, so check it before
   presenting it as a match. Don't quote similarity numbers to the user. If
   `semantic.note` says screenshots aren't indexed yet, say results may
   improve shortly. If the top results don't clearly fit,
   search again with a different expansion. For visual queries (colors,
   layouts, objects), pass `include_images: 3` and look before you claim a
   match.
4. **Answer like a person who remembers.** Give the best match first, with
   its date, a one-line description and why it fits. Then add a few alternates
   if they're plausible, and offer to open the original. Keep ids in mind for
   follow-ups, but don't recite them unless asked.
5. **Use tags when the user names a group** ("in my Recipes", "anything tagged
   Pickleball"): add `tags: [...]` as a filter.
6. **Be honest about coverage.** If `unanalyzed_in_library` > 0, say that
   those screenshots were matched only on their text, and offer to analyze
   them. If nothing fits, say so and suggest other wording. Never invent a
   screenshot.

## Related screenshots

For "more like this", "what else did I save about this?", or a follow-up on a
screenshot you just found, call `get_related_screenshots` with its id. Each
result lists its `reasons`, strongest first. Use them in your answer ("three
more from the same pricing research, captured minutes apart"). `near_duplicate`
marks copies and re-captures. Mention duplicates when they're relevant, but
never offer to delete anything. Without semantic search, relatedness uses
looks, tags, names, topics and dates only, and `note` says so.

## "What have I been saving?"

Use `get_library_stats`. Add a date range for "lately" or "this month", and
compare two ranges for "what's changed". Then run one or two searches to ground
each theme in concrete examples. Talk about patterns and counts ("17 screenshots
of dehydrated foods since June"), not lists of files.

## Privacy

- Explain the model when asked. The index stays on the Mac and OCR runs
  on-device. Semantic search runs on-device too: the model is downloaded once
  (from Hugging Face and npm), then runs locally, and no screenshot data is
  sent anywhere for it. Images
  are sent to Claude only when it analyzes them or looks at them for a
  search. There's no Memvana Shot account or server.
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
