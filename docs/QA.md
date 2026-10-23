# QA

Memvana Shot has no web interface. People use it inside Claude Code, plus a
few macOS windows: the Photos permission prompt, System Settings, Preview and
Finder. QA happens in those same places, in two parts:

- **Part 1, automated** (`npm run qa`). A script drives real Claude Code
  sessions with the plugin loaded, against a throwaway library of the test
  screenshots. After each turn it checks what Claude did (which tools it
  called, and whether it asked first) and the library itself (counts, tags,
  notes, search results). It takes about 3 minutes.
- **Part 2, guided** (`npm run qa:guided`). You work through a checklist in a
  real Claude Code window. This part covers what a script can't: the Photos
  permission, System Settings, Preview and Finder windows, and whether the
  conversation feels right. It takes about 30 minutes.

The 109 unit tests (`npm test`) cover the tools' logic. This QA covers the
rest: Claude following the Skill, the plugin loading, the signed app, and the
macOS integration.

**Safety.** Both parts use a throwaway library in `/tmp/memvana-qa`. Your
real library (`~/Library/Application Support/Memvana Shot`) is never opened,
and part 1 checks that it wasn't touched. Part 1 never connects Photos, opens
windows or downloads the meaning model. In part 2, Photos is read-only, as
always.

## Before you start

- macOS 14 or later, Node.js 22.13 or later, and `npm install` done.
- Claude Code, signed in. The scripts find its `claude` command on your PATH
  or inside the VS Code extension. If they can't, set `CLAUDE_BIN` to its
  path.
- Both parts use the shipped, notarized `bin/Memvana Shot.app`. Add `--dev`
  (for example `npm run qa -- --dev`) to test your local builds instead.

## Part 1: automated

In VS Code, open a terminal (**Terminal > New Terminal**) in the repo folder
and run:

```sh
npm run qa
```

You'll see each case as it runs. A ✓ is a pass and a ✗ is a failure. A ! is
a warning: Claude skipped something the Skill asks for as a matter of style,
such as delegating analysis to the subagent. When a case doesn't fully pass,
Claude's reply is printed under it. The run ends with a summary like this:

```
57 passed, 0 warnings, 0 failed in 2.6 min, $0.46 of Claude usage.
Report with Claude's full replies: /tmp/memvana-qa/auto/report.md
```

The script exits with code 1 when any check fails. It uses Sonnet by default,
which costs about $0.50 of Claude usage per run. Add `-- --model opus` to test
another model.

| Case | You type (in one conversation) | Checked |
|---|---|---|
| P | (nothing; this case runs before any Claude turn) | Node version; the plugin validates; the helper version matches the Swift source; the shipped app is universal, signed and notarized |
| A1 | Set up Memvana Shot on my screenshots… | Calls `get_status`; scans nothing and analyzes nothing before you pick a source |
| A2 | Use this folder: … Leave Photos out for now. | Scans that folder only, extracts all 5 screenshots on-device, and asks before analyzing, even with only 5; gives no screenshot another one's date |
| A3 | Yes, analyze all of them. | All 5 analyzed; uses the screenshot-analyst subagent (!); bases its overview on `get_library_stats` (!); gives no screenshot another one's date; creates no tags |
| A4 | Find the screenshot of that snack bag I saved. | Adds expansion terms (!); the chip bag ranks first (its text never says "snack"); the answer names it |
| A5 | What did I screenshot in February 2025? | Filters by a February 2025 date range; finds the receipt |
| A6 | Show me screenshots related to that receipt. | Calls `get_related_screenshots` on the receipt without an error |
| A7 | What tags would you suggest for organizing these? | The `code` folder is listed as a group and offered as a tag (!); no tag is created or applied |
| A8 | Make a tag called Kitchen… and put the pour-over receipt in it. | The tag exists and the receipt carries it |
| A9 | Actually, take the Kitchen tag off the receipt. | Recorded as a rejection; the tag itself survives |
| A10 | Add a note to the receipt: ask about a refund. | The note is saved, and searching "refund" finds the receipt first |
| A11 | Hide the blank screenshot… | Only that screenshot is hidden |
| A12 | `/memvana-shot:scan` (after the script deletes one file and adds a Finder tag to another) | The deleted file is marked missing, not removed; the Finder tag is imported; nothing is analyzed |
| A13 | `/memvana-shot:tags` | Lists both tags |
| A14 | `/memvana-shot:rebuild-index` | Rebuilds, and search still works |
| A15 | `/memvana-shot:status` | Reads status and stats, and mentions the missing screenshot (!) |
| A16 | Anything new in my screenshots since last time? (after the script adds a screenshot and runs the session-start hook the way Claude Code does) | The hook returns at once; its detached catch-up prepares the new screenshot without analyzing it; Claude mentions the 1 new screenshot and doesn't analyze it |
| Z | (nothing; this case runs after the last turn) | Photos was never connected; your real library wasn't touched |

(!) marks a soft check: when it fails you get a warning, not a failure.

Everything from the run stays in `/tmp/memvana-qa/auto` until the next run:
the report, one transcript per turn (`turn-01.jsonl`…), and the library.

## Part 2: guided

1. In VS Code, open a terminal (**Terminal > New Terminal**) in the repo
   folder and run:

   ```sh
   npm run qa:guided
   ```

   This copies the 5 test screenshots into `/tmp/memvana-qa/guided/Screenshots`
   and starts Claude Code there with the plugin loaded. To test with your own
   screenshots instead, add a folder: `npm run qa:guided -- --images ~/Desktop/Some-Screenshots`.
   The steps below assume the test screenshots.
2. The first time Claude uses each Memvana Shot tool, Claude Code asks for
   permission. That's Claude Code's normal tool prompt. Choose the option that
   allows it for the rest of the session.
3. Work through G1 to G10, ticking each box. "Type" means type it into Claude
   Code. "You" means a step you do outside the chat.

### G1. First run asks before acting

Type: `Set up Memvana Shot on my screenshots and tell me what I've been saving.`

- [ ] Claude offers two places to look: Photos and a folder.
- [ ] For Photos, it says that macOS will ask once, that access is read-only,
      and that only screenshots are indexed.
- [ ] It doesn't scan or analyze anything yet.

Type: `Use the folder /tmp/memvana-qa/guided/Screenshots for now. Not Photos yet.`

- [ ] One line reports what it found: 5 screenshots.
- [ ] It asks how many to analyze before it starts. With only 5, offering all
      of them is fine.

### G2. Analysis and the overview

Type: `Analyze all of them.`

- [ ] An analyst agent does the work: you see an agent step, not a long run
      of image tool calls.
- [ ] The overview is short and grouped into themes with counts. It isn't a
      list of files.
- [ ] It offers starter tags, and creates none until you agree.
- [ ] It offers search by meaning at most once, and mentions the download size
      (about 330 MB), that the model runs on your Mac, and Google's Gemma Terms
      of Use.

Type: `No tags yet, and skip search by meaning for now.`

- [ ] It accepts that. Search by meaning isn't offered again for the rest of
      the session.

### G3. Search, open and reveal

Type: `Find the screenshot of the tortilla chip bag.`

- [ ] It gives the best match first, with its date (August 3, 2025) and a
      one-line description, and offers to open it.

Type: `Open it.`

- [ ] **You:** check that Preview opened the chip bag image.

Type: `Show it in Finder.`

- [ ] **You:** check that a Finder window opened with the file selected.

### G4. Connect Photos (your real screenshots, read-only)

This reads your Photos library into the throwaway library only. Nothing in
Photos changes.

Type: `Now add my Photos screenshots too, but only prepare the newest 10.`

- [ ] Before it connects, Claude says macOS may ask to let "Memvana Shot"
      access Photos. It waits for your OK if it asked for one.

If it asked, type: `Yes.`

- [ ] **You:** if a macOS dialog appears, click **Allow** (on some macOS
      versions it says **Allow Full Access**). If you've allowed access
      before, no dialog appears.
- [ ] One line reports the result, such as "Found 1,204 screenshots in Photos
      and prepared the newest 10."
- [ ] It asks before analyzing them. Analyzing sends those screenshots to
      Claude. That's fine to do here, and fine to skip.

### G5. Open a Photos screenshot

Type: `Open the newest one from Photos.`

- [ ] **You:** check that Preview opened a copy (an exported file). The
      original stays in Photos, unchanged.

Type: `Show that one in Finder.`

- [ ] It explains in plain words that screenshots from Photos have no file to
      show in Finder. It doesn't fail with an error.

### G5b. Photos albums as tags

This needs an album of your own. Memvana Shot only reads album names; it
never changes them.

1. **You:** in Photos, click **Screenshots** under **Media Types**, select the
   two most recent screenshots (usually at the bottom), and choose **File >
   New Album with Selection**. Type `QA Album` and press Return. (Use the two
   most recent, because G4 prepared only the newest 10.)

Type: `/memvana-shot:scan photos`

Type: `What tags would you suggest?`

- [ ] It offers QA Album as a tag, among others, and creates nothing yet.

Type: `Yes, make QA Album a tag.`

- [ ] It confirms that both screenshots in the album now carry the tag.
- [ ] `/memvana-shot:tags` shows QA Album on 2 screenshots.

2. **You:** in Photos, open **QA Album**, select one of its screenshots and
   press Delete. Choose **Remove from Album** if asked (the screenshot stays
   in your library).

Type: `/memvana-shot:scan photos`, then `Which screenshots are in my QA Album album now?`

- [ ] It finds 1, the one still in the album.

3. **You:** delete the album when you're done: Control-click **QA Album** and
   choose **Delete Album**. The screenshots stay in your library.

### G6. Finder tags

1. **You:** in Finder, choose **Go > Go to Folder…** (Shift-Command-G), paste
   `/tmp/memvana-qa/guided/Screenshots` and press Return.
2. **You:** Control-click `receipt.jpg`, choose **Tags…**, type `QA Finder`,
   and press Return.

Type: `/memvana-shot:scan`

- [ ] A one- or two-line report that mentions 1 Finder tag imported.

Type: `/memvana-shot:tags`

- [ ] A compact table that shows QA Finder on 1 screenshot.

3. **You:** remove the QA Finder tag from `receipt.jpg` in Finder.

Type: `/memvana-shot:scan`

- [ ] It reports the Finder tag as removed.

### G7. Corrections and notes

Type: `That receipt is for my coffee setup. Add a note: return by Friday.`

- [ ] It briefly confirms what changed.

Type: `Find my coffee setup receipt.`

- [ ] It finds the receipt and mentions your note.

### G8. Photos access turned off

1. **You:** open **Apple menu > System Settings > Privacy & Security >
   Photos**, and turn off **Memvana Shot**.

Type: `/memvana-shot:status`

- [ ] It says in plain words that Photos access is off, and how to turn it
      back on (or it offers to open System Settings).

Type: `Find the receipt.`

- [ ] Search still works with what's already indexed.

2. **You:** turn **Memvana Shot** back on in the same System Settings pane.
   Don't skip this, or your real setup loses Photos access too.

Type: `/memvana-shot:scan photos`

- [ ] It scans Photos again without an error.

### G9. Judgment calls

Type: `What gets sent to Claude, and what stays on my Mac?`

- [ ] The answer matches the README: the index stays on your Mac, OCR runs
      on-device, images are sent to Claude only when it analyzes or looks at
      them, and Photos access is read-only.

Then look back over the whole session:

- [ ] It never scanned, connected Photos, analyzed, created tags or
      downloaded anything without asking first.
- [ ] It never told you to type a slash command when plain words would do.
- [ ] Replies were short and plain, with counts rather than lists of files.
- [ ] It never repeated anything secret-looking (a code, a card or account
      number).

### G9b. New screenshots between sessions

1. Type `/exit`. At `Delete the QA library and test folder now? [Y/n]`, type
   `n` and press Return.
2. **You:** in the same terminal, add a "new" screenshot:

   ```sh
   cp /tmp/memvana-qa/guided/Screenshots/receipt.jpg "/tmp/memvana-qa/guided/Screenshots/receipt again.jpg"
   ```

3. **You:** reopen the same library: `npm run qa:guided -- --keep`. The banner
   says `(reopened)`. As the session starts, Memvana Shot quietly prepares the
   new screenshot.

Type: `Anything new in my screenshots since last time?`

- [ ] It says there's 1 new screenshot and offers to analyze it.
- [ ] It doesn't analyze it until you say yes.

### Optional: search by meaning (about 5 minutes the first time)

Do this before G10, in the same session.

Type: `Actually, turn on search by meaning.`

- [ ] It restates the size and license, then starts the download after your
      yes.
- [ ] A few minutes later, `/memvana-shot:status` shows search by meaning as
      ready.

Type: `Find the screenshot about a racket sport.`

- [ ] It finds the pickleball spec, even though its text never mentions
      rackets or sports.

The model downloads to `/tmp/memvana-qa/models` and is kept between runs, so
later QA runs, part 1 included, use search by meaning too.

### G10. Finish

Type: `/exit`

- [ ] The script asks `Delete the QA library and test folder now? [Y/n]`.
      Press Return and it deletes them.

### Reporting

Note any unticked box with what you saw (a screenshot helps), and pass it to
whoever is fixing it, for example by pasting it into a Claude Code session
working on this repo.

## Cleaning up

```sh
npm run qa:clean          # deletes /tmp/memvana-qa/auto and /tmp/memvana-qa/guided
npm run qa:clean -- --all # also deletes the downloaded meaning model
```

## Not covered yet

- Installing from the GitHub marketplace into a fresh Claude Code. That
  becomes a release step once the repo moves to its final home.
- Libraries of thousands of screenshots (planned with the V1.0 scale test).
- Intel Macs, and the Claude desktop app.
