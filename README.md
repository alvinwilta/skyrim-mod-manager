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

- **Install Order** — loose MO2 left-panel install order for the library
  (which mod's files overwrite which on disk — not plugin load order).
  Two rows of tools:
  - **Ordering** — changes the order. `Sort (heuristic)` classifies every
    unlocked mod into one of the STEP SkyrimSE 2.3 guide's 20 groups
    (name keywords first, Nexus category as fallback), instant, no AI.
    `Refine with Claude` sends every unlocked mod plus any real scanned
    file conflicts to Claude (model picked via the dropdown: Haiku/Sonnet/
    Opus) and asks it to correct misfits — a safety valve rejects the whole
    reply if it tries to reshuffle too much. `Refine uncertain` is a
    second, smaller pass that only re-checks mods still flagged
    `UNCERTAIN`, with each mod's real Nexus description as extra signal.
    `Apply collection order rules` repositions only mods that violate a
    curator-authored before/after/requires rule pulled from an imported
    collection's own manifest. Each action's result shows in its own log
    tab (Sort / Refine with Claude / Refine uncertain / Collection rules).
    The Claude prompt used by the two Claude buttons is editable inline
    (collapsible) and resettable to default.
  - **Analysis** — read-only, changes nothing by itself. `Scan archives`
    lists every downloaded archive's real file paths (via `7z`) and finds
    genuine path overlaps between mods. `Sync requirements` pulls each
    mod's real Nexus "requires" data and flags anything required but
    missing from the library. `Check for drift` flags mods whose current
    group disagrees with the last sorter opinion (usually means a manual
    drag moved it). Results show in Conflicts / Requirements / Check for
    drift tabs.

  Reordering the table: drag a row, or click its position number to type
  an exact position; Ctrl/Cmd+click or Shift+click selects multiple rows to
  drag as a block; plain click locks 🔒/unlocks a row — locked mods are
  pinned and skipped by every sort/refine pass. When signals disagree,
  priority is locked position > manual drag/move > collection curated rule
  > Claude correction > heuristic guess.

  Everything is persisted per mod in `mods.db` (`mod_sort` table), so
  order, locks and flags survive restarts and file redownloads.

  ![Install Order tab](img/order.png)

- **Collections** — collections you've imported and which of their mods are
  in your library, in their current real install order. Disable a
  collection to exclude its curated ordering rules from "Apply collection
  order rules" (Install Order tab) without losing its data.

  ![Collections tab](img/collections.png)

- **Import** — paste a collection URL or a single mod page URL (fetched via
  Nexus GraphQL), or paste/upload a `modlist.json`; diffed against the
  library into new / updated / unchanged

  ![Import tab](img/import.png)

- **Progress** — live download dashboard

  ![Progress tab](img/progress.png)

- **Guide** — in-app reference explaining what each tab does and how the
  Install Order sorting actually works

  ![Guide tab](img/guide.png)

## Sorter prompt

The "Refine with Claude" pass sends the prompt below (the built-in default in
`modman/llm_refine.py`, so a fresh installation works out of the box). It is
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

Known file conflicts (ground truth: these mods' archives were actually
inspected and share real file paths — not a guess). Use these instead of
inventing your own; you may still flag a mod CONFLICT if you're separately
confident of a real incompatibility, but prefer this list:
{{CONFLICTS}}

The mods below are listed under their current group heading — a heuristic
guess. Most are already right. Each line: mod_id|mod name|nexus category.

Reply with ONLY corrections — one line per mod whose group should change
from the heading it's shown under. Do NOT list a mod that's already
correctly placed: omitting a mod means "leave it exactly where the
heading shows it." No prose, no code fences. Format:
<mod_id>|<correct bucket 1-20>
Append |<flags> only when flagged (comma-separated). Allowed flags:
UNCERTAIN, CONFLICT:<mod_id of the mod it conflicts with>,
DUPLICATE:<mod_id of the mod it's a duplicate of>
Then, if any mods conflict or duplicate, a final section:
CONFLICTS:
<mod_id A> (<name A>) vs <mod_id B> (<name B>): <which should win and why>
DUPLICATE: <mod_id A> (<name A>) vs <mod_id B> (<name B>): <why they're the same mod, which to keep>
Use the DUPLICATE flag/line specifically when two entries are likely THE
SAME mod under a different name or rerelease (e.g. "X" vs "X NG", "X SE" vs
"X AE", "X Redux", an author's old version next to their replacement) —
that's a real duplicate-install problem the user should resolve, not an
install-order conflict. Use plain CONFLICT for mods that merely share files
or don't play well together but are genuinely different mods.
If nothing needs correcting, reply with just the CONFLICTS section, or
nothing at all.

Mods:
{{MODS}}
```

`{{BUCKETS}}` expands to the 20 groups annotated with STEP's description of
each (`BUCKET_HINTS` in `modman/buckets.py`); `{{CONFLICTS}}` is the real
file-path overlaps found by "Scan archives"; `{{MODS}}` groups the mods
under their current heuristic heading. The reply is corrections-only (not
a full reorder) to keep it small and cheap to parse — if Claude tries to
"correct" more than 40% of the mods shown, the whole reply is rejected as
a safety valve (looks like a full reorder in disguise) and the existing
order is left untouched. `modman/llm_refine.py` builds the prompt and
parses the reply server-side.

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
  buckets.py  STEP 2.3 group scheme + name/category heuristic classifier
  order_store.py    mod_sort table CRUD, heuristic sort, locks, moves
  llm_refine.py     claude -p bulk + uncertain-only refine passes
  conflicts.py      real archive file-path overlap scan (7z)
  requirements.py   real Nexus "requires" edges, missing-dependency check
  collection_rules.py  curator before/after/requires rules from a collection manifest
  precedence.py     applies collection_rules as a final position adjustment
webapp.py     FastAPI server + JSON API
cli.py        command-line downloader
browser.sh    launches the dedicated Chromium (profile + debug port)
web/          frontend (single page)
```

Files land in `/games/modding/downloads/`. Downloads resume on re-run;
completed files are skipped via the DB diff.
