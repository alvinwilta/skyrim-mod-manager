import os
import shutil
import sqlite3
import time

from .config import DB_PATH, GAME

# collection_mod_rules types that actually imply an order and get applied by
# modman/precedence.py's enforce() pass -- conflicts/recommends/provides don't.
# Shared so list_collections()'s rule_count can't drift from what "Apply
# collection order rules" actually acts on.
ORDER_RULE_TYPES = ("before", "after", "requires")


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # a refine saving a big correction batch holds one write transaction for
    # a while; a concurrently finishing download's record_downloads must wait
    # it out, not die on "database is locked" after sqlite's default 5s
    conn.execute("PRAGMA busy_timeout = 30000")
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
        # user config (paths/dirs/cdp_port/api key) -- read at import by
        # config.py (directly, read-only) with precedence DB > .env > env.
        conn.execute("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)")
        # separator taxonomy (grouping layer, NOT the functional order) -- seeded
        # from the repo `separator/` dir by modman/separators.py. id IS the band
        # sort key (major*100+minor from the numeric prefix), so ordering by id
        # is ordering by band. special_kind: header/output/unsorted/dlc/storage/
        # root, else NULL (a normal assignable sub-separator).
        conn.execute(
            "CREATE TABLE IF NOT EXISTS separator (id INTEGER PRIMARY KEY, name TEXT NOT NULL,"
            " folder TEXT, special_kind TEXT, collapsed INTEGER NOT NULL DEFAULT 0)"
        )
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
        # MO2 live install-state from the last pull (modman/mo2_pull.py):
        # 'enabled'/'disabled' = folder present in MO2's mods dir (active/inactive),
        # 'removed' = an ok db mod MO2 no longer has, NULL = never pulled.
        if "mo2_state" not in cols_sort:
            conn.execute("ALTER TABLE mod_sort ADD COLUMN mo2_state TEXT")
        # which separator (grouping band) a mod belongs to -- separator.id, i.e.
        # the band sort key. Assigned by modman/separators.py; NULL = unassigned
        # (shows under NEW & UNSORTED). Cosmetic in Phase 2; feeds bands in P3.
        if "separator_id" not in cols_sort:
            conn.execute("ALTER TABLE mod_sort ADD COLUMN separator_id INTEGER")
        # Phase 3 ordering engine (modman/ordering.py): a cross-band auto-pin.
        # conflict_pin = 1 when the engine forced this mod out of its band's
        # natural slot to satisfy a real file-overlap that band order alone
        # would resolve backwards; pin_reason = the human-readable "why" (the
        # shared path + the mod it must overwrite/yield to). Both NULL = the
        # mod sits where its band+cluster naturally places it.
        if "conflict_pin" not in cols_sort:
            conn.execute("ALTER TABLE mod_sort ADD COLUMN conflict_pin INTEGER NOT NULL DEFAULT 0")
        if "pin_reason" not in cols_sort:
            conn.execute("ALTER TABLE mod_sort ADD COLUMN pin_reason TEXT")
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
        # original on-disk name before an install-order "commit" prefixed it; NULL
        # = file is in its original (uncommitted) name -- see modman/commit.py
        if "orig_filename" not in cols:
            conn.execute("ALTER TABLE mods ADD COLUMN orig_filename TEXT")
        # provenance: NULL = downloaded/imported through the tool (has a managed
        # archive in downloads dir); 'mo2' = adopted from an MO2-only installed
        # folder (no managed archive, filename NULL) -- see modman/mo2_pull.py.
        # Download-centric ops (validate/commit/hide) skip 'mo2' rows.
        if "source" not in cols:
            conn.execute("ALTER TABLE mods ADD COLUMN source TEXT")
        # real per-mod "requires" edges from Nexus's own GraphQL -- see modman/requirements.py
        conn.execute(
            "CREATE TABLE IF NOT EXISTS mod_requirements (mod_id INTEGER NOT NULL,"
            " requires_mod_id INTEGER NOT NULL, notes TEXT,"
            " PRIMARY KEY (mod_id, requires_mod_id))"
        )
        # the required mod's Nexus name (from the same requirements fetch), so the
        # missing-requirements list can show a name, not just an id
        cols_req = [r[1] for r in conn.execute("PRAGMA table_info(mod_requirements)")]
        if "requires_mod_name" not in cols_req:
            conn.execute("ALTER TABLE mod_requirements ADD COLUMN requires_mod_name TEXT")
        # user-asserted substitutes: "this missing required mod is actually
        # satisfied by an owned library mod". Keyed by the MISSING required
        # Nexus mod_id (global — every mod requiring it is satisfied at once);
        # sub_mod_id points at an ok mod. See modman/requirements.py.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS requirement_subs (requires_mod_id INTEGER PRIMARY KEY,"
            " sub_mod_id INTEGER NOT NULL, created_at TEXT)"
        )
        # which collection(s) a mod came from, if any -- absent = manually installed
        conn.execute(
            "CREATE TABLE IF NOT EXISTS collections (id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " slug TEXT NOT NULL UNIQUE, nexus_collection_id INTEGER, revision_number INTEGER,"
            " name TEXT, updated_at TEXT, enabled INTEGER NOT NULL DEFAULT 1)"
        )
        cols_coll = [r[1] for r in conn.execute("PRAGMA table_info(collections)")]
        if "enabled" not in cols_coll:
            conn.execute("ALTER TABLE collections ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS mod_collections (file_id INTEGER NOT NULL,"
            " collection_id INTEGER NOT NULL, PRIMARY KEY (file_id, collection_id))"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mod_collections_collection ON mod_collections (collection_id)")
        cols_mc = [r[1] for r in conn.execute("PRAGMA table_info(mod_collections)")]
        for col in ("mod_id", "mod_name", "mod_url"):
            if col not in cols_mc:
                conn.execute(f"ALTER TABLE mod_collections ADD COLUMN {col} {'INTEGER' if col == 'mod_id' else 'TEXT'}")
        # curator-authored before/after/requires/conflicts/recommends/provides rules
        # from a collection's own manifest -- see modman/collection_rules.py
        conn.execute(
            "CREATE TABLE IF NOT EXISTS collection_mod_rules (collection_id INTEGER NOT NULL,"
            " type TEXT NOT NULL, source_mod_id INTEGER, reference_mod_id INTEGER)"
        )
        cols_cmr = [r[1] for r in conn.execute("PRAGMA table_info(collection_mod_rules)")]
        if "notes" in cols_cmr:
            conn.execute("ALTER TABLE collection_mod_rules DROP COLUMN notes")  # never written, never read
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


def get_config():
    """All stored config overrides as {key: value}. Only rows the user actually
    set -- resolution against .env/env/default happens in config.py."""
    with connect() as conn:
        return {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM config")}


def set_config(values):
    """Upsert config keys. A blank/None value deletes the row (so the key falls
    back to .env/env/default again). Only known keys are written."""
    from .config import CONFIG_KEYS

    with connect() as conn:
        for key, value in values.items():
            if key not in CONFIG_KEYS:
                continue
            if value in (None, ""):
                conn.execute("DELETE FROM config WHERE key = ?", (key,))
            else:
                conn.execute(
                    "INSERT INTO config (key, value) VALUES (?, ?)"
                    " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (key, str(value).strip()),
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


def mo2_states():
    """{mod_id: mo2_state} for every mod that carries a live MO2 pull state
    ('enabled'/'disabled'/'removed'). MO2 is the truth for install-state once
    pulled, so both the Library and Install Order surfaces prefer this over the
    per-download .meta sidecar (which goes stale when a mod is enabled/removed
    in MO2, and is simply absent for MO2-only adopted mods)."""
    with connect() as conn:
        return {
            r["mod_id"]: r["mo2_state"]
            for r in conn.execute(
                "SELECT mod_id, mo2_state FROM mod_sort WHERE mo2_state IS NOT NULL"
            )
        }


def file_ids_for_mods(mod_ids):
    """All live (status='ok') file_ids belonging to the given mods — lets
    mod-level surfaces (install order) reuse the file-level delete path."""
    if not mod_ids:
        return []
    with connect() as conn:
        rows = conn.execute(
            f"SELECT file_id FROM mods WHERE status = 'ok' AND mod_id IN ({','.join('?' * len(mod_ids))})",
            list(mod_ids),
        ).fetchall()
    return [r["file_id"] for r in rows]


def collections_for_files(file_ids):
    """file_id -> [{slug, name}] for every collection that references it.
    Empty list means manually installed (or a collection whose import never
    got recorded)."""
    by_file = {fid: [] for fid in file_ids}
    if not file_ids:
        return by_file
    with connect() as conn:
        rows = conn.execute(
            "SELECT mc.file_id, c.slug, c.name FROM mod_collections mc"
            f" JOIN collections c ON c.id = mc.collection_id"
            f" WHERE mc.file_id IN ({','.join('?' * len(file_ids))})",
            file_ids,
        ).fetchall()
    for r in rows:
        by_file.setdefault(r["file_id"], []).append({"slug": r["slug"], "name": r["name"]})
    return by_file


def record_downloads(entries):
    """Persist finished progress entries: 'done' as ok, 'failed' flagged missing.

    Missing rows keep the mod visible in the library but are excluded from the
    diff, so the next import retries them. Sort state lives in mod_sort keyed
    by mod_id, so writing file rows never touches it."""
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    with connect() as conn:
        for entry in entries:
            if entry["status"] not in ("done", "failed"):
                continue
            status = "ok" if entry["status"] == "done" else "missing"
            m = entry["meta"]
            game = m.get("game") or GAME
            conn.execute(
                # ON CONFLICT UPDATE (not INSERT OR REPLACE) so columns omitted here --
                # files_scanned in particular -- keep their existing value on a
                # redownload instead of being reset to their column default.
                # The status/filename CASEs keep a FAILED redownload from
                # downgrading a healthy 'ok' row to missing/NULL-filename --
                # the intact archive already on disk stays the row's truth.
                "INSERT INTO mods (file_id, mod_id, mod_name, file_name,"
                " mod_version, file_version, category, author, filename, size_bytes,"
                " game, downloaded_at, status, mod_url, requirements_alert) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(file_id) DO UPDATE SET mod_id=excluded.mod_id, mod_name=excluded.mod_name,"
                " file_name=excluded.file_name, mod_version=excluded.mod_version,"
                " file_version=excluded.file_version, category=excluded.category, author=excluded.author,"
                " filename=CASE WHEN excluded.status = 'missing' AND mods.status = 'ok'"
                "   THEN mods.filename ELSE excluded.filename END,"
                " size_bytes=excluded.size_bytes, game=excluded.game,"
                " downloaded_at=excluded.downloaded_at,"
                " status=CASE WHEN excluded.status = 'missing' AND mods.status = 'ok'"
                "   THEN mods.status ELSE excluded.status END,"
                " mod_url=excluded.mod_url,"
                " requirements_alert=excluded.requirements_alert",
                (
                    m["file_id"], m["mod_id"], m["mod_name"], m["file_name"],
                    m["mod_version"], m["file_version"], m["category"], m["author"],
                    # the exact on-disk name recorded by the downloader itself
                    entry.get("filename") if status == "ok" else None,
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


def link_collection_files(collection_id, entries):
    """Link a collection to every mod it references -- called both at fetch
    time (the collection's FULL modlist, whether or not any file is actually
    downloaded yet) and after a download batch completes. Each entry is
    {file_id, mod_id, mod_name, mod_url}: stored on mod_collections itself
    (not derived via a join to `mods`) so collection membership/mod list is
    known immediately on import, before the mod ever exists in `mods`."""
    if not entries:
        return 0
    with connect() as conn:
        conn.executemany(
            "INSERT INTO mod_collections (file_id, collection_id, mod_id, mod_name, mod_url)"
            " VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(file_id, collection_id) DO UPDATE SET mod_id = excluded.mod_id,"
            " mod_name = excluded.mod_name, mod_url = excluded.mod_url",
            [(e["file_id"], collection_id, e["mod_id"], e["mod_name"], e["mod_url"]) for e in entries],
        )
        return len(entries)


def list_collections():
    """Every imported collection: how many mods it lists total vs. how many
    are actually downloaded, and how many curated order rules it has.
    `enabled` controls whether this collection's rules feed the precedence
    enforce pass (see modman/precedence.py) -- toggling it off doesn't touch
    provenance tracking, just whether its ordering rules are applied."""
    order_placeholders = ",".join("?" * len(ORDER_RULE_TYPES))
    with connect() as conn:
        # correlated subqueries, not joins: joining mods x rules multiplies to
        # (mod_count x rule_count) intermediate rows per collection before the
        # COUNT(DISTINCT) dedups — millions of rows scanned per /api/collections
        # hit on a big collection
        rows = conn.execute(
            "SELECT c.id, c.slug, c.name, c.revision_number, c.enabled,"
            " (SELECT COUNT(*) FROM mod_collections mc WHERE mc.collection_id = c.id) AS mod_count,"
            " (SELECT COUNT(*) FROM mod_collections mc JOIN mods m ON m.file_id = mc.file_id"
            "   AND m.status = 'ok' WHERE mc.collection_id = c.id) AS downloaded_count,"
            f" (SELECT COUNT(*) FROM collection_mod_rules r WHERE r.collection_id = c.id"
            f"   AND r.type IN ({order_placeholders})) AS rule_count"
            " FROM collections c ORDER BY c.name COLLATE NOCASE",
            ORDER_RULE_TYPES,
        ).fetchall()
    out = [dict(r) for r in rows]
    for r in out:
        r["url"] = f"https://www.nexusmods.com/games/{GAME}/collections/{r['slug']}"
    return out


def set_collection_enabled(collection_id, enabled):
    with connect() as conn:
        conn.execute("UPDATE collections SET enabled = ? WHERE id = ?", (1 if enabled else 0, collection_id))


def collection_exclusive_files(collection_id):
    """(exclusive_ids, shared_count) among this collection's downloaded ('ok')
    files: exclusive = linked to no other collection — the removable set for
    "remove this collection's mods"; shared = kept on removal. Any other
    registered collection's link counts as sharing, enabled or not — a
    collection disabled just to mute its order rules must not lose files."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT mc.file_id, EXISTS (SELECT 1 FROM mod_collections o"
            "   WHERE o.file_id = mc.file_id AND o.collection_id != ?) AS shared"
            " FROM mod_collections mc JOIN mods m ON m.file_id = mc.file_id"
            " WHERE mc.collection_id = ? AND m.status = 'ok'",
            (collection_id, collection_id),
        ).fetchall()
    exclusive = [r["file_id"] for r in rows if not r["shared"]]
    return exclusive, len(rows) - len(exclusive)


def collection_mods(collection_id):
    """This collection's full mod list -- including mods not yet downloaded
    -- in the current global install order for whichever ones are (same rank
    the Install Order tab uses)."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT COALESCE(m.mod_id, mc.mod_id) AS mod_id,"
            " COALESCE(m.mod_name, mc.mod_name) AS mod_name,"
            " COALESCE(m.mod_url, mc.mod_url) AS mod_url,"
            " MAX(CASE WHEN m.status = 'ok' THEN 1 ELSE 0 END) AS downloaded,"
            " s.bucket, s.rank, s.locked"
            " FROM mod_collections mc"
            " LEFT JOIN mods m ON m.file_id = mc.file_id AND m.status = 'ok'"
            " LEFT JOIN mod_sort s ON s.mod_id = COALESCE(m.mod_id, mc.mod_id)"
            " WHERE mc.collection_id = ? GROUP BY COALESCE(m.mod_id, mc.mod_id)"
            " ORDER BY downloaded DESC, s.rank IS NULL, s.rank, s.bucket, mod_name COLLATE NOCASE",
            (collection_id,),
        ).fetchall()
    return [
        {
            "mod_id": r["mod_id"], "mod_name": r["mod_name"], "mod_url": r["mod_url"],
            "downloaded": bool(r["downloaded"]),
            "bucket": r["bucket"], "locked": bool(r["locked"]),
        }
        for r in rows
    ]
