# Mod Manager

Downloads Skyrim SE mods from Nexus collections and tracks them in a local
SQLite library. Works with a free Nexus account by generating download links
through your own logged-in browser session.

## Requirements

- System Chromium (`pacman -S chromium`) — start it with `./browser.sh`
  (dedicated profile + CDP on port 9223) and log into nexusmods.com once
- `python -m venv .venv && .venv/bin/pip install -r requirements.txt`

## Web app

```
.venv/bin/python webapp.py   # http://127.0.0.1:7788/
```

- **Library** — browse/search everything in `mods.db`; validate, redownload,
  or delete selected files

  ![Library tab](img/library.png)

- **Install Order** — loose MO2 left-panel install order for the library.
  Instant heuristic sort (Nexus category + name keywords → the STEP 2.3
  guide's 20 groups, Extenders → Post-Processing), plus an optional "Refine
  with Claude" pass (`claude -p`, uses your Claude Code login) that re-ranks
  misfits, marks what it moved (amber `MOVED from → to` badge) and lists
  conflicts (`CONFLICT ↔ other mod` badges + a notes block). A header badge
  shows while the refine runs; the same button turns into a red "Force Stop
  Claude" to kill it. Reordering:
  - drag a row, or click its position number to jump it to a place
    (everything else shifts); dragging auto-scrolls near the screen edges
  - Ctrl/Cmd+click or Shift+click selects multiple rows, then drag (or click
    a position number) to move the whole block
  - plain click on a row locks 🔒 / unlocks it — locked mods are pinned to
    their position and skipped entirely by both sorts and the Claude pass
  - "Check order" highlights mods whose group no longer matches the last
    sorter opinion (e.g. after manual moves)

  Mods MO2 reports as installed are badged; the Mod ID column links to the
  Nexus page. Everything is persisted per mod in `mods.db` (`mod_sort`
  table), so order, locks and flags survive restarts and file redownloads.

  ![Install Order tab](img/order.png)

- **Import** — paste a collection URL or a single mod page URL (fetched via
  Nexus GraphQL), or paste/upload a `modlist.json`; diffed against the
  library into new / updated / unchanged

  ![Import tab](img/import.png)

- **Progress** — live download dashboard

  ![Progress tab](img/progress.png)

## Sorter prompt

The "Refine with Claude" pass sends the prompt below (the built-in default in
`modman/sorter.py`, so a fresh installation works out of the box). It is
editable in the Install Order tab — a custom version is stored in the `meta`
table and an empty save resets to this default. Locked mods are excluded from
the prompt and spliced back at their pinned position afterwards.

```
You are a Skyrim SE mod install order sorter for the MO2 left panel
(top to bottom, bottom = highest priority / overwrites above). The scheme is
the STEP SkyrimSE 2.3 guide (stepmodifications.org/wiki/SkyrimSE:2.3): mods
are installed in the guide's group order so that each group's files overwrite
the groups above it, and compatibility patches overwrite everything they
patch.

Groups, in install order, with what STEP puts in each:
{{BUCKETS}}

Rules:
- A patch always goes below every mod it patches.
- More specific mods go below general ones.
- A mod's primary function decides its group when several could apply.
- Keep STEP's counterintuitive placements: USSEP and base overhauls are
  Foundation (early, meant to be overwritten); generic bug-fix mods are
  Fixes (mid-list, after asset mods); Nemesis/DynDOLOD/LOD tools are
  Utilities (late); ENB and particle lights are Post-Processing, below
  Patches.
- The Nexus category is a hint only; it is often wrong (e.g. 'Bug Fixes'
  for SKSE plugins that belong in Extenders).

The mods below are listed under their current group heading — a heuristic
guess. Most are right; move the misfits. Each line: mod_id|mod name|nexus
category.

Reply with ONLY plain lines, no prose, no code fences. First every input mod
exactly once, one per line, in full install order (top to bottom):
<mod_id>|<bucket 1-20>
Append |<flags> only when flagged (comma-separated). Allowed flags:
UNCERTAIN, CONFLICT:<mod_id of the mod it conflicts with>
Then, if any mods conflict, a final section:
CONFLICTS:
<mod_id A> (<name A>) vs <mod_id B> (<name B>): <which should win and why>

Mods:
{{MODS}}
```

`{{BUCKETS}}` expands to the 20 groups annotated with STEP's description of
each (see `BUCKET_HINTS` in `sorter.py`); `{{MODS}}` groups the mods under
their current heuristic heading. The line-based reply (instead of JSON) keeps
the response ~3x smaller, which is what dominates the refine runtime;
`sorter.py` parses it server-side.

## CLI

```
.venv/bin/python cli.py https://www.nexusmods.com/games/skyrimspecialedition/collections/<slug>
.venv/bin/python cli.py modlist.json --include-unchanged
```

## Layout

```
modman/
  config.py   game/paths/constants
  db.py       sqlite library (mods.db: mods = files, mod_sort = install order)
  nexus.py    GraphQL collection fetch, CDP link generation, file transfer
  engine.py   diff + download pipeline, progress state
  mo2.py      MO2 .meta interop (installed state)
  sorter.py   install-order sort (heuristic buckets + claude -p refine, locks)
webapp.py     FastAPI server + JSON API
cli.py        command-line downloader
browser.sh    launches the dedicated Chromium (profile + debug port)
web/          frontend (single page)
```

Files land in `/games/modding/downloads/`. Downloads resume on re-run;
completed files are skipped via the DB diff.
