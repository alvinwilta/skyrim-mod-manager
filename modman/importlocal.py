"""Adopt archives that are sitting in the downloads dir but aren't in the DB --
files the user downloaded directly through MO2 or from other sites (LoversLab,
GitHub, ...), so the diff/download pipeline never recorded them.

Each orphan is classified into one of three tiers, most-truthful first, and
NOTHING is inferred beyond what the file itself / its .meta / Nexus actually say:

  1. Nexus .meta (repository=Nexus, real modID/fileID) -> fetch full metadata
     from Nexus GraphQL, exactly like a manager download. Real url.
  2. Nexus .meta but the Nexus fetch fails (mod pulled/offline) -> keep the real
     ids + whatever the .meta states, empty url.
  3. no usable identity (no .meta, or a non-Nexus .meta) -> synthetic NEGATIVE
     ids derived stably from the filename (so re-runs are idempotent and never
     collide with Nexus's positive ids), mod_name = filename minus extension,
     size from disk, everything else blank, empty url. A minimal truthful .meta
     is written for it if one doesn't already exist.

Runs as a background job (state + lock + thread), mirroring conflicts.start_scan.
"""

import hashlib
import logging
import os
import threading
import time

from . import conflicts, db, jobs, mo2, nexus, order_store
from .config import DOWNLOADS_DIR, GAME

log = logging.getLogger(__name__)

state = {"phase": "idle", "running": False, "error": None, "adopted": 0, "non_nexus": 0, "skipped": 0}
_lock = threading.Lock()
jobs.register("import", state)

ARCHIVE_EXTS = {".7z", ".zip", ".rar", ".7zip"}


def _synthetic_id(filename):
    """Stable negative id from the filename: idempotent across re-runs, and can
    never clash with Nexus's positive modId/fileId space."""
    return -int(hashlib.sha1(filename.encode("utf-8", "surrogatepass")).hexdigest()[:15], 16)


def _list_archives():
    try:
        names = os.listdir(DOWNLOADS_DIR)
    except FileNotFoundError:
        return []
    return sorted(
        f
        for f in names
        if os.path.splitext(f)[1].lower() in ARCHIVE_EXTS and os.path.isfile(os.path.join(DOWNLOADS_DIR, f))
    )


def _row_for(filename):
    """Build the mods-row column dict for one orphan archive (tiers above)."""
    path = os.path.join(DOWNLOADS_DIR, filename)
    size = os.path.getsize(path)
    downloaded_at = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(os.path.getmtime(path)))
    meta = mo2.read_meta(filename)
    ident = mo2.nexus_identity(meta)

    if ident:
        domain, mod_id, file_id = ident
        info = None
        try:
            info = _fetch_file(domain, mod_id, file_id)  # tier 1
        except Exception as e:
            log.warning("import: Nexus fetch failed for %s (mod %s): %s", filename, mod_id, e)
        if info:  # tier 1: full metadata, real url
            return {
                **info,
                "file_id": file_id, "mod_id": mod_id, "filename": filename,
                "size_bytes": size, "game": domain, "downloaded_at": downloaded_at,
                "mod_url": nexus.mod_url(domain, mod_id),
                "non_nexus": False,
            }
        # tier 2: real ids from the .meta, no url
        return {
            "file_id": file_id, "mod_id": mod_id,
            "mod_name": meta.get("modname") or os.path.splitext(filename)[0],
            "file_name": meta.get("name") or filename,
            "mod_version": None, "file_version": meta.get("version") or None,
            "category": None, "author": None, "requirements_alert": None,
            "filename": filename, "size_bytes": size, "game": domain,
            "downloaded_at": downloaded_at, "mod_url": "", "non_nexus": False,
        }

    # tier 3: no usable identity -> synthetic ids, minimal truthful row + .meta
    sid = _synthetic_id(filename)
    mod_name = os.path.splitext(filename)[0]
    mo2.write_local_meta(filename, mod_name)
    return {
        "file_id": sid, "mod_id": sid,
        "mod_name": mod_name, "file_name": filename,
        "mod_version": None, "file_version": None,
        "category": None, "author": None, "requirements_alert": None,
        "filename": filename, "size_bytes": size, "game": GAME,
        "downloaded_at": downloaded_at, "mod_url": "", "non_nexus": True,
    }


def _fetch_file(domain, mod_id, file_id):
    """Full metadata for one Nexus file via fetch_mod, matched by fileId. Returns
    the mod-level + file-level fields, or None if the file/mod isn't found."""
    payload = nexus.fetch_mod(f"https://www.nexusmods.com/{domain}/mods/{mod_id}")
    for mf in payload["data"]["collectionRevision"]["modFiles"]:
        f = mf["file"]
        if int(f["fileId"]) == file_id:
            mod = f["mod"]
            return {
                "mod_name": mod["name"], "file_name": f["name"],
                "mod_version": mod.get("version"), "file_version": f.get("version"),
                "category": mod.get("category"), "author": mod.get("author"),
                "requirements_alert": f.get("requirementsAlert"),
            }
    return None


def scan():
    """Adopt every downloads-dir archive not already tracked. Returns counts."""
    archives = _list_archives()
    with db.connect() as conn:
        known_names = {r["filename"] for r in conn.execute("SELECT filename FROM mods WHERE filename IS NOT NULL")}
        known_ids = {r["file_id"] for r in conn.execute("SELECT file_id FROM mods")}

    adopted = non_nexus = 0
    adopted_ids = []
    for i, filename in enumerate(archives):
        if filename in known_names:
            continue
        state["phase"] = f"Adopting {i + 1}/{len(archives)}: {filename}"
        row = _row_for(filename)
        if row["file_id"] in known_ids:  # already tracked under another name
            continue
        _insert(row)
        known_ids.add(row["file_id"])
        adopted_ids.append(row["mod_id"])
        adopted += 1
        non_nexus += 1 if row["non_nexus"] else 0

    state["adopted"], state["non_nexus"] = adopted, non_nexus
    state["skipped"] = len(archives) - adopted
    if adopted:
        # same rule as downloads: new arrivals park Unsorted at the very end
        # of the order (top of the overwrite stack) until the next Sort/Refine
        try:
            order_store.park_new_at_end(adopted_ids)
        except Exception as e:
            log.warning("could not park adopted mods: %s", e)
        # scan first: classify_file_types only reads rows with files_scanned=1
        conflicts.scan()
        conflicts.classify_file_types()
    return adopted, non_nexus


def _insert(row):
    now = row["downloaded_at"]
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO mods (file_id, mod_id, mod_name, file_name, mod_version, file_version,"
            " category, author, filename, size_bytes, game, downloaded_at, status, mod_url,"
            " requirements_alert) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'ok', ?, ?)"
            " ON CONFLICT(file_id) DO UPDATE SET filename=excluded.filename, size_bytes=excluded.size_bytes,"
            " status='ok'",
            (
                row["file_id"], row["mod_id"], row["mod_name"], row["file_name"], row["mod_version"],
                row["file_version"], row["category"], row["author"], row["filename"], row["size_bytes"],
                row["game"], now, row["mod_url"], row["requirements_alert"],
            ),
        )


def start_scan():
    """Async adopt. Returns an error string or None (mirrors conflicts.start_scan)."""

    def work():
        n, nn = scan()
        return f"Adopted {n} file(s)" + (f" ({nn} non-Nexus)" if nn else "") if n else "Nothing new to import"

    # exclusive: adopting mid-download would record a partial archive as a
    # healthy synthetic-id mod and write a non-Nexus .meta the finishing
    # download then refuses to overwrite (two rows, one file, wrong .meta)
    return jobs.start(_lock, state, "an import is already running", work,
                      init={"adopted": 0, "non_nexus": 0, "skipped": 0},
                      exclusive_as="import")
