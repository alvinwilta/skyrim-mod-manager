import os
import shutil
import sqlite3
import time

from .config import DB_PATH, DOWNLOADS_DIR, GAME


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    # one-generation safety net before any migration below touches the schema
    if os.path.isfile(DB_PATH):
        shutil.copy2(DB_PATH, DB_PATH + ".bak")
    with connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS mods (
                file_id INTEGER PRIMARY KEY,
                mod_id INTEGER NOT NULL,
                mod_name TEXT,
                file_name TEXT,
                mod_version TEXT,
                file_version TEXT,
                category TEXT,
                author TEXT,
                filename TEXT,
                size_bytes INTEGER,
                game TEXT,
                downloaded_at TEXT,
                status TEXT DEFAULT 'ok',
                mod_url TEXT,
                requirements_alert INTEGER
            )
            """
        )
        conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
        # install-order state is per *mod*, one row per mod_id (a mod has many
        # file rows in `mods`); survives file redownloads/updates untouched.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS mod_sort (
                mod_id INTEGER PRIMARY KEY,
                bucket INTEGER,
                rank INTEGER,
                flags TEXT,
                expected_bucket INTEGER,
                locked INTEGER NOT NULL DEFAULT 0,
                description TEXT,
                desc_checked INTEGER NOT NULL DEFAULT 0,
                file_type TEXT,
                requirements_checked INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        cols_sort = [r[1] for r in conn.execute("PRAGMA table_info(mod_sort)")]
        if "description" not in cols_sort:
            conn.execute("ALTER TABLE mod_sort ADD COLUMN description TEXT")
        if "desc_checked" not in cols_sort:
            conn.execute("ALTER TABLE mod_sort ADD COLUMN desc_checked INTEGER NOT NULL DEFAULT 0")
        if "file_type" not in cols_sort:
            conn.execute("ALTER TABLE mod_sort ADD COLUMN file_type TEXT")
        if "requirements_checked" not in cols_sort:
            conn.execute("ALTER TABLE mod_sort ADD COLUMN requirements_checked INTEGER NOT NULL DEFAULT 0")
        # real (not guessed) file-path overlaps between archives -- see modman/conflicts.py
        conn.execute(
            "CREATE TABLE IF NOT EXISTS mod_files (file_id INTEGER NOT NULL, path TEXT NOT NULL,"
            " PRIMARY KEY (file_id, path))"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mod_files_path ON mod_files (path)")
        cols = [r[1] for r in conn.execute("PRAGMA table_info(mods)")]
        if "files_scanned" not in cols:
            conn.execute("ALTER TABLE mods ADD COLUMN files_scanned INTEGER NOT NULL DEFAULT 0")
        if "status" not in cols:
            conn.execute("ALTER TABLE mods ADD COLUMN status TEXT DEFAULT 'ok'")
        if "mod_url" not in cols:
            conn.execute("ALTER TABLE mods ADD COLUMN mod_url TEXT")
        if "requirements_alert" not in cols:
            conn.execute("ALTER TABLE mods ADD COLUMN requirements_alert INTEGER")
        # real per-mod "requires" edges from Nexus's own GraphQL -- see modman/requirements.py
        conn.execute(
            "CREATE TABLE IF NOT EXISTS mod_requirements (mod_id INTEGER NOT NULL,"
            " requires_mod_id INTEGER NOT NULL, notes TEXT,"
            " PRIMARY KEY (mod_id, requires_mod_id))"
        )
        # which collection(s) a mod came from, if any -- absent = manually installed
        conn.execute(
            "CREATE TABLE IF NOT EXISTS collections (id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " slug TEXT NOT NULL UNIQUE, nexus_collection_id INTEGER, revision_number INTEGER,"
            " name TEXT, updated_at TEXT)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS mod_collections (file_id INTEGER NOT NULL,"
            " collection_id INTEGER NOT NULL, PRIMARY KEY (file_id, collection_id))"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mod_collections_collection ON mod_collections (collection_id)")
        # curator-authored before/after/requires/conflicts/recommends/provides rules
        # from a collection's own manifest -- see modman/collection_rules.py
        conn.execute(
            "CREATE TABLE IF NOT EXISTS collection_mod_rules (collection_id INTEGER NOT NULL,"
            " type TEXT NOT NULL, source_mod_id INTEGER, reference_mod_id INTEGER, notes TEXT)"
        )
        # migrate sort state that used to live denormalized on the file rows
        if "sort_bucket" in cols:
            conn.execute(
                "INSERT OR IGNORE INTO mod_sort (mod_id, bucket, rank, flags, expected_bucket, locked)"
                " SELECT mod_id, sort_bucket, sort_rank, sort_flags, expected_bucket,"
                "        COALESCE(MAX(sort_locked), 0)"
                " FROM mods WHERE sort_rank IS NOT NULL GROUP BY mod_id"
            )
            for col in ("sort_bucket", "sort_rank", "sort_flags", "expected_bucket", "sort_locked"):
                if col in cols:
                    conn.execute(f"ALTER TABLE mods DROP COLUMN {col}")
        conn.execute(
            "UPDATE mods SET mod_url = 'https://www.nexusmods.com/' || game || '/mods/' || mod_id WHERE mod_url IS NULL"
        )


def list_mods(q=None):
    sql = "SELECT * FROM mods"
    args = []
    if q:
        sql += " WHERE mod_name LIKE ? OR file_name LIKE ? OR author LIKE ? OR category LIKE ?"
        args = [f"%{q}%"] * 4
    sql += " ORDER BY downloaded_at DESC, mod_name COLLATE NOCASE"
    with connect() as conn:
        return [dict(r) for r in conn.execute(sql, args)]


def record_downloads(entries):
    """Persist finished progress entries: 'done' as ok, 'failed' flagged missing.

    Missing rows keep the mod visible in the library but are excluded from the
    diff, so the next import retries them. Sort state lives in mod_sort keyed
    by mod_id, so writing file rows never touches it."""
    ondisk = {os.path.splitext(f)[0]: f for f in os.listdir(DOWNLOADS_DIR)}
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    with connect() as conn:
        for entry in entries:
            if entry["status"] not in ("done", "failed"):
                continue
            status = "ok" if entry["status"] == "done" else "missing"
            m = entry["meta"]
            game = m.get("game") or GAME
            conn.execute(
                "INSERT OR REPLACE INTO mods (file_id, mod_id, mod_name, file_name,"
                " mod_version, file_version, category, author, filename, size_bytes,"
                " game, downloaded_at, status, mod_url, requirements_alert) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    m["file_id"], m["mod_id"], m["mod_name"], m["file_name"],
                    m["mod_version"], m["file_version"], m["category"], m["author"],
                    ondisk.get(entry["name"]) if status == "ok" else None,
                    entry["size"], game, now, status,
                    f"https://www.nexusmods.com/{game}/mods/{m['mod_id']}",
                    m.get("requirements_alert"),
                ),
            )


def upsert_collection(slug, nexus_collection_id=None, revision_number=None, name=None):
    """Register/refresh a collection by slug (a collection can have many
    revisions over time; slug is the app's own dedup key). Returns collection_id."""
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    with connect() as conn:
        conn.execute(
            "INSERT INTO collections (slug, nexus_collection_id, revision_number, name, updated_at)"
            " VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(slug) DO UPDATE SET nexus_collection_id = excluded.nexus_collection_id,"
            " revision_number = excluded.revision_number, name = excluded.name, updated_at = excluded.updated_at",
            (slug, nexus_collection_id, revision_number, name, now),
        )
        return conn.execute("SELECT id FROM collections WHERE slug = ?", (slug,)).fetchone()["id"]


def link_collection_files(collection_id, file_ids):
    """Link mods already present in the library to a collection that
    references them -- called both at diff time (mods you already have that
    this collection also lists) and after a download batch completes (mods
    freshly downloaded from it). Silently ignores file_ids not yet in `mods`."""
    if not file_ids:
        return 0
    with connect() as conn:
        have = {
            r["file_id"] for r in conn.execute(
                f"SELECT file_id FROM mods WHERE file_id IN ({','.join('?' * len(file_ids))})", file_ids
            )
        }
        conn.executemany(
            "INSERT OR IGNORE INTO mod_collections (file_id, collection_id) VALUES (?, ?)",
            [(fid, collection_id) for fid in have],
        )
        return len(have)
