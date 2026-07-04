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

- **Library** — browse/search everything in `mods.db`
- **Import** — paste a collection URL (fetched via Nexus GraphQL) or a
  `modlist.json`; diffed against the library into new / updated / unchanged
- **Progress** — live download dashboard

## CLI

```
.venv/bin/python cli.py https://www.nexusmods.com/games/skyrimspecialedition/collections/<slug>
.venv/bin/python cli.py modlist.json --include-unchanged
```

## Layout

```
modman/
  config.py   game/paths/constants
  db.py       sqlite library (mods.db)
  nexus.py    GraphQL collection fetch, CDP link generation, file transfer
  engine.py   diff + download pipeline, progress state
webapp.py     FastAPI server + JSON API
cli.py        command-line downloader
browser.sh    launches the dedicated Chromium (profile + debug port)
web/          frontend (single page)
```

Files land in `/games/modding/downloads/`. Downloads resume on re-run;
completed files are skipped via the DB diff.
