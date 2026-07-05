import os

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
                    env[k.strip()] = v.strip()
    return env


_env = _load_env()

GAME = "skyrimspecialedition"
GAME_ID = "1704"
CDP_URL = "http://localhost:9223"
BROWSER_CMD = [
    "chromium",
    "--user-data-dir=" + os.path.expanduser("~/.config/modman-browser"),
    "--remote-debugging-port=9223",
    "--no-first-run",
    "--start-minimized",
    "https://www.nexusmods.com",
]
MAX_WORKERS = 10

# MO2 base directory: downloads/mods paths derive from it (.env: MO2_BASE_DIR)
BASE_DIR = os.path.expanduser(_env.get("MO2_BASE_DIR") or os.environ.get("MO2_BASE_DIR") or "/games/modding")

# Personal Nexus API key (free tier works) -- only needed to fetch a
# collection's own curated ordering rules (modman/collection_rules.py).
# Everything else in this app works without it. Get one at
# https://next.nexusmods.com/settings/api-keys
NEXUS_API_KEY = _env.get("NEXUS_API_KEY") or os.environ.get("NEXUS_API_KEY")
DOWNLOADS_DIR = os.path.join(BASE_DIR, "downloads", "")
MODS_DIR = os.path.join(BASE_DIR, "mods", "")

# Override for test isolation (MODMAN_DB_PATH env var) -- must be a real env
# var read at import time, not a post-import monkeypatch: modman/__init__.py
# unconditionally imports db, which binds its own DB_PATH from this module at
# that moment, so anything that patches config.DB_PATH afterward is too late
# in the same process. A fresh subprocess with this env var set is the only
# reliable way to point a test server at a throwaway db copy.
DB_PATH = os.environ.get("MODMAN_DB_PATH") or os.path.join(ROOT_DIR, "mods.db")
WEB_DIR = os.path.join(ROOT_DIR, "web")
