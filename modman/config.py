import os
import re
import shutil
import sqlite3

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_env():
    """Tiny .env reader (KEY=VALUE lines, # comments). No dependency needed."""
    env = {}
    path = os.path.join(ROOT_DIR, ".env")
    if os.path.isfile(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    # conventional dotenv quoting: KEY="value" must not leave
                    # literal quotes in derived paths
                    env[k.strip()] = v.strip().strip("\"'")
    return env


_env = _load_env()

# ENVIRONMENT (from .env / OS env): the single dev-vs-live toggle.
#   dev            -> sandbox db (mods.dev.db) + dev port 7799
#   empty / other  -> LIVE: real mods.db + port 7788   (the default)
# One switch drives BOTH the backend db+port and (via vite.config.ts reading the
# same .env) the dev frontend's proxy target. An explicit MODMAN_DB_PATH /
# MODMAN_PORT still overrides either (test isolation).
ENVIRONMENT = (_env.get("ENVIRONMENT") or os.environ.get("ENVIRONMENT") or "").strip().lower()
IS_DEV = ENVIRONMENT == "dev"

_LIVE_DB = os.path.join(ROOT_DIR, "mods.db")
_DEV_DB = os.path.join(ROOT_DIR, "mods.dev.db")


def _seed_dev_db(path):
    """Semi-permanent dev sandbox: on first dev run copy the live db to
    mods.dev.db and UNLOCK everything (so the ordering engine can reorder
    freely to demonstrate its output). Never auto-deleted; tweak it at will.
    Uses raw sqlite3 (config.py must not import db.py -- circular)."""
    if os.path.isfile(path) or not os.path.isfile(_LIVE_DB):
        return
    shutil.copy2(_LIVE_DB, path)
    try:
        conn = sqlite3.connect(path)
        conn.execute("UPDATE mod_sort SET locked = 0 WHERE locked = 1")
        conn.commit()
        conn.close()
    except sqlite3.Error:
        pass


# DB_PATH is resolved FIRST: the config table lives inside it, so it can't be
# a config-table value itself (would be circular). Stays env/file only -- must
# be a real env var read at import time, not a post-import monkeypatch:
# modman/__init__.py unconditionally imports db, which binds its own DB_PATH
# from this module at that moment, so anything that patches config.DB_PATH
# afterward is too late in the same process. A fresh subprocess with this env
# var set is the only reliable way to point a test server at a throwaway copy.
if os.environ.get("MODMAN_DB_PATH"):
    DB_PATH = os.environ["MODMAN_DB_PATH"]
elif IS_DEV:
    DB_PATH = _DEV_DB
    _seed_dev_db(DB_PATH)
else:
    DB_PATH = _LIVE_DB

# Server port: dev 7799, live 7788. MODMAN_PORT overrides.
PORT = int(os.environ.get("MODMAN_PORT") or (7799 if IS_DEV else 7788))


def _load_db_config():
    """Read the config(key,value) table directly via read-only sqlite -- NOT
    through db.py, which imports this module (circular). Returns {} when the db
    or table doesn't exist yet (first run, before init_db creates it), so paths
    always fall back to .env/env/default. Blank values are treated as unset."""
    cfg = {}
    if not os.path.isfile(DB_PATH):
        return cfg
    try:
        conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
        try:
            for key, value in conn.execute("SELECT key, value FROM config"):
                if value not in (None, ""):
                    cfg[key] = value
        finally:
            conn.close()
    except sqlite3.Error:
        pass  # no config table yet, or db mid-migration
    return cfg


_dbcfg = _load_db_config()


def _cfg(db_key, env_key=None, default=None):
    """First non-empty of: DB config > .env > OS env > default. The DB always
    wins so the Config tab is the single source of truth once set; .env/env
    remain as a pre-config bootstrap and for test isolation."""
    if _dbcfg.get(db_key):
        return _dbcfg[db_key]
    if env_key:
        v = _env.get(env_key) or os.environ.get(env_key)
        if v:
            return v
    return default


GAME = "skyrimspecialedition"
GAME_ID = "1704"

# CDP port for the dedicated Chromium (link generation). Configurable so a
# clashing port can be moved without editing code.
CDP_PORT = int(_cfg("cdp_port", "CDP_PORT", "9223"))
CDP_URL = f"http://localhost:{CDP_PORT}"
_BROWSER_FLAGS = [
    "--user-data-dir=" + os.path.expanduser("~/.config/modman-browser"),
    "--remote-debugging-port=" + str(CDP_PORT),
    "--no-first-run",
]
BROWSER_CMD = ["chromium", *_BROWSER_FLAGS, "--start-minimized", "https://www.nexusmods.com"]
# Windowless variant for routine link generation: the saved profile session
# usually authenticates on its own, so no window needs to appear. Login (when
# the session has expired) always requires the visible BROWSER_CMD.
BROWSER_CMD_HEADLESS = ["chromium", *_BROWSER_FLAGS, "--headless=new", "https://www.nexusmods.com"]
MAX_WORKERS = 10

# MO2 base directory: downloads/mods/profiles paths derive from it unless a
# per-path override is set. Precedence DB(mo2_base_dir) > .env/env(MO2_BASE_DIR)
# > /games/modding.
BASE_DIR = os.path.expanduser(_cfg("mo2_base_dir", "MO2_BASE_DIR", "/games/modding"))

# Personal Nexus API key (free tier works) -- only needed to fetch a
# collection's own curated ordering rules (modman/collection_rules.py).
# Everything else in this app works without it. Get one at
# https://next.nexusmods.com/settings/api-keys
NEXUS_API_KEY = _cfg("nexus_api_key", "NEXUS_API_KEY")

# Per-path overrides (optional): each defaults to a BASE_DIR-relative path but
# can be pinned independently in the config table for non-standard MO2 layouts.
# expanduser so a `~/...` override behaves the same as BASE_DIR and matches the
# save-time validation (which also expands) -- otherwise a validated `~/x` would
# be used literally at runtime.
def _path(db_key, *default_parts):
    val = _cfg(db_key)
    return os.path.expanduser(val) if val else os.path.join(BASE_DIR, *default_parts)


DOWNLOADS_DIR = _path("downloads_dir", "downloads", "")
MODS_DIR = _path("mods_dir", "mods", "")

# MO2 install-state paths (read-only) -- used by modman/mo2_order.py to compare
# the app's computed install order against what MO2 actually has installed.
MO2_INI = _path("mo2_ini", "MO2", "ModOrganizer.ini")
PROFILES_DIR = _path("profiles_dir", "profiles", "")


def active_profile():
    """MO2's currently-selected profile name (ModOrganizer.ini
    `selected_profile=@ByteArray(<name>)`). Falls back to 'Default'."""
    try:
        with open(MO2_INI, errors="ignore") as f:
            for line in f:
                if line.strip().startswith("selected_profile="):
                    val = line.split("=", 1)[1].strip()
                    m = re.match(r"@ByteArray\((.*)\)$", val)
                    return (m.group(1) if m else val) or "Default"
    except OSError:
        pass
    return "Default"


def modlist_path():
    """Path to the active profile's modlist.txt (ordered install list)."""
    return os.path.join(PROFILES_DIR, active_profile(), "modlist.txt")


# The config keys the Config tab reads/writes. Path keys are validated (must be
# an existing dir) on save; the rest are free-form. Single source of truth so
# webapp and any future consumer don't drift.
CONFIG_KEYS = ("mo2_base_dir", "downloads_dir", "mods_dir", "profiles_dir", "mo2_ini", "cdp_port", "nexus_api_key")
CONFIG_DIR_KEYS = ("mo2_base_dir", "downloads_dir", "mods_dir", "profiles_dir")


def _source_of(db_key, env_key=None):
    """Where a key's value comes from: 'db' (Config tab), 'env' (.env/OS env),
    or 'default'."""
    if _dbcfg.get(db_key):
        return "db"
    if env_key and (_env.get(env_key) or os.environ.get(env_key)):
        return "env"
    return "default"


_base_source = _source_of("mo2_base_dir", "MO2_BASE_DIR")


def sources():
    """Provenance per config key so the UI can tell a user which paths are
    already supplied (env) vs. still need setting. The derived path keys inherit
    the base dir's origin when they have no explicit override -- a downloads dir
    computed off an env-provided base is 'provided' too, not a blank to fill."""

    def path_src(db_key):
        return "db" if _dbcfg.get(db_key) else _base_source

    return {
        "mo2_base_dir": _base_source,
        "downloads_dir": path_src("downloads_dir"),
        "mods_dir": path_src("mods_dir"),
        "profiles_dir": path_src("profiles_dir"),
        "mo2_ini": path_src("mo2_ini"),
        "cdp_port": _source_of("cdp_port", "CDP_PORT"),
        "nexus_api_key": _source_of("nexus_api_key", "NEXUS_API_KEY"),
    }


def effective():
    """Current resolved values (post-precedence) for the Config tab to show
    alongside the raw stored overrides -- so the user sees what's actually in
    effect even when a value comes from .env/default, not the db."""
    return {
        "mo2_base_dir": BASE_DIR,
        "downloads_dir": DOWNLOADS_DIR,
        "mods_dir": MODS_DIR,
        "profiles_dir": PROFILES_DIR,
        "mo2_ini": MO2_INI,
        "cdp_port": CDP_PORT,
        # never expose the raw key to the UI (it'd show as the field's
        # placeholder) -- only whether one is set
        "nexus_api_key": "•••• (set)" if NEXUS_API_KEY else "",
    }
