import os
import sqlite3
import time

from .config import DB_PATH, DOWNLOADS_DIR, GAME


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
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
                mod_url TEXT
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
                locked INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        cols = [r[1] for r in conn.execute("PRAGMA table_info(mods)")]
        if "status" not in cols:
            conn.execute("ALTER TABLE mods ADD COLUMN status TEXT DEFAULT 'ok'")
        if "mod_url" not in cols:
            conn.execute("ALTER TABLE mods ADD COLUMN mod_url TEXT")
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
                " game, downloaded_at, status, mod_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    m["file_id"], m["mod_id"], m["mod_name"], m["file_name"],
                    m["mod_version"], m["file_version"], m["category"], m["author"],
                    ondisk.get(entry["name"]) if status == "ok" else None,
                    entry["size"], game, now, status,
                    f"https://www.nexusmods.com/{game}/mods/{m['mod_id']}",
                ),
            )
